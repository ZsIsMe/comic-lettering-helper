from __future__ import annotations

import asyncio
import io
import json
import zipfile
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from app.config import Settings
from app.project_api import create_project_router, export_project, import_project
from app.projects import ProjectConflict, ProjectStore
from app.repository import JobRepository, now_iso
from app.schemas import JobRecord


def make_project(tmp_path, *, masks=True):
    store = ProjectStore(tmp_path / 'projects')
    original = tmp_path / '01.png'
    mask = tmp_path / 'mask.png'
    Image.new('RGB', (6, 4), (20, 30, 40)).save(original)
    Image.new('L', (6, 4), 0).save(mask)
    project = store.create('測試漫畫', {'01': original}, {'01': mask} if masks else None)
    return store, project


def test_project_requires_original_and_missing_mask_is_not_black(tmp_path):
    store, project = make_project(tmp_path, masks=False)
    assert project['pages'][0]['mask_ready'] is False
    with pytest.raises(ValueError, match='原圖'):
        store.create('空', {})
    with pytest.raises(ValueError, match='尚未準備 Mask'):
        store.snapshot(project['id'], 0)


def test_edit_snapshot_is_immutable_and_black_mask_uses_filled_base(tmp_path):
    store, project = make_project(tmp_path)
    pid, page = project['id'], project['pages'][0]
    first = store.snapshot(pid, 0)
    overlay = Image.new('RGBA', (6, 4))
    overlay.putpixel((1, 1), (240, 230, 220, 255))
    project = store.save_edit(pid, page['id'], 0, overlay, Image.new('L', (6, 4)), Image.new('L', (6, 4), 255))
    second = store.snapshot(pid, project['revision'])
    assert second['pages'][0]['passthrough'] is True
    with Image.open(store.asset_path(pid, first['pages'][0]['source'])) as original:
        assert original.getpixel((1, 1)) == (20, 30, 40)
    with Image.open(store.asset_path(pid, second['pages'][0]['source'])) as filled:
        assert filled.getpixel((1, 1)) == (240, 230, 220)
    with pytest.raises(ProjectConflict):
        store.save_edit(pid, page['id'], 0, overlay, Image.new('L', (6, 4)), Image.new('L', (6, 4)))


def test_repair_mask_and_fill_are_mutually_exclusive(tmp_path):
    store, project = make_project(tmp_path)
    result = store.save_edit(project['id'], project['pages'][0]['id'], 0, Image.new('RGBA', (6, 4), (255, 0, 0, 255)), Image.new('L', (6, 4), 255), Image.new('L', (6, 4)))
    with Image.open(store.asset_path(project['id'], result['pages'][0]['overlay'])) as overlay:
        assert overlay.getchannel('A').getbbox() is None


def test_project_archive_roundtrip_remaps_runs_and_preserves_edits(tmp_path):
    store, project = make_project(tmp_path)
    repository = JobRepository(tmp_path / 'jobs')
    pid = project['id']
    snapshot = store.snapshot(pid, 0)
    stamp = now_iso()
    record = JobRecord(id='oldrun', name='run', project_id=pid, snapshot_id=snapshot['id'], workflows=['firered'], pair_count=1, total_runs=1, created_at=stamp, updated_at=stamp, state='completed', download_ready=True, results={'firered': ['01.png']})
    repository.write(record)
    result = repository.job_dir(record.id) / 'inpaint_workflows' / 'firered' / '01.png'
    result.parent.mkdir(parents=True)
    Image.new('RGB', (6, 4), (100, 110, 120)).save(result)
    project['runs'] = [{'id': record.id, 'snapshot_id': snapshot['id'], 'workflows': record.workflows}]
    project['current_run_id'] = record.id
    store.write(project)
    composition = store.project_dir(pid) / 'compositions' / record.id
    composition.mkdir(parents=True)
    (composition / 'selection.json').write_text(json.dumps({'run_id': record.id, 'snapshot_id': snapshot['id']}))
    # A newer draft must survive while current_run still references the earlier snapshot.
    store.save_edit(pid, project['pages'][0]['id'], 0, Image.new('RGBA', (6, 4), (200, 210, 220, 255)), Image.new('L', (6, 4)), Image.new('L', (6, 4), 255))
    archive = export_project(store, repository, pid)
    new_store = ProjectStore(tmp_path / 'other' / 'projects')
    new_repository = JobRepository(tmp_path / 'other' / 'jobs')
    imported = import_project(new_store, new_repository, archive, 1000000)
    assert imported['id'] != pid
    assert imported['current_run_id'] != 'oldrun'
    new_run = imported['current_run_id']
    assert new_repository.read(new_run).project_id == imported['id']
    assert (new_repository.job_dir(new_run) / 'download.zip').is_file()
    assert json.loads((new_store.project_dir(imported['id']) / 'compositions' / new_run / 'selection.json').read_text())['run_id'] == new_run
    current_snapshot = new_store.snapshot(imported['id'], imported['revision'])
    assert current_snapshot['pages'][0]['passthrough']
    with Image.open(new_store.asset_path(imported['id'], current_snapshot['pages'][0]['source'])) as image:
        assert image.getpixel((0, 0)) == (200, 210, 220)
    with Image.open(new_store.asset_path(imported['id'], snapshot['pages'][0]['source'])) as image:
        assert image.getpixel((0, 0)) == (20, 30, 40)


def test_archive_rejects_traversal_and_unpacked_size(tmp_path):
    store, project = make_project(tmp_path)
    repository = JobRepository(tmp_path / 'jobs')
    archive = tmp_path / 'bad.zip'
    with zipfile.ZipFile(archive, 'w') as handle:
        handle.writestr('../escape', 'bad')
    with pytest.raises(ValueError, match='超出項目'):
        import_project(store, repository, archive, 1000)
    archive = export_project(store, repository, project['id'])
    with pytest.raises(ValueError, match='超過限制'):
        import_project(store, repository, archive, 10)


def test_active_job_or_download_prevents_delete(tmp_path):
    store, project = make_project(tmp_path)
    pid = project['id']
    repository = JobRepository(tmp_path / 'jobs')
    with store.reader(pid):
        with pytest.raises(ProjectConflict, match='下載'):
            store.require_idle(project, repository)
    timestamp = now_iso()
    repository.write(JobRecord(id='running', name='busy', project_id=pid, workflows=['firered'], pair_count=1, total_runs=1, created_at=timestamp, updated_at=timestamp))
    with pytest.raises(ProjectConflict, match='運行'):
        store.require_idle(project, repository)


class Gate:
    owner = None
    def claim(self, owner):
        if self.owner is not None:
            return False
        self.owner = owner
        return True
    def release(self, owner):
        if self.owner == owner:
            self.owner = None


class Manager:
    def __init__(self):
        self.gpu_gate = Gate()
        self.enqueued = []
    async def enqueue(self, job_id):
        self.enqueued.append(job_id)


def test_project_api_submit_snapshots_and_locks_delete(tmp_path):
    store, project = make_project(tmp_path)
    repository = JobRepository(tmp_path / 'jobs')
    manager = Manager()
    app = FastAPI()
    app.include_router(create_project_router(Settings(data_root=tmp_path), repository, manager, store))
    with TestClient(app) as client:
        response = client.post(f"/api/projects/{project['id']}/jobs", json={'workflows': ['firered'], 'expected_revision': 0})
        assert response.status_code == 202, response.text
        job = response.json()
        assert job['snapshot_id']
        assert job['black_mask_count'] == 1
        assert manager.enqueued == [job['id']]
        assert client.delete(f"/api/projects/{project['id']}?confirm=true").status_code == 409
        assert client.post(f"/api/projects/{project['id']}/jobs", json={'workflows': ['firered'], 'expected_revision': 1}).status_code == 409


def png_upload(mode, color):
    data = io.BytesIO()
    Image.new(mode, (6, 4), color).save(data, 'PNG')
    return data.getvalue()


def test_api_mask_replace_preserves_fill_and_asset_read_releases_lock(tmp_path):
    store, project = make_project(tmp_path)
    pid = project['id']
    page_id = project['pages'][0]['id']
    project = store.save_edit(pid, page_id, 0, Image.new('RGBA', (6, 4), (240, 230, 220, 255)), Image.new('L', (6, 4)), Image.new('L', (6, 4)))
    repository = JobRepository(tmp_path / 'jobs')
    app = FastAPI()
    app.include_router(create_project_router(Settings(data_root=tmp_path), repository, Manager(), store))
    with TestClient(app) as client:
        response = client.post(f'/api/projects/{pid}/masks', data={'expected_revision': 1, 'confirm_replace': True}, files={'mask_files': ('01.png', png_upload('L', 255), 'image/png')})
        assert response.status_code == 200, response.text
        page = response.json()['pages'][0]
        image = client.get(f"/api/projects/{pid}/assets/{page['overlay']}")
        assert image.status_code == 200
        with Image.open(io.BytesIO(image.content)) as overlay:
            assert overlay.getpixel((0, 0)) == (240, 230, 220, 255)
        assert client.delete(f'/api/projects/{pid}?confirm=true').status_code == 200
        assert not store.project_dir(pid).exists()


def test_archive_content_hash_rejects_tampered_original(tmp_path):
    store, project = make_project(tmp_path)
    repository = JobRepository(tmp_path / 'jobs')
    archive = export_project(store, repository, project['id'])
    tampered = tmp_path / 'tampered.zip'
    with zipfile.ZipFile(archive) as source, zipfile.ZipFile(tampered, 'w') as target:
        for name in source.namelist():
            content = b'changed' if name == project['pages'][0]['original'] else source.read(name)
            target.writestr(name, content)
    with pytest.raises(ValueError, match='校驗失敗'):
        import_project(store, repository, tampered, 1000000)
    assert len(store.list()) == 1


def test_submit_failure_releases_gpu_gate(tmp_path):
    store, project = make_project(tmp_path, masks=False)
    repository = JobRepository(tmp_path / 'jobs')
    manager = Manager()
    app = FastAPI()
    app.include_router(create_project_router(Settings(data_root=tmp_path), repository, manager, store))
    with TestClient(app) as client:
        response = client.post(f"/api/projects/{project['id']}/jobs", json={'workflows': ['firered'], 'expected_revision': 0})
        assert response.status_code == 400
        assert manager.gpu_gate.owner is None
        assert repository.list() == []


def test_recovery_job_blocks_new_project_submission_before_worker_reserves_gate(tmp_path):
    store, project = make_project(tmp_path)
    repository = JobRepository(tmp_path / 'jobs')
    timestamp = now_iso()
    repository.write(JobRecord(id='legacy-recovery', name='old', workflows=['firered'], pair_count=1, total_runs=1, created_at=timestamp, updated_at=timestamp, state='queued'))
    manager = Manager()
    app = FastAPI()
    app.include_router(create_project_router(Settings(data_root=tmp_path), repository, manager, store))
    with TestClient(app) as client:
        response = client.post(f"/api/projects/{project['id']}/jobs", json={'workflows': ['firered'], 'expected_revision': 0})
        assert response.status_code == 409
        assert manager.gpu_gate.owner is None
        assert manager.enqueued == []


def test_delete_cleans_owned_orphan_job_but_keeps_legacy_jobs(tmp_path):
    store, project = make_project(tmp_path)
    repository = JobRepository(tmp_path / 'jobs')
    timestamp = now_iso()
    for job_id, project_id in [('owned-orphan', project['id']), ('legacy', None)]:
        repository.write(JobRecord(id=job_id, name=job_id, project_id=project_id, workflows=['firered'], pair_count=1, total_runs=1, created_at=timestamp, updated_at=timestamp, state='failed'))
    app = FastAPI()
    app.include_router(create_project_router(Settings(data_root=tmp_path), repository, Manager(), store))
    with TestClient(app) as client:
        response = client.delete(f"/api/projects/{project['id']}?confirm=true")
        assert response.status_code == 200
    assert not repository.job_dir('owned-orphan').exists()
    assert repository.job_dir('legacy').is_dir()


def test_thumbnail_is_small_source_is_unchanged_and_archive_rebuilds_it(tmp_path):
    store = ProjectStore(tmp_path / 'projects')
    repository = JobRepository(tmp_path / 'jobs')
    original = tmp_path / 'large.png'
    Image.new('RGB', (600, 800), (70, 80, 90)).save(original)
    project = store.create('縮圖', {'large': original})
    page = project['pages'][0]
    with Image.open(store.asset_path(project['id'], page['thumbnail'])) as thumbnail:
        assert thumbnail.size == (180, 240)
    with Image.open(store.asset_path(project['id'], page['source'])) as source:
        assert source.size == (600, 800)
        assert source.getpixel((0, 0)) == (70, 80, 90)
    archive = export_project(store, repository, project['id'])
    with zipfile.ZipFile(archive) as handle:
        assert page['thumbnail'] not in handle.namelist()
    imported = import_project(store, repository, archive, 1000000)
    with Image.open(store.asset_path(imported['id'], imported['pages'][0]['thumbnail'])) as thumbnail:
        assert thumbnail.size == (180, 240)


def test_replaced_mask_preserves_fill_and_protects_added_and_erased_pixels_from_detection(tmp_path, monkeypatch):
    import numpy as np
    from imaging import core

    store, project = make_project(tmp_path)
    pid, page_id = project['id'], project['pages'][0]['id']
    overlay = Image.new('RGBA', (6, 4))
    overlay.putpixel((0, 0), (255, 255, 255, 255))
    old_other = Image.new('L', (6, 4))
    old_other.putpixel((1, 0), 255)
    edited = Image.new('L', (6, 4))
    edited.putpixel((3, 0), 255)
    store.save_edit(pid, page_id, 0, overlay, old_other, edited)
    new_other = Image.new('L', (6, 4))
    new_other.putpixel((0, 0), 255)  # Existing fill wins over this overlap.
    new_other.putpixel((2, 0), 255)  # Add repair here, erase the old repair at (1,0).
    project = store.save_edit(pid, page_id, 1, overlay, new_other, edited, preserve_overlay=True)
    page = project['pages'][0]
    layers = {}
    for key in ('source', 'overlay', 'other', 'edited'):
        with Image.open(store.asset_path(pid, page[key])) as image:
            layers[key] = np.array(image)
    assert not np.any((layers['overlay'][:, :, 3] > 0) & (layers['other'] > 0))
    assert layers['other'][0, :4].tolist() == [0, 0, 255, 0]
    assert layers['edited'][0, :4].tolist() == [255, 255, 255, 255]

    def new_detection(*args):
        fresh_overlay = np.zeros((4, 6, 4), np.uint8)
        fresh_overlay[:, :] = [0, 0, 255, 255]
        return fresh_overlay, np.zeros((4, 6), np.uint8), None, {}
    monkeypatch.setattr(core, '_solid_overlay_from_mask', new_detection)
    result, remaining, protection, _ = core.classify_page(layers['source'], np.full((4, 6), 255, np.uint8), [], overlay=layers['overlay'], other=layers['other'], edited=layers['edited'])
    assert remaining[0, :4].tolist() == [0, 0, 255, 0]
    assert result[0, 0].tolist() == [255, 255, 255, 255]
    assert result[0, 1].tolist() == [0, 0, 0, 0]  # Erasure survives re-detection.
    assert result[0, 2].tolist() == [0, 0, 0, 0]
    assert np.array_equal(protection, layers['edited'])


def test_detected_text_is_optional_immutable_and_roundtrips_with_manual_edits(tmp_path):
    store, project = make_project(tmp_path)
    repository = JobRepository(tmp_path / 'jobs')
    pid, page_id = project['id'], project['pages'][0]['id']
    assert 'detected_text' not in project['pages'][0]
    text = Image.new('L', (6, 4))
    text.putpixel((1, 1), 255)
    overlay, other, edited = Image.new('RGBA', (6, 4)), Image.new('L', (6, 4)), Image.new('L', (6, 4))
    project = store.save_edit(pid, page_id, 0, overlay, other, edited, detected_text=text)
    first_path = project['pages'][0]['detected_text']
    project = store.save_edit(pid, page_id, 1, overlay, other, edited, detected_text=Image.new('L', (6, 4), 255))
    second_path = project['pages'][0]['detected_text']
    assert first_path != second_path
    with Image.open(store.asset_path(pid, first_path)) as first:
        assert first.getpixel((0, 0)) == 0
        assert first.getpixel((1, 1)) == 255
    project = store.save_edit(pid, page_id, 2, overlay, other, edited)
    assert project['pages'][0]['detected_text'] == second_path
    archive = export_project(store, repository, pid)
    imported = import_project(store, repository, archive, 1000000)
    imported_page = imported['pages'][0]
    with Image.open(store.asset_path(imported['id'], imported_page['detected_text'])) as image:
        assert image.mode == 'L'
        assert image.size == (6, 4)
        assert image.getextrema() == (255, 255)


def test_detected_text_save_failure_does_not_publish_partial_revision(tmp_path, monkeypatch):
    store, project = make_project(tmp_path)
    pid, page_id = project['id'], project['pages'][0]['id']
    before = (store.project_dir(pid) / 'project.json').read_bytes()
    save = Image.Image.save
    def failed_save(image, path, *args, **kwargs):
        if 'detected-text-' in str(path):
            raise OSError('simulated asset write failure')
        return save(image, path, *args, **kwargs)
    monkeypatch.setattr(Image.Image, 'save', failed_save)
    with pytest.raises(OSError, match='write failure'):
        store.save_edit(pid, page_id, 0, Image.new('RGBA', (6, 4)), Image.new('L', (6, 4)), Image.new('L', (6, 4)), detected_text=Image.new('L', (6, 4)))
    assert (store.project_dir(pid) / 'project.json').read_bytes() == before
    assert 'detected_text' not in store.read(pid)['pages'][0]


@pytest.mark.parametrize('invalid', ['path', 'mode', 'size', 'missing'])
def test_import_validates_optional_detected_text_asset(tmp_path, invalid):
    store, project = make_project(tmp_path)
    repository = JobRepository(tmp_path / 'jobs')
    pid, page_id = project['id'], project['pages'][0]['id']
    project = store.save_edit(pid, page_id, 0, Image.new('RGBA', (6, 4)), Image.new('L', (6, 4)), Image.new('L', (6, 4)), detected_text=Image.new('L', (6, 4)))
    text_path = store.asset_path(pid, project['pages'][0]['detected_text'])
    if invalid == 'path':
        project['pages'][0]['detected_text'] = '../outside.png'
        store.write(project)
    elif invalid == 'mode':
        Image.new('RGB', (6, 4)).save(text_path)
    elif invalid == 'size':
        Image.new('L', (7, 4)).save(text_path)
    else:
        text_path.unlink()
    archive = export_project(store, repository, pid)
    with pytest.raises(ValueError):
        import_project(store, repository, archive, 1000000)
    assert len(store.list()) == 1


def test_create_project_detection_settings_survive_reopen_and_archive_without_running_models(tmp_path):
    store = ProjectStore(tmp_path / 'projects')
    repository, manager = JobRepository(tmp_path / 'jobs'), Manager()
    app = FastAPI()
    app.include_router(create_project_router(Settings(data_root=tmp_path), repository, manager, store))
    options = dict(mask_dilate=7, mask_mode='onomatopoeia', bubble_enabled=False, bubble_shrink_percent=3.5)
    with TestClient(app) as client:
        response = client.post('/api/projects', data={'name': 'new settings', 'detection_options': json.dumps(options)},
            files={'source_files': ('01.png', png_upload('RGB', 'white'), 'image/png')})
        assert response.status_code == 201, response.text
        project = response.json()
        assert project['detection_options'] == options
        assert client.get(f"/api/projects/{project['id']}").json()['detection_options'] == options
    assert project['revision'] == 0
    assert project['state'] == 'ready'
    assert 'detection_id' not in project
    assert not project['pages'][0]['mask_ready']
    assert not (store.project_dir(project['id']) / 'detections').exists()
    assert manager.enqueued == []
    assert manager.gpu_gate.owner is None
    reopened = ProjectStore(store.root).read(project['id'])
    assert reopened['detection_options'] == options
    archive = export_project(store, repository, project['id'])
    new_store = ProjectStore(tmp_path / 'restored')
    imported = import_project(new_store, repository, archive, 1000000)
    assert imported['id'] != project['id']
    assert imported['detection_options'] == options
    assert new_store.read(imported['id'])['detection_options'] == options


@pytest.mark.parametrize('settings', ['not json', 'null', '[]', '{}',
    json.dumps(dict(mask_dilate=65, mask_mode='text', bubble_enabled=True, bubble_shrink_percent=2)),
    json.dumps(dict(mask_dilate=2, mask_mode='text', bubble_enabled=True, bubble_shrink_percent=11)),
    json.dumps(dict(mask_dilate=2, mask_mode='text', bubble_enabled=True, bubble_shrink_percent=2, device='cpu')),
])
def test_create_rejects_invalid_detection_settings_before_persisting_project(tmp_path, settings):
    store = ProjectStore(tmp_path / 'projects')
    app = FastAPI()
    app.include_router(create_project_router(Settings(data_root=tmp_path), JobRepository(tmp_path / 'jobs'), Manager(), store))
    with TestClient(app) as client:
        response = client.post('/api/projects', data={'detection_options': settings},
            files={'source_files': ('01.png', png_upload('RGB', 'white'), 'image/png')})
    assert response.status_code == 400, response.text
    assert store.list() == []
    assert not list(store.root.iterdir())


def test_create_without_detection_settings_retains_existing_api_behavior(tmp_path):
    store = ProjectStore(tmp_path / 'projects')
    app = FastAPI()
    app.include_router(create_project_router(Settings(data_root=tmp_path), JobRepository(tmp_path / 'jobs'), Manager(), store))
    with TestClient(app) as client:
        response = client.post('/api/projects', files={'source_files': ('01.png', png_upload('RGB', 'white'), 'image/png')})
    assert response.status_code == 201
    assert 'detection_options' not in response.json()


def test_page_repair_status_uses_current_mask_and_supports_old_projects(tmp_path):
    store, project = make_project(tmp_path)
    pid, page = project['id'], project['pages'][0]
    assert store.read(pid)['pages'][0]['has_repair_mask'] is False
    mask = Image.new('L', (6, 4)); mask.putpixel((2, 2), 255)
    result = store.save_edit(pid, page['id'], 0, Image.new('RGBA', (6, 4)), mask, Image.new('L', (6, 4)))
    assert result['pages'][0]['has_repair_mask'] is True
    result['pages'][0].pop('has_repair_mask')
    store.write(result)
    assert store.read(pid)['pages'][0]['has_repair_mask'] is True
    store.save_edit(pid, page['id'], 1, Image.new('RGBA', (6, 4)), Image.new('L', (6, 4)), Image.new('L', (6, 4)))
    assert store.read(pid)['pages'][0]['has_repair_mask'] is False


@pytest.mark.parametrize('value', [0, 255])
def test_partial_uploaded_masks_are_ready_even_when_black(tmp_path, value):
    store, _ = make_project(tmp_path)
    source, mask = tmp_path / '01.png', tmp_path / 'mask.png'
    Image.new('L', (6, 4), value).save(mask)
    project = store.create('partial', {'01': source, '02': source}, {'01': mask})
    first, second = project['pages']
    assert first['mask_ready'] is True and second['mask_ready'] is False
    with Image.open(store.asset_path(project['id'], first['other'])) as saved:
        assert saved.getextrema() == (value, value)
    with pytest.raises(ValueError, match='尚未準備 Mask'):
        store.snapshot(project['id'], 0)
    with pytest.raises(ValueError, match='多餘'):
        store.create('invalid', {'01': source}, {'03': mask})
    Image.new('L', (2, 2)).save(mask)
    with pytest.raises(ValueError, match='尺寸'):
        store.create('invalid', {'01': source, '02': source}, {'01': mask})
