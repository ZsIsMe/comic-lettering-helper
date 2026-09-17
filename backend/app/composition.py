"""CPU comparison and compositing, bound to immutable completed repair inputs.

Difference/feather algorithms adapted from workflow_compare_ui.py, reference
comic-text-detector-inpaint commit a94fd14d7594ea5bf005b1e1ad2d56731f1a8619.
There is deliberately no Qt, model inference, or candidate import dependency.
"""
from __future__ import annotations

import io
import json
import os
import uuid
import zipfile
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response, StreamingResponse
from PIL import Image
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

WORKFLOW_ORDER = ["flux2klein_lanpaint", "firered", "qwen2511_lanpaint"]
DEFAULT_SETTINGS = {"threshold": 12, "min_area": 16, "expand_px": 5, "feather_px": 1}


def read_rgb(path: Path) -> np.ndarray:
    with Image.open(path) as image:
        return np.asarray(image.convert("RGB")).copy()


def png_bytes(image: np.ndarray) -> bytes:
    output = io.BytesIO()
    Image.fromarray(image).save(output, format="PNG")
    return output.getvalue()


def atomic_write(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_bytes(content)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def difference_mask(base: np.ndarray, result: np.ndarray, threshold: int = 12,
                    min_area: int = 16, expand_px: int = 0) -> np.ndarray:
    if base.shape != result.shape:
        raise ValueError("底圖與候選圖片尺寸不同，不能對齊合成")
    difference = cv2.absdiff(base, result).max(axis=2).astype(np.uint8)
    changed = np.where(difference >= max(1, min(255, threshold)), 255, 0).astype(np.uint8)
    if np.any(changed):
        changed = cv2.morphologyEx(changed, cv2.MORPH_CLOSE,
                                  cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))
        count, labels, stats, _ = cv2.connectedComponentsWithStats(changed, connectivity=8)
        filtered = np.zeros_like(changed)
        for label in range(1, count):
            if int(stats[label, cv2.CC_STAT_AREA]) >= max(1, min_area):
                filtered[labels == label] = 255
        changed = filtered
    if expand_px and np.any(changed):
        size = max(0, expand_px) * 2 + 1
        changed = cv2.dilate(changed, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size)))
    return changed


def compose_result(base: np.ndarray, candidates: dict[int, np.ndarray],
                   assignment: np.ndarray, feather_px: int = 1) -> np.ndarray:
    if assignment.shape != base.shape[:2]:
        raise ValueError("像素來源圖與底圖尺寸不一致")
    selected_codes = set(int(code) for code in np.unique(assignment) if code > 1)
    for code in selected_codes:
        if code not in candidates:
            raise ValueError(f"缺少已採用的候選來源 {code}")
        if candidates[code].shape != base.shape:
            raise ValueError(f"候選來源 {code} 的尺寸與底圖不同")
    if feather_px <= 0:
        output = base.copy()
        for code in selected_codes:
            selected = assignment == code
            output[selected] = candidates[code][selected]
        return output
    base_float = base.astype(np.float32)
    weighted = np.zeros_like(base_float)
    alpha_sum = np.zeros(assignment.shape, np.float32)
    allowed = (assignment > 1).astype(np.float32)
    sigma = max(0.35, float(feather_px) * 0.65)
    for code in sorted(selected_codes):
        alpha = cv2.GaussianBlur((assignment == code).astype(np.float32), (0, 0), sigmaX=sigma, sigmaY=sigma)
        alpha *= allowed
        weighted += candidates[code].astype(np.float32) * alpha[:, :, None]
        alpha_sum += alpha
    mix = np.clip(alpha_sum, 0.0, 1.0)
    normalized = weighted / np.maximum(alpha_sum[:, :, None], 1e-6)
    output = base_float * (1.0 - mix[:, :, None]) + normalized * mix[:, :, None]
    output[alpha_sum <= 1e-6] = base_float[alpha_sum <= 1e-6]
    return np.clip(output, 0, 255).astype(np.uint8)


def decode_assignment(runs: list[list[int]], shape: tuple[int, int], codes: set[int]) -> np.ndarray:
    size = shape[0] * shape[1]
    if len(runs) > size:
        raise ValueError("像素來源資料過長")
    output = np.empty(size, dtype=np.uint16)
    cursor = 0
    for item in runs:
        if len(item) != 2:
            raise ValueError("像素來源必須是 [來源, 連續像素數]")
        code, count = item
        if code not in codes or count <= 0 or cursor + count > size:
            raise ValueError("像素來源代碼或長度無效")
        output[cursor:cursor + count] = code
        cursor += count
    if cursor != size:
        raise ValueError("像素來源圖與底圖尺寸不一致")
    return output.reshape(shape)


def encode_assignment(assignment: np.ndarray) -> list[list[int]]:
    flat = assignment.reshape(-1)
    if flat.size == 0:
        return []
    starts = np.r_[0, np.flatnonzero(flat[1:] != flat[:-1]) + 1]
    ends = np.r_[starts[1:], flat.size]
    return [[int(flat[start]), int(end - start)] for start, end in zip(starts, ends)]


class SavePage(BaseModel):
    revision: int = Field(ge=0)
    assignment_rle: list[list[int]]
    confirmed: bool = False
    settings: dict[str, int] | None = None


class RevisionRequest(BaseModel):
    revision: int = Field(ge=0)


class CompositionService:
    def __init__(self, store: Any, repository: Any):
        self.store, self.repository = store, repository

    def context(self, project_id: str, run_id: str) -> tuple[dict, dict, dict, Path]:
        try:
            project = self.store.read(project_id)
        except KeyError as exc:
            raise HTTPException(404, "項目不存在") from exc
        if project.get("state") == "deleting":
            raise HTTPException(409, "項目正在刪除")
        run = next((run for run in project.get("runs", []) if run["id"] == run_id), None)
        if run is None:
            raise HTTPException(404, "這個修復批次不屬於此項目")
        try:
            job = self.repository.read(run_id)
        except KeyError as exc:
            raise HTTPException(409, "修復批次資料缺失") from exc
        if str(job.state) != "completed" and not (str(job.state) == "failed" and job.partial_results_accepted):
            raise HTTPException(409, "請等待修復完成，或在失敗任務中選擇使用已有結果")
        root = self.store.project_dir(project_id)
        snapshot_path = self.store.asset_path(project_id, f"inputs/{run['snapshot_id']}/manifest.json")
        try:
            snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise HTTPException(409, "修復輸入快照缺失或無效") from exc
        return project, run, snapshot, root / "compositions" / run_id

    def page_assets(self, project_id: str, run: dict, snapshot: dict, page_id: str) -> tuple[np.ndarray, dict[int, np.ndarray], list[dict], bool]:
        page = next((page for page in snapshot["pages"] if page["page_id"] == page_id), None)
        if page is None:
            raise HTTPException(404, "快照中沒有此頁")
        try:
            base = read_rgb(self.store.asset_path(project_id, page["source"]))
            with Image.open(self.store.asset_path(project_id, page["mask"])) as mask_image:
                mask = np.asarray(mask_image.convert("L"))
            if mask.shape != base.shape[:2]:
                raise ValueError("底圖与 Mask 尺寸不同")
        except (OSError, ValueError) as exc:
            raise HTTPException(409, f"快照底圖或 Mask 損壞：{page['stem']}") from exc
        passthrough = not bool(np.any(mask >= 128))
        candidates, availability = {}, []
        codes = self.codes(run)
        for workflow, code in codes.items():
            path = self.repository.job_dir(run["id"]) / "inpaint_workflows" / workflow / f"{page['stem']}.png"
            error = None
            try:
                candidate = read_rgb(path)
                if candidate.shape != base.shape:
                    raise ValueError("尺寸不同，不能對齊合成")
                candidates[code] = candidate
            except (OSError, ValueError) as exc:
                error = "缺少候選圖片" if not path.is_file() else str(exc)
            availability.append({"workflow": workflow, "code": code, "available": error is None, "error": error})
        return base, candidates, availability, passthrough

    @staticmethod
    def codes(run: dict) -> dict[str, int]:
        return {name: index + 2 for index, name in enumerate(name for name in WORKFLOW_ORDER if name in run["workflows"])}

    def write(self, root: Path, state: dict) -> None:
        atomic_write(root / "selection.json", json.dumps(state, ensure_ascii=False, indent=2).encode("utf-8"))

    def initialize(self, project_id: str, run_id: str) -> tuple[dict, dict, dict, Path]:
        _, run, snapshot, root = self.context(project_id, run_id)
        path = root / "selection.json"
        if path.is_file():
            state = json.loads(path.read_text(encoding="utf-8"))
            if state["run_id"] != run_id or state["snapshot_id"] != run["snapshot_id"]:
                raise HTTPException(409, "合成記錄與修復快照不一致")
            return state, run, snapshot, root
        state = {"version": 1, "run_id": run_id, "snapshot_id": run["snapshot_id"], "revision": 0,
                 "workflow_codes": self.codes(run), "settings": dict(DEFAULT_SETTINGS), "pages": {}}
        for page in snapshot["pages"]:
            base, candidates, _, passthrough = self.page_assets(project_id, run, snapshot, page["page_id"])
            assignment = np.zeros(base.shape[:2], np.uint16)
            if not passthrough and candidates:
                code = next(iter(candidates))
                assignment[difference_mask(base, candidates[code], 12, 16, 5) > 0] = code
            relative = f"assignments/{page['stem']}.0.png"
            atomic_write(root / relative, png_bytes(assignment))
            state["pages"][page["page_id"]] = {"stem": page["stem"], "width": base.shape[1],
                    "height": base.shape[0], "assignment": relative, "confirmed": passthrough, "passthrough": passthrough, "initially_missing_candidates": not passthrough and not candidates}
        self.write(root, state)
        return state, run, snapshot, root

    @staticmethod
    def assignment(root: Path, page: dict) -> np.ndarray:
        relative = Path(page["assignment"])
        path = (root / relative).resolve()
        if relative.is_absolute() or not path.is_relative_to(root.resolve()):
            raise HTTPException(409, "像素來源圖路徑無效")
        try:
            with Image.open(path) as image:
                assignment = np.asarray(image).astype(np.uint16)
            if assignment.shape != (page["height"], page["width"]):
                raise ValueError("尺寸不一致")
            return assignment
        except (OSError, ValueError) as exc:
            raise HTTPException(409, "保存的像素來源圖缺失或損壞") from exc

    def describe(self, project_id: str, run_id: str) -> dict:
        state, run, snapshot, _ = self.initialize(project_id, run_id)
        result = {key: value for key, value in state.items() if key != "pages"}
        result["pages"] = []
        snapshot_pages = {page["page_id"]: page for page in snapshot["pages"]}
        for page_id, page in state["pages"].items():
            snapshot_page = snapshot_pages.get(page_id)
            if snapshot_page is None:
                raise HTTPException(409, "合成頁面不在修復快照中")
            expected_size = (page["width"], page["height"])
            # Metadata refresh runs after every brush save. Inspect headers only;
            # loading every page's full RGB buffers here scales with batch size.
            # The immutable snapshot supplied passthrough at initialization;
            # image/save/confirm/export still decode and validate actual pixels.
            try:
                for kind in ("source", "mask"):
                    with Image.open(self.store.asset_path(project_id, snapshot_page[kind])) as asset:
                        if asset.size != expected_size:
                            raise ValueError("快照尺寸不同")
            except (OSError, ValueError) as exc:
                raise HTTPException(409, f"快照底圖或 Mask 損壞：{page['stem']}") from exc
            candidates = []
            for workflow, code in self.codes(run).items():
                path = self.repository.job_dir(run_id) / "inpaint_workflows" / workflow / f"{page['stem']}.png"
                error = None
                try:
                    with Image.open(path) as candidate:
                        if candidate.size != expected_size:
                            raise ValueError("尺寸不同，不能對齊合成")
                except (OSError, ValueError) as exc:
                    error = "缺少候選圖片" if not path.is_file() else str(exc)
                candidates.append({"workflow": workflow, "code": code, "available": error is None, "error": error})
            url = f"/api/projects/{project_id}/compositions/{run_id}/pages/{page_id}/image"
            result["pages"].append({**page, "page_id": page_id, "candidates": candidates,
                                    "warnings": [f"{candidate['workflow']}：{candidate['error']}" for candidate in candidates if candidate["error"]]
                                    + (["此頁初次比較時沒有候選；補跑後請選擇新候選，既有合成不會自動更改。"] if page.get("initially_missing_candidates") and any(c["available"] for c in candidates) else []),
                                    "base_url": url + "?source=base", "preview_url": url + f"?source=preview&revision={state['revision']}",
                                    "assignment_url": url + f"?source=assignment&revision={state['revision']}"})
        return result

    @staticmethod
    def check_revision(state: dict, revision: int) -> None:
        if state["revision"] != revision:
            raise HTTPException(409, "合成版本已更新，請重新載入後保存")

    def save_page(self, project_id: str, run_id: str, page_id: str, request: SavePage) -> dict:
        state, run, snapshot, root = self.initialize(project_id, run_id)
        self.check_revision(state, request.revision)
        if page_id not in state["pages"]:
            raise HTTPException(404, "沒有此頁")
        page = state["pages"][page_id]
        base, candidates, _, passthrough = self.page_assets(project_id, run, snapshot, page_id)
        try:
            assignment = decode_assignment(request.assignment_rle, base.shape[:2], {0, 1, *state["workflow_codes"].values()})
            if passthrough and np.any(assignment > 1):
                raise ValueError("全黑 Mask 頁面應沿用底圖")
            compose_result(base, candidates, assignment, 0)
            if request.confirmed and not passthrough and not candidates:
                raise ValueError("此頁沒有可用候選，不能確認為完整成品")
            if request.settings is not None:
                limits = {"threshold": (1, 255), "min_area": (1, 1000000), "expand_px": (0, 100), "feather_px": (0, 100)}
                for key, value in request.settings.items():
                    if key not in limits or not limits[key][0] <= value <= limits[key][1]:
                        raise ValueError("差異或羽化參數無效")
                if request.settings.get("feather_px", state["settings"]["feather_px"]) != state["settings"]["feather_px"]:
                    for existing in state["pages"].values():
                        existing["confirmed"] = existing["passthrough"]
                state["settings"].update(request.settings)
            # Recomputing a difference mask does not erase saved decisions. Only
            # newly adopted pixels must be inside this candidate's current mask.
            previous = self.assignment(root, page)
            settings = state["settings"]
            for code, candidate in candidates.items():
                newly_selected = (assignment == code) & (previous != code)
                if np.any(newly_selected):
                    allowed = difference_mask(base, candidate, settings["threshold"], settings["min_area"], settings["expand_px"])
                    if np.any(newly_selected & (allowed == 0)):
                        raise ValueError("新採用區域超出此工作流的差異 Mask")
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        state["revision"] += 1
        relative = f"assignments/{page['stem']}.{state['revision']}.png"
        atomic_write(root / relative, png_bytes(assignment))
        page.update(assignment=relative, confirmed=passthrough or request.confirmed)
        self.write(root, state)
        return self.describe(project_id, run_id)

    def confirm(self, project_id: str, run_id: str, revision: int) -> dict:
        state, run, snapshot, root = self.initialize(project_id, run_id)
        self.check_revision(state, revision)
        for page_id, page in state["pages"].items():
            base, candidates, _, passthrough = self.page_assets(project_id, run, snapshot, page_id)
            if not passthrough and not candidates:
                raise HTTPException(409, f"{page['stem']} 缺少可用候選")
            try:
                compose_result(base, candidates, self.assignment(root, page), state["settings"]["feather_px"])
            except ValueError as exc:
                raise HTTPException(409, f"{page['stem']}：{exc}") from exc
        for page in state["pages"].values():
            page["confirmed"] = True
        state["revision"] += 1
        self.write(root, state)
        return self.describe(project_id, run_id)

    def image(self, project_id: str, run_id: str, page_id: str, source: str) -> bytes:
        state, run, snapshot, root = self.initialize(project_id, run_id)
        if page_id not in state["pages"]:
            raise HTTPException(404, "沒有此頁")
        page = state["pages"][page_id]
        base, candidates, _, _ = self.page_assets(project_id, run, snapshot, page_id)
        if source == "base":
            return png_bytes(base)
        assignment = self.assignment(root, page)
        if source == "assignment":
            return png_bytes(assignment)
        if source == "preview":
            try:
                return png_bytes(compose_result(base, candidates, assignment, state["settings"]["feather_px"]))
            except ValueError as exc:
                raise HTTPException(409, str(exc)) from exc
        workflow = source.removeprefix("diff:")
        code = state["workflow_codes"].get(workflow)
        if code not in candidates:
            raise HTTPException(409, "候選缺失或尺寸不符")
        if source.startswith("diff:"):
            settings = state["settings"]
            return png_bytes(difference_mask(base, candidates[code], settings["threshold"], settings["min_area"], settings["expand_px"]))
        return png_bytes(candidates[code])

    def export(self, project_id: str, run_id: str, revision: int) -> Path:
        state, run, snapshot, root = self.initialize(project_id, run_id)
        self.check_revision(state, revision)
        pending = [page["stem"] for page in state["pages"].values() if not page["confirmed"]]
        if pending:
            raise HTTPException(409, "仍有待確認頁面：" + "、".join(pending))
        export_root = self.store.project_dir(project_id) / "result" / run_id / str(revision)
        archive = export_root / "result.zip"
        temporary = export_root / f".{uuid.uuid4().hex}.zip"
        export_root.mkdir(parents=True, exist_ok=True)
        try:
            with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_STORED) as output:
                for page_id, page in state["pages"].items():
                    base, candidates, _, passthrough = self.page_assets(project_id, run, snapshot, page_id)
                    if not passthrough and not candidates:
                        raise HTTPException(409, f"{page['stem']} 缺少可用候選")
                    try:
                        result = compose_result(base, candidates, self.assignment(root, page), state["settings"]["feather_px"])
                    except ValueError as exc:
                        raise HTTPException(409, f"{page['stem']}：{exc}") from exc
                    content = png_bytes(result)
                    atomic_write(export_root / f"{page['stem']}.png", content)
                    output.writestr(f"{page['stem']}.png", content)
            os.replace(temporary, archive)
        finally:
            temporary.unlink(missing_ok=True)
        return archive


def build_composition_router(store: Any, repository: Any) -> APIRouter:
    router = APIRouter(prefix="/api/projects/{project_id}/compositions/{run_id}")
    service = CompositionService(store, repository)

    @router.get("")
    def get_composition(project_id: str, run_id: str):
        with store.lock(project_id):
            return service.describe(project_id, run_id)

    @router.get("/pages/{page_id}/image")
    def get_image(project_id: str, run_id: str, page_id: str, source: str = Query("preview")):
        with store.lock(project_id):
            content = service.image(project_id, run_id, page_id, source)
        return Response(content, media_type="image/png", headers={"Cache-Control": "no-store"})

    @router.get("/pages/{page_id}/assignment")
    def get_assignment(project_id: str, run_id: str, page_id: str):
        with store.lock(project_id):
            state, _, _, root = service.initialize(project_id, run_id)
            if page_id not in state["pages"]:
                raise HTTPException(404, "沒有此頁")
            return {"revision": state["revision"], "assignment_rle": encode_assignment(service.assignment(root, state["pages"][page_id]))}

    @router.put("/pages/{page_id}")
    def save_page(project_id: str, run_id: str, page_id: str, request: SavePage):
        with store.lock(project_id):
            return service.save_page(project_id, run_id, page_id, request)

    @router.post("/confirm")
    def confirm(project_id: str, run_id: str, request: RevisionRequest):
        with store.lock(project_id):
            return service.confirm(project_id, run_id, request.revision)

    @router.post("/export")
    def export(project_id: str, run_id: str, request: RevisionRequest):
        with store.lock(project_id):
            service.export(project_id, run_id, request.revision)
        return {"download_url": f"/api/projects/{project_id}/compositions/{run_id}/download?revision={request.revision}"}

    @router.get("/download")
    def download(project_id: str, run_id: str, revision: int = Query(ge=0)):
        # reader protects assets for the complete streaming lifetime; project locks
        # also serialize the initial existence check against deletion.
        reader = store.reader(project_id)
        reader.__enter__()
        try:
            with store.lock(project_id):
                service.context(project_id, run_id)
                path = store.project_dir(project_id) / "result" / run_id / str(revision) / "result.zip"
                if not path.is_file():
                    raise HTTPException(404, "請先導出此版本成品")
                handle = path.open("rb")
        except BaseException:
            reader.__exit__(None, None, None)
            raise

        closed = False

        def close():
            nonlocal closed
            if not closed:
                closed = True
                handle.close()
                reader.__exit__(None, None, None)

        def chunks():
            try:
                with handle:
                    while chunk := handle.read(1024 * 1024):
                        yield chunk
            finally:
                close()
        return StreamingResponse(chunks(), media_type="application/zip", headers={"Content-Disposition": 'attachment; filename="result.zip"'}, background=BackgroundTask(close))

    return router
