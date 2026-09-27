from __future__ import annotations

import io
import json
import zipfile

import numpy as np
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from PIL import Image

from app.composition import SavePage, build_composition_router, encode_assignment
from app.projects import ProjectStore
from app.repository import JobRepository, now_iso
from app.round_composition import RoundCompositionService, build_round_composition_router
from app.schemas import JobRecord, JobState


@pytest.fixture
def rounds(tmp_path):
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    base = np.full((12, 14, 3), 42, np.uint8)
    active = np.zeros((12, 14), np.uint8)
    active[2:10, 2:12] = 255
    sources, masks = {}, {}
    for stem, mask in [("01", active), ("02", active), ("03", np.zeros_like(active))]:
        sources[stem] = uploads / f"{stem}.png"
        masks[stem] = uploads / f"{stem}-mask.png"
        Image.fromarray(base).save(sources[stem])
        Image.fromarray(mask).save(masks[stem])
    store = ProjectStore(tmp_path / "projects")
    project = store.create("rounds", sources, masks)
    repository = JobRepository(tmp_path / "jobs")
    return RoundCompositionService(store, repository), store, repository, project, base, active


def add_run(store, repository, project, run_id, page_ids, workflow="firered", color=(220, 30, 20), *, state=JobState.completed, accepted=False):
    snapshot = store.snapshot(project["id"], project["revision"], page_ids)
    repository.write(JobRecord(id=run_id, name=run_id, state=state, workflows=[workflow],
                               pair_count=len(page_ids), total_runs=len(page_ids),
                               created_at=now_iso(), updated_at=now_iso(),
                               partial_results_accepted=accepted))
    project["runs"].append({"id": run_id, "snapshot_id": snapshot["id"], "workflows": [workflow]})
    store.write(project)
    root = repository.job_dir(run_id) / "inpaint_workflows" / workflow
    root.mkdir(parents=True)
    for page in snapshot["pages"]:
        with Image.open(store.asset_path(project["id"], page["source"])) as image:
            result = np.asarray(image.convert("RGB")).copy()
        if not page["passthrough"]:
            result[2:10, 2:12] = color
        Image.fromarray(result).save(root / f"{page['stem']}.png")
    return snapshot


def test_partial_first_run_then_same_workflow_new_round_and_full_export(rounds):
    service, store, repository, project, base, _ = rounds
    p1, p2, p3 = (page["id"] for page in project["pages"])
    add_run(store, repository, project, "round1", [p1, p3])
    first = service.describe(project["id"])
    assert len(first["pages"]) == 3
    assert first["pages"][1]["candidates"][0]["error"] == "此輪次沒有選擇本頁"
    assert first["pages"][1]["confirmed"] is False
    assert first["pages"][2]["confirmed"] is True
    assert first["candidates"][0]["target_count"] == 2
    assert first["candidates"][0]["available_count"] == 2
    with pytest.raises(HTTPException, match="缺少可用候選"):
        service.confirm(project["id"], 0)
    state, _, root = service.initialize(project["id"])
    before = service.assignment(root, state["pages"][p1]).copy()
    add_run(store, repository, project, "round2", [p2], color=(20, 210, 30))
    second = service.describe(project["id"])
    assert second["workflow_codes"] == {"round1:firered": 2, "round2:firered": 3}
    assert second["revision"] == 0
    state, _, root = service.initialize(project["id"])
    np.testing.assert_array_equal(service.assignment(root, state["pages"][p1]), before)
    assert second["pages"][1]["candidates"][1]["available"]
    assert not second["pages"][0]["candidates"][1]["available"]
    assignment = np.zeros(base.shape[:2], np.uint16)
    assignment[2:10, 2:12] = 3
    saved = service.save_page(project["id"], p2, SavePage(revision=0, assignment_rle=encode_assignment(assignment), confirmed=True, settings={"feather_px": 0}))
    assert saved["revision"] == 1
    with pytest.raises(HTTPException) as stale:
        service.save_page(project["id"], p2, SavePage(revision=0, assignment_rle=encode_assignment(assignment)))
    assert stale.value.status_code == 409
    confirmed = service.confirm(project["id"], 1)
    assert confirmed["revision"] == 2
    archive = service.export(project["id"], 2)
    with zipfile.ZipFile(archive) as bundle:
        assert bundle.namelist() == ["01.png", "02.png", "03.png"]
        with Image.open(io.BytesIO(bundle.read("02.png"))) as image:
            assert image.getpixel((3, 3)) == (20, 210, 30)
    reopened = RoundCompositionService(store, repository)
    assert reopened.describe(project["id"])["workflow_codes"] == second["workflow_codes"]


def test_cross_snapshot_wrong_base_unavailable_and_preserves_old_assignment(rounds):
    service, store, repository, project, _, _ = rounds
    p1 = project["pages"][0]["id"]
    add_run(store, repository, project, "round1", [p1])
    service.describe(project["id"])
    state, _, root = service.initialize(project["id"])
    before = service.assignment(root, state["pages"][p1]).copy()
    Image.new("RGBA", (14, 12), (255, 255, 255, 255)).save(store.asset_path(project["id"], project["pages"][0]["overlay"]))
    add_run(store, repository, project, "round2", [p1], color=(10, 220, 20))
    described = service.describe(project["id"])
    assert "凍結底圖不同" in described["pages"][0]["candidates"][1]["error"]
    assert described["pages"][0]["candidates"][0]["available"]
    state, _, root = service.initialize(project["id"])
    np.testing.assert_array_equal(service.assignment(root, state["pages"][p1]), before)
    with pytest.raises(HTTPException):
        service.image(project["id"], p1, "candidate:3")
    # Tampering after registration must also be visible in metadata.
    snapshot = next(run for run in project["runs"] if run["id"] == "round1")
    manifest = json.loads(store.asset_path(project["id"], f"inputs/{snapshot['snapshot_id']}/manifest.json").read_text())
    Image.new("RGB", (14, 12), "black").save(store.asset_path(project["id"], manifest["pages"][0]["source"]))
    assert not service.describe(project["id"])["pages"][0]["candidates"][0]["available"]


def test_black_mask_can_be_repaired_by_later_nonblack_round(rounds):
    service, store, repository, project, base, active = rounds
    p3 = project["pages"][2]["id"]
    add_run(store, repository, project, "round1", [p3])
    assert service.describe(project["id"])["pages"][2]["passthrough"]
    Image.fromarray(active).save(store.asset_path(project["id"], project["pages"][2]["other"]))
    add_run(store, repository, project, "round2", [p3], color=(11, 22, 200))
    described = service.describe(project["id"])
    assert described["pages"][2]["passthrough"] is False
    assert described["pages"][2]["confirmed"] is False
    assignment = np.zeros(base.shape[:2], np.uint16)
    assignment[2:10, 2:12] = 3
    saved = service.save_page(project["id"], p3, SavePage(revision=0, assignment_rle=encode_assignment(assignment), confirmed=True))
    assert saved["pages"][2]["confirmed"]


def test_only_completed_or_accepted_partial_failures_are_candidates(rounds):
    service, store, repository, project, _, _ = rounds
    p1 = project["pages"][0]["id"]
    add_run(store, repository, project, "full", [p1])
    service.describe(project["id"])
    add_run(store, repository, project, "failed", [p1], state=JobState.failed)
    assert len(service.describe(project["id"])["candidates"]) == 1
    job = repository.read("failed")
    job.partial_results_accepted = True
    repository.write(job)
    assert len(service.describe(project["id"])["candidates"]) == 2
    job.state = JobState.running
    repository.write(job)
    assert not service.describe(project["id"])["pages"][0]["candidates"][1]["available"]


def test_tampered_candidate_reference_is_rejected_before_job_path_lookup(rounds):
    service, store, repository, project, _, _ = rounds
    add_run(store, repository, project, "full", [project["pages"][0]["id"]])
    service.describe(project["id"])
    path = store.project_dir(project["id"]) / "compositions/rounds/selection.json"
    state = json.loads(path.read_text())
    state["candidates"][0]["run_id"] = "../../outside"
    path.write_text(json.dumps(state))
    with pytest.raises(HTTPException) as error:
        service.describe(project["id"])
    assert error.value.status_code == 409


def test_api_coexists_with_old_run_composition_and_download_reader(rounds):
    service, store, repository, project, _, _ = rounds
    page_ids = [page["id"] for page in project["pages"]]
    add_run(store, repository, project, "full", page_ids)
    app = FastAPI()
    app.include_router(build_round_composition_router(store, repository))
    app.include_router(build_composition_router(store, repository))
    root = f"/api/projects/{project['id']}/round-composition"
    with TestClient(app) as client:
        response = client.get(root)
        assert response.status_code == 200
        code = response.json()["candidates"][0]["code"]
        assert client.put(root + f"/candidates/{code}", json={"revision": 0, "selected": False}).json()["revision"] == 1
        assert client.put(root + f"/candidates/{code}", json={"revision": 0, "selected": True}).status_code == 409
        assert client.get(f"/api/projects/{project['id']}/compositions/full").status_code == 200
        assert client.post(root + "/confirm", json={"revision": 1}).status_code == 200
        export = client.post(root + "/export", json={"revision": 2})
        assert export.status_code == 200
        assert len(zipfile.ZipFile(io.BytesIO(client.get(export.json()["download_url"]).content)).namelist()) == 3
        assert store._readers[project["id"]] == 0
