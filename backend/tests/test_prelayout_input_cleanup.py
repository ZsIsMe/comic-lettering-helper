"""Published assets survive reclamation of a finished worker's input snapshot."""
import asyncio
import io
import shutil

import pytest
from PIL import Image

from app.config import Settings
from app.prelayout.detection import PrelayoutDetection
from app.prelayout.store import PrelayoutStore, atomic_json
from app.resources import ResourceGate
from prelayout_core.data import identifier


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
    overlay = folder / 'output' / 'inpainted' / '1.png'
    overlay.parent.mkdir(parents=True)
    Image.new('RGBA', (40, 60), (10, 20, 30, 128)).save(overlay)
    atomic_json(folder / 'output' / 'measure.json', {'pages': {'1.png': []}})
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
    patch = (folder / 'output' / 'inpainted' / '1.png').read_bytes()
    detector.publish(pid, did)
    published = store.read(pid)
    assert published['pages'][0]['clean'] == f'detections/{did}/output/inpainted/1.png'
    assert detector.status(pid)['state'] == 'completed'
    assert not (folder / 'input').exists()
    assert not (store.directory(pid) / 'clean').exists()
    assert not (folder / 'output' / 'backgrounds').exists()
    assert source.read_bytes() == original
    assert (folder / 'output' / 'inpainted' / '1.png').read_bytes() == patch
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


def test_preexisting_task_without_cleanup_policy_is_not_reclaimed_on_start(task):
    detector, project, did, folder = task
    detector.publish(project['id'], did)
    inputs = folder / 'input'; inputs.mkdir()
    (inputs / 'old-source.png').write_bytes(b'preexisting task snapshot')
    record = detector.status(project['id'])
    record.pop('cleanup_input_after_publish')
    atomic_json(folder / 'task.json', record)
    asyncio.run(detector.start())
    assert (inputs / 'old-source.png').read_bytes() == b'preexisting task snapshot'


@pytest.mark.parametrize('invalid', ['missing', 'rgb', 'size', 'corrupt'])
def test_invalid_overlay_preserves_input_and_old_project(task, invalid):
    detector, project, did, folder = task
    path = folder / 'output' / 'inpainted' / '1.png'
    if invalid == 'missing': path.unlink()
    elif invalid == 'rgb': Image.new('RGB', (40, 60)).save(path)
    elif invalid == 'size': Image.new('RGBA', (41, 60)).save(path)
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
    asyncio.run(detector.start())
    assert not (folder / 'input').exists()
    assert detector.status(project['id'])['input_cleanup_error'] is None
    assert detector.store.read(project['id']) == published


def test_start_recovers_publication_before_reclaiming_input(task):
    detector, project, _, folder = task
    asyncio.run(detector.start())
    assert detector.status(project['id'])['state'] == 'completed'
    assert not (folder / 'input').exists()


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
