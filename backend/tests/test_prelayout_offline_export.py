import asyncio
import io
import json
from pathlib import Path
import zipfile

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image
import pytest

from app.prelayout import offline_export
from app.prelayout.api import router
from app.prelayout.store import Conflict, PrelayoutStore, atomic_json
from app.prelayout.import_line_breaks import LINE_BREAK_SUGGESTIONS_VERSION
from prelayout_core.preview import load_overlay, save_overlay


def picture(color='white'):
    output = io.BytesIO()
    Image.new('RGB', (20, 30), color).save(output, 'PNG')
    return output.getvalue()


@pytest.fixture
def chapter(tmp_path, monkeypatch):
    runtime = tmp_path / 'offline'
    runtime.mkdir()
    (runtime / 'editor.js').write_text('window.offlineEditor = true;')
    (runtime / 'editor.css').write_text('body { margin: 0; }')
    monkeypatch.setattr(offline_export, 'OFFLINE_ASSETS', runtime)
    store = PrelayoutStore(tmp_path / 'prelayout')
    project = store.create('離線測試', [('1 中文 #.png', picture()), ('2.png', picture()), ('3.png', picture())])
    pid = project['id']
    first = project['pages'][0]
    saved = store.save_page(pid, first['id'], 0,
                            [{'text': '最新文字', 'x': .5, 'y': .5, 'font-size': 20,
                              'ocr_text': '原文', 'note': '保留註解'}], 'offline-text')
    item = saved['items'][0]
    store.save_question_records(pid, 0, [{
        'id': 'question-1', 'note': '保留疑問',
        'createdAt': '2026-11-29T10:00:00Z', 'updatedAt': '2026-11-29T10:00:00Z',
        'texts': [{'key': 'reference-1', 'pageId': first['id'], 'pageNumber': 1,
                   'pageName': first['name'], 'itemId': item['_id'], 'itemNumber': 1, 'text': item['text']}],
    }])
    store.review_page(pid, first['id'], 1, True)
    store.clean_images(pid, [('3.png', picture('black'))])
    project = store.read(pid)
    relative = 'inpainted/1.npz'
    path = store.directory(pid) / relative
    path.parent.mkdir()
    patch = Image.new('RGBA', (20, 30), (0, 0, 0, 0))
    patch.putpixel((2, 3), (12, 34, 56, 128))
    save_overlay(patch, path)
    project['pages'][0].update(clean=relative, clean_kind='inpainted')
    store.write(project)
    return store, pid, runtime


def test_package_contract_native_assets_metadata_and_no_project_changes(chapter):
    store, pid, runtime = chapter
    root = store.directory(pid)
    before = {str(path.relative_to(root)): path.read_bytes() for path in root.rglob('*') if path.is_file()}
    expected_meo = store.translation(pid)
    path = store.export_offline(pid)
    try:
        with zipfile.ZipFile(path) as archive:
            manifest = json.loads(archive.read('project.json'))
            meo = json.loads(archive.read('Meo.json'))
            assert manifest.keys() == {'version', 'name', 'pages'}
            assert manifest['version'] == 1 and manifest['name'] == '離線測試'
            assert meo == expected_meo
            assert archive.read('editor.js') == (runtime / 'editor.js').read_bytes()
            assert archive.read('editor.css') == (runtime / 'editor.css').read_bytes()
            html = archive.read('index.html').decode()
            assert 'src="./editor.js"' in html and 'href="./editor.css"' in html
            assert 'id="root"' in html and 'type="module"' not in html
            pages = manifest['pages']
            ref = meo['questionRecords']['records'][0]['texts'][0]
            assert pages[0]['id'] == ref['pageId'] and pages[0]['itemIds'] == [ref['itemId']]
            assert pages[0].keys() == {'id', 'name', 'width', 'height', 'original', 'overlay', 'itemIds'}
            assert pages[1].keys() == {'id', 'name', 'width', 'height', 'original', 'itemIds'}
            assert pages[1]['itemIds'] == []
            assert 'clean' in pages[2] and 'overlay' not in pages[2]
            for page in pages:
                assert (page['width'], page['height']) == (20, 30)
                assert archive.read(page['original']) == (root / 'originals' / page['name']).read_bytes()
                assert page['original'].startswith('assets/') and page['original'].isascii()
            with Image.open(io.BytesIO(archive.read(pages[0]['overlay']))) as overlay:
                with load_overlay(root / 'inpainted/1.npz') as expected:
                    assert overlay.mode == 'RGBA' and overlay.size == (20, 30)
                    assert overlay.tobytes() == expected.tobytes()
            assert archive.read(pages[2]['clean']) == picture('black')
            assert len(archive.namelist()) == len(set(archive.namelist())) == 10
            assert all(name in {'index.html', 'editor.js', 'editor.css', 'project.json', 'Meo.json'}
                       or name.startswith('assets/') for name in archive.namelist())
            assert 'review' not in archive.read('project.json').decode()
            assert '最新文字' not in archive.read('project.json').decode()
    finally:
        path.unlink()
    assert before == {str(path.relative_to(root)): path.read_bytes() for path in root.rglob('*') if path.is_file()}
    assert store._readers[pid] == 0


def test_snapshot_stays_coherent_while_later_edits_and_delete_are_blocked(chapter, monkeypatch):
    store, pid, _ = chapter
    expected = store.translation(pid)
    first = store.read(pid)['pages'][0]
    original_write = zipfile.ZipFile.write
    edited = False

    def write(archive, *args, **kwargs):
        nonlocal edited
        if not edited:
            edited = True
            with pytest.raises(Conflict):
                store.delete(pid)
            items = store.page(pid, first['id'])['items']
            items[0]['text'] = '後來的修改'
            store.save_page(pid, first['id'], 1, items, 'during-offline-package')
        return original_write(archive, *args, **kwargs)

    monkeypatch.setattr(zipfile.ZipFile, 'write', write)
    path = store.export_offline(pid)
    try:
        with zipfile.ZipFile(path) as archive:
            assert json.loads(archive.read('Meo.json')) == expected
        assert store.translation(pid)['transMap'][first['name']][0]['text'] == '後來的修改'
    finally:
        path.unlink()


def test_bad_overlay_cleans_partial_package_and_reader(chapter):
    store, pid, _ = chapter
    (store.directory(pid) / 'inpainted/1.npz').write_bytes(b'invalid')
    with pytest.raises(ValueError, match='NPZ'):
        store.export_offline(pid)
    assert not list(store.root.glob('prelayout-offline-*.zip'))
    assert store._readers[pid] == 0


@pytest.mark.parametrize('legacy', [False, True])
def test_optional_line_break_suggestions_use_compatible_saved_state(chapter, legacy):
    store, pid, _ = chapter
    project = store.read(pid)
    page = project['pages'][0]
    state_path = store.directory(pid) / page['state']
    state = json.loads(state_path.read_bytes())
    item_id = state['items'][0]['_id']
    state.update(line_break_suggestions={item_id: {
        'original_text': '最新文字', 'source_line_count': 2,
        'candidates': [{'line_count': 2, 'text': '最新\n文字'}],
    }}, line_break_suggestions_version=1 if legacy else LINE_BREAK_SUGGESTIONS_VERSION,
        line_break_pending_ids=[item_id])
    atomic_json(state_path, state)
    before = state_path.read_bytes()
    expected = store._line_break_state(pid, page, state)['line_break_suggestions']
    assert expected
    path = store.export_offline(pid)
    try:
        with zipfile.ZipFile(path) as archive:
            pages = json.loads(archive.read('project.json'))['pages']
            assert pages[0]['line_break_suggestions'] == expected
            assert set(pages[0]) == {'id', 'name', 'width', 'height', 'original', 'overlay',
                                     'itemIds', 'line_break_suggestions'}
            assert all('line_break_suggestions' not in page for page in pages[1:])
            assert json.loads(archive.read('Meo.json')) == store.translation(pid)
        assert state_path.read_bytes() == before
    finally:
        path.unlink()


@pytest.mark.parametrize('relative', ['../outside.png', '/tmp/outside.png', 'outside-link.png'])
def test_asset_paths_cannot_escape_project(chapter, relative):
    store, pid, runtime = chapter
    project = store.read(pid)
    if relative == 'outside-link.png':
        (store.directory(pid) / relative).symlink_to(runtime / 'editor.js')
    project['pages'][0]['clean'] = relative
    store.write(project)
    with pytest.raises(ValueError, match='不可離開'):
        store.export_offline(pid)
    assert not list(store.root.glob('prelayout-offline-*.zip'))
    assert store._readers[pid] == 0


def test_endpoint_zip_cleanup_and_missing_build(chapter):
    store, pid, runtime = chapter
    app = FastAPI()
    app.include_router(router(store, object(), 1000000))
    with TestClient(app) as client:
        response = client.get(f'/api/prelayout/projects/{pid}/export/offline')
        assert response.status_code == 200
        assert response.headers['content-type'] == 'application/zip'
        assert response.headers['cache-control'] == 'no-store'
        assert 'attachment;' in response.headers['content-disposition']
        with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
            assert json.loads(archive.read('Meo.json')) == store.translation(pid)
        assert not list(store.root.glob('prelayout-offline-*.zip'))
        assert store._readers[pid] == 0
        (runtime / 'editor.js').unlink()
        response = client.get(f'/api/prelayout/projects/{pid}/export/offline')
        assert response.status_code == 503 and '建置' in response.json()['detail']
        assert store._readers[pid] == 0
        assert client.get('/api/prelayout/projects/pl_' + 'f' * 32 + '/export/offline').status_code == 404


def test_interrupted_download_removes_zip_and_releases_reader(chapter):
    store, pid, _ = chapter
    api = router(store, object(), 1000000)
    endpoint = next(route.endpoint for route in api.routes if route.path.endswith('/export/offline'))
    response = endpoint(pid)
    with pytest.raises(Conflict):
        store.delete(pid)
    path = Path(response.path)

    async def fail_send(_message):
        raise RuntimeError('client disconnected')

    async def receive():
        return {'type': 'http.disconnect'}

    with pytest.raises(RuntimeError, match='disconnected'):
        asyncio.run(response({'type': 'http', 'method': 'GET', 'headers': []}, receive, fail_send))
    assert not path.exists() and store._readers[pid] == 0


def test_imported_offline_identity_map_follows_current_project_on_reexport(chapter):
    store, pid, _ = chapter
    project = store.read(pid)
    project['template']['_offlinePrelayout'] = {'version': 1, 'itemIds': {}, 'extra': 'preserve'}
    store.write(project)
    path = store.export_offline(pid)
    try:
        with zipfile.ZipFile(path) as archive:
            pages = json.loads(archive.read('project.json'))['pages']
            ids = json.loads(archive.read('Meo.json'))['_offlinePrelayout']
            assert ids == {'version': 1, 'itemIds': {p['name']: p['itemIds'] for p in pages}, 'extra': 'preserve'}
        assert store.read(pid)['template']['_offlinePrelayout']['itemIds'] == {}
    finally:
        path.unlink()
