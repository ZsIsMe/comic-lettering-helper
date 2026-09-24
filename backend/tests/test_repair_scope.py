import asyncio
import json
import zipfile
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from app.config import Settings
from app.project_api import create_project_router, export_project, import_project
from app.projects import ProjectConflict, atomic_json
from app.repair_scope import validate_rect, default_rect
from app.repository import JobRepository
from test_projects import make_project, Manager
from test_engine import make_manager, make_record


def test_scope_apply_overwrites_custom_pages_clamps_and_stays_local(tmp_path):
    store, project = make_project(tmp_path)
    source = tmp_path / '02.png'
    Image.new('RGB', (3, 2)).save(source)
    project = store.create('two', {'01': tmp_path / '01.png', '02': source})
    pid = project['id']
    first, second = project['pages']
    rect = dict(x=2, y=1, width=3, height=2)
    p = store.save_repair_scope(pid, second['id'], 0, True, dict(x=0, y=0, width=2, height=1))
    p = store.save_repair_scope(pid, first['id'], 1, True, rect, True)
    assert p['repair_scope']['pages'][second['id']] == dict(x=2, y=1, width=1, height=1)
    p = store.save_repair_scope(pid, second['id'], 2, True, dict(x=0, y=0, width=3, height=2))
    assert p['repair_scope']['pages'][first['id']] == rect
    with pytest.raises(ProjectConflict):
        store.save_repair_scope(pid, first['id'], 0, True, rect)
    persisted = json.loads((store.project_dir(pid) / 'repair_scope.json').read_text())
    assert persisted == store.read(pid)['repair_scope']
    assert 'repair_scope' not in json.loads((store.project_dir(pid) / 'project.json').read_text())
    repository = JobRepository(tmp_path / 'jobs')
    archive = export_project(store, repository, pid)
    with zipfile.ZipFile(archive) as zipped:
        assert 'repair_scope.json' not in zipped.namelist()
    imported = import_project(store, repository, archive, 10**7)
    assert store.read(imported['id'])['repair_scope'] == dict(enabled=False, revision=0, pages={})


@pytest.mark.parametrize('rect', [dict(x=-1, y=0, width=1, height=1), dict(x=0, y=0, width=0, height=1), dict(x=0, y=0, width=7, height=1), dict(x=True, y=0, width=1, height=1), dict(x=0.5, y=0, width=1, height=1)])
def test_reject_invalid_scope(rect):
    with pytest.raises(ValueError):
        validate_rect(rect, 6, 4)


def test_unconfigured_page_snapshot_uses_ten_pixel_inset(tmp_path):
    store, _ = make_project(tmp_path)
    source, mask = tmp_path / 'big.png', tmp_path / 'big_mask.png'
    Image.new('RGB', (100, 80)).save(source)
    Image.new('L', (100, 80), 255).save(mask)
    project = store.create('default inset', {'01': source, '02': source}, {'01': mask, '02': mask})
    first, second = project['pages']
    project = store.save_repair_scope(project['id'], first['id'], 0, True, dict(x=0, y=0, width=100, height=80))
    snapshot = store.snapshot(project['id'], project['revision'])
    assert snapshot['pages'][0]['repair_rect'] == dict(x=0, y=0, width=100, height=80)
    assert snapshot['pages'][1]['repair_rect'] == dict(x=10, y=10, width=80, height=60)
    assert second['id'] not in project['repair_scope']['pages']
    assert default_rect(1, 4) == dict(x=0, y=1, width=1, height=2)


def test_snapshot_freezes_effective_mask_preserves_fill_and_default_off(tmp_path):
    store, project = make_project(tmp_path)
    pid, page = project['id'], project['pages'][0]
    mask = Image.new('L', (6, 4)); mask.putpixel((5, 3), 255)
    fill = Image.new('RGBA', (6, 4)); fill.putpixel((0, 0), (255, 0, 0, 255))
    project = store.save_edit(pid, page['id'], 0, fill, mask, Image.new('L', (6, 4)))
    default = store.snapshot(pid, project['revision'])['pages'][0]
    assert not default['passthrough'] and 'repair_rect' not in default
    rect = dict(x=1, y=1, width=3, height=2)
    project = store.save_repair_scope(pid, page['id'], 0, True, rect)
    snap = store.snapshot(pid, project['revision'])['pages'][0]
    assert snap['passthrough'] and snap['repair_rect'] == rect
    with Image.open(store.asset_path(pid, snap['mask'])) as scoped:
        assert scoped.size == (6, 4) and scoped.getbbox() is None
    with Image.open(store.asset_path(pid, snap['source'])) as base:
        assert base.getpixel((0, 0)) == (255, 0, 0)
    with Image.open(store.asset_path(pid, page['other'])) as original_mask:
        # The old edit asset is immutable too.
        assert original_mask.size == (6, 4)
    project = store.save_repair_scope(pid, page['id'], 1, False, rect)
    assert not store.snapshot(pid, project['revision'])['pages'][0]['passthrough']
    assert snap['passthrough']


def test_api_generates_immutable_job_geometry_and_blocks_active_changes(tmp_path):
    store, project = make_project(tmp_path)
    pid, page = project['id'], project['pages'][0]
    repository, manager = JobRepository(tmp_path / 'jobs'), Manager()
    app = FastAPI(); app.include_router(create_project_router(Settings(data_root=tmp_path), repository, manager, store))
    url = f"/api/projects/{pid}/pages/{page['id']}/repair-scope"
    body = dict(revision=0, enabled=True, rect=dict(x=1, y=1, width=3, height=2), apply_all=False)
    with TestClient(app) as client:
        assert client.put(url, json={**body, 'file': 'external.json'}).status_code == 400
        response = client.put(url, json=body)
        assert response.status_code == 200, response.text
        job = client.post(f'/api/projects/{pid}/jobs', json=dict(workflows=['firered'], expected_revision=response.json()['revision']))
        assert job.status_code == 202, job.text
        geometry = json.loads((repository.job_dir(job.json()['id']) / 'input_geometry.json').read_text())
        assert geometry == {'01': body['rect']}
        assert client.put(url, json={**body, 'revision': 1}).status_code == 409


def cropped_job(tmp_path, black=False):
    manager, repository = make_manager(tmp_path)
    record = make_record(); record.pair_count = record.total_runs = 1
    repository.write(record)
    root = repository.job_dir(record.id)
    for folder, image in [('pair', Image.new('RGB', (6, 4), (20, 30, 40))), ('pair_mask', Image.new('L', (6, 4), 0))]:
        path = root / 'uploads' / folder / '01.png'; path.parent.mkdir(parents=True)
        if folder == 'pair_mask' and not black: image.putpixel((2, 1), 255)
        image.save(path)
    atomic_json(root / 'input_geometry.json', {'01': dict(x=1, y=1, width=3, height=2)})
    return manager, repository, record, root


@pytest.mark.parametrize('workflow', ['firered', 'flux2klein_lanpaint', 'qwen2511_lanpaint'])
def test_crop_restore_and_resume_keep_original_size_and_outside_pixels(tmp_path, workflow):
    from app.engine import WORKFLOW_META
    manager, repository, record, root = cropped_job(tmp_path)
    record.workflows = [workflow]; repository.write(record)
    batch, stems = manager._prepare_comfy_input(record)
    for path in [manager.settings.comfy_input / batch / 'pair' / '01.png', manager.settings.comfy_input / f'{batch}_01.png']:
        assert not path.is_symlink()
        with Image.open(path) as image: assert image.size == (3, 2)
    with Image.open(manager.settings.comfy_input / batch / 'pair_mask' / '01.png') as mask:
        assert mask.size == (3, 2) and mask.getpixel((1, 0)) == 255
    prefix = f'web_{record.id.replace("-", "")[:12]}_{WORKFLOW_META[workflow]["prefix"]}_'
    raw = manager.settings.comfy_output / f'{prefix}01_00001_.png'; raw.parent.mkdir(parents=True)
    Image.new('RGB', (3, 2), (255, 0, 0)).save(raw)
    assert manager._sync_available_outputs(record, workflow, prefix, stems, require_all=True) == 1
    final = root / 'inpaint_workflows' / workflow / '01.png'
    with Image.open(final) as image:
        assert image.size == (6, 4)
        for y in range(4):
            for x in range(6):
                assert image.getpixel((x, y)) == ((255, 0, 0) if 1 <= x < 4 and 1 <= y < 3 else (20, 30, 40))
    raw.unlink()
    manager._prepare_existing_outputs(record, stems)
    with Image.open(raw) as image: assert image.size == (3, 2)
    manager._normalize_outputs(record, workflow, prefix, stems)
    with Image.open(final) as image: assert image.size == (6, 4)
    Image.new('RGB', (4, 2)).save(raw)
    with pytest.raises(RuntimeError):
        manager._sync_available_outputs(record, workflow, prefix, stems, require_all=True)
    with Image.open(final) as image: assert image.getpixel((1, 1)) == (255, 0, 0)


def test_cropped_all_black_never_contacts_comfy_and_returns_full_image(tmp_path):
    manager, repository, record, root = cropped_job(tmp_path, black=True)
    manager._wait_comfy = AsyncMock(side_effect=AssertionError('must not contact ComfyUI'))
    asyncio.run(manager._run_job(record.id))
    assert repository.read(record.id).state.value == 'completed'
    manager._wait_comfy.assert_not_called()
    with Image.open(root / 'inpaint_workflows/flux2klein_lanpaint/01.png') as image:
        assert image.size == (6, 4)
