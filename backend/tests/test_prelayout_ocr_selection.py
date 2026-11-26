"""Model selection remains explicit across new tasks and legacy records."""
import asyncio
import sys

import pytest

from app.config import Settings
from app.prelayout.detection import PrelayoutDetection
from app.prelayout.store import PrelayoutStore
from app.resources import ResourceGate
from prelayout_core.ocr_engine import charspot_assets, configured_engine, task_engine


@pytest.fixture
def installation(tmp_path, monkeypatch):
    root = tmp_path / 'models'
    root.mkdir()
    for name in ('comictextdetector.pt', 'mit48pxctc_ocr.ckpt', 'alphabet-all-v5.txt',
                 'NotoSansCJKjp-Medium.otf', 'NotoSansCJKjp-Medium.ink-metrics.json'):
        (root / name).write_bytes(b'fixture')
    monkeypatch.setenv('COMIC_PRELAYOUT_MODEL_ROOT', str(root))
    monkeypatch.setenv('COMIC_PRELAYOUT_PYTHON', sys.executable)
    monkeypatch.setenv('COMIC_PRELAYOUT_DEVICE', 'mps')
    monkeypatch.delenv('COMIC_PRELAYOUT_OCR_ENGINE', raising=False)
    monkeypatch.delenv('COMIC_PRELAYOUT_CHARSPOT_DEVICE', raising=False)
    store = PrelayoutStore(tmp_path / 'prelayout')
    return root, store


def test_missing_new_model_disables_ocr_without_selecting_installed_mit(installation):
    _, store = installation
    detector = PrelayoutDetection(Settings(), store, ResourceGate())
    status = detector.availability()
    assert status['ocr_engine'] == 'charspot'
    assert status['ocr_device'] == 'cpu'
    assert status['methods'] == {'fixed': True, 'single_char': True, 'ocr_aligned': False}


def test_charspot_does_not_require_mit_assets(installation):
    root, store = installation
    for name in ('mit48pxctc_ocr.ckpt', 'alphabet-all-v5.txt'):
        (root / name).unlink()
    for name in charspot_assets('cpu'):
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b'fixture')
    detector = PrelayoutDetection(Settings(), store, ResourceGate())
    assert detector.availability()['methods']['ocr_aligned'] is True


def test_legacy_model_is_disabled_and_legacy_tasks_keep_their_identity(installation, monkeypatch):
    _, store = installation
    monkeypatch.setenv('COMIC_PRELAYOUT_OCR_ENGINE', 'mit48')
    detector = PrelayoutDetection(Settings(), store, ResourceGate())
    status = detector.availability()
    assert status['methods'] == {'fixed': True, 'single_char': True, 'ocr_aligned': False}
    assert 'mit48 推理已停用' in status['ocr_error']
    with pytest.raises(ValueError, match='mit48 推理已停用'):
        configured_engine()
    monkeypatch.setenv('COMIC_PRELAYOUT_OCR_ENGINE', 'charspot')
    assert configured_engine() == 'charspot'
    assert task_engine({'options': {'method': 'ocr_aligned'}}) == 'mit48'
    assert task_engine({'options': {'ocr_engine': 'charspot'}}) == 'charspot'


@pytest.mark.parametrize('options', [{'method': 'ocr_aligned'}, {'method': 'ocr_aligned', 'ocr_engine': 'mit48'}])
def test_worker_refuses_disabled_tasks_before_reading_or_writing_inputs(tmp_path, options):
    from prelayout_core.worker import run_ocr

    with pytest.raises(ValueError, match='mit48 推理已停用'):
        run_ocr(tmp_path, {'options': options}, tmp_path / 'missing-images', tmp_path / 'missing-models')
    assert not list(tmp_path.iterdir())


def test_invalid_engine_disables_only_ocr(installation, monkeypatch):
    _, store = installation
    monkeypatch.setenv('COMIC_PRELAYOUT_OCR_ENGINE', 'typo')
    detector = PrelayoutDetection(Settings(), store, ResourceGate())
    status = detector.availability()
    assert status['ocr_error']
    assert status['methods'] == {'fixed': True, 'single_char': True, 'ocr_aligned': False}


def test_submit_snapshots_ocr_engine_and_device(installation, monkeypatch):
    from io import BytesIO
    from PIL import Image

    _, store = installation
    image = BytesIO()
    Image.new('RGB', (20, 30), 'white').save(image, 'PNG')
    project = store.create('test', [('1.png', image.getvalue())])
    detector = PrelayoutDetection(Settings(), store, ResourceGate())
    monkeypatch.setattr(detector, 'availability', lambda: {
        'methods': {'ocr_aligned': True}, 'ocr_device': 'cpu'})

    async def run(*_):
        pass

    monkeypatch.setattr(detector, 'run', run)

    async def submit():
        task = await detector.submit(project['id'], {'method': 'ocr_aligned'})
        await detector.tasks[project['id']]
        return task

    task = asyncio.run(submit())
    assert task['device'] == 'mps'
    assert task['options'] == {
        'method': 'ocr_aligned', 'font_size': 24, 'step': 2,
        'ocr_engine': 'charspot', 'ocr_device': 'cpu',
    }
