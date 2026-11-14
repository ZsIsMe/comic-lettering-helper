"""Independent image layers have no disk cache and preserve RGBA pixels."""
import io

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from app.config import Settings
from app.prelayout.api import router
from app.prelayout.detection import PrelayoutDetection
from app.prelayout.store import PrelayoutStore
from app.resources import ResourceGate
from prelayout_core.data import identifier
from prelayout_core.preview import save_overlay


@pytest.fixture
def layers(tmp_path):
    source = Image.new('RGB', (600, 900), (100, 120, 140))
    encoded = io.BytesIO(); source.save(encoded, 'JPEG')
    store = PrelayoutStore(tmp_path / 'data')
    project = store.create('layers', [('1.jpg', encoded.getvalue())])
    page = project['pages'][0]
    did = identifier('d')
    relative = f'detections/{did}/output/inpainted/1.npz'
    overlay = Image.new('RGBA', source.size)
    overlay.paste((200, 80, 40, 128), (100, 200, 300, 500))
    save_overlay(overlay, store.directory(project['id']) / relative)
    page.update(clean=relative, clean_kind='inpainted')
    project['detection_id'] = did; store.write(project)
    app = FastAPI(); app.include_router(router(store, PrelayoutDetection(Settings(), store, ResourceGate()), 10_000_000))
    return store, project, encoded.getvalue(), overlay, app


@pytest.mark.parametrize(('edge', 'region'), [(None, None), (384, None), (768, (100, 200, 150, 250))])
def test_independent_layers_and_auxiliary_previews_never_write_disk(layers, edge, region):
    store, project, source, overlay, _ = layers
    pid = project['id']; page = project['pages'][0]; root = store.directory(pid)
    before = {str(p.relative_to(root)): p.read_bytes() for p in root.rglob('*') if p.is_file()}
    original, _, media = store.layer(pid, page['id'], 'original')
    assert original == source and media == 'image/jpeg'
    image, key, media = store.layer(pid, page['id'], 'overlay', edge, region)
    assert media == 'image/png'
    expected = overlay.copy()
    if region:
        x, y, w, h = region
        expected = expected.crop((x, y, x+w, y+h))
    if edge: expected.thumbnail((edge, edge))
    with Image.open(io.BytesIO(image)) as decoded:
        assert decoded.mode == 'RGBA' and decoded.tobytes() == expected.tobytes()
    assert store.layer(pid, page['id'], 'overlay', edge, region) == (image, key, media)
    store.preview(pid, page['id'], 384, True, region)
    after = {str(p.relative_to(root)): p.read_bytes() for p in root.rglob('*') if p.is_file()}
    assert before == after
    assert not (root / 'previews').exists()


def test_layer_routes_are_no_store_and_validate_crop(layers):
    _, project, source, _, app = layers
    prefix = f'/api/prelayout/projects/{project["id"]}/pages/{project["pages"][0]["id"]}'
    with TestClient(app) as client:
        original = client.get(prefix + '/layers/original')
        assert original.content == source and original.headers['content-type'] == 'image/jpeg'
        overlay = client.get(prefix + '/layers/overlay?edge=384')
        assert overlay.status_code == 200 and overlay.headers['content-type'] == 'image/png'
        assert overlay.headers['cache-control'] == original.headers['cache-control'] == 'no-store'
        assert client.get(prefix + '/layers/overlay?x=1').status_code == 400
        assert client.get(prefix + '/layers/overlay?x=500&y=0&w=200&h=100').status_code == 400
        assert client.get(prefix + '/layers/overlay?edge=99').status_code == 400
        assert client.get(prefix + '/layers/invalid').status_code == 400
        assert client.get(prefix + '/preview?clean=true').headers['cache-control'] == 'no-store'


def test_missing_formal_characters_is_reported_without_writing_empty_data(layers):
    store, project, _, _, _ = layers
    page = project['pages'][0]; root = store.directory(project['id'])
    with pytest.raises(ValueError, match='缺少正式單字框'):
        store.page(project['id'], page['id'])
    assert not list(root.rglob('page-characters/*.json'))
