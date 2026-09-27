"""Persistent comparison across completed project repair runs.

Candidate codes are append-only: a new run never changes saved uint16 assignments.
The frozen base is stored for every project page, including pages omitted by an
initial partial run. Each run's snapshot source must match that base by RGB pixels.
"""
from __future__ import annotations

import json
import os
import re
import uuid
import zipfile
from pathlib import Path
from typing import Any

import numpy as np
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response, StreamingResponse
from PIL import Image
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

from .composition import (DEFAULT_SETTINGS, RevisionRequest, SavePage, atomic_write,
                          compose_result, decode_assignment, difference_mask,
                          encode_assignment, png_bytes, read_rgb)
from .projects import digest_file
from .composition import WORKFLOW_ORDER


class SelectCandidate(BaseModel):
    revision: int = Field(ge=0)
    selected: bool


class RoundCompositionService:
    def __init__(self, store: Any, repository: Any):
        self.store, self.repository = store, repository

    def context(self, project_id: str) -> tuple[dict, Path]:
        try:
            project = self.store.read(project_id)
        except KeyError as exc:
            raise HTTPException(404, "項目不存在") from exc
        if project.get("state") == "deleting":
            raise HTTPException(409, "項目正在刪除")
        return project, self.store.project_dir(project_id) / "compositions" / "rounds"

    def eligible_runs(self, project: dict) -> list[dict]:
        runs = []
        for run in project.get("runs", []):
            if not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", run["id"]):
                raise HTTPException(409, "修復輪次 ID 無效")
            try:
                job = self.repository.read(run["id"])
            except KeyError:
                continue
            if str(job.state) == "completed" or (str(job.state) == "failed" and job.partial_results_accepted):
                runs.append(run)
        return runs

    def snapshot(self, project_id: str, run: dict) -> dict:
        try:
            path = self.store.asset_path(project_id, f"inputs/{run['snapshot_id']}/manifest.json")
            snapshot = json.loads(path.read_text(encoding="utf-8"))
            if snapshot["id"] != run["snapshot_id"]:
                raise ValueError("snapshot id mismatch")
            return snapshot
        except (OSError, ValueError, KeyError) as exc:
            raise HTTPException(409, f"修復輸入快照缺失或無效：{run['id']}") from exc

    @staticmethod
    def write(root: Path, state: dict) -> None:
        atomic_write(root / "selection.json", json.dumps(state, ensure_ascii=False, indent=2).encode("utf-8"))

    @staticmethod
    def check_revision(state: dict, revision: int) -> None:
        if state["revision"] != revision:
            raise HTTPException(409, "合成版本已更新，請重新載入後保存")

    @staticmethod
    def validate_state(state: dict, project: dict) -> None:
        try:
            runs = {run["id"]: run for run in project.get("runs", [])}
            codes = state["workflow_codes"]
            if len(set(codes.values())) != len(codes) or any(type(code) is not int or not 2 <= code <= 65535 for code in codes.values()):
                raise ValueError("candidate codes")
            if len(state["candidates"]) != len(codes):
                raise ValueError("candidate count")
            for candidate in state["candidates"]:
                run_id = candidate["run_id"]
                workflow = candidate["workflow"]
                run = runs.get(run_id)
                if (not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", run_id) or run is None
                        or workflow not in WORKFLOW_ORDER or workflow not in run["workflows"]
                        or candidate["snapshot_id"] != run["snapshot_id"]
                        or codes.get(f"{run_id}:{workflow}") != candidate["code"]
                        or type(candidate["selected"]) is not bool
                        or not set(candidate["page_errors"]) <= set(state["pages"])):
                    raise ValueError("candidate reference")
            project_pages = {item["id"]: item for item in project["pages"]}
            for page_id, page in state["pages"].items():
                project_page = project_pages[page_id]
                if (page["base"] != f"base/{page_id}.png"
                        or page["mask"] not in (None, f"masks/{page_id}.png")
                        or not re.fullmatch(rf"assignments/{re.escape(page_id)}\.\d+\.png", page["assignment"])
                        or page["stem"] != project_page["stem"]
                        or (page["width"], page["height"]) != (project_page["width"], project_page["height"])):
                    raise ValueError("page asset reference")
        except (TypeError, KeyError, ValueError) as exc:
            raise HTTPException(409, "輪次合成記錄引用無效") from exc

    def _freeze_page(self, project_id: str, page: dict, runs: list[dict], root: Path) -> dict:
        source = mask = None
        for run in runs:
            item = next((item for item in self.snapshot(project_id, run)["pages"] if item["page_id"] == page["id"]), None)
            if item:
                source = self.store.asset_path(project_id, item["source"])
                mask = self.store.asset_path(project_id, item["mask"])
                break
        try:
            if source is not None:
                base = read_rgb(source)
                with Image.open(mask) as image:
                    frozen_mask = np.asarray(image.convert("L")).copy()
                mask_ready = True
            else:
                with Image.open(self.store.asset_path(project_id, page["source"])) as image:
                    original = image.convert("RGBA")
                with Image.open(self.store.asset_path(project_id, page["overlay"])) as image:
                    overlay = image.convert("RGBA")
                base = np.asarray(Image.alpha_composite(original, overlay).convert("RGB")).copy()
                mask_ready = bool(page.get("mask_ready"))
                if mask_ready:
                    with Image.open(self.store.asset_path(project_id, page["other"])) as image:
                        frozen_mask = np.asarray(image.convert("L")).copy()
                else:
                    frozen_mask = None
            if base.shape[:2] != (page["height"], page["width"]):
                raise ValueError("底圖尺寸不同")
            if frozen_mask is not None and frozen_mask.shape != base.shape[:2]:
                raise ValueError("Mask 尺寸不同")
        except (OSError, ValueError) as exc:
            raise HTTPException(409, f"無法凍結項目底圖：{page['stem']}") from exc
        base_rel = f"base/{page['id']}.png"
        mask_rel = f"masks/{page['id']}.png" if frozen_mask is not None else None
        atomic_write(root / base_rel, png_bytes(base))
        if mask_rel is not None:
            atomic_write(root / mask_rel, png_bytes(frozen_mask))
        assignment_rel = f"assignments/{page['id']}.0.png"
        atomic_write(root / assignment_rel, png_bytes(np.zeros(base.shape[:2], np.uint16)))
        passthrough = frozen_mask is not None and not bool(np.any(frozen_mask >= 128))
        return {"stem": page["stem"], "width": page["width"], "height": page["height"],
                "base": base_rel, "mask": mask_rel, "base_sha256": digest_file(root / base_rel),
                "assignment": assignment_rel, "confirmed": passthrough,
                "passthrough": passthrough, "mask_ready": mask_ready}

    def initialize(self, project_id: str) -> tuple[dict, dict, Path]:
        project, root = self.context(project_id)
        runs = self.eligible_runs(project)
        path = root / "selection.json"
        fresh = not path.is_file()
        if not fresh:
            try:
                state = json.loads(path.read_text(encoding="utf-8"))
                if state["version"] != 2 or set(state["pages"]) != {p["id"] for p in project["pages"]}:
                    raise ValueError("state/project mismatch")
            except (OSError, ValueError, KeyError) as exc:
                raise HTTPException(409, "輪次合成記錄損壞或項目頁面已變更") from exc
            self.validate_state(state, project)
        else:
            if not runs:
                raise HTTPException(409, "尚無已完成的修復輪次")
            state = {"version": 2, "revision": 0, "settings": dict(DEFAULT_SETTINGS),
                     "workflow_codes": {}, "candidates": [], "pages": {}}
            for page in project["pages"]:
                state["pages"][page["id"]] = self._freeze_page(project_id, page, runs, root)
            self.write(root, state)
        changed = self._append_runs(project_id, state, runs, root)
        if fresh:
            for page_id, page in state["pages"].items():
                if page["passthrough"]:
                    continue
                base, candidates, _ = self.page_assets(project_id, state, root, page_id)
                if candidates:
                    code = next(iter(candidates))
                    assignment = np.zeros(base.shape[:2], np.uint16)
                    settings = state["settings"]
                    assignment[difference_mask(base, candidates[code], settings["threshold"], settings["min_area"], settings["expand_px"]) > 0] = code
                    atomic_write(root / page["assignment"], png_bytes(assignment))
        if changed:
            self.write(root, state)
        return state, project, root

    def _append_runs(self, project_id: str, state: dict, runs: list[dict], root: Path) -> bool:
        changed = False
        for run in runs:
            if all(f"{run['id']}:{workflow}" in state["workflow_codes"] for workflow in run["workflows"]):
                continue
            snapshot = self.snapshot(project_id, run)
            snapshot_pages = {page["page_id"]: page for page in snapshot["pages"]}
            compatibility: dict[str, str | None] = {}
            for page_id, item in snapshot_pages.items():
                if page_id not in state["pages"]:
                    raise HTTPException(409, "修復快照包含未知項目頁面")
                frozen = state["pages"][page_id]
                try:
                    if item["stem"] != frozen["stem"]:
                        raise ValueError("快照頁面檔名不同")
                    source = self.store.asset_path(project_id, item["source"])
                    with Image.open(source) as image:
                        size = image.size
                    if size != (frozen["width"], frozen["height"]):
                        raise ValueError("快照底圖尺寸不同")
                    if digest_file(source) != frozen["base_sha256"]:
                        # PNG encoders may vary; compare normalized pixels below.
                        if not np.array_equal(read_rgb(source), read_rgb(root / frozen["base"])):
                            raise ValueError("快照底圖與凍結底圖不同")
                    compatibility[page_id] = None
                    if frozen["passthrough"]:
                        with Image.open(self.store.asset_path(project_id, item["mask"])) as mask:
                            if mask.size != (frozen["width"], frozen["height"]):
                                raise ValueError("快照 Mask 尺寸不同")
                            has_edit_pixels = mask.convert("L").getbbox() is not None
                        if has_edit_pixels:
                            frozen["passthrough"] = False
                            frozen["confirmed"] = False
                            changed = True
                except (OSError, ValueError) as exc:
                    compatibility[page_id] = str(exc)
            for workflow in run["workflows"]:
                key = f"{run['id']}:{workflow}"
                if key in state["workflow_codes"]:
                    continue
                code = max(state["workflow_codes"].values(), default=1) + 1
                if code > 65535:
                    raise HTTPException(409, "候選來源數量超過 uint16 上限")
                state["workflow_codes"][key] = code
                state["candidates"].append({"run_id": run["id"], "workflow": workflow,
                                           "code": code, "selected": True,
                                           "snapshot_id": run["snapshot_id"],
                                           "page_errors": {page_id: error for page_id, error in compatibility.items() if error}})
                changed = True
        return changed

    @staticmethod
    def assignment(root: Path, page: dict) -> np.ndarray:
        relative = Path(page["assignment"])
        path = (root / relative).resolve()
        if relative.is_absolute() or not path.is_relative_to(root.resolve()):
            raise HTTPException(409, "像素來源圖路徑無效")
        try:
            with Image.open(path) as image:
                value = np.asarray(image).astype(np.uint16)
            if value.shape != (page["height"], page["width"]):
                raise ValueError("尺寸不同")
            return value
        except (OSError, ValueError) as exc:
            raise HTTPException(409, "保存的像素來源圖缺失或損壞") from exc

    def _candidate_status(self, project_id: str, candidate: dict, page_id: str, page: dict, *, decode: bool = False) -> tuple[dict, np.ndarray | None]:
        error = candidate["page_errors"].get(page_id)
        run = {"id": candidate["run_id"], "snapshot_id": candidate["snapshot_id"]}
        snapshot_page = next((item for item in self.snapshot(project_id, run)["pages"] if item["page_id"] == page_id), None)
        if snapshot_page is None:
            error = "此輪次沒有選擇本頁"
        try:
            job = self.repository.read(candidate["run_id"])
            if str(job.state) != "completed" and not (str(job.state) == "failed" and job.partial_results_accepted):
                error = "此輪次尚未完成或未接受部分結果"
        except KeyError:
            error = "輪次任務資料缺失"
        path = self.repository.job_dir(candidate["run_id"]) / "inpaint_workflows" / candidate["workflow"] / f"{page['stem']}.png"
        image = None
        if error is None:
            try:
                source = self.store.asset_path(project_id, snapshot_page["source"])
                with Image.open(source) as source_image:
                    if source_image.size != (page["width"], page["height"]):
                        raise ValueError("快照底圖尺寸不同")
                if digest_file(source) != snapshot_page["source_sha256"]:
                    raise ValueError("快照底圖已變更")
                with Image.open(path) as asset:
                    if asset.size != (page["width"], page["height"]):
                        raise ValueError("候選圖片尺寸不同")
                if decode:
                    if not np.array_equal(read_rgb(source), read_rgb(self.store.project_dir(project_id) / "compositions" / "rounds" / page["base"])):
                        raise ValueError("快照底圖與凍結底圖不同")
                    image = read_rgb(path)
            except (OSError, ValueError) as exc:
                error = "缺少候選圖片" if not path.is_file() else str(exc)
        return {"run_id": candidate["run_id"], "workflow": candidate["workflow"],
                "code": candidate["code"], "selected": candidate["selected"],
                "available": error is None, "error": error}, image

    def page_assets(self, project_id: str, state: dict, root: Path, page_id: str) -> tuple[np.ndarray, dict[int, np.ndarray], list[dict]]:
        page = state["pages"].get(page_id)
        if page is None:
            raise HTTPException(404, "沒有此頁")
        try:
            base = read_rgb(root / page["base"])
            if base.shape[:2] != (page["height"], page["width"]) or digest_file(root / page["base"]) != page["base_sha256"]:
                raise ValueError("凍結底圖損壞")
            if page["mask"] is not None:
                with Image.open(root / page["mask"]) as mask:
                    if mask.size != (page["width"], page["height"]):
                        raise ValueError("凍結 Mask 尺寸不同")
        except (OSError, ValueError) as exc:
            raise HTTPException(409, f"凍結底圖或 Mask 損壞：{page['stem']}") from exc
        candidates, statuses = {}, []
        for candidate in state["candidates"]:
            status, image = self._candidate_status(project_id, candidate, page_id, page, decode=True)
            statuses.append(status)
            if image is not None:
                candidates[candidate["code"]] = image
        return base, candidates, statuses

    def describe(self, project_id: str) -> dict:
        state, project, root = self.initialize(project_id)
        result = {key: value for key, value in state.items() if key not in ("pages", "candidates")}
        result["candidates"] = [dict(candidate) for candidate in state["candidates"]]
        for candidate in result["candidates"]:
            run = {"id": candidate["run_id"], "snapshot_id": candidate["snapshot_id"]}
            candidate["target_count"] = len(self.snapshot(project_id, run)["pages"])
            candidate["available_count"] = 0
        result["pages"] = []
        for item in project["pages"]:
            page_id = item["id"]
            page = state["pages"][page_id]
            try:
                with Image.open(root / page["base"]) as image:
                    if image.size != (page["width"], page["height"]):
                        raise ValueError("尺寸不同")
                if digest_file(root / page["base"]) != page["base_sha256"]:
                    raise ValueError("底圖內容已變更")
            except (OSError, ValueError) as exc:
                raise HTTPException(409, f"凍結底圖損壞：{page['stem']}") from exc
            candidates = [self._candidate_status(project_id, candidate, page_id, page)[0] for candidate in state["candidates"]]
            for candidate, status in zip(result["candidates"], candidates):
                candidate["available_count"] += int(status["available"])
            url = f"/api/projects/{project_id}/round-composition/pages/{page_id}/image"
            result["pages"].append({**page, "page_id": page_id, "candidates": candidates,
                                    "warnings": [f"{c['workflow']} ({c['run_id']})：{c['error']}" for c in candidates if c["error"]],
                                    "base_url": url + "?source=base",
                                    "preview_url": url + f"?source=preview&revision={state['revision']}",
                                    "assignment_url": url + f"?source=assignment&revision={state['revision']}"})
        return result

    def select_candidate(self, project_id: str, code: int, request: SelectCandidate) -> dict:
        state, _, root = self.initialize(project_id)
        self.check_revision(state, request.revision)
        candidate = next((item for item in state["candidates"] if item["code"] == code), None)
        if candidate is None:
            raise HTTPException(404, "沒有此輪次候選")
        if candidate["selected"] != request.selected:
            candidate["selected"] = request.selected
            state["revision"] += 1
            self.write(root, state)
        return self.describe(project_id)

    def save_page(self, project_id: str, page_id: str, request: SavePage) -> dict:
        state, _, root = self.initialize(project_id)
        self.check_revision(state, request.revision)
        page = state["pages"].get(page_id)
        if page is None:
            raise HTTPException(404, "沒有此頁")
        base, candidates, _ = self.page_assets(project_id, state, root, page_id)
        try:
            assignment = decode_assignment(request.assignment_rle, base.shape[:2], {0, 1, *state["workflow_codes"].values()})
            if page["passthrough"] and np.any(assignment > 1):
                raise ValueError("全黑 Mask 頁面應沿用底圖")
            compose_result(base, candidates, assignment, 0)
            if request.confirmed and not page["passthrough"] and not candidates:
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
            previous = self.assignment(root, page)
            settings = state["settings"]
            for code, candidate in candidates.items():
                newly_selected = (assignment == code) & (previous != code)
                if np.any(newly_selected):
                    allowed = difference_mask(base, candidate, settings["threshold"], settings["min_area"], settings["expand_px"])
                    if np.any(newly_selected & (allowed == 0)):
                        raise ValueError("新採用區域超出此候選的差異 Mask")
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        state["revision"] += 1
        relative = f"assignments/{page_id}.{state['revision']}.png"
        atomic_write(root / relative, png_bytes(assignment))
        page.update(assignment=relative, confirmed=page["passthrough"] or request.confirmed)
        self.write(root, state)
        return self.describe(project_id)

    def confirm(self, project_id: str, revision: int) -> dict:
        state, _, root = self.initialize(project_id)
        self.check_revision(state, revision)
        for page_id, page in state["pages"].items():
            base, candidates, _ = self.page_assets(project_id, state, root, page_id)
            if not page["passthrough"] and not candidates:
                raise HTTPException(409, f"{page['stem']} 缺少可用候選")
            try:
                compose_result(base, candidates, self.assignment(root, page), state["settings"]["feather_px"])
            except ValueError as exc:
                raise HTTPException(409, f"{page['stem']}：{exc}") from exc
        for page in state["pages"].values():
            page["confirmed"] = True
        state["revision"] += 1
        self.write(root, state)
        return self.describe(project_id)

    def image(self, project_id: str, page_id: str, source: str) -> bytes:
        state, _, root = self.initialize(project_id)
        if page_id not in state["pages"]:
            raise HTTPException(404, "沒有此頁")
        if source == "assignment":
            return png_bytes(self.assignment(root, state["pages"][page_id]))
        base, candidates, _ = self.page_assets(project_id, state, root, page_id)
        if source == "base":
            return png_bytes(base)
        if source == "preview":
            try:
                return png_bytes(compose_result(base, candidates, self.assignment(root, state["pages"][page_id]), state["settings"]["feather_px"]))
            except ValueError as exc:
                raise HTTPException(409, str(exc)) from exc
        kind, _, code_text = source.partition(":")
        try:
            code = int(code_text)
        except ValueError as exc:
            raise HTTPException(400, "無效圖片來源") from exc
        if kind not in ("candidate", "diff") or code not in candidates:
            raise HTTPException(409, "候選缺失或尺寸不符")
        if kind == "candidate":
            return png_bytes(candidates[code])
        settings = state["settings"]
        return png_bytes(difference_mask(base, candidates[code], settings["threshold"], settings["min_area"], settings["expand_px"]))

    def export(self, project_id: str, revision: int) -> Path:
        state, project, root = self.initialize(project_id)
        self.check_revision(state, revision)
        pending = [page["stem"] for page in state["pages"].values() if not page["confirmed"]]
        if pending:
            raise HTTPException(409, "仍有待確認頁面：" + "、".join(pending))
        export_root = self.store.project_dir(project_id) / "result" / "rounds" / str(revision)
        archive = export_root / "result.zip"
        temporary = export_root / f".{uuid.uuid4().hex}.zip"
        export_root.mkdir(parents=True, exist_ok=True)
        try:
            with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_STORED) as output:
                for item in project["pages"]:
                    page_id = item["id"]
                    page = state["pages"][page_id]
                    base, candidates, _ = self.page_assets(project_id, state, root, page_id)
                    if not page["passthrough"] and not candidates:
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


def build_round_composition_router(store: Any, repository: Any) -> APIRouter:
    router = APIRouter(prefix="/api/projects/{project_id}/round-composition")
    service = RoundCompositionService(store, repository)

    @router.get("")
    def get_composition(project_id: str):
        with store.lock(project_id):
            return service.describe(project_id)

    @router.put("/candidates/{code}")
    def select_candidate(project_id: str, code: int, request: SelectCandidate):
        with store.lock(project_id):
            return service.select_candidate(project_id, code, request)

    @router.get("/pages/{page_id}/image")
    def get_image(project_id: str, page_id: str, source: str = Query("preview")):
        with store.lock(project_id):
            content = service.image(project_id, page_id, source)
        return Response(content, media_type="image/png", headers={"Cache-Control": "no-store"})

    @router.get("/pages/{page_id}/assignment")
    def get_assignment(project_id: str, page_id: str):
        with store.lock(project_id):
            state, _, root = service.initialize(project_id)
            if page_id not in state["pages"]:
                raise HTTPException(404, "沒有此頁")
            return {"revision": state["revision"], "assignment_rle": encode_assignment(service.assignment(root, state["pages"][page_id]))}

    @router.put("/pages/{page_id}")
    def save_page(project_id: str, page_id: str, request: SavePage):
        with store.lock(project_id):
            return service.save_page(project_id, page_id, request)

    @router.post("/confirm")
    def confirm(project_id: str, request: RevisionRequest):
        with store.lock(project_id):
            return service.confirm(project_id, request.revision)

    @router.post("/export")
    def export(project_id: str, request: RevisionRequest):
        with store.lock(project_id):
            service.export(project_id, request.revision)
        return {"download_url": f"/api/projects/{project_id}/round-composition/download?revision={request.revision}"}

    @router.get("/download")
    def download(project_id: str, revision: int = Query(ge=0)):
        reader = store.reader(project_id)
        reader.__enter__()
        try:
            with store.lock(project_id):
                service.context(project_id)
                path = store.project_dir(project_id) / "result" / "rounds" / str(revision) / "result.zip"
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
