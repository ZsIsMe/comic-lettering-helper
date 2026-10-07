from __future__ import annotations

import asyncio
import io
import threading
import uuid
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from app.config import Settings
from app.project_api import create_project_router
from app.projects import ProjectConflict, ProjectStore
from app.repository import JobRepository
from app.upload_progress import UploadProgressRegistry


def png_bytes(size=(8, 8)):
    output = io.BytesIO()
    Image.new('RGB', size, (20, 30, 40)).save(output, format='PNG')
    return output.getvalue()


def files(*sources, mask=False):
    uploads = [('source_files', (f'{stem}.png', png_bytes(), 'image/png')) for stem in sources]
    if mask:
        uploads.append(('mask_files', (f'{sources[0]}.png', png_bytes(), 'image/png')))
    return uploads


@pytest.fixture
def project_api(tmp_path):
    store = ProjectStore(tmp_path / 'projects')
    app = FastAPI()
    manager = SimpleNamespace(gpu_gate=SimpleNamespace(owner=None))
    app.include_router(create_project_router(Settings(data_root=tmp_path), JobRepository(tmp_path / 'jobs'), manager, store))
    return app, store


def test_progress_can_be_read_during_create_and_completes_only_after_write(project_api, monkeypatch):
    app, store = project_api
    entered, release = threading.Event(), threading.Event()
    write = store.write

    def blocked_write(project):
        entered.set()
        assert release.wait(5), 'test did not release project write'
        write(project)

    monkeypatch.setattr(store, 'write', blocked_write)
    progress_id = uuid.uuid4().hex
    url = f'/api/projects/upload-progress/{progress_id}'

    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            absent = await client.get(url)
            assert absent.status_code == 404
            assert absent.headers['cache-control'] == 'no-store'
            request = asyncio.create_task(client.post(f'/api/projects?progress_id={progress_id}', files=files('01', '02', mask=True)))
            try:
                assert await asyncio.to_thread(entered.wait, 3)
                progress = await asyncio.wait_for(client.get(url), timeout=1)
                assert progress.status_code == 200
                assert progress.headers['cache-control'] == 'no-store'
                assert progress.json() == {'stage': 'creating', 'completed': 2, 'total': 2, 'filename': '02.png', 'error': None}
                assert list(store.root.glob('*/project.json')) == []
                duplicate = await client.post(f'/api/projects?progress_id={progress_id}', files=files('03'))
                assert duplicate.status_code == 409
                assert (await client.get(url)).json()['stage'] == 'creating'
            finally:
                release.set()
            result = await asyncio.wait_for(request, timeout=3)
            assert result.status_code == 201, result.text
            project = result.json()
            assert len(project['pages']) == 2
            assert project['pages'][0]['mask_ready'] is True
            assert project['pages'][1]['mask_ready'] is False
            assert (store.project_dir(project['id']) / 'project.json').is_file()
            assert (await client.get(url)).json() == {'stage': 'completed', 'completed': 2, 'total': 2, 'filename': None, 'error': None}
            duplicate = await client.post(f'/api/projects?progress_id={progress_id}', files=files('03'))
            assert duplicate.status_code == 409
            assert (await client.get(url)).json()['stage'] == 'completed'

    asyncio.run(run())


def test_validation_is_observable_without_blocking_the_event_loop(project_api, monkeypatch):
    from app import storage

    app, _ = project_api
    entered, release = threading.Event(), threading.Event()
    save = storage._save_upload

    def blocked_save(source, target, limit):
        if target.parent.name == 'mask':
            entered.set()
            assert release.wait(5), 'test did not release mask validation'
        return save(source, target, limit)

    monkeypatch.setattr(storage, '_save_upload', blocked_save)
    progress_id = uuid.uuid4().hex

    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            request = asyncio.create_task(client.post(f'/api/projects?progress_id={progress_id}', files=files('01', '02', mask=True)))
            try:
                assert await asyncio.to_thread(entered.wait, 3)
                progress = await asyncio.wait_for(client.get(f'/api/projects/upload-progress/{progress_id}'), timeout=1)
                assert progress.json() == {'stage': 'validating', 'completed': 2, 'total': 3, 'filename': '02.png', 'error': None}
            finally:
                release.set()
            assert (await asyncio.wait_for(request, timeout=3)).status_code == 201

    asyncio.run(run())


def test_failed_validation_is_retained_and_existing_post_contract_works(project_api):
    app, store = project_api
    progress_id = uuid.uuid4().hex
    with TestClient(app) as client:
        failed = client.post(f'/api/projects?progress_id={progress_id}', files=[('source_files', ('bad.png', b'invalid', 'image/png'))])
        assert failed.status_code == 400
        progress = client.get(f'/api/projects/upload-progress/{progress_id}').json()
        assert progress['stage'] == 'failed'
        assert progress['completed'] == 0 and progress['total'] == 1
        assert '圖片無法讀取' in progress['error']
        assert list(store.root.iterdir()) == []
        ordinary = client.post('/api/projects', data={'name': '舊契約'}, files=files('01'))
        assert ordinary.status_code == 201
        assert ordinary.json()['name'] == '舊契約'
        assert len(ordinary.json()['pages']) == 1
        assert 'stage' not in ordinary.json()
        invalid = client.post('/api/projects?progress_id=invalid', files=files('02'))
        assert invalid.status_code == 422


def test_validation_count_includes_masks_before_creation(project_api, monkeypatch):
    app, _ = project_api
    updates = []
    update = UploadProgressRegistry.update

    def record_update(registry, progress_id, **changes):
        updates.append(changes.copy())
        update(registry, progress_id, **changes)

    monkeypatch.setattr(UploadProgressRegistry, 'update', record_update)
    with TestClient(app) as client:
        result = client.post(f'/api/projects?progress_id={uuid.uuid4().hex}', files=files('01', '02', mask=True))
        assert result.status_code == 201
    assert [(entry['completed'], entry['total'], entry['filename']) for entry in updates if entry['stage'] == 'validating'] == [
        (1, 3, '01.png'), (2, 3, '02.png'), (3, 3, '01.png'),
    ]


def test_failed_persistence_does_not_report_completed_and_removes_project(project_api, monkeypatch):
    app, store = project_api

    def fail_write(_project):
        raise OSError('disk full')

    monkeypatch.setattr(store, 'write', fail_write)
    progress_id = uuid.uuid4().hex
    with TestClient(app) as client:
        result = client.post(f'/api/projects?progress_id={progress_id}', files=files('01'))
        assert result.status_code == 400
        assert client.get(f'/api/projects/upload-progress/{progress_id}').json() == {
            'stage': 'failed', 'completed': 1, 'total': 1, 'filename': '01.png', 'error': 'disk full',
        }
    assert list(store.root.iterdir()) == []


def test_create_callback_reports_started_and_finished_pages(project_api, tmp_path):
    _, store = project_api
    sources = {}
    for stem in ('02', '01'):
        source = tmp_path / f'{stem}.png'
        source.write_bytes(png_bytes())
        sources[stem] = source
    calls = []
    project = store.create('progress', sources, progress=lambda *args: calls.append(args))
    assert calls == [(0, 2, '01.png'), (1, 2, '01.png'), (1, 2, '02.png'), (2, 2, '02.png')]
    assert (store.project_dir(project['id']) / 'project.json').is_file()


def test_progress_registry_prunes_finished_entries_and_never_active(monkeypatch):
    from app import upload_progress

    now = [0.0]
    monkeypatch.setattr(upload_progress.time, 'monotonic', lambda: now[0])
    registry = UploadProgressRegistry(ttl_seconds=10, capacity=2)
    registry.register('active', 5)
    registry.register('finished', 1)
    registry.update('finished', stage='completed', completed=1)
    with pytest.raises(ProjectConflict, match='已使用'):
        registry.register('active', 1)
    now[0] = 11
    assert registry.read('active')['stage'] == 'validating'
    with pytest.raises(KeyError):
        registry.read('finished')
    registry.register('second_active', 2)
    with pytest.raises(ProjectConflict, match='過多'):
        registry.register('third', 1)
    registry.update('second_active', stage='failed', error='failed')
    registry.register('third', 1)
    with pytest.raises(KeyError):
        registry.read('second_active')
    copy = registry.read('active')
    copy['completed'] = 99
    assert registry.read('active')['completed'] == 0
