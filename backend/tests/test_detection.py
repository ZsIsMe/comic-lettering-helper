from __future__ import annotations

import asyncio
import json
from pathlib import Path
import sys

import numpy as np
from PIL import Image
import pytest

from app.config import Settings
from app.detection import DetectionManager, DetectionRequest
from app.projects import ProjectStore, ProjectConflict
from app.resources import ResourceGate as Gate
from imaging.core import classify_page
from imaging.models import DetectionUnavailable, load_config, validate_weights
from imaging.worker import run_stage


ROOT = Path(__file__).resolve().parents[2]


def test_solid_classification_uses_rgb_and_preserves_manual_erasures():
    # Explicitly non-gray background catches RGB/BGR swaps at the project boundary.
    rgb = np.full((140, 140, 3), (240, 210, 180), np.uint8)
    text = np.zeros((140, 140), np.uint8)
    text[65:72, 65:72] = 255
    rgb[text > 0] = 0
    overlay = np.zeros((140, 140, 4), np.uint8)
    other = np.zeros((140, 140), np.uint8)
    edited = np.zeros_like(other)
    edited[60:64, 60:64] = 255  # An erased patch must stay transparent.
    overlay[64, 65] = [10, 20, 30, 255]
    edited[64, 65] = 255
    other[66, 66] = edited[66, 66] = 255
    result, remaining, locks, _ = classify_page(rgb, text, [], overlay=overlay, other=other, edited=edited)
    assert tuple(result[69, 69]) == (240, 210, 180, 255)
    assert tuple(result[64, 65]) == (10, 20, 30, 255)
    assert not np.any(result[60:64, 60:64])
    assert remaining[66, 66] == 255 and result[66, 66, 3] == 0
    assert np.array_equal(locks, edited)
    assert not np.any((result[:, :, 3] > 0) & (remaining > 0))


def test_empty_detection_retains_manual_edits():
    source = np.full((24, 24, 3), 255, np.uint8)
    overlay = np.zeros((24, 24, 4), np.uint8)
    overlay[2:5, 2:5] = [0, 128, 240, 255]
    edited = overlay[:, :, 3].copy()
    mask = np.zeros((24, 24), np.uint8)
    result, other, locks, _ = classify_page(source, mask, [], overlay=overlay, edited=edited)
    assert np.array_equal(result, overlay)
    assert not other.any()
    assert np.array_equal(locks, edited)


def test_complex_background_stays_in_other():
    rng = np.random.default_rng(7)
    rgb = rng.integers(0, 256, size=(140, 140, 3), dtype=np.uint8)
    mask = np.zeros((140, 140), np.uint8)
    mask[60:80, 60:80] = 255
    overlay, other, _, _ = classify_page(rgb, mask, [])
    assert np.any(other)
    assert not np.any(overlay[:, :, 3])


def test_invalid_dimensions_and_overlap_rejected():
    rgb = np.zeros((20, 20, 3), np.uint8)
    with pytest.raises(ValueError, match='尺寸'):
        classify_page(rgb, np.zeros((19, 20), np.uint8), [])
    overlay = np.full((20, 20, 4), 255, np.uint8)
    with pytest.raises(ValueError, match='重疊'):
        classify_page(rgb, np.zeros((20, 20), np.uint8), [], overlay=overlay, other=np.ones((20, 20), np.uint8))


def test_missing_models_and_hash_mismatch(tmp_path):
    config = load_config(ROOT / 'config/detection-models.json')
    config['rf']['path'] = str(tmp_path / 'rf.safetensors')
    config['mangalens']['path'] = str(tmp_path / 'mangalens.pt')
    with pytest.raises(DetectionUnavailable, match='缺少 rf'):
        validate_weights(config)
    Path(config['rf']['path']).write_bytes(b'not a real weight')
    with pytest.raises(DetectionUnavailable, match='SHA-256'):
        validate_weights(config)


def test_classify_worker_consumes_stage_cache_without_torch(tmp_path):
    source = Image.new('RGB', (32, 32), 'white')
    for name, image in [('source', source), ('overlay', Image.new('RGBA', source.size)),
                        ('other', Image.new('L', source.size)), ('edited', Image.new('L', source.size))]:
        image.save(tmp_path / f'{name}.png')
    output = tmp_path / 'out'
    output.mkdir()
    Image.new('L', source.size).save(output / 'text_mask.png')
    (output / 'bubbles.json').write_text('[]')
    page = dict(id='one', output=str(output), **{name: str(tmp_path / f'{name}.png') for name in ('source', 'overlay', 'other', 'edited')})
    run_stage('classify', {'pages': [page]}, {'mangalens': {'shrink_ratio': 0.02}}, tmp_path / 'progress.json')
    assert (output / 'overlay.png').is_file()
    assert json.loads((tmp_path / 'progress.json').read_text())['completed'] == 1


def setup_manager(tmp_path):
    store = ProjectStore(tmp_path / 'projects')
    source = tmp_path / 'one.png'
    Image.new('RGB', (30, 30), 'white').save(source)
    project = store.create('test', {'one': source})
    manager = DetectionManager(Settings(app_root=ROOT, data_root=tmp_path), store, Gate())
    return manager, project


def test_missing_environment_does_not_claim_gpu_or_lock_project(tmp_path):
    manager, project = setup_manager(tmp_path)
    with pytest.raises(ValueError):
        asyncio.run(manager.submit(project['id'], DetectionRequest(expected_revision=0)))
    assert manager.gpu_gate.owner is None
    assert manager.store.read(project['id'])['state'] == 'ready'


def test_detection_failure_unlocks_project_and_gpu(tmp_path, monkeypatch):
    manager, project = setup_manager(tmp_path)
    monkeypatch.setattr(manager, 'availability', lambda: {'available': True})
    def busy_comfy():
        raise ProjectConflict('external ComfyUI work')
    monkeypatch.setattr(manager, '_comfy_release', busy_comfy)
    async def run():
        await manager.submit(project['id'], DetectionRequest(expected_revision=0))
        await manager.task
    asyncio.run(run())
    assert manager.status(project['id'])['state'] == 'failed'
    assert manager.store.read(project['id'])['state'] == 'ready'
    assert manager.gpu_gate.owner is None


def test_stale_detection_rejected_before_state_change(tmp_path, monkeypatch):
    manager, project = setup_manager(tmp_path)
    monkeypatch.setattr(manager, 'availability', lambda: {'available': True})
    with pytest.raises(ProjectConflict, match='已更新'):
        asyncio.run(manager.submit(project['id'], DetectionRequest(expected_revision=1)))
    assert manager.gpu_gate.owner is None
    assert manager.store.read(project['id'])['state'] == 'ready'


def test_bubble_fill_preserves_protected_other():
    rgb = np.full((180, 180, 3), 255, np.uint8)
    text = np.zeros((180, 180), np.uint8)
    text[70:90, 75:82] = 255
    rgb[text > 0] = 0
    polygon = np.array([[30, 30], [150, 30], [150, 150], [30, 150]], np.float32)
    other = np.zeros_like(text)
    other[75:80, 75:80] = 255
    overlay, remaining, _, diagnostics = classify_page(rgb, text, [polygon], other=other, edited=other)
    assert np.all(remaining[75:80, 75:80] == 255)
    assert not np.any(overlay[75:80, 75:80, 3])
    assert diagnostics['bubbles_debug']
    assert not np.any((overlay[:, :, 3] > 0) & (remaining > 0))


def test_sequential_stages_and_publish_without_model_inference(tmp_path, monkeypatch):
    manager, project = setup_manager(tmp_path)
    monkeypatch.setattr(manager, 'availability', lambda: {'available': True})
    monkeypatch.setattr(manager, '_comfy_release', lambda: None)
    stages = []
    async def stage(record, name):
        stages.append(name)
        if name == 'classify':
            manifest = json.loads((manager._task_dir(project['id'], record['id']) / 'manifest.json').read_text())
            for entry in manifest['pages']:
                target = Path(entry['output'])
                target.mkdir(parents=True)
                for key in ('overlay', 'other', 'edited'):
                    with Image.open(entry[key]) as image:
                        image.save(target / f'{key}.png')
    monkeypatch.setattr(manager, '_stage', stage)
    async def run():
        await manager.submit(project['id'], DetectionRequest(expected_revision=0))
        await manager.task
    asyncio.run(run())
    assert stages == ['check', 'rf', 'mangalens', 'classify']
    assert manager.status(project['id'])['state'] == 'completed'
    saved = manager.store.read(project['id'])
    assert saved['state'] == 'ready'
    assert saved['pages'][0]['edit_revision'] == 1
    assert saved['pages'][0]['mask_ready']
    assert manager.gpu_gate.owner is None


def test_restart_does_not_replay_interrupted_detection(tmp_path):
    manager, project = setup_manager(tmp_path)
    detection_id = 'a' * 32
    project.update(state='detecting', detection_id=detection_id)
    manager.store.write(project)
    manager._write({'id': detection_id, 'project_id': project['id'], 'state': 'rf', 'pid': None})
    asyncio.run(manager.start())
    assert manager.status(project['id'])['state'] == 'failed'
    assert manager.store.read(project['id'])['state'] == 'ready'
    assert manager.gpu_gate.owner is None


def test_restart_reserves_gpu_for_surviving_process(tmp_path, monkeypatch):
    manager, project = setup_manager(tmp_path)
    detection_id = 'b' * 32
    project.update(state='detecting', detection_id=detection_id)
    manager.store.write(project)
    manager._write({'id': detection_id, 'project_id': project['id'], 'state': 'rf', 'pid': 42})
    monkeypatch.setattr('app.detection.pid_alive', lambda pid: True)
    asyncio.run(manager.start())
    assert manager.status(project['id'])['state'] == 'recovery_required'
    assert manager.gpu_gate.owner == detection_id
    with pytest.raises(ProjectConflict, match='仍存在'):
        manager.recover(project['id'])
    monkeypatch.setattr('app.detection.pid_alive', lambda pid: False)
    manager.recover(project['id'])
    assert manager.gpu_gate.owner is None
    assert manager.store.read(project['id'])['state'] == 'ready'


def test_cancel_waits_for_real_child_exit_before_releasing_gate(tmp_path, monkeypatch):
    manager, project = setup_manager(tmp_path)
    monkeypatch.setattr(manager, 'availability', lambda: {'available': True})
    monkeypatch.setattr(manager, '_comfy_release', lambda: None)
    manager.python = sys.executable
    create = asyncio.create_subprocess_exec
    spawned = []
    async def spawn(*args, **kwargs):
        child = await create(sys.executable, '-c', 'import time; time.sleep(30)', **kwargs)
        spawned.append(child)
        return child
    monkeypatch.setattr(asyncio, 'create_subprocess_exec', spawn)
    async def run():
        await manager.submit(project['id'], DetectionRequest(expected_revision=0))
        for _ in range(100):
            if manager.process:
                break
            await asyncio.sleep(0.01)
        assert manager.process is not None
        assert manager.gpu_gate.owner is not None
        await manager.cancel(project['id'])
        await asyncio.wait_for(manager.task, timeout=5)
    asyncio.run(run())
    assert spawned[0].returncode is not None
    assert manager.gpu_gate.owner is None
    assert manager.store.read(project['id'])['state'] == 'ready'
    assert manager.status(project['id'])['state'] == 'cancelled'
