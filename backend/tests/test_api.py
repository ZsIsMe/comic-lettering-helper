from __future__ import annotations

import io

from fastapi.testclient import TestClient
from PIL import Image

from app.main import app


def png_bytes(size: tuple[int, int] = (8, 8)) -> bytes:
    output = io.BytesIO()
    Image.new("L", size, 255).save(output, format="PNG")
    return output.getvalue()


def test_health_and_built_frontend_are_served() -> None:
    with TestClient(app) as client:
        health = client.get("/api/health")
        assert health.status_code == 200
        assert health.json()["app"] == "ok"
        page = client.get("/")
        assert page.status_code == 200
        assert "漫畫去字工作台" in page.text


def test_mismatched_upload_is_rejected_before_queueing() -> None:
    with TestClient(app) as client:
        response = client.post(
            "/api/jobs",
            data={"name": "配對錯誤", "workflows": "firered"},
            files=[
                ("source_files", ("01.png", png_bytes(), "image/png")),
                ("mask_files", ("02.png", png_bytes(), "image/png")),
            ],
        )
    assert response.status_code == 400
    assert "配對失敗" in response.json()["detail"]


def test_health_without_executable_gpu_driver(monkeypatch):
    from app import main
    def no_driver(*args, **kwargs):
        raise OSError(8, "Exec format error")
    monkeypatch.setattr(main.subprocess, "run", no_driver)
    monkeypatch.setattr(main, "comfy_ready", lambda: False)
    health = main.health()
    assert health.app == "ok"
    assert health.gpu_name is None
    assert health.gpu_memory_total_mib is None


def test_resume_failed_job_preserves_results_and_reserves_gpu(tmp_path, monkeypatch):
    import asyncio
    from unittest.mock import AsyncMock
    from app import main
    from app.repository import JobRepository
    from app.engine import JobManager
    from app.config import Settings
    from app.schemas import JobRecord, JobState
    repo = JobRepository(tmp_path / "jobs")
    mgr = JobManager(Settings(data_root=tmp_path), repo)
    mgr.enqueue = AsyncMock()
    monkeypatch.setattr(main, "repository", repo)
    monkeypatch.setattr(main, "manager", mgr)
    monkeypatch.setattr(main, "comfy_ready", lambda: True)
    rec = JobRecord(id="resume", name="test", workflows=["firered"], pair_count=2, total_runs=2,
                    created_at="2026-09-17T00:00:00+00:00", updated_at="2026-09-17T00:00:00+00:00",
                    finished_at="2026-09-17T01:00:00+00:00", state=JobState.failed,
                    results={"firered": ["01.png"]}, completed_total=1)
    repo.write(rec)
    result = asyncio.run(main.resume_job(rec.id))
    assert result.state == JobState.queued and result.finished_at is None
    assert result.results == rec.results
    assert mgr.gpu_gate.owner == rec.id
    mgr.enqueue.assert_awaited_once_with(rec.id)
