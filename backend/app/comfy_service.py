"""Restart only the managed ComfyUI process while reserving the shared GPU."""
from __future__ import annotations

import json
import os
from pathlib import Path
from contextlib import suppress
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Request


class ComfyService:
    owner = "comfy-service-restart"

    def __init__(self, settings, manager, gpu_available, maintenance_busy=lambda: False):
        self.settings, self.manager, self.gpu_available = settings, manager, gpu_available
        self.maintenance_busy = maintenance_busy
        self.lock = threading.Lock()
        self.state = {"state": "idle", "message": ""}

    def status(self):
        with self.lock:
            return dict(self.state)

    def _set(self, state, message):
        with self.lock:
            self.state = {"state": state, "message": message}

    def _queue_idle(self):
        try:
            with urllib.request.urlopen(f"{self.settings.comfy_url}/queue", timeout=3) as response:
                queue = json.load(response)
        except (OSError, urllib.error.URLError):
            return  # A dead service can be restarted.
        if queue.get("queue_running") or queue.get("queue_pending"):
            raise HTTPException(409, "ComfyUI 還有任務，請先停止任務再重啟")

    def launch(self):
        with self.lock:
            if self.maintenance_busy():
                raise HTTPException(409, "應用正在更新，請稍後再重啟")
            if self.state["state"] == "restarting":
                raise HTTPException(409, "ComfyUI 正在重啟")
            if self.manager.active_job_id or any(str(r.state) in {"queued", "validating", "running", "packaging", "abandoning"}
                                                for r in self.manager.repository.list(limit=None)):
                raise HTTPException(409, "請先停止修復任務，再重啟 ComfyUI")
            if not self.gpu_available():
                raise HTTPException(409, "目前沒有可用 GPU，請先在 AutoDL 有卡開機")
            if not self.manager.gpu_gate.claim(self.owner):
                raise HTTPException(409, "偵測、生成或更新正在執行，請等待完成或先停止任務")
            try:
                self._queue_idle()
                self.state = {"state": "restarting", "message": "正在停止並重新啟動 ComfyUI"}
                thread = threading.Thread(target=self._restart, daemon=True)
                thread.start()
            except Exception:
                self.manager.gpu_gate.release(self.owner)
                self.state = {"state": "failed", "message": "未啟動重啟操作"}
                raise
            return dict(self.state)

    def recover_for_job(self, job_id):
        # The active job keeps its reservation for the whole recovery.
        if self.manager.active_job_id != job_id or self.manager.gpu_gate.owner != job_id:
            raise RuntimeError("任務已不再擁有 GPU，停止自動恢復")
        if not self.gpu_available():
            raise RuntimeError("沒有可用 GPU，自動恢復已停止；請有卡開機後手動續跑")
        self._set("restarting", "ComfyUI 失聯，正在自動恢復一次")
        self._restart()
        if self.status()["state"] != "ready":
            raise RuntimeError(self.status()["message"])

    def _owned_pid(self):
        path = self.settings.data_root / "run/comfyui.pid"
        if not path.exists():
            return None
        pid = int(path.read_text().strip())
        if pid <= 1:
            raise RuntimeError("ComfyUI PID 無效")
        proc = Path(f"/proc/{pid}/cmdline")
        if not proc.exists():
            return None
        try:
            args = proc.read_bytes().decode().split("\0")
        except FileNotFoundError:
            return None
        if not any(args):
            return None
        expected = str(self.settings.comfy_root / "main.py")
        if expected not in args or "--port" not in args or args[args.index("--port") + 1] != "6006":
            raise RuntimeError("PID 不屬於受管理的 ComfyUI，已拒絕停止")
        return pid

    def _restart(self):
        try:
            pid = self._owned_pid()
            if pid is None:
                try:
                    with urllib.request.urlopen(f"{self.settings.comfy_url}/system_stats", timeout=2):
                        pass
                except OSError:
                    pass
                else:
                    raise RuntimeError("服務可用但沒有可核對的受管理 PID，已拒絕重啟")
            if pid is not None:
                with suppress(ProcessLookupError):
                    os.kill(pid, signal.SIGTERM)
                deadline = time.monotonic() + 15
                while self._owned_pid() == pid and time.monotonic() < deadline:
                    time.sleep(0.25)
                if self._owned_pid() == pid:
                    with suppress(ProcessLookupError):
                        os.kill(pid, signal.SIGKILL)
                    deadline = time.monotonic() + 5
                    while self._owned_pid() == pid and time.monotonic() < deadline:
                        time.sleep(0.25)
                    if self._owned_pid() == pid:
                        raise RuntimeError("舊 ComfyUI 程序未能停止")
            logs = self.settings.data_root / "logs"
            logs.mkdir(parents=True, exist_ok=True)
            old = logs / "comfyui.log"
            if old.exists():
                import shutil
                shutil.copy2(old, logs / f"comfyui-before-restart-{time.time_ns()}.log")
            with (logs / "comfyui-restart.log").open("ab") as log:
                result = subprocess.run([str(self.settings.app_root / "deploy/start-comfy.sh")],
                    stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, timeout=150,
                    env=dict(os.environ, COMIC_APP_ROOT=str(self.settings.app_root),
                             COMIC_DATA_ROOT=str(self.settings.data_root), COMFY_ROOT=str(self.settings.comfy_root)))
            if result.returncode:
                raise RuntimeError("ComfyUI 啟動失敗，請查看服務日誌")
            with urllib.request.urlopen(f"{self.settings.comfy_url}/system_stats", timeout=3):
                pass
            self._set("ready", "ComfyUI 已就緒；原有失敗任務不會自動重跑")
        except Exception as exc:
            self._set("failed", f"重啟失敗：{exc}")
        finally:
            self.manager.gpu_gate.release(self.owner)


def router(service):
    api = APIRouter(prefix="/api/app/comfy")

    @api.get("/status")
    def status():
        return service.status()

    @api.post("/restart", status_code=202)
    def restart(request: Request):
        if request.headers.get("x-comic-service") != "1":
            raise HTTPException(403, "請從網頁的重啟按鈕操作")
        origin = request.headers.get("origin")
        if origin and urlsplit(origin).netloc != request.headers.get("host"):
            raise HTTPException(403, "重啟要求必須來自同一個網頁")
        return service.launch()

    return api
