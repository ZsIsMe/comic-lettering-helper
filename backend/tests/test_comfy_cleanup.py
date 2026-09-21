from __future__ import annotations

import os
import io
import json
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from app.comfy_cleanup import ComfyCleanup, create_comfy_cleanup_router
from app.config import Settings
from app.repository import JobRepository, now_iso
from app.resources import ResourceGate
from app.schemas import JobRecord
from app.projects import ProjectStore
from app.project_api import create_project_router


def make_service(tmp_path, *, queue_check=False):
    settings = Settings(app_root=tmp_path, data_root=tmp_path / "data", comfy_root=tmp_path / "ComfyUI", comfy_url="http://127.0.0.1:1")
    for name in ("input", "output", "temp"):
        (settings.comfy_root / name).mkdir(parents=True)
    repository = JobRepository(settings.jobs_root)
    manager = SimpleNamespace(gpu_gate=ResourceGate(), active_job_id=None)
    service = ComfyCleanup(settings, repository, manager)
    if not queue_check:
        service._assert_comfy_queue_idle = lambda: None
    return service, repository, manager


def image(path, color="white"):
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (3, 2), color).save(path)
    return path


def record(repository, job_id, *, state="completed", saved=True, project_id=None):
    stamp = now_iso()
    item = JobRecord(
        id=job_id, name=job_id, state=state, project_id=project_id,
        workflows=["firered"], pair_count=1, total_runs=1,
        created_at=stamp, updated_at=stamp, download_ready=saved,
        results={"firered": ["page.png"]} if saved else {},
    )
    repository.write(item)
    if saved:
        image(repository.job_dir(job_id) / "inpaint_workflows/firered/page.png")
    return item


def test_scan_classifies_only_uniquely_owned_completed_copies_as_safe(tmp_path):
    service, repository, _ = make_service(tmp_path)
    done = record(repository, "12345678-1234-aaaa-bbbb-cccccccccccc")
    pending = record(repository, "87654321-4321-aaaa-bbbb-cccccccccccc", state="failed", saved=False)
    done_batch = "web_123456781234"
    pending_batch = "web_876543214321"
    image(service.settings.comfy_input / done_batch / "pair/page.png")
    image(service.settings.comfy_output / f"{done_batch}_firered_page_00001_.png")
    image(service.settings.comfy_input / pending_batch / "pair/page.png")
    unknown = image(service.settings.comfy_input / "manual/page.png")
    outside = image(tmp_path / "outside.png")
    os.symlink(outside, service.settings.comfy_input / "manual/link.png")

    inventory = service.scan()
    categories = {(item["root"], item["path"]): item["category"] for item in inventory["items"]}
    assert categories[("input", f"{done_batch}/pair/page.png")] == "web_safe"
    assert categories[("output", f"{done_batch}_firered_page_00001_.png")] == "web_safe"
    assert categories[("input", f"{pending_batch}/pair/page.png")] == "web_protected"
    assert categories[("input", "manual/page.png")] == "unknown"
    assert ("input", "manual/link.png") not in categories
    assert inventory["summary"]["input"]["files"] == 3
    assert done.id != pending.id and unknown.is_file()


def test_safe_delete_preserves_unknown_and_unfinished_images(tmp_path):
    service, repository, manager = make_service(tmp_path)
    record(repository, "12345678-1234-aaaa-bbbb-cccccccccccc")
    record(repository, "87654321-4321-aaaa-bbbb-cccccccccccc", state="failed", saved=False)
    safe = image(service.settings.comfy_input / "web_123456781234/pair/page.png")
    protected = image(service.settings.comfy_input / "web_876543214321/pair/page.png")
    unknown = image(service.settings.comfy_output / "manual.png")

    safe_list = [item for item in service.scan()["items"] if item["category"] == "web_safe"]
    appeared_after_confirmation = image(service.settings.comfy_output / "web_123456781234_firered_later_00001_.png")
    result = service.delete("safe", safe_list)
    assert result["deleted_files"] == 1
    assert not safe.exists()
    assert protected.exists() and unknown.exists() and appeared_after_confirmation.exists()
    assert manager.gpu_gate.owner is None


def test_selected_delete_rechecks_signature_and_rejects_traversal(tmp_path):
    service, _, _ = make_service(tmp_path)
    target = image(service.settings.comfy_input / "manual/page.png")
    listed = next(item for item in service.scan()["items"] if item["category"] == "unknown")
    image(target, "black")
    try:
        service.delete("selected", [listed])
        raise AssertionError("changed file was deleted")
    except RuntimeError as exc:
        assert "變更" in str(exc)
    assert target.exists()
    bad = {**listed, "path": "../outside.png", "signature": listed["signature"]}
    try:
        service.delete("selected", [bad])
        raise AssertionError("traversal was accepted")
    except RuntimeError as exc:
        assert "清理清單已改變" in str(exc)


def test_delete_is_blocked_by_gpu_owner_or_unfinished_queue(tmp_path):
    service, repository, manager = make_service(tmp_path)
    manager.gpu_gate.claim("detection")
    try:
        service.delete("safe", [])
        raise AssertionError("busy gate was ignored")
    except RuntimeError as exc:
        assert "運行" in str(exc)
    manager.gpu_gate.release("detection")
    record(repository, "active-job", state="queued", saved=False)
    try:
        service.delete("safe", [])
        raise AssertionError("queued job was ignored")
    except RuntimeError as exc:
        assert "佇列" in str(exc)


def test_manual_comfy_queue_and_unknown_queue_response_block_cleanup(tmp_path, monkeypatch):
    service, _, _ = make_service(tmp_path, queue_check=True)
    response = Mock()
    response.__enter__ = Mock(return_value=io.BytesIO(json.dumps({"queue_running": [[1]], "queue_pending": []}).encode()))
    response.__exit__ = Mock(return_value=False)
    monkeypatch.setattr("app.comfy_cleanup.urllib.request.urlopen", Mock(return_value=response))
    try:
        service.delete("safe", [])
        raise AssertionError("manual queue was ignored")
    except RuntimeError as exc:
        assert "手動" in str(exc)

    malformed = Mock()
    malformed.__enter__ = Mock(return_value=io.BytesIO(b'{"queue_running": []}'))
    malformed.__exit__ = Mock(return_value=False)
    monkeypatch.setattr("app.comfy_cleanup.urllib.request.urlopen", Mock(return_value=malformed))
    try:
        service.delete("safe", [])
        raise AssertionError("unknown queue response was ignored")
    except RuntimeError as exc:
        assert "格式不明" in str(exc)


def test_selected_delete_cannot_bypass_unfinished_job_protection(tmp_path):
    service, repository, _ = make_service(tmp_path)
    record(repository, "87654321-4321-aaaa-bbbb-cccccccccccc", state="failed", saved=False)
    protected = image(service.settings.comfy_input / "web_876543214321/pair/page.png")
    listed = next(item for item in service.scan()["items"] if item["category"] == "web_protected")
    try:
        service.delete("selected", [listed])
        raise AssertionError("protected copy was deleted")
    except RuntimeError as exc:
        assert "禁止" in str(exc)
    assert protected.exists()


def test_cleanup_api_checks_same_page_header_and_confirmation(tmp_path):
    service, _, _ = make_service(tmp_path)
    image(service.settings.comfy_input / "manual.png")
    app = FastAPI()
    app.include_router(create_comfy_cleanup_router(service))
    client = TestClient(app)
    assert client.get("/api/comfy-cleanup").status_code == 403
    assert client.get("/api/comfy-cleanup", headers={"X-Comic-Cleanup": "1", "Origin": "https://foreign.example"}).status_code == 403
    assert client.post("/api/comfy-cleanup/delete", json={"confirm": True, "scope": "safe"}).status_code == 403
    headers = {"X-Comic-Cleanup": "1", "Origin": "https://public.example", "Host": "127.0.0.1", "Sec-Fetch-Site": "same-origin"}
    assert client.get("/api/comfy-cleanup", headers=headers).status_code == 200
    assert client.post("/api/comfy-cleanup/delete", headers=headers, json={"confirm": False, "scope": "safe"}).status_code == 400
    inventory = client.get("/api/comfy-cleanup", headers=headers).json()
    unknown = next(item for item in inventory["items"] if item["category"] == "unknown")
    assert client.post("/api/comfy-cleanup/delete", headers=headers, json={"confirm": True, "scope": "selected", "items": [unknown]}).status_code == 200


def test_project_job_cleanup_uses_exact_job_prefix_and_keeps_unknown_qwen_legacy(tmp_path):
    service, repository, _ = make_service(tmp_path)
    owned = record(repository, "12345678-1234-aaaa-bbbb-cccccccccccc", state="failed", saved=False, project_id="project")
    exact_input = image(service.settings.comfy_input / "web_123456781234/pair/page.png")
    exact_output = image(service.settings.comfy_output / "web_123456781234_firered_page_00001_.png")
    legacy_qwen = image(service.settings.comfy_input / "page_rgba.png")
    similar = image(service.settings.comfy_output / "web_123456781235_firered_page_00001_.png")
    result = service.delete_project_jobs([owned])
    assert result["deleted_files"] == 2
    assert not exact_input.exists() and not exact_output.exists()
    assert legacy_qwen.exists() and similar.exists()


def test_project_delete_calls_cleanup_with_exact_owned_records_before_removing_job(tmp_path):
    service, repository, manager = make_service(tmp_path)
    source = image(tmp_path / "source.png")
    store = ProjectStore(service.settings.data_root / "projects")
    project = store.create("project", {"page": source})
    owned = record(repository, "owned-job", state="failed", saved=False, project_id=project["id"])
    record(repository, "other-job", state="failed", saved=False, project_id=None)
    received = []

    class Hook:
        def delete_project_jobs(self, records):
            assert repository.job_dir(owned.id).is_dir()
            received.extend(item.id for item in records)
            return {"deleted_files": 0, "deleted_bytes": 0}

    app = FastAPI()
    app.include_router(create_project_router(service.settings, repository, manager, store, Hook()))
    response = TestClient(app).delete(f"/api/projects/{project['id']}?confirm=true")
    assert response.status_code == 200, response.text
    assert received == ["owned-job"]
    assert not repository.job_dir("owned-job").exists()
    assert repository.job_dir("other-job").exists()
