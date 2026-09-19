from types import SimpleNamespace
from unittest.mock import Mock
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from app.comfy_service import ComfyService, router
from app.config import Settings
from app.resources import ResourceGate


def service(tmp_path):
    manager = SimpleNamespace(active_job_id=None, repository=SimpleNamespace(list=lambda **kwargs: []), gpu_gate=ResourceGate())
    settings = Settings(app_root=tmp_path, data_root=tmp_path, comfy_root=tmp_path / "ComfyUI")
    return ComfyService(settings, manager, lambda: True)


def test_restart_rejects_active_task(tmp_path):
    s = service(tmp_path); s.manager.active_job_id = "active"
    with pytest.raises(HTTPException) as e: s.launch()
    assert e.value.status_code == 409
    assert s.manager.gpu_gate.owner is None


def test_restart_rejects_gpu_owner_and_no_gpu(tmp_path):
    s = service(tmp_path); s.manager.gpu_gate.claim("detection")
    with pytest.raises(HTTPException): s.launch()
    assert s.manager.gpu_gate.owner == "detection"
    s.manager.gpu_gate.release("detection"); s.gpu_available = lambda: False
    with pytest.raises(HTTPException): s.launch()
    assert s.manager.gpu_gate.owner is None


def test_queue_rejection_releases_reservation(tmp_path):
    s = service(tmp_path); s._queue_idle = Mock(side_effect=HTTPException(409, "busy"))
    with pytest.raises(HTTPException): s.launch()
    assert s.manager.gpu_gate.owner is None


def test_restart_reserves_gpu_and_releases_on_failure(tmp_path, monkeypatch):
    s = service(tmp_path); s._queue_idle = Mock()
    thread = Mock(); monkeypatch.setattr("app.comfy_service.threading.Thread", lambda **kw: thread)
    assert s.launch()["state"] == "restarting"
    assert s.manager.gpu_gate.owner == s.owner
    with pytest.raises(HTTPException): s.launch()
    s._owned_pid = Mock(side_effect=RuntimeError("foreign PID"))
    s._restart()
    assert s.status()["state"] == "failed"
    assert "foreign PID" in s.status()["message"]
    assert s.manager.gpu_gate.owner is None


def test_rejects_foreign_pid_before_signalling(tmp_path, monkeypatch):
    import os
    s = service(tmp_path)
    (tmp_path / "run").mkdir(); (tmp_path / "run/comfyui.pid").write_text(str(os.getpid()))
    monkeypatch.setattr("app.comfy_service.Path.exists", lambda self: True)
    original = __import__("pathlib").Path.read_bytes
    monkeypatch.setattr("app.comfy_service.Path.read_bytes", lambda self: b"python\0unrelated.py\0" if str(self).startswith("/proc/") else original(self))
    with pytest.raises(RuntimeError, match="不屬於"): s._owned_pid()


def test_restart_route_checks_same_origin(tmp_path):
    s = service(tmp_path); s.launch = Mock(return_value={"state": "restarting", "message": "starting"})
    app = FastAPI(); app.include_router(router(s)); c = TestClient(app)
    assert c.post("/api/app/comfy/restart").status_code == 403
    assert c.post("/api/app/comfy/restart", headers={"X-Comic-Service": "1", "Origin": "https://foreign.example"}).status_code == 403
    proxy = {"X-Comic-Service": "1", "Origin": "https://public.example:8443",
             "Host": "127.0.0.1:6008", "Sec-Fetch-Site": "same-origin"}
    assert c.post("/api/app/comfy/restart", headers=proxy).status_code == 202
    forwarded = {"X-Comic-Service": "1", "Origin": "https://public.example:8443",
                 "Host": "127.0.0.1:6008", "X-Forwarded-Host": "public.example:8443"}
    assert c.post("/api/app/comfy/restart", headers=forwarded).status_code == 202
    assert c.post("/api/app/comfy/restart", headers={**proxy, "Sec-Fetch-Site": "cross-site"}).status_code == 403
    assert c.post("/api/app/comfy/restart", headers={"X-Comic-Service": "1"}).status_code == 202
    assert s.launch.call_count == 3


def test_proc_disappearing_is_already_stopped(tmp_path, monkeypatch):
    s = service(tmp_path)
    (tmp_path / "run").mkdir(); (tmp_path / "run/comfyui.pid").write_text("12345")
    monkeypatch.setattr("app.comfy_service.Path.exists", lambda self: True)
    monkeypatch.setattr("app.comfy_service.Path.read_bytes", Mock(side_effect=FileNotFoundError()))
    assert s._owned_pid() is None


def test_update_in_progress_blocks_restart_even_without_gpu_owner(tmp_path):
    s = service(tmp_path); s.maintenance_busy = lambda: True
    with pytest.raises(HTTPException) as e: s.launch()
    assert e.value.status_code == 409
    assert s.manager.gpu_gate.owner is None


def test_exit_during_sigterm_still_starts_service(tmp_path, monkeypatch):
    s = service(tmp_path)
    s._owned_pid = Mock(side_effect=[12345, None, None])
    monkeypatch.setattr("app.comfy_service.os.kill", Mock(side_effect=ProcessLookupError()))
    run = Mock(return_value=SimpleNamespace(returncode=0))
    monkeypatch.setattr("app.comfy_service.subprocess.run", run)
    from unittest.mock import MagicMock
    monkeypatch.setattr("app.comfy_service.urllib.request.urlopen", MagicMock())
    s._restart()
    assert s.status()["state"] == "ready"
    run.assert_called_once()
