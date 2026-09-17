from __future__ import annotations

import io
import json
import zipfile
from unittest.mock import patch

import numpy as np
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from PIL import Image

from app.composition import (CompositionService, SavePage, build_composition_router,
                             compose_result, decode_assignment, difference_mask,
                             encode_assignment, read_rgb)
from app.projects import ProjectStore
from app.repository import JobRepository, now_iso
from app.schemas import JobRecord, JobState


@pytest.fixture
def composition(tmp_path):
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    base = np.full((20, 24, 3), 40, np.uint8)
    active = np.zeros((20, 24), np.uint8)
    active[2:18, 2:22] = 255
    sources, masks = {}, {}
    for stem, mask in [("01", active), ("02", np.zeros_like(active))]:
        sources[stem], masks[stem] = uploads / f"{stem}.png", uploads / f"{stem}_mask.png"
        Image.fromarray(base).save(sources[stem])
        Image.fromarray(mask).save(masks[stem])
    store = ProjectStore(tmp_path / "projects")
    project = store.create("test", sources, masks)
    snapshot = store.snapshot(project["id"], project["revision"])
    repository = JobRepository(tmp_path / "jobs")
    run_id = "repair1"
    workflows = ["flux2klein_lanpaint", "firered"]
    repository.write(JobRecord(id=run_id, name="test", state=JobState.completed,
                               workflows=workflows, pair_count=2, total_runs=4,
                               created_at=now_iso(), updated_at=now_iso()))
    project["runs"] = [{"id": run_id, "snapshot_id": snapshot["id"], "workflows": workflows}]
    project["current_run_id"] = run_id
    store.write(project)
    for workflow, color in [(workflows[0], (230, 20, 10)), (workflows[1], (10, 220, 30))]:
        root = repository.job_dir(run_id) / "inpaint_workflows" / workflow
        root.mkdir(parents=True)
        result = base.copy()
        result[2:18, 2:22] = color
        Image.fromarray(result).save(root / "01.png")
        Image.fromarray(base).save(root / "02.png")
    service = CompositionService(store, repository)
    return service, store, repository, project, run_id, snapshot


def test_difference_filters_small_noise_and_rejects_resize():
    base = np.zeros((20, 24, 3), np.uint8)
    result = base.copy()
    result[3:9, 4:11] = 50
    result[15, 20] = 255
    mask = difference_mask(base, result, threshold=12, min_area=8)
    assert mask[5, 6] == 255
    assert mask[15, 20] == 0
    assert not np.any(difference_mask(base, base + 8))
    with pytest.raises(ValueError, match="尺寸不同"):
        difference_mask(base, result[:-1])


def test_mix_regions_preserves_base_and_feather_boundary():
    base = np.full((20, 24, 3), 40, np.uint8)
    candidates = {2: np.full_like(base, (230, 20, 10)), 3: np.full_like(base, (10, 220, 30))}
    assignment = np.zeros(base.shape[:2], np.uint16)
    assignment[2:10, 2:10] = 2
    assignment[10:18, 12:22] = 3
    plain = compose_result(base, candidates, assignment, 0)
    np.testing.assert_array_equal(plain[4, 4], candidates[2][4, 4])
    np.testing.assert_array_equal(plain[12, 16], candidates[3][12, 16])
    feathered = compose_result(base, candidates, assignment, 2)
    np.testing.assert_array_equal(feathered[assignment == 0], base[assignment == 0])
    with pytest.raises(ValueError, match="缺少"):
        compose_result(base, {2: candidates[2]}, assignment)
    with pytest.raises(ValueError, match="尺寸"):
        compose_result(base, {2: candidates[2][:-1], 3: candidates[3]}, assignment)


def test_rle_validates_dimensions_and_keeps_uint16():
    array = np.array([[0, 1, 300], [300, 300, 2]], np.uint16)
    np.testing.assert_array_equal(decode_assignment(encode_assignment(array), (2, 3), {0, 1, 2, 300}), array)
    for bad in ([[2, 5]], [[2, 7]], [[4, 6]], [[2, -1]], [[2, 3, 4]]):
        with pytest.raises(ValueError):
            decode_assignment(bad, (2, 3), {0, 1, 2})


def test_snapshot_defaults_persistence_revision_and_export(composition):
    service, store, _, project, run_id, _ = composition
    pid = project["id"]
    state = service.describe(pid, run_id)
    first, black = state["pages"]
    assert not first["confirmed"] and not first["passthrough"]
    assert black["confirmed"] and black["passthrough"]
    # Changing the live draft cannot replace this run's immutable comparison base.
    Image.new("RGB", (24, 20), "white").save(store.asset_path(pid, project["pages"][0]["source"]))
    with Image.open(io.BytesIO(service.image(pid, run_id, first["page_id"], "base"))) as image:
        assert image.getpixel((0, 0)) == (40, 40, 40)
    with pytest.raises(HTTPException) as pending:
        service.export(pid, run_id, 0)
    assert pending.value.status_code == 409
    assignment = np.zeros((20, 24), np.uint16)
    assignment[2:10, 2:10] = 2
    assignment[10:18, 12:22] = 3
    saved = service.save_page(pid, run_id, first["page_id"], SavePage(revision=0,
                assignment_rle=encode_assignment(assignment), confirmed=True, settings={"feather_px": 0}))
    assert saved["revision"] == 1
    with pytest.raises(HTTPException) as stale:
        service.save_page(pid, run_id, first["page_id"], SavePage(revision=0, assignment_rle=encode_assignment(assignment)))
    assert stale.value.status_code == 409
    reopened = CompositionService(store, service.repository)
    state_disk, _, _, root = reopened.initialize(pid, run_id)
    np.testing.assert_array_equal(reopened.assignment(root, state_disk["pages"][first["page_id"]]), assignment)
    archive = reopened.export(pid, run_id, 1)
    with zipfile.ZipFile(archive) as bundle:
        assert bundle.namelist() == ["01.png", "02.png"]
        assert bundle.read("01.png") == reopened.image(pid, run_id, first["page_id"], "preview")
    assert json.loads((root / "selection.json").read_text())["snapshot_id"] == project["runs"][0]["snapshot_id"]


def test_difference_settings_do_not_erase_choices(composition):
    service, _, _, project, run_id, _ = composition
    pid = project["id"]
    state, _, _, root = service.initialize(pid, run_id)
    page_id = next(iter(state["pages"]))
    assigned = service.assignment(root, state["pages"][page_id])
    service.save_page(pid, run_id, page_id, SavePage(revision=0, assignment_rle=encode_assignment(assigned),
                                                  settings={"threshold": 255, "expand_px": 0}))
    state, _, _, root = service.initialize(pid, run_id)
    np.testing.assert_array_equal(service.assignment(root, state["pages"][page_id]), assigned)


def test_missing_or_wrong_sized_selected_candidate_blocks_export(composition):
    service, _, repository, project, run_id, _ = composition
    pid = project["id"]
    service.describe(pid, run_id)
    service.confirm(pid, run_id, 0)
    selected = repository.job_dir(run_id) / "inpaint_workflows/flux2klein_lanpaint/01.png"
    selected.unlink()
    state = service.describe(pid, run_id)
    assert not state["pages"][0]["candidates"][0]["available"]
    with pytest.raises(HTTPException) as missing:
        service.export(pid, run_id, 1)
    assert missing.value.status_code == 409
    Image.new("RGB", (4, 4)).save(selected)
    assert "尺寸" in service.describe(pid, run_id)["pages"][0]["candidates"][0]["error"]
    with pytest.raises(HTTPException):
        service.export(pid, run_id, 1)


def test_missing_mask_is_not_passthrough_and_incomplete_job_blocked(composition):
    service, store, repository, project, run_id, snapshot = composition
    job = repository.read(run_id)
    job.state = JobState.running
    repository.write(job)
    with pytest.raises(HTTPException) as active:
        service.describe(project["id"], run_id)
    assert active.value.status_code == 409
    job.state = JobState.completed
    repository.write(job)
    store.asset_path(project["id"], snapshot["pages"][1]["mask"]).unlink()
    with pytest.raises(HTTPException) as missing:
        service.describe(project["id"], run_id)
    assert missing.value.status_code == 409


def test_api_assignment_download_and_stale_revision(composition):
    _, store, repository, project, run_id, _ = composition
    app = FastAPI()
    app.include_router(build_composition_router(store, repository))
    root = f"/api/projects/{project['id']}/compositions/{run_id}"
    with TestClient(app) as client:
        first = client.get(root).json()["pages"][0]
        assignment = client.get(root + f"/pages/{first['page_id']}/assignment").json()
        assert assignment["revision"] == 0 and assignment["assignment_rle"]
        assert client.post(root + "/confirm", json={"revision": 0}).status_code == 200
        assert client.post(root + "/confirm", json={"revision": 0}).status_code == 409
        result = client.post(root + "/export", json={"revision": 1})
        assert result.status_code == 200
        response = client.get(result.json()["download_url"])
        assert response.status_code == 200
        assert zipfile.ZipFile(io.BytesIO(response.content)).namelist() == ["01.png", "02.png"]
        assert store._readers[project["id"]] == 0


def test_metadata_refresh_and_autosave_do_not_decode_other_pages(composition):
    service, _, _, project, run_id, _ = composition
    pid = project["id"]
    state, _, _, root = service.initialize(pid, run_id)
    page_id = next(iter(state["pages"]))
    assignment = service.assignment(root, state["pages"][page_id])
    with patch("app.composition.read_rgb", wraps=read_rgb) as decode:
        described = service.describe(pid, run_id)
        assert len(described["pages"]) == 2
        assert all(candidate["available"] for page in described["pages"] for candidate in page["candidates"])
        assert decode.call_count == 0
        saved = service.save_page(pid, run_id, page_id, SavePage(
            revision=0, assignment_rle=encode_assignment(assignment), confirmed=True))
        assert saved["revision"] == 1
        # Only the edited page's base plus its two selected workflows are
        # decoded; the returned whole-project metadata performs header reads.
        assert decode.call_count == 3
        assert all(call.args[0].name == "01.png" for call in decode.call_args_list)


def test_failed_run_requires_acceptance_and_keeps_missing_candidates_visible(composition):
    service, store, repository, project, run_id, snapshot = composition
    record = repository.read(run_id)
    record.state = JobState.failed
    repository.write(record)
    with pytest.raises(HTTPException): service.context(project["id"], run_id)
    record.partial_results_accepted = True
    repository.write(record)
    missing = repository.job_dir(run_id) / "inpaint_workflows/firered/01.png"
    missing.unlink()
    result = service.describe(project["id"], run_id)
    page = next(p for p in result["pages"] if p["stem"] == "01")
    assert any(c["available"] for c in page["candidates"])
    assert any(not c["available"] for c in page["candidates"])
    assert page["warnings"]
    record.state = JobState.running
    repository.write(record)
    with pytest.raises(HTTPException): service.context(project["id"], run_id)
