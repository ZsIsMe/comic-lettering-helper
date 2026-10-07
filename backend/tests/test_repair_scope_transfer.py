"""Portable repair bounds use filenames, never transient project/page IDs."""
import io
import json
import uuid
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from app.config import Settings
from app.project_api import create_project_router
from app.projects import ProjectConflict, ProjectStore
from app.repair_scope import MAX_SCOPE_BYTES, default_rect
from app.repository import JobRepository


def image_bytes(size=(80, 60), mode='RGB', format='PNG'):
    output = io.BytesIO()
    Image.new(mode, size, 255).save(output, format=format)
    return output.getvalue()


@pytest.fixture
def api(tmp_path):
    store = ProjectStore(tmp_path / 'projects')
    app = FastAPI()
    manager = SimpleNamespace(gpu_gate=SimpleNamespace(owner=None))
    app.include_router(create_project_router(Settings(data_root=tmp_path), JobRepository(tmp_path / 'jobs'), manager, store))
    with TestClient(app) as client:
        yield client, store


def post_project(client, scope=None, *, raw=None, progress_id=None):
    uploads = [
        ('source_files', ('第二頁.png', image_bytes(), 'image/png')),
        ('source_files', ('001.JPG', image_bytes(format='JPEG'), 'image/jpeg')),
        ('mask_files', ('001.png', image_bytes(mode='L'), 'image/png')),
    ]
    if scope is not None or raw is not None:
        uploads.append(('repair_scope_file', ('repair_scope.json', raw if raw is not None else json.dumps(scope).encode(), 'application/json')))
    url = '/api/projects' + (f'?progress_id={progress_id}' if progress_id else '')
    return client.post(url, files=uploads)


def portable_scope(**overrides):
    return {'enabled': True, 'revision': 9, 'pages': {'001.JPG': dict(x=2, y=3, width=30, height=20)}, **overrides}


def test_filename_export_import_roundtrip_defaults_and_revision_reset(api):
    client, store = api
    original = post_project(client).json()
    first = original['pages'][0]
    changed = client.put(f"/api/projects/{original['id']}/pages/{first['id']}/repair-scope", json={
        'revision': 0, 'enabled': True, 'rect': dict(x=2, y=3, width=30, height=20),
    }).json()
    before = store.read(original['id'])
    exported = client.get(f"/api/projects/{original['id']}/repair-scope/export")
    assert exported.status_code == 200
    assert exported.headers['cache-control'] == 'no-store'
    assert exported.headers['content-disposition'] == 'attachment; filename="repair_scope.json"'
    assert exported.headers['content-type'] == 'application/json'
    payload = exported.json()
    assert payload == {
        'enabled': True, 'revision': 1,
        'pages': {'001.JPG': changed['repair_scope']['pages'][first['id']], '第二頁.png': default_rect(80, 60)},
    }
    assert '第二頁.png'.encode() in exported.content
    assert store.read(original['id']) == before
    imported = post_project(client, raw=exported.content)
    assert imported.status_code == 201, imported.text
    project = imported.json()
    assert project['id'] != original['id']
    assert not {p['id'] for p in project['pages']} & {p['id'] for p in original['pages']}
    assert project['repair_scope']['enabled'] is True
    assert project['repair_scope']['revision'] == 0
    assert project['revision'] == 0
    assert {page['filename']: project['repair_scope']['pages'][page['id']] for page in project['pages']} == payload['pages']
    assert [page['mask_ready'] for page in project['pages']] == [True, False]
    assert store.read(project['id'])['repair_scope'] == project['repair_scope']
    persisted = json.loads((store.project_dir(project['id']) / 'project.json').read_text())
    assert 'repair_scope' not in persisted
    snapshot = store.snapshot(project['id'], 0, [project['pages'][0]['id']])
    assert snapshot['pages'][0]['repair_rect'] == payload['pages']['001.JPG']
    assert snapshot['pages'][0]['passthrough'] is False


@pytest.mark.parametrize('enabled', [True, False])
def test_partial_scope_preserves_disabled_and_missing_page_defaults(api, enabled):
    client, store = api
    progress_id = uuid.uuid4().hex
    response = post_project(client, portable_scope(enabled=enabled), progress_id=progress_id)
    assert response.status_code == 201, response.text
    project = response.json()
    assert len(project['repair_scope']['pages']) == 1
    exported = client.get(f"/api/projects/{project['id']}/repair-scope/export").json()
    assert exported['enabled'] is enabled
    assert exported['pages']['第二頁.png'] == default_rect(80, 60)
    snapshot = store.snapshot(project['id'], 0, [project['pages'][0]['id']])
    assert ('repair_rect' in snapshot['pages'][0]) is enabled
    assert client.get(f'/api/projects/upload-progress/{progress_id}').json() == {
        'stage': 'completed', 'completed': 2, 'total': 2, 'filename': None, 'error': None,
    }


def test_default_export_without_settings_and_optional_revision(api):
    client, _ = api
    response = post_project(client)
    project = response.json()
    assert 'repair_scope' not in project  # Existing POST shape remains unchanged.
    payload = client.get(f"/api/projects/{project['id']}/repair-scope/export").json()
    assert payload['enabled'] is False and payload['revision'] == 0
    assert payload['pages'] == {'001.JPG': default_rect(80, 60), '第二頁.png': default_rect(80, 60)}
    del payload['revision']
    assert post_project(client, payload).json()['repair_scope']['revision'] == 0


@pytest.mark.parametrize('scope', [
    [],
    {'enabled': True},
    portable_scope(enabled='true'),
    portable_scope(pages=[]),
    portable_scope(revision=True),
    portable_scope(revision=-1),
    portable_scope(revision=1.5),
    portable_scope(extra=True),
    portable_scope(pages={'old-random-page-id': dict(x=0, y=0, width=1, height=1)}),
    portable_scope(pages={'folder/001.JPG': dict(x=0, y=0, width=1, height=1)}),
    portable_scope(pages={'folder\\001.JPG': dict(x=0, y=0, width=1, height=1)}),
    portable_scope(pages={'._001.JPG': dict(x=0, y=0, width=1, height=1)}),
    portable_scope(pages={'.001.JPG': dict(x=0, y=0, width=1, height=1)}),
    portable_scope(pages={'a b.png': {}, 'a_b.png': {}}),
])
def test_invalid_scope_does_not_leave_project_or_alter_existing(api, scope):
    client, store = api
    previous = post_project(client).json()
    before = store.read(previous['id'])
    progress_id = uuid.uuid4().hex
    response = post_project(client, scope, progress_id=progress_id)
    assert response.status_code == 400, response.text
    assert [path.name for path in store.root.iterdir()] == [previous['id']]
    assert store.read(previous['id']) == before
    assert client.get(f'/api/projects/upload-progress/{progress_id}').json()['stage'] == 'failed'


@pytest.mark.parametrize('raw', [
    b'not json', b'\xff',
    b'{"enabled":true,"enabled":false,"pages":{}}',
    b'{"enabled":true,"pages":{"001.JPG":{},"001.JPG":{}}}',
    b'{"enabled":true,"pages":{"001.JPG":{"x":0,"x":1,"y":0,"width":1,"height":1}}}',
    b' ' * (MAX_SCOPE_BYTES + 1),
])
def test_duplicate_json_keys_invalid_encoding_and_size_are_rejected(api, raw):
    client, store = api
    result = post_project(client, raw=raw)
    assert result.status_code == 400, result.text
    assert list(store.root.iterdir()) == []


def test_scope_is_persisted_before_project_publication_and_failure_cleans_up(api, monkeypatch):
    client, store = api
    def fail_write(project):
        scope = json.loads((store.project_dir(project['id']) / 'repair_scope.json').read_text())
        assert scope == project['repair_scope']
        assert not (store.project_dir(project['id']) / 'project.json').exists()
        raise OSError('disk full')
    monkeypatch.setattr(store, 'write', fail_write)
    result = post_project(client, portable_scope())
    assert result.status_code == 400 and 'disk full' in result.text
    assert list(store.root.iterdir()) == []


def test_export_uses_reader_and_does_not_export_deleting_project(api, monkeypatch):
    client, store = api
    project = post_project(client).json()
    pid = project['id']
    read = store.read
    def observed_read(project_id):
        result = read(project_id)
        if store._readers.get(project_id):
            with pytest.raises(ProjectConflict, match='下載'):
                store.require_idle(result)
        return result
    monkeypatch.setattr(store, 'read', observed_read)
    assert client.get(f'/api/projects/{pid}/repair-scope/export').status_code == 200
    assert store._readers[pid] == 0
    project['state'] = 'deleting'
    store.write(project)
    assert client.get(f'/api/projects/{pid}/repair-scope/export').status_code == 409
    assert client.get('/api/projects/missing/repair-scope/export').status_code == 404


def test_ambiguous_existing_filename_export_is_rejected(tmp_path):
    store = ProjectStore(tmp_path / 'projects')
    original = tmp_path / '001.png'
    original.write_bytes(image_bytes())
    project = store.create('ambiguous', {'01': original, '02': original})
    with pytest.raises(ValueError, match='重複'):
        store.export_repair_scope(project['id'])


def test_all_skipped_preflight_precedes_create_progress_and_asset_writes(tmp_path, monkeypatch):
    from app import projects
    store = ProjectStore(tmp_path / 'projects')
    original = tmp_path / '001.png'
    original.write_bytes(image_bytes())
    progress = []

    def unexpected_copy(*_args):
        pytest.fail('Invalid scope must fail before copying project assets')

    monkeypatch.setattr(projects.shutil, 'copyfile', unexpected_copy)
    with pytest.raises(ValueError, match='沒有可匯入的圖片.*001.png.*位於圖片內'):
        store.create('invalid', {'001': original}, repair_scope=portable_scope(pages={'001.png': dict(x=0, y=0, width=81, height=1)}),
                     progress=lambda *args: progress.append(args))
    assert progress == []
    assert list(store.root.iterdir()) == []


@pytest.mark.parametrize('rect', [
    dict(x=0.1, y=0, width=1, height=1),
    dict(x=True, y=0, width=1, height=1),
    dict(x=0, y=0, width=81, height=1),
    dict(x=0, y=0, width=0, height=1),
    dict(x=-1, y=0, width=1, height=1),
    {'x': 0, 'y': 0, 'width': 1},
    dict(x=0, y=0, width=1, height=1, extra=0),
    None,
])
def test_invalid_matched_rect_skips_only_its_source_and_mask(api, rect):
    client, store = api
    result = post_project(client, portable_scope(pages={'001.JPG': rect}))
    assert result.status_code == 201, result.text
    project = result.json()
    assert [page['filename'] for page in project['pages']] == ['第二頁.png']
    assert project['pages'][0]['mask_ready'] is False
    assert project['repair_scope'] == {'enabled': True, 'revision': 0, 'pages': {}}
    assert project['repair_scope_import']['skipped_images'][0]['filename'] == '001.JPG'
    assert project['repair_scope_import']['skipped_images'][0]['reason']
    assert project['repair_scope_import']['ignored_entries'] == []
    assert store.read(project['id'])['repair_scope_import'] == project['repair_scope_import']
    exported = client.get(f"/api/projects/{project['id']}/repair-scope/export").json()
    assert exported['pages'] == {'第二頁.png': default_rect(80, 60)}


def test_unknown_entries_are_ignored_and_do_not_match_stem_or_case(api):
    client, _ = api
    # Both entries are unknown, including one with an invalid rectangle.
    result = post_project(client, portable_scope(pages={'001.jpg': {}, 'missing.png': None}))
    assert result.status_code == 201, result.text
    project = result.json()
    assert len(project['pages']) == 2
    assert project['repair_scope']['pages'] == {}
    assert project['repair_scope_import'] == {
        'skipped_images': [], 'ignored_entries': [
            {'filename': '001.jpg', 'reason': '裁切 JSON 沒有對應的原圖'},
            {'filename': 'missing.png', 'reason': '裁切 JSON 沒有對應的原圖'},
        ],
    }


def test_mixed_import_preserves_valid_and_default_pages_counts_and_report(api, monkeypatch):
    from app.upload_progress import UploadProgressRegistry
    client, store = api
    updates = []
    update = UploadProgressRegistry.update

    def observed_update(registry, progress_id, **changes):
        updates.append(changes.copy())
        update(registry, progress_id, **changes)

    monkeypatch.setattr(UploadProgressRegistry, 'update', observed_update)
    rect = dict(x=5, y=4, width=20, height=10)
    scope = portable_scope(pages={
        '001.png': dict(x=0, y=0, width=81, height=1),
        '002.png': rect, 'missing.png': rect,
    })
    uploads = [
        ('source_files', (f'{stem}.png', image_bytes(), 'image/png')) for stem in ('001', '002', '003')
    ] + [
        ('mask_files', (f'{stem}.png', image_bytes(mode='L'), 'image/png')) for stem in ('001', '002')
    ] + [('repair_scope_file', ('scope.json', json.dumps(scope), 'application/json'))]
    progress_id = uuid.uuid4().hex
    result = client.post(f'/api/projects?progress_id={progress_id}', files=uploads)
    assert result.status_code == 201, result.text
    project = result.json()
    assert [page['filename'] for page in project['pages']] == ['002.png', '003.png']
    assert [page['order'] for page in project['pages']] == [0, 1]
    assert [page['mask_ready'] for page in project['pages']] == [True, False]
    assert project['repair_scope']['pages'] == {project['pages'][0]['id']: rect}
    assert project['repair_scope_import'] == {
        'skipped_images': [{'filename': '001.png', 'reason': '作用範圍必須位於圖片內，且寬高至少為 1 像素'}],
        'ignored_entries': [{'filename': 'missing.png', 'reason': '裁切 JSON 沒有對應的原圖'}],
    }
    assert store.read(project['id'])['repair_scope_import'] == project['repair_scope_import']
    assert len(list((store.project_dir(project['id']) / 'originals').iterdir())) == 2
    validation = [entry for entry in updates if entry['stage'] == 'validating']
    assert [(entry['completed'], entry['total']) for entry in validation] == [(i, 5) for i in range(1, 6)]
    creating = [entry for entry in updates if entry['stage'] == 'creating']
    assert [(entry['completed'], entry['total'], entry['filename']) for entry in creating] == [
        (0, 2, '002.png'), (1, 2, '002.png'), (1, 2, '003.png'), (2, 2, '003.png'),
    ]
    assert client.get(f'/api/projects/upload-progress/{progress_id}').json() == {
        'stage': 'completed', 'completed': 2, 'total': 2, 'filename': None, 'error': None,
    }
    exported = client.get(f"/api/projects/{project['id']}/repair-scope/export").json()
    assert exported['pages'] == {'002.png': rect, '003.png': default_rect(80, 60)}
    assert store.snapshot(project['id'], 0, [project['pages'][0]['id']])['pages'][0]['repair_rect'] == rect


def test_all_sources_skipped_is_failed_without_an_empty_project(api):
    client, store = api
    progress_id = uuid.uuid4().hex
    result = post_project(client, portable_scope(pages={
        '001.JPG': dict(x=0, y=0, width=81, height=1),
        '第二頁.png': dict(x=0, y=0, width=1, height=61),
    }), progress_id=progress_id)
    assert result.status_code == 400, result.text
    assert '沒有可匯入的圖片' in result.json()['detail']
    assert '001.JPG' in result.json()['detail'] and '第二頁.png' in result.json()['detail']
    assert list(store.root.iterdir()) == []
    progress = client.get(f'/api/projects/upload-progress/{progress_id}').json()
    assert progress['stage'] == 'failed' and progress['total'] == 3
    assert '沒有可匯入的圖片' in progress['error']
