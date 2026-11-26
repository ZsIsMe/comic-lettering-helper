"""Published assets survive reclamation of a finished worker's input snapshot."""
import asyncio
import io
import shutil
import threading

import pytest
from PIL import Image

from app.config import Settings
from app.prelayout.detection import PrelayoutDetection
from app.prelayout.store import PrelayoutStore, atomic_json
from app.resources import ResourceGate
from prelayout_core.data import identifier, read_json
from prelayout_core.preview import save_overlay
import numpy as np


async def start_and_cleanup(detector):
    await detector.start()
    if detector.cleanup_task is not None:
        await detector.cleanup_task


@pytest.fixture
def task(tmp_path):
    image = io.BytesIO()
    Image.new('RGB', (40, 60), 'white').save(image, 'PNG')
    store = PrelayoutStore(tmp_path / 'prelayout')
    project = store.create('storage', [('1.png', image.getvalue())])
    pid, did = project['id'], identifier('d')
    folder = store.directory(pid) / 'detections' / did
    inputs = folder / 'input'; inputs.mkdir(parents=True)
    (inputs / '1.png').write_bytes(image.getvalue())
    overlay = folder / 'output' / 'inpainted' / '1.npz'
    overlay.parent.mkdir(parents=True)
    save_overlay(Image.new('RGBA', (40, 60), (10, 20, 30, 128)), overlay)
    atomic_json(folder / 'output' / 'measure.json', {'pages': {'1.png': []}})
    page = project['pages'][0]
    atomic_json(folder / 'output' / 'page-measures' / f'{page["id"]}.json', [])
    atomic_json(folder / 'output' / 'page-characters' / f'{page["id"]}.json', [])
    atomic_json(folder / 'output' / 'complete.json', {'pages': ['1.png'], 'inpainted': True})
    atomic_json(folder / 'task.json', {'id': did, 'project_id': pid, 'state': 'publishing',
                                     'created_at': '2026-11-13T00:00:00Z', 'pid': None,
                                     'cleanup_input_after_publish': True})
    detector = PrelayoutDetection(Settings(), store, ResourceGate())
    return detector, project, did, folder


def test_success_reclaims_only_input_and_publication_is_idempotent(task):
    detector, project, did, folder = task
    store, pid = detector.store, project['id']
    source = store.directory(pid) / 'originals' / '1.png'
    original = source.read_bytes()
    patch = (folder / 'output' / 'inpainted' / '1.npz').read_bytes()
    detector.publish(pid, did)
    published = store.read(pid)
    assert published['pages'][0]['clean'] == f'detections/{did}/output/inpainted/1.npz'
    assert detector.status(pid)['state'] == 'completed'
    assert not (folder / 'input').exists()
    assert not (store.directory(pid) / 'clean').exists()
    assert not (folder / 'output' / 'backgrounds').exists()
    assert source.read_bytes() == original
    assert (folder / 'output' / 'inpainted' / '1.npz').read_bytes() == patch
    page = published['pages'][0]
    store.review_page(pid, page['id'], page['revision'], True)
    reviewed = store.read(pid)
    detector.publish(pid, did)
    assert store.read(pid) == reviewed


@pytest.mark.parametrize('state', ['queued', 'detecting', 'calibrating', 'publishing', 'failed', 'cancelled'])
def test_unfinished_or_failed_input_is_retained(task, state):
    detector, project, did, folder = task
    detector.update(project['id'], did, state=state)
    detector.cleanup_input(project['id'], did)
    assert (folder / 'input' / '1.png').exists()


def test_live_worker_input_is_retained(task, monkeypatch):
    detector, project, did, folder = task
    detector.update(project['id'], did, state='completed')
    monkeypatch.setattr(detector, 'process_alive', lambda record: True)
    detector.cleanup_input(project['id'], did)
    assert (folder / 'input' / '1.png').exists()


@pytest.mark.parametrize('manifest_state', ['missing', 'invalid'])
def test_unavailable_project_manifest_retains_completed_task_and_input(task, manifest_state):
    detector, project, did, folder = task
    record = detector.update(project['id'], did, state='completed')
    manifest = detector.store.directory(project['id']) / 'project.json'
    if manifest_state == 'missing':
        manifest.unlink()
    else:
        manifest.write_bytes(b'invalid project manifest')

    detector.cleanup_input(project['id'], did)

    assert (folder / 'input' / '1.png').exists()
    assert read_json((folder / 'task.json').read_bytes()) == record


def test_start_skips_process_check_for_already_reclaimed_input(task, monkeypatch):
    detector, project, did, folder = task
    detector.publish(project['id'], did)
    record = detector.update(project['id'], did, pid=123456)
    published = detector.store.read(project['id'])
    assert not (folder / 'input').exists()

    def unexpected_process_check(_):
        pytest.fail('An already reclaimed input does not need a worker process check')

    monkeypatch.setattr(detector, 'process_alive', unexpected_process_check)
    with monkeypatch.context() as patch:
        patch.setattr(detector.store, 'read', lambda _: pytest.fail('Completed projects load when requested'))
        patch.setattr(detector.store, 'list', lambda: pytest.fail('Startup must not load the project list'))
        asyncio.run(start_and_cleanup(detector))
    assert detector.status(project['id']) == record
    assert detector.store.read(project['id']) == published


def test_start_returns_while_completed_input_cleanup_runs(task, monkeypatch):
    detector, project, did, folder = task
    detector.update(project['id'], did, state='completed')
    entered, finish = threading.Event(), threading.Event()
    cleanup = detector.cleanup_input

    def delayed_cleanup(pid, task_id):
        entered.set()
        assert finish.wait(5)
        cleanup(pid, task_id)

    monkeypatch.setattr(detector, 'cleanup_input', delayed_cleanup)

    async def scenario():
        try:
            await asyncio.wait_for(detector.start(), 1)
            assert await asyncio.to_thread(entered.wait, 2)
            assert (folder / 'input' / '1.png').exists()
            assert not detector.cleanup_task.done()
        finally:
            finish.set()
            await detector.stop()
        assert not (folder / 'input').exists()

    asyncio.run(scenario())


def test_stop_waits_for_current_cleanup_and_skips_remaining_projects(task, monkeypatch):
    detector, project, did, folder = task
    detector.update(project['id'], did, state='completed')
    other = detector.store.create('other', [('1.png', (folder / 'input' / '1.png').read_bytes())])
    other_did = identifier('d')
    other_task = detector.store.directory(other['id']) / 'detections' / other_did / 'task.json'
    atomic_json(other_task, {'id': other_did, 'project_id': other['id'], 'state': 'completed',
                            'created_at': '2026-11-13T00:00:00Z', 'cleanup_input_after_publish': True})
    entered, finish = threading.Event(), threading.Event()
    calls = []

    def delayed_cleanup(pid, task_id):
        calls.append((pid, task_id))
        entered.set()
        assert finish.wait(5)

    monkeypatch.setattr(detector, 'cleanup_input', delayed_cleanup)

    async def scenario():
        stopping = None
        try:
            await detector.start()
            assert await asyncio.to_thread(entered.wait, 2)
            stopping = asyncio.create_task(detector.stop())
            await asyncio.sleep(0)
            assert not stopping.done()
        finally:
            finish.set()
            if stopping is not None:
                await stopping
            else:
                await detector.stop()
        assert len(calls) == 1

    asyncio.run(scenario())


def test_preexisting_task_without_cleanup_policy_is_not_reclaimed_on_start(task):
    detector, project, did, folder = task
    detector.publish(project['id'], did)
    inputs = folder / 'input'; inputs.mkdir()
    (inputs / 'old-source.png').write_bytes(b'preexisting task snapshot')
    record = detector.status(project['id'])
    record.pop('cleanup_input_after_publish')
    atomic_json(folder / 'task.json', record)
    asyncio.run(start_and_cleanup(detector))
    assert (inputs / 'old-source.png').read_bytes() == b'preexisting task snapshot'


@pytest.mark.parametrize('invalid', ['missing', 'rgb', 'size', 'corrupt'])
def test_invalid_overlay_preserves_input_and_old_project(task, invalid):
    detector, project, did, folder = task
    path = folder / 'output' / 'inpainted' / '1.npz'
    if invalid == 'missing': path.unlink()
    elif invalid == 'rgb': np.savez_compressed(path, overlay=np.zeros((60,40,3), dtype=np.uint8))
    elif invalid == 'size': save_overlay(Image.new('RGBA', (41, 60)), path)
    else: path.write_bytes(b'invalid PNG')
    before = detector.store.read(project['id'])
    with pytest.raises((ValueError, OSError)):
        detector.publish(project['id'], did)
    assert detector.store.read(project['id']) == before
    assert detector.status(project['id'])['state'] == 'publishing'
    assert (folder / 'input' / '1.png').exists()


def test_failed_manifest_write_does_not_reclaim_input(task, monkeypatch):
    detector, project, did, folder = task
    def fail(_): raise OSError('manifest write failed')
    monkeypatch.setattr(detector.store, 'write', fail)
    with pytest.raises(OSError, match='manifest write failed'):
        detector.publish(project['id'], did)
    assert detector.store.read(project['id']) == project
    assert (folder / 'input' / '1.png').exists()


def test_cleanup_failure_keeps_result_completed_and_retries_on_start(task, monkeypatch):
    detector, project, did, folder = task
    remove = shutil.rmtree
    def fail(_): raise PermissionError('input busy')
    monkeypatch.setattr('app.prelayout.detection.shutil.rmtree', fail)
    detector.publish(project['id'], did)
    published = detector.store.read(project['id'])
    assert detector.status(project['id'])['state'] == 'completed'
    assert detector.status(project['id'])['input_cleanup_error'] == 'input busy'
    assert (folder / 'input').exists()
    monkeypatch.setattr('app.prelayout.detection.shutil.rmtree', remove)
    asyncio.run(start_and_cleanup(detector))
    assert not (folder / 'input').exists()
    assert detector.status(project['id'])['input_cleanup_error'] is None
    assert detector.store.read(project['id']) == published


def test_start_recovers_publication_before_reclaiming_input(task):
    detector, project, _, folder = task

    async def scenario():
        await detector.start()
        assert detector.status(project['id'])['state'] == 'completed'
        assert (folder / 'input').exists()
        await detector.cleanup_task
        assert not (folder / 'input').exists()

    asyncio.run(scenario())


def test_input_symlink_is_not_followed(task, tmp_path):
    detector, project, did, folder = task
    shutil.rmtree(folder / 'input')
    outside = tmp_path / 'outside'; outside.mkdir()
    sentinel = outside / 'keep'; sentinel.write_text('untouched')
    (folder / 'input').symlink_to(outside, target_is_directory=True)
    detector.publish(project['id'], did)
    assert detector.status(project['id'])['state'] == 'completed'
    assert '符號連結' in detector.status(project['id'])['input_cleanup_error']
    assert sentinel.read_text() == 'untouched'
