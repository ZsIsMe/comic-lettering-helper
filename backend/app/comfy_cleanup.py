"""Conservative inventory and deletion of image copies under ComfyUI staging roots."""
from __future__ import annotations

import os
import json
import socket
import stat
import urllib.error
import urllib.request
import uuid
from datetime import date, datetime, time, timezone
from pathlib import Path, PurePosixPath
from typing import Literal

from fastapi import APIRouter, Body, HTTPException, Request
from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask

from .request_security import same_page_request
from .schemas import JobRecord, JobState


IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}
ACTIVE_STATES = {JobState.queued, JobState.validating, JobState.running, JobState.packaging, JobState.abandoning}
ROOT_NAMES = ("input", "output", "temp")
WORKFLOW_PREFIXES = {"firered": "firered", "qwen2511_lanpaint": "qwen", "flux2klein_lanpaint": "flux"}


class CleanupConflict(RuntimeError):
    pass


class UnsafePath(ValueError):
    pass


def _batch_name(job_id: str) -> str:
    return f"web_{job_id.replace('-', '')[:12]}"


def _parse_day(value: str | None, *, end: bool) -> float | None:
    if not value:
        return None
    parsed = date.fromisoformat(value)
    boundary = datetime.combine(parsed, time.max if end else time.min, tzinfo=timezone.utc)
    return boundary.timestamp()


class ComfyCleanup:
    def __init__(self, settings, repository, manager) -> None:
        self.settings = settings
        self.repository = repository
        self.manager = manager

    @property
    def roots(self) -> dict[str, Path]:
        return {
            "input": self.settings.comfy_input,
            "output": self.settings.comfy_output,
            "temp": self.settings.comfy_root / "temp",
        }

    def _records(self) -> tuple[dict[str, JobRecord], set[str]]:
        by_batch: dict[str, JobRecord] = {}
        ambiguous: set[str] = set()
        for record in self.repository.list(limit=None):
            batch = _batch_name(record.id)
            if batch in by_batch:
                ambiguous.add(batch)
            else:
                by_batch[batch] = record
        for batch in ambiguous:
            by_batch.pop(batch, None)
        return by_batch, ambiguous

    def _owner(self, root_name: str, relative: str, records: dict[str, JobRecord]) -> JobRecord | None:
        parts = PurePosixPath(relative).parts
        if not parts:
            return None
        name = parts[-1]
        for batch, record in records.items():
            if root_name == "input" and (parts[0] == batch or name.startswith(f"{batch}_")):
                return record
            if root_name in {"output", "temp"}:
                prefixes = [f"{batch}_{WORKFLOW_PREFIXES[workflow]}_" for workflow in record.workflows]
                if parts[0] == batch or any(name.startswith(prefix) for prefix in prefixes):
                    return record
        return None

    def _products_saved(self, record: JobRecord) -> bool:
        if record.state != JobState.completed or not record.download_ready:
            return False
        root = self.repository.job_dir(record.id) / "inpaint_workflows"
        for workflow in record.workflows:
            names = record.results.get(workflow, [])
            if len(names) != record.pair_count:
                return False
            for name in names:
                path = root / workflow / name
                if path.is_symlink() or not path.is_file():
                    return False
        return True

    def _item(self, root_name: str, root: Path, path: Path, records: dict[str, JobRecord]) -> dict | None:
        try:
            relative = path.relative_to(root).as_posix()
            info = self._stat_no_links(root_name, relative)
        except (FileNotFoundError, UnsafePath, ValueError):
            return None
        if not stat.S_ISREG(info.st_mode) or path.suffix.lower() not in IMAGE_SUFFIXES:
            return None
        owner = self._owner(root_name, relative, records)
        saved = bool(owner and self._products_saved(owner))
        category = "web_safe" if saved else "web_protected" if owner else "unknown"
        return {
            "root": root_name,
            "path": relative,
            "name": path.name,
            "bytes": info.st_size,
            "modified_at": datetime.fromtimestamp(info.st_mtime, timezone.utc).isoformat(),
            "category": category,
            "job_id": owner.id if owner else None,
            "job_name": owner.name if owner else None,
            "signature": {
                "device": info.st_dev,
                "inode": info.st_ino,
                "size": info.st_size,
                "mtime_ns": info.st_mtime_ns,
            },
        }

    def scan(self, unknown_after: str | None = None, unknown_before: str | None = None) -> dict:
        after = _parse_day(unknown_after, end=False)
        before = _parse_day(unknown_before, end=True)
        records, _ = self._records()
        items: list[dict] = []
        summary = {name: {
            "files": 0, "bytes": 0,
            "web_safe": 0, "web_safe_bytes": 0,
            "web_protected": 0, "web_protected_bytes": 0,
            "unknown": 0, "unknown_bytes": 0,
        } for name in ROOT_NAMES}
        for root_name, root in self.roots.items():
            if root.is_symlink() or not root.is_dir():
                continue
            for directory, dirs, files in os.walk(root, followlinks=False):
                base = Path(directory)
                dirs[:] = [name for name in dirs if not (base / name).is_symlink()]
                for name in files:
                    item = self._item(root_name, root, base / name, records)
                    if item is None:
                        continue
                    bucket = summary[root_name]
                    bucket["files"] += 1
                    bucket["bytes"] += item["bytes"]
                    bucket[item["category"]] += 1
                    bucket[f"{item['category']}_bytes"] += item["bytes"]
                    stamp = datetime.fromisoformat(item["modified_at"]).timestamp()
                    if item["category"] != "unknown" or ((after is None or stamp >= after) and (before is None or stamp <= before)):
                        items.append(item)
        busy = self.manager.gpu_gate.owner is not None or self._has_active_jobs()
        return {"busy": busy, "summary": summary, "items": items}

    def _has_active_jobs(self) -> bool:
        return bool(getattr(self.manager, "active_job_id", None)) or any(
            record.state in ACTIVE_STATES for record in self.repository.list(limit=None)
        )

    def _claim(self) -> str:
        owner = f"comfy-cleanup:{uuid.uuid4().hex}"
        self._assert_comfy_queue_idle()
        if self._has_active_jobs() or not self.manager.gpu_gate.claim(owner):
            raise CleanupConflict("GPU 或修復佇列仍在運行，暫停清理")
        if self._has_active_jobs():
            self.manager.gpu_gate.release(owner)
            raise CleanupConflict("修復佇列狀態已改變，暫停清理")
        try:
            self._assert_comfy_queue_idle()
        except BaseException:
            self.manager.gpu_gate.release(owner)
            raise
        return owner

    def _assert_comfy_queue_idle(self) -> None:
        try:
            with urllib.request.urlopen(f"{self.settings.comfy_url}/queue", timeout=2) as response:
                payload = json.load(response)
        except urllib.error.URLError as exc:
            reason = exc.reason
            if isinstance(reason, ConnectionRefusedError):
                return  # A stopped local ComfyUI cannot be writing staging images.
            raise CleanupConflict("無法確認 ComfyUI 佇列狀態，已取消清理") from exc
        except (TimeoutError, socket.timeout, OSError, ValueError, json.JSONDecodeError) as exc:
            raise CleanupConflict("無法確認 ComfyUI 佇列狀態，已取消清理") from exc
        if not isinstance(payload, dict) or not isinstance(payload.get("queue_running"), list) or not isinstance(payload.get("queue_pending"), list):
            raise CleanupConflict("ComfyUI 佇列回應格式不明，已取消清理")
        if payload["queue_running"] or payload["queue_pending"]:
            raise CleanupConflict("ComfyUI 尚有手動或網頁任務，暫停清理")

    def _relative(self, root_name: str, value: str) -> tuple[Path, tuple[str, ...]]:
        if root_name not in self.roots:
            raise UnsafePath("清理根目錄無效")
        relative = PurePosixPath(value)
        if relative.is_absolute() or not relative.parts or any(part in {"", ".", ".."} for part in relative.parts):
            raise UnsafePath("圖片相對路徑無效")
        if relative.suffix.lower() not in IMAGE_SUFFIXES:
            raise UnsafePath("只允許清理圖片檔案")
        root = self.roots[root_name]
        if root.is_symlink() or not root.is_dir():
            raise UnsafePath("清理根目錄不存在或不安全")
        return root, relative.parts

    def _stat_no_links(self, root_name: str, value: str) -> os.stat_result:
        root, parts = self._relative(root_name, value)
        root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        current = root_fd
        try:
            for part in parts[:-1]:
                next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
                if current != root_fd:
                    os.close(current)
                current = next_fd
            file_fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=current)
            try:
                info = os.fstat(file_fd)
                if not stat.S_ISREG(info.st_mode):
                    raise UnsafePath("目標不是一般圖片檔案")
                return info
            finally:
                os.close(file_fd)
        except OSError as exc:
            raise UnsafePath("圖片已移動、刪除或路徑不安全") from exc
        finally:
            if current != root_fd:
                os.close(current)
            os.close(root_fd)

    def open_preview(self, root_name: str, value: str):
        root, parts = self._relative(root_name, value)
        root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        current = root_fd
        try:
            for part in parts[:-1]:
                next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
                if current != root_fd:
                    os.close(current)
                current = next_fd
            file_fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=current)
            info = os.fstat(file_fd)
            if not stat.S_ISREG(info.st_mode):
                os.close(file_fd)
                raise UnsafePath("目標不是一般圖片檔案")
            return os.fdopen(file_fd, "rb")
        except OSError as exc:
            raise UnsafePath("圖片已移動、刪除或路徑不安全") from exc
        finally:
            if current != root_fd:
                os.close(current)
            os.close(root_fd)

    @staticmethod
    def _same_signature(info: os.stat_result, signature: dict) -> bool:
        expected = (signature.get("device"), signature.get("inode"), signature.get("size"), signature.get("mtime_ns"))
        return expected == (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)

    def _unlink(self, item: dict) -> int:
        self._assert_comfy_queue_idle()
        root_name, value = item.get("root"), item.get("path")
        root, parts = self._relative(root_name, value)
        root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        current = root_fd
        try:
            for part in parts[:-1]:
                next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
                if current != root_fd:
                    os.close(current)
                current = next_fd
            file_fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=current)
            try:
                info = os.fstat(file_fd)
                if not stat.S_ISREG(info.st_mode) or not self._same_signature(info, item.get("signature") or {}):
                    raise CleanupConflict(f"圖片已變更，未刪除：{value}")
            finally:
                os.close(file_fd)
            current_info = os.stat(parts[-1], dir_fd=current, follow_symlinks=False)
            if not self._same_signature(current_info, item.get("signature") or {}):
                raise CleanupConflict(f"圖片已變更，未刪除：{value}")
            os.unlink(parts[-1], dir_fd=current)
            return info.st_size
        except FileNotFoundError as exc:
            raise CleanupConflict(f"圖片已不存在，請重新掃描：{value}") from exc
        except OSError as exc:
            if isinstance(exc, CleanupConflict):
                raise
            raise UnsafePath(f"無法安全刪除圖片：{value}") from exc
        finally:
            if current != root_fd:
                os.close(current)
            os.close(root_fd)

    def delete(self, scope: Literal["safe", "selected"], selected: list[dict]) -> dict:
        owner = self._claim()
        try:
            current = self.scan()["items"]
            current_by_key = {(item["root"], item["path"]): item for item in current}
            if not selected:
                raise ValueError("請先重新掃描並選擇要刪除的圖片")
            targets = []
            seen = set()
            expected_category = "web_safe" if scope == "safe" else "unknown"
            for requested in selected:
                key = (requested.get("root"), requested.get("path"))
                if key in seen:
                    raise ValueError("清理清單含重複圖片")
                seen.add(key)
                item = current_by_key.get(key)
                if item is None:
                    raise CleanupConflict("清理清單已改變，請重新掃描")
                if item["category"] != expected_category:
                    message = "未完成任務的網頁副本禁止手動清理" if item["category"] == "web_protected" else "圖片分類已改變，請重新掃描"
                    raise CleanupConflict(message)
                if item["signature"] != requested.get("signature"):
                    raise CleanupConflict(f"圖片已變更，未刪除：{item['path']}")
                targets.append(item)
            return self._delete_many(targets)
        finally:
            self.manager.gpu_gate.release(owner)

    def _delete_many(self, targets) -> dict:
        deleted_files = 0
        deleted_bytes = 0
        try:
            for item in targets:
                deleted_bytes += self._unlink(item)
                deleted_files += 1
        except (CleanupConflict, UnsafePath) as exc:
            if deleted_files:
                raise CleanupConflict(
                    f"已刪除 {deleted_files} 張（{deleted_bytes} bytes）後停止：{exc}；未完成的項目與清單已保留，可重新掃描後重試"
                ) from exc
            raise
        return {"deleted_files": deleted_files, "deleted_bytes": deleted_bytes}

    def delete_project_jobs(self, records: list[JobRecord]) -> dict:
        """Delete only filenames derived from exact owned job IDs; never infer ownership by page stem."""
        if not records:
            return {"deleted_files": 0, "deleted_bytes": 0}
        all_records, ambiguous = self._records()
        if any(_batch_name(record.id) in ambiguous or all_records.get(_batch_name(record.id), record).id != record.id for record in records):
            raise CleanupConflict("任務暫存前綴不唯一，未清理 ComfyUI 圖片")
        owner = self._claim()
        try:
            targets: dict[tuple[str, str], dict] = {}
            for record in records:
                batch = _batch_name(record.id)
                patterns = {
                    "input": [f"{batch}/**/*", f"{batch}_*"],
                    "output": [f"{batch}_*"],
                    "temp": [f"{batch}/**/*", f"{batch}_*"],
                }
                for root_name, values in patterns.items():
                    root = self.roots[root_name]
                    if root.is_symlink() or not root.is_dir():
                        continue
                    for pattern in values:
                        for path in root.glob(pattern):
                            item = self._item(root_name, root, path, all_records)
                            if item and item["job_id"] == record.id:
                                targets[(root_name, item["path"])] = item
            return self._delete_many(targets.values())
        finally:
            self.manager.gpu_gate.release(owner)


def create_comfy_cleanup_router(service: ComfyCleanup) -> APIRouter:
    router = APIRouter(prefix="/api/comfy-cleanup", tags=["comfy-cleanup"])

    def secure(request: Request) -> None:
        if not same_page_request(request) or request.headers.get("x-comic-cleanup") != "1":
            raise HTTPException(403, "只接受本頁面的清理請求")

    @router.get("")
    def inventory(request: Request, unknown_after: str | None = None, unknown_before: str | None = None):
        secure(request)
        try:
            return service.scan(unknown_after, unknown_before)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @router.get("/preview/{root_name}/{relative:path}")
    def preview(root_name: str, relative: str, request: Request):
        secure(request)
        try:
            handle = service.open_preview(root_name, relative)
            suffix = PurePosixPath(relative).suffix.lower()
            media = "image/png" if suffix == ".png" else "image/jpeg" if suffix in {".jpg", ".jpeg"} else "image/webp"
            def stream():
                while chunk := handle.read(1024 * 1024):
                    yield chunk
            return StreamingResponse(stream(), media_type=media, background=BackgroundTask(handle.close))
        except (UnsafePath, CleanupConflict) as exc:
            raise HTTPException(400, str(exc)) from exc

    @router.post("/delete")
    def delete(request: Request, body: dict = Body(...)):
        secure(request)
        if body.get("confirm") is not True:
            raise HTTPException(400, "請先確認刪除")
        scope = body.get("scope")
        if scope not in {"safe", "selected"}:
            raise HTTPException(400, "清理範圍無效")
        try:
            return service.delete(scope, body.get("items") or [])
        except CleanupConflict as exc:
            raise HTTPException(409, str(exc)) from exc
        except (UnsafePath, ValueError) as exc:
            raise HTTPException(400, str(exc)) from exc

    return router
