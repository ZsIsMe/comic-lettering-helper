import asyncio
import io
import json
import threading
import zipfile
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image, ImageCms

from app.config import Settings
from app.edgewhite import EdgeWhiteStore
from app.edgewhite_api import Workspace, LeasedFile, create_edgewhite_router
from app.projects import ProjectConflict, digest_file
from app.resources import ResourceGate
from imaging.edgewhite import Edit, normalize


def source(tmp_path, name='1.png', size=(12, 10), color=(10, 20, 30)):
    path = tmp_path / name
    Image.new('RGB', size, color).save(path)
    return path


def setup(tmp_path):
    store = EdgeWhiteStore(tmp_path / 'data' / 'edgewhite')
    image = source(tmp_path)
    collection = store.create('清理', [('10.png', image), ('2.png', image), ('1.png', image)])
    return store, collection


def edit():
    return Edit(verticalGuides=[4, 8], horizontalGuides=[3, 7], selectedCells=[{'column': 1, 'row': 0}])


def test_source_preservation_natural_order_and_full_output(tmp_path):
    store, c = setup(tmp_path)
    assert [p['filename'] for p in c['pages']] == ['1.png', '2.png', '10.png']
    page = c['pages'][0]
    original = store.directory(c['id']) / page['id'] / 'original.png'
    before = digest_file(original)
    c = store.save(c['id'], page['id'], 0, edit(), output=True)
    assert c['pages'][0]['revision'] == c['pages'][0]['output_revision'] == 1
    path, release = store.download(c['id'])
    try:
        with zipfile.ZipFile(path) as z:
            assert set(z.namelist()) == {'deal/1.png', 'deal/2.png', 'deal/10.png', 'edgewhite_guides.json'}
            with Image.open(io.BytesIO(z.read('deal/1.png'))) as im:
                assert im.size == (12, 10)
                for y in range(10):
                    for x in range(12):
                        assert im.getpixel((x, y)) == ((255, 255, 255) if 4 <= x < 8 and 0 <= y < 3 else (10, 20, 30))
            with Image.open(io.BytesIO(z.read('deal/2.png'))) as im:
                assert im.getpixel((5, 0)) == (10, 20, 30)
            assert json.loads(z.read('edgewhite_guides.json'))['images']['1.png'] == edit().model_dump()
        assert digest_file(original) == before
    finally:
        release()


def test_drafts_require_explicit_output_and_restore_after_restart(tmp_path):
    store, c = setup(tmp_path)
    p = c['pages'][0]
    c = store.save(c['id'], p['id'], 0, edit())
    assert c['pages'][0]['output_revision'] == 0
    with pytest.raises(ProjectConflict, match='先逐頁保存'):
        store.download(c['id'])
    restored = EdgeWhiteStore(store.root)
    assert restored.read(c['id'])['pages'][0]['edit'] == edit().model_dump()
    with pytest.raises(ProjectConflict, match='其他分頁'):
        restored.save(c['id'], p['id'], 0, Edit())
    saved = restored.save(c['id'], p['id'], 1, edit(), True)
    output = restored.directory(c['id']) / saved['pages'][0]['output']
    old_hash = digest_file(output)
    restored.save(c['id'], p['id'], 1, Edit(), True)
    assert digest_file(output) == old_hash
    with Image.open(restored.directory(c['id']) / restored.read(c['id'])['pages'][0]['output']) as im:
        assert im.getpixel((5, 0)) == (10, 20, 30)


def test_json_import_validates_all_pages_atomically_and_supports_partial_workspace(tmp_path):
    store, c = setup(tmp_path)
    workspace = Workspace(version=1, images={'1.png': edit(), '2.png': Edit(verticalGuides=[99])})
    with pytest.raises(ValueError, match='圖片內部'):
        store.import_guides(c['id'], 0, workspace)
    assert store.read(c['id']) == c
    for images in [{'missing.png': edit()}, {'1.png': Edit(verticalGuides=[4, 4])}, {'1.png': Edit(selectedCells=[{'row': 0, 'column': 0}])}]:
        with pytest.raises(ValueError):
            store.import_guides(c['id'], 0, Workspace(version=1, images=images))
    c = store.import_guides(c['id'], 0, Workspace(version=1, images={'1.png': edit()}))
    assert c['pages'][1]['revision'] == 0
    assert store.guides(c) == {'version': 1, 'images': {'1.png': edit().model_dump()}}
    with pytest.raises(ProjectConflict):
        store.import_guides(c['id'], 0, Workspace(version=1, images={'1.png': edit()}))


def test_reader_prevents_delete_and_response_disconnect_releases(tmp_path):
    store, c = setup(tmp_path)
    path, release = store.download(c['id'])
    with pytest.raises(ProjectConflict, match='正在下載'):
        store.delete(c['id'])
    response = LeasedFile(path, release, temporary=True)
    async def fail_send(message):
        raise ConnectionError('disconnected')
    async def receive():
        return {'type': 'http.disconnect'}
    with pytest.raises(ConnectionError):
        asyncio.run(response({'type': 'http', 'method': 'GET', 'headers': []}, receive, fail_send))
    assert not path.exists()
    release()  # idempotent
    store.delete(c['id'])
    assert not store.directory(c['id']).exists()


def test_concurrent_save_has_one_winner_and_no_lost_update(tmp_path):
    store, c = setup(tmp_path)
    barrier = threading.Barrier(2)
    results = []
    def save():
        barrier.wait()
        try:
            store.save(c['id'], c['pages'][0]['id'], 0, edit())
            results.append('saved')
        except ProjectConflict:
            results.append('conflict')
    threads = [threading.Thread(target=save) for _ in range(2)]
    for t in threads: t.start()
    for t in threads: t.join()
    assert sorted(results) == ['conflict', 'saved']


def test_normalization_alpha_profile_orientation_and_input_validation(tmp_path):
    transparent = tmp_path / 'alpha.png'
    Image.new('RGBA', (4, 5), (0, 0, 0, 0)).save(transparent)
    target = tmp_path / 'normalized.png'
    normalize(transparent, target)
    with Image.open(target) as im:
        assert im.mode == 'RGB' and im.getpixel((0, 0)) == (255, 255, 255)
    icc = ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()
    Image.new('RGB', (4, 5), (23, 100, 240)).save(transparent, icc_profile=icc)
    normalize(transparent, target)
    with Image.open(target) as im:
        assert im.getpixel((0, 0)) == (23, 100, 240)
    oriented = tmp_path / 'rotated.jpg'
    exif = Image.Exif(); exif[274] = 6
    Image.new('RGB', (4, 5)).save(oriented, exif=exif)
    with pytest.raises(ValueError, match='旋轉'):
        normalize(oriented, target)
    store = EdgeWhiteStore(tmp_path / 'store')
    for names in [['1.png', '1.jpg'], ['../evil.png'], ['a.webp']]:
        with pytest.raises(ValueError):
            store.create('invalid', [(n, transparent) for n in names])
    assert not list(store.root.glob('.upload-*'))
    assert store.list() == []
    with pytest.raises(KeyError):
        store.read('../../escape')


def test_api_upload_save_import_download_and_busy_policy(tmp_path):
    gate = ResourceGate()
    store = EdgeWhiteStore(tmp_path / 'data' / 'edgewhite')
    app = FastAPI()
    app.include_router(create_edgewhite_router(Settings(data_root=tmp_path / 'data', max_upload_mb=1), gate, store))
    client = TestClient(app)
    image = source(tmp_path)
    data = image.read_bytes()
    response = client.post('/api/edgewhite', data={'name': '試用'}, files=[('source_files', ('._ignored.png', b'invalid')), ('source_files', ('1.png', data))])
    assert response.status_code == 201
    c = response.json(); cid = c['id']; pid = c['pages'][0]['id']; url = f'/api/edgewhite/{cid}'
    assert len(client.get('/api/edgewhite').json()) == 1
    assert client.get(f'{url}/pages/{pid}/source').headers['content-type'] == 'image/png'
    assert client.get(f'{url}/pages/not-a-page/source').status_code == 404
    gate.claim('test-gpu')
    assert client.post('/api/edgewhite', files={'source_files': ('2.png', data)}).status_code == 409
    assert client.get(f'{url}/download').status_code == 409
    assert client.get(url).status_code == 200
    assert client.put(f'{url}/pages/{pid}', json={'revision': 0, 'edit': edit().model_dump()}).status_code == 200
    gate.release('test-gpu')
    assert client.get(f'{url}/download').status_code == 409
    assert client.put(f'{url}/pages/{pid}', json={'revision': 0, 'edit': edit().model_dump()}).status_code == 409
    assert client.put(f'{url}/pages/{pid}', json={'revision': 1, 'edit': edit().model_dump(), 'output': True}).status_code == 200
    assert client.get(f'{url}/guides').json()['images']['1.png'] == edit().model_dump()
    assert client.put(f'{url}/guides', json={'revision': 2, 'workspace': {'version': 1, 'images': {'missing.png': edit().model_dump()}}}).status_code == 400
    response = client.get(f'{url}/download')
    assert response.status_code == 200
    assert zipfile.is_zipfile(io.BytesIO(response.content))
    assert not list((store.directory(cid) / 'exports').glob('*.zip'))
    assert client.delete(url).status_code == 400
    assert client.delete(f'{url}?confirm=true').status_code == 200
    assert client.get(url).status_code == 404


def test_api_rejects_oversized_upload_and_invalid_draft(tmp_path):
    gate = ResourceGate()
    app = FastAPI()
    app.include_router(create_edgewhite_router(Settings(data_root=tmp_path / 'data', max_upload_mb=1), gate))
    client = TestClient(app)
    assert client.post('/api/edgewhite', files={'source_files': ('1.png', b'x' * (1024 * 1024 + 1))}).status_code == 413
    c = client.post('/api/edgewhite', files={'source_files': ('1.png', source(tmp_path).read_bytes())}).json()
    url = f"/api/edgewhite/{c['id']}/pages/{c['pages'][0]['id']}"
    for invalid in [{'verticalGuides': [4, 4]}, {'verticalGuides': [4, 2]}, {'verticalGuides': [12]}, {'selectedCells': [{'column': 0, 'row': 0}]}]:
        assert client.put(url, json={'revision': 0, 'edit': invalid}).status_code == 400
    assert client.put(url, json={'revision': 0, 'edit': {'verticalGuides': [2.5]}}).status_code == 422


def test_multipart_desktop_json_import_and_parse_errors(tmp_path):
    gate = ResourceGate()
    store = EdgeWhiteStore(tmp_path / 'data' / 'edgewhite')
    app = FastAPI()
    app.include_router(create_edgewhite_router(Settings(data_root=tmp_path / 'data'), gate, store))
    client = TestClient(app)
    c = client.post('/api/edgewhite', files={'source_files': ('1.png', source(tmp_path).read_bytes())}).json()
    url = f"/api/edgewhite/{c['id']}/guides"
    assert client.post(url, data={'revision': 0}, files={'workspace_file': ('edgewhite_guides.json', b'invalid')}).status_code == 400
    workspace = {'version': 1, 'images': {'1.png': edit().model_dump()}}
    response = client.post(url, data={'revision': 0}, files={'workspace_file': ('edgewhite_guides.json', json.dumps(workspace).encode())})
    assert response.status_code == 200
    assert response.json()['pages'][0]['edit'] == edit().model_dump()
    assert client.post(url, data={'revision': 0}, files={'workspace_file': ('edgewhite_guides.json', json.dumps(workspace).encode())}).status_code == 409


def test_empty_desktop_workspace_roundtrip_is_valid(tmp_path):
    store, c = setup(tmp_path)
    exported = Workspace.model_validate(store.guides(c))
    restored = store.import_guides(c['id'], 0, exported)
    assert [p['edit'] for p in restored['pages']] == [p['edit'] for p in c['pages']]
    assert not any(p['revision'] != p['output_revision'] for p in restored['pages'])
