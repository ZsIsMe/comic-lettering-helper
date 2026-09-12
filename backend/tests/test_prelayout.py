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
from app.resources import ResourceGate
from app.prelayout.store import PrelayoutStore, Conflict, atomic_json
from app.prelayout.detection import PrelayoutDetection
from app.prelayout.api import router
from prelayout_core.data import identifier


def picture(size=(300, 400), fill='white'):
    out = io.BytesIO(); Image.new('RGB', size, fill).save(out, 'PNG'); return out.getvalue()


@pytest.fixture
def store(tmp_path):
    return PrelayoutStore(tmp_path / 'prelayout')


@pytest.fixture
def project(store):
    return store.create('預排版', [('10.png', picture()), ('2.png', picture()), ('._2.png', b'ignored')])


def item(**extra):
    return dict(_id=identifier(), text='測試\n文字', x=.5, y=.5, **{'font-size': 30, 'rotation': -15, 'orientation': 'vertical', 'color': '#000000', 'stroke-color': '#ffffff', 'stroke-weight': 2}, **extra)


def test_natural_sort_duplicate_and_isolation(store, project):
    assert [p['name'] for p in project['pages']] == ['2.png', '10.png']
    repair = store.root.parent / 'projects' / 'repair'; repair.mkdir(parents=True)
    (repair / 'sentinel').write_text('unchanged')
    with pytest.raises(ValueError, match='重複'):
        store.create('duplicate', [('2.png', picture()), ('2.jpg', picture())])
    assert (repair / 'sentinel').read_text() == 'unchanged'
    assert len(store.list()) == 1
    with pytest.raises(KeyError): store.directory('../projects/repair')


def test_revision_idempotency_and_precision(store, project):
    pid = project['id']; page = project['pages'][0]; values = [item()]
    result = store.save_page(pid, page['id'], 0, values, 'operation-1')
    assert result['revision'] == 1
    assert store.save_page(pid, page['id'], 0, values, 'operation-1')['revision'] == 1
    with pytest.raises(Conflict): store.save_page(pid, page['id'], 0, values, 'operation-2')
    for _ in range(3):
        value = store.translation(pid)
        record = store.read(pid)
        store.import_translation(pid, json.dumps(value).encode(), 'bt', record['revision'], True)
    exported = store.translation(pid)['transMap']['2.png'][0]
    assert '_id' not in exported
    assert exported['rotation'] == -15
    assert exported['x'] == .5
    assert exported['text'] == '測試\n文字'


def test_invalid_page_save_does_not_change_revision(store, project):
    page = project['pages'][0]
    bad = item(); bad['rotation'] = float('nan')
    with pytest.raises(ValueError): store.save_page(project['id'], page['id'], 0, [bad], 'bad')
    assert store.page(project['id'], page['id'])['revision'] == 0


def test_import_preview_unknown_fields_and_atomic_rejection(store, project):
    raw = {'version': [1, 0], 'custom': {'retained': True}, 'groupList': [{'name': '框外'}], 'transMap': {'2.png': [item(extra_field=123)]}}
    payload = json.dumps(raw).encode()
    summary = store.import_translation(project['id'], payload, 'bt', 0)
    assert summary['items'] == 1
    assert not store.page(project['id'], project['pages'][0]['id'])['items']
    store.import_translation(project['id'], payload, 'bt', 0, True)
    exported = store.translation(project['id'])
    assert exported['custom'] == {'retained': True}
    assert exported['transMap']['2.png'][0]['extra_field'] == 123
    raw['transMap']['missing.png'] = [item()]
    with pytest.raises(ValueError, match='原圖'):
        store.import_translation(project['id'], json.dumps(raw).encode(), 'bt', 1, True)
    assert store.read(project['id'])['revision'] == 1


def test_labelplus_groups_are_preserved(store, project):
    raw = '1, 0\n-\n對話\n框外\n-\n備註\n>>>>>>>>[2.png]<<<<<<<<\n----------------[1]----------------[0.5,0.5,1]\n對話\n----------------[2]----------------[0.7,0.2,2]\n音效\n'
    store.import_translation(project['id'], raw.encode(), 'labelplus', 0, True)
    data = store.translation(project['id'])
    assert [i['groupId'] for i in data['transMap']['2.png']] == [0, 1]
    assert all(i['match_status'] == 'unmatched' for i in data['transMap']['2.png'])


def test_preview_originals_and_clean_pairing(store, project):
    page = project['pages'][0]
    root = store.directory(project['id'])
    original = (root / 'originals' / '2.png').read_bytes()
    data, key = store.preview(project['id'], page['id'], 384)
    assert Image.open(io.BytesIO(data)).size == (288, 384)
    assert (root / 'originals' / '2.png').read_bytes() == original
    with pytest.raises(ValueError): store.clean_images(project['id'], [('2.png', picture((200, 200)))])
    assert store.read(project['id'])['pages'][0]['clean'] is None
    store.clean_images(project['id'], [('2.jpg', picture(fill='black'))])
    clean, clean_key = store.preview(project['id'], page['id'], 384, True)
    assert clean_key != key
    assert Image.open(io.BytesIO(clean)).getpixel((1, 1)) == (0, 0, 0)
    tile, _ = store.preview(project['id'], page['id'], 384, False, (0, 0, 100, 100))
    assert Image.open(io.BytesIO(tile)).size == (100, 100)


def test_archive_roundtrip_and_path_rejection(store, project):
    page = project['pages'][0]
    store.save_page(project['id'], page['id'], 0, [item(custom='kept')], 'a')
    store.preview(project['id'], page['id'])
    path = store.export_archive(project['id'])
    with zipfile.ZipFile(path) as archive:
        assert all('previews/' not in n for n in archive.namelist())
    imported = store.import_archive(path.read_bytes(), 10_000_000)
    path.unlink()
    assert imported['id'] != project['id']
    assert store.translation(imported['id']) == store.translation(project['id'])
    attack = io.BytesIO()
    with zipfile.ZipFile(attack, 'w') as archive: archive.writestr('prelayout/../../escape.txt', 'attack')
    with pytest.raises(ValueError): store.import_archive(attack.getvalue(), 10000)
    assert not (store.root / 'escape.txt').exists()


def test_measure_read_only_and_upstream_matching(store, project):
    page = project['pages'][0]; pid = project['id']; did = identifier('d')
    measure = {'pages': {'2.png': [{'xyxy_pixel': [120, 100, 180, 300], 'center_normalized': [.5, .5], 'font_size': 28.5, 'orientation': 'vertical', 'text_color': '#000000'}]}}
    path = store.directory(pid) / 'detections' / did / 'output' / 'measure.json'
    atomic_json(path, measure)
    project['detection_id'] = did; store.write(project)
    store.save_page(pid, page['id'], 0, [item()], 'a')
    assert store.page(pid, page['id'])['measure'] == measure['pages']['2.png']
    candidate = store.matches(pid)['data']['transMap']['2.png'][0]
    assert candidate['match_status'] == 'auto'
    assert candidate['font-size'] == 29
    assert json.loads(path.read_text()) == measure


def test_missing_models_and_gpu_gate(store, project, tmp_path, monkeypatch):
    monkeypatch.setenv('COMIC_PRELAYOUT_MODEL_ROOT', str(tmp_path / 'models'))
    monkeypatch.setenv('COMIC_PRELAYOUT_PYTHON', '')
    detector = PrelayoutDetection(Settings(), store, ResourceGate())
    assert not detector.availability()['methods']['ocr_aligned']
    with pytest.raises(ValueError, match='尚未安裝'):
        asyncio.run(detector.submit(project['id'], {}))
    assert detector.gate.owner is None
    app = FastAPI(); app.include_router(router(store, detector, 10_000_000))
    with TestClient(app) as client:
        prefix = f'/api/prelayout/projects/{project["id"]}'
        assert client.get(prefix).status_code == 200
        assert client.get(f'{prefix}/pages/{project["pages"][0]["id"]}').status_code == 200
        assert client.put(f'{prefix}/measure', json={}).status_code == 404
        assert client.patch(f'{prefix}/pages/{project["pages"][0]["id"]}/text', json={'items': [item()], 'expected_revision': 0, 'operation_id': 'a'}).status_code == 200
        assert client.get('/api/projects').status_code == 404
        exported = client.get(f'{prefix}/export/bt')
        assert exported.status_code == 200
        assert exported.headers['content-disposition'] == 'attachment; filename="bt.json"'
        assert exported.json() == store.translation(project['id'])
        assert client.get(f'{prefix}/export/archive').status_code == 404


def install_measure(store, project):
    did = identifier('d'); pid = project['id']
    folder = store.directory(pid) / 'detections' / did
    measure = {'pages': {p['name']: [{'xyxy_pixel': [100, 100, 200, 300], 'center_normalized': [.5, .5], 'font_size': 32, 'orientation': 'vertical', 'text_color': 'white', 'text_has_stroke': True}] for p in project['pages']}}
    atomic_json(folder / 'output' / 'measure.json', measure)
    atomic_json(folder / 'output' / 'complete.json', {'pages': [p['name'] for p in project['pages']]})
    atomic_json(folder / 'task.json', {'id': did, 'project_id': pid, 'state': 'completed', 'created_at': '2026-09-12T00:00:00Z', 'pid': None})
    record = store.read(pid); record['detection_id'] = did; store.write(record)
    return did, folder, measure


def test_matching_transaction_preserves_manual_and_rejects_stale(store, project):
    pid = project['id']; page = project['pages'][0]
    auto, manual = item(), item(match_status='manual')
    store.save_page(pid, page['id'], 0, [auto, manual], 'a')
    did, folder, original_measure = install_measure(store, project)
    candidate = store.matches(pid)
    assert candidate['summary'] == {'manual': 1, 'automatic': 1}
    store.apply_matches(pid, candidate['project_revision'], {})
    saved = store.page(pid, page['id'])['items']
    assert saved[1]['rotation'] == manual['rotation']
    assert saved[1]['match_status'] == 'manual'
    assert saved[0]['_id'] == auto['_id']
    with pytest.raises(Conflict): store.apply_matches(pid, candidate['project_revision'], {})
    candidate = store.matches(pid)
    store.apply_matches(pid, candidate['project_revision'], {page['id']: [manual['_id']]})
    assert store.page(pid, page['id'])['items'][1]['match_status'] != 'manual'
    assert json.loads((folder / 'output' / 'measure.json').read_text()) == original_measure
    assert store.read(pid)['detection_id'] == did


def test_reader_allows_save_but_prevents_deletion_and_excludes_unpublished(store, project):
    pid = project['id']; page = project['pages'][0]
    with store.reader(pid) as (snapshot, _):
        store.save_page(pid, page['id'], 0, [item()], 'a')
        assert snapshot['pages'][0]['revision'] == 0
        with pytest.raises(Conflict): store.delete(pid)
    did, folder, _ = install_measure(store, project)
    unfinished = store.directory(pid) / 'detections' / identifier('d')
    atomic_json(unfinished / 'task.json', {'state': 'detecting'})
    (folder / 'worker.log').write_text('local process paths')
    path = store.export_archive(pid)
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        assert f'prelayout/detections/{did}/output/measure.json' in names
        assert not any('worker.log' in name or unfinished.name in name for name in names)
        saved = json.loads(archive.read('prelayout/project.json'))
        assert saved['pages'][0]['revision'] == 1
    imported = store.import_archive(path.read_bytes(), 10_000_000)
    assert store.page(imported['id'], imported['pages'][0]['id'])['measure']
    path.unlink(); store.delete(pid)
    assert all(value['id'] != pid for value in store.list())


def test_invalid_roots_numeric_and_ids(tmp_path, store, project):
    from prelayout_core.data import read_json, validate_items
    for root in (tmp_path, tmp_path / 'projects', tmp_path / 'projects' / 'child'):
        with pytest.raises(ValueError): PrelayoutStore(root, forbidden=[tmp_path / 'projects'])
    for raw in ('{"x":NaN}', '{"x":1e999}', '{"x":-Infinity}'):
        with pytest.raises(ValueError): read_json(raw)
    values = validate_items([item(index=2), item(index=2), item()], 300, 400)
    assert len({value['index'] for value in values}) == 3
    assert values[0]['index'] == 2


def test_gpu_recovery_reservations():
    gate = ResourceGate(); assert gate.claim('repair')
    gate.retain('detector-a'); gate.retain('detector-b')
    assert not gate.claim('another')
    gate.release('repair'); assert gate.owner in {'detector-a', 'detector-b'}
    gate.release('detector-a'); assert gate.owner == 'detector-b'
    assert not gate.claim('another')
    gate.release('detector-b'); assert gate.claim('another')


def test_cancel_before_run_never_starts_process(store, project, monkeypatch):
    detector = PrelayoutDetection(Settings(), store, ResourceGate())
    monkeypatch.setattr(detector, 'availability', lambda: {'methods': {'ocr_aligned': True}})
    def forbidden(): raise AssertionError('ComfyUI should not be called for a queued cancellation')
    monkeypatch.setattr(detector, 'free_comfy', forbidden)
    async def scenario():
        record = await detector.submit(project['id'], {})
        assert detector.gate.owner == record['id']
        await detector.cancel(project['id'])
        await detector.tasks[project['id']]
        assert detector.status(project['id'])['state'] == 'cancelled'
        assert detector.gate.owner is None
    asyncio.run(scenario())


def test_completed_worker_recovered_and_invalid_publication_preserves_old(store, project, monkeypatch):
    detector = PrelayoutDetection(Settings(), store, ResourceGate())
    did, folder, _ = install_measure(store, project)
    detector.update(project['id'], did, state='publishing')
    monkeypatch.setattr(detector, 'process_alive', lambda record: False)
    asyncio.run(detector.start())
    assert detector.status(project['id'])['state'] == 'completed'
    other = identifier('d'); root = store.directory(project['id']) / 'detections' / other
    atomic_json(root / 'task.json', {'id': other, 'project_id': project['id'], 'created_at': '2026-09-13', 'state': 'detecting'})
    atomic_json(root / 'output' / 'complete.json', {'pages': [p['name'] for p in project['pages']]})
    atomic_json(root / 'output' / 'measure.json', {'pages': {}})
    asyncio.run(detector.start())
    assert detector.status(project['id'])['state'] == 'failed'
    assert store.read(project['id'])['detection_id'] == did
    assert json.loads((folder / 'task.json').read_text())['state'] == 'completed'


def test_source_hash_is_checked_before_worker_copy(store, project):
    from prelayout_core.worker import verify_sources
    root = store.directory(project['id']) / 'originals'
    verify_sources(project, root)
    (root / project['pages'][0]['name']).write_bytes(picture(fill='black'))
    with pytest.raises(ValueError, match='原圖已改變'): verify_sources(project, root)


def test_archive_reader_released_on_disconnect(store, project):
    from app.prelayout.api import ArchiveResponse
    lease = store.reader(project['id']); lease.__enter__()
    path = store.export_archive(project['id'])
    response = ArchiveResponse(path, lease)
    with pytest.raises(Conflict): store.delete(project['id'])
    async def receive(): return {'type': 'http.disconnect'}
    async def send(message):
        if message['type'] == 'http.response.body': raise RuntimeError('client disconnected')
    with pytest.raises(RuntimeError, match='disconnected'):
        asyncio.run(response({'type': 'http', 'method': 'GET', 'headers': [], 'extensions': {}}, receive, send))
    assert not path.exists()
    store.delete(project['id'])


def test_import_archive_rejects_duplicate_alias_and_foreign_binary(store, project):
    for name in ('prelayout//project.json', 'prelayout/detections/model.pt'):
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w') as archive: archive.writestr(name, b'invalid')
        with pytest.raises(ValueError): store.import_archive(output.getvalue(), 10000)
    with pytest.raises(ValueError): store.import_archive(b'not a zip', 10000)


def test_archive_rebuilds_derived_measures_and_log_download_retains_source(store, project):
    did, folder, measure = install_measure(store, project)
    page = project['pages'][0]
    atomic_json(folder / 'output' / 'page-measures' / f'{page["id"]}.json', [])
    archive = store.export_archive(project['id'])
    imported = store.import_archive(archive.read_bytes(), 10_000_000)
    archive.unlink()
    assert imported['detection_id'] != did
    assert store.page(imported['id'], page['id'])['measure'] == measure['pages'][page['name']]
    (folder / 'worker.log').write_text('synthetic log')
    app = FastAPI(); app.include_router(router(store, PrelayoutDetection(Settings(), store, ResourceGate()), 10_000_000))
    with TestClient(app) as client:
        response = client.get(f'/api/prelayout/projects/{project["id"]}/detections/{did}/log')
        assert response.status_code == 200 and response.content == b'synthetic log'
        assert (folder / 'worker.log').read_text() == 'synthetic log'
    store.delete(project['id'])


def test_per_page_measure_is_used_without_loading_whole_chapter(store, project, monkeypatch):
    did, folder, measure = install_measure(store, project)
    page = project['pages'][0]
    atomic_json(folder / 'output' / 'page-measures' / f'{page["id"]}.json', measure['pages'][page['name']])
    # A cached page remains self-contained; corrupting the aggregate proves it is not read here.
    (folder / 'output' / 'measure.json').write_bytes(b'not JSON')
    assert store.page(project['id'], page['id'])['measure'] == measure['pages'][page['name']]


def test_live_recovery_process_group_keeps_gpu_until_children_exit(store, project):
    """An actual child ignoring TERM must not leave the gate free while still running."""
    import os
    import signal
    import subprocess
    import sys
    did = identifier('d')
    child_code = "import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); print('ready',flush=True); time.sleep(60)"
    parent_code = "import subprocess,sys,time; p=subprocess.Popen([sys.executable,'-c',sys.argv[1],'prelayout_core.worker',sys.argv[2]],stdout=subprocess.PIPE); p.stdout.readline(); print('ready',flush=True); time.sleep(60)"
    process = subprocess.Popen([sys.executable, '-c', parent_code, child_code, did, 'prelayout_core.worker'], start_new_session=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    detector = PrelayoutDetection(Settings(), store, ResourceGate())
    try:
        assert process.stdout.readline().strip() == 'ready'
        folder = store.directory(project['id']) / 'detections' / did
        record = {'id': did, 'project_id': project['id'], 'created_at': '2026-09-12', 'state': 'detecting'}
        atomic_json(folder / 'task.json', record)
        # Recover even if the web process died between spawning and persisting the PID.
        record = detector.status(project['id'], recover=True)
        assert record['pid'] == process.pid
        assert detector.process_alive(record, verify=True)
        async def scenario():
            await detector.start()
            assert detector.gate.owner == did
            cancelling = asyncio.create_task(detector.cancel(project['id']))
            await asyncio.sleep(.3)
            assert detector.gate.owner == did
            assert not detector.gate.claim('repair')
            await asyncio.wait_for(cancelling, 15)
            await asyncio.wait_for(detector.tasks[project['id']], 3)
            assert detector.gate.owner is None
            assert detector.status(project['id'])['state'] == 'cancelled'
            assert not detector.process_alive(record)
        asyncio.run(scenario())
    finally:
        if detector.process_alive({'id': did, 'pid': process.pid}, verify=True):
            try: os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError: pass
        process.wait(timeout=5)


def test_preview_decode_does_not_hold_edit_lock(store, project, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    import threading
    decoding, finish = threading.Event(), threading.Event()
    original = Image.Image.thumbnail
    def thumbnail(image, *args, **kwargs):
        decoding.set()
        assert finish.wait(5)
        return original(image, *args, **kwargs)
    monkeypatch.setattr(Image.Image, 'thumbnail', thumbnail)
    pid, page_id = project['id'], project['pages'][0]['id']
    with ThreadPoolExecutor(2) as pool:
        preview = pool.submit(store.preview, pid, page_id, 768)
        assert decoding.wait(2)
        try:
            save = pool.submit(store.save_page, pid, page_id, 0, [item()], 'during-decode')
            assert save.result(timeout=2)['revision'] == 1
        finally:
            finish.set()
        assert preview.result(timeout=2)[0]


@pytest.mark.parametrize('device', ['cuda', 'mps'])
def test_real_worker_missing_models_fails_without_publishing(store, project, tmp_path, monkeypatch, device):
    import sys
    monkeypatch.setenv('COMIC_PRELAYOUT_MODEL_ROOT', str(tmp_path / 'missing-models'))
    monkeypatch.setenv('COMIC_PRELAYOUT_PYTHON', sys.executable)
    monkeypatch.setenv('COMIC_PRELAYOUT_DEVICE', device)
    detector = PrelayoutDetection(Settings(app_root=Path(__file__).resolve().parents[2]), store, ResourceGate())
    # Simulate assets disappearing between the lightweight availability check and worker startup.
    monkeypatch.setattr(detector, 'availability', lambda: {'methods': {'single_char': True}})
    comfy_calls = []
    monkeypatch.setattr(detector, 'free_comfy', lambda: comfy_calls.append(True))
    async def scenario():
        record = await detector.submit(project['id'], {'method': 'single_char', 'device': 'cpu'})
        assert record['device'] == device  # Requests cannot override the server GPU configuration.
        await asyncio.wait_for(detector.tasks[project['id']], 15)
        state = detector.status(project['id'])
        assert state['state'] == 'failed'
        assert isinstance(state['pid'], int)
        assert not detector.process_alive(state)
        assert detector.gate.owner is None
        assert store.read(project['id'])['detection_id'] is None
        assert '缺少資產' in (detector.task_path(project['id'], record['id']).parent / 'worker.log').read_text()
        assert bool(comfy_calls) == (device == 'cuda')
    asyncio.run(scenario())


def test_device_defaults_to_cuda_and_rejects_cpu(store, project, monkeypatch):
    monkeypatch.delenv('COMIC_PRELAYOUT_DEVICE', raising=False)
    assert PrelayoutDetection(Settings(), store, ResourceGate()).device == 'cuda'
    monkeypatch.setenv('COMIC_PRELAYOUT_DEVICE', 'cpu')
    detector = PrelayoutDetection(Settings(), store, ResourceGate())
    assert not any(detector.availability()['methods'].values())
    with pytest.raises(ValueError, match='不自動降級 CPU'):
        asyncio.run(detector.submit(project['id'], {}))
    assert detector.gate.owner is None
    assert detector.status(project['id']) is None


def test_publish_cleanup_lists_only_prelayout_data_and_preserves_external_assets(tmp_path, monkeypatch):
    import os
    import subprocess
    import sys
    data, models = tmp_path / 'data', tmp_path / 'models'
    models.mkdir(); (models / 'asset.pt').write_bytes(b'synthetic model sentinel')
    prelayout = tmp_path / 'independent-prelayout'
    (prelayout / 'projects').mkdir(parents=True); (prelayout / 'preferences').mkdir()
    (prelayout / 'prelayout-test.zip').write_bytes(b'synthetic archive')
    env = {**os.environ, 'COMIC_PRELAYOUT_DATA_ROOT': str(prelayout), 'COMIC_PRELAYOUT_MODEL_ROOT': str(models)}
    command = [sys.executable, str(Path(__file__).resolve().parents[2] / 'deploy' / 'prepublish_clean.py'), '--data-root', str(data), '--comfy-root', str(tmp_path / 'comfy')]
    result = subprocess.run(command, env=env, text=True, capture_output=True, check=True)
    assert 'DRY-RUN' in result.stdout and str(prelayout / 'projects') in result.stdout
    assert (prelayout / 'projects').exists() and str(models) not in result.stdout
    subprocess.run(command + ['--apply'], env=env, text=True, capture_output=True, check=True)
    assert not (prelayout / 'projects').exists()
    assert (models / 'asset.pt').read_bytes() == b'synthetic model sentinel'
