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


@pytest.mark.parametrize('device', ['cuda:0', 'mps', 'cpu'])
def test_sequential_stages_and_publish_without_model_inference(tmp_path, monkeypatch, device):
    manager, project = setup_manager(tmp_path)
    config = json.loads(manager.config_path.read_text())
    config['device'] = device
    manager.config_path = tmp_path / 'detection-config.json'
    manager.config_path.write_text(json.dumps(config))
    monkeypatch.setattr(manager, 'availability', lambda: {'available': True})
    releases = []
    monkeypatch.setattr(manager, '_comfy_release', lambda: releases.append(True))
    stages = []
    async def stage(record, name):
        stages.append(name)
        if name == 'classify':
            manifest = json.loads((manager._task_dir(project['id'], record['id']) / 'manifest.json').read_text())
            for entry in manifest['pages']:
                target = Path(entry['output'])
                target.mkdir(parents=True)
                text = Image.new('L', (30, 30))
                text.putpixel((4, 5), 255)
                text.save(target / 'text_mask.png')
                for key in ('overlay', 'other', 'edited'):
                    with Image.open(entry[key]) as image:
                        image.save(target / f'{key}.png')
    monkeypatch.setattr(manager, '_stage', stage)
    async def run():
        await manager.submit(project['id'], DetectionRequest(expected_revision=0))
        await manager.task
    asyncio.run(run())
    assert stages == ['check', 'rf', 'mangalens', 'classify']
    assert releases == ([True] if device == 'cuda:0' else [])
    assert manager.status(project['id'])['state'] == 'completed'
    saved = manager.store.read(project['id'])
    assert saved['state'] == 'ready'
    assert saved['pages'][0]['edit_revision'] == 1
    assert saved['pages'][0]['mask_ready']
    assert saved['pages'][0]['detection']['device'] == device
    with Image.open(manager.store.asset_path(project['id'], saved['pages'][0]['detected_text'])) as text:
        assert text.mode == 'L'
        assert text.size == (30, 30)
        assert text.getpixel((4, 5)) == 255
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


def edited_detection_project(tmp_path, monkeypatch):
    manager, _ = setup_manager(tmp_path)
    sources = {}
    for name in ('first', 'second'):
        sources[name] = tmp_path / f'{name}.png'
        Image.new('RGB', (140, 140), 'white').save(sources[name])
    project = manager.store.create('existing edits', sources)
    for page in project['pages']:
        overlay = Image.new('RGBA', (140, 140))
        overlay.putpixel((10, 10), (12, 34, 56, 255))
        other, edited = Image.new('L', overlay.size), Image.new('L', overlay.size)
        other.putpixel((11, 11), 255)
        for point in ((10, 10), (11, 11), (12, 12)):
            edited.putpixel(point, 255)  # Includes a deliberate empty/erased pixel.
        detected = Image.new('L', overlay.size)
        detected.putpixel((90, 90), 255)
        project = manager.store.save_edit(project['id'], page['id'], 0, overlay, other, edited,
                                          detected_text=detected)
    monkeypatch.setattr(manager, 'availability', lambda: {'available': True})
    monkeypatch.setattr(manager, '_comfy_release', lambda: None)
    assets = {page['id']: {key: manager.store.asset_path(project['id'], page[key]).read_bytes()
                          for key in ('source', 'overlay', 'other', 'edited', 'detected_text')}
              for page in project['pages']}
    return manager, project, assets


def write_simulated_detection_stage(manager, record, name):
    root = manager._task_dir(record['project_id'], record['id'])
    manifest = json.loads((root / 'manifest.json').read_text())
    for entry in manifest['pages']:
        target = Path(entry['output'])
        target.mkdir(parents=True, exist_ok=True)
        if name == 'rf':
            text = Image.new('L', (140, 140))
            text.paste(255, (65, 65, 73, 73))
            text.save(target / 'text_mask.png')
        elif name == 'mangalens':
            (target / 'bubbles.json').write_text('[]')
    if name == 'classify':
        config = json.loads((root / 'config.json').read_text())
        run_stage(name, manifest, config, root / 'progress.json')
    return manifest


@pytest.mark.parametrize('replace_existing', [False, True])
def test_detection_replace_uses_isolated_inputs_and_only_publishes_selected_page(tmp_path, monkeypatch, replace_existing):
    manager, project, assets = edited_detection_project(tmp_path, monkeypatch)
    selected, unselected = project['pages']
    stages = []

    async def stage(record, name):
        stages.append(name)
        assert record['replace_existing'] is replace_existing
        # No edit is removed before completion, including during classification.
        current = manager.store.read(project['id'])
        assert current['pages'] == project['pages']
        for page in current['pages']:
            for key, content in assets[page['id']].items():
                assert manager.store.asset_path(project['id'], page[key]).read_bytes() == content
        manifest = write_simulated_detection_stage(manager, record, name)
        assert manifest['replace_existing'] is replace_existing
        assert len(manifest['pages']) == 1
        entry = manifest['pages'][0]
        assert entry['id'] == selected['id']
        assert Path(entry['source']).read_bytes() == assets[selected['id']]['source']
        for key in ('overlay', 'other', 'edited'):
            if replace_existing:
                assert Path(entry[key]).is_relative_to(manager._task_dir(project['id'], record['id']) / 'inputs')
                with Image.open(entry[key]) as image:
                    assert not np.asarray(image).any()
            else:
                assert Path(entry[key]).read_bytes() == assets[selected['id']][key]

    monkeypatch.setattr(manager, '_stage', stage)
    async def run():
        request = dict(expected_revision=project['revision'], page_ids=[selected['id']])
        if replace_existing:
            request['replace_existing'] = True
        await manager.submit(project['id'], DetectionRequest(**request))
        await manager.task
    asyncio.run(run())
    assert stages == ['check', 'rf', 'mangalens', 'classify']
    assert manager.status(project['id'])['state'] == 'completed'
    saved = manager.store.read(project['id'])
    result = manager.store.page(saved, selected['id'])
    assert manager.store.page(saved, unselected['id']) == unselected
    assert result['edit_revision'] == selected['edit_revision'] + 1
    assert result['detection']['replace_existing'] is replace_existing
    for page in saved['pages']:
        assert manager.store.asset_path(project['id'], page['source']).read_bytes() == assets[page['id']]['source']
    for key in ('overlay', 'other', 'edited'):
        with Image.open(manager.store.asset_path(project['id'], result[key])) as image:
            if key == 'overlay':
                assert image.getpixel((69, 69)) == (255, 255, 255, 255)
                assert image.getpixel((10, 10)) == ((0, 0, 0, 0) if replace_existing else (12, 34, 56, 255))
            elif key == 'other':
                assert image.getpixel((11, 11)) == (0 if replace_existing else 255)
            else:
                assert image.getpixel((12, 12)) == (0 if replace_existing else 255)
    with Image.open(manager.store.asset_path(project['id'], result['detected_text'])) as text:
        assert text.getpixel((90, 90)) == 0
        assert text.getpixel((69, 69)) == 255
    assert manager.gpu_gate.owner is None


@pytest.mark.parametrize('failure', ['stage_failure', 'invalid_second_output', 'cancel_before_publish'])
def test_replacement_failure_or_cancellation_preserves_all_existing_assets(tmp_path, monkeypatch, failure):
    manager, project, assets = edited_detection_project(tmp_path, monkeypatch)

    async def stage(record, name):
        if failure == 'stage_failure' and name == 'mangalens':
            raise RuntimeError('simulated model failure')
        manifest = write_simulated_detection_stage(manager, record, name)
        if name == 'classify':
            if failure == 'invalid_second_output':
                Image.new('L', (1, 1)).save(Path(manifest['pages'][1]['output']) / 'other.png')
            elif failure == 'cancel_before_publish':
                await manager.cancel(project['id'])

    monkeypatch.setattr(manager, '_stage', stage)
    async def run():
        await manager.submit(project['id'], DetectionRequest(expected_revision=project['revision'], replace_existing=True))
        await manager.task
    asyncio.run(run())
    status = manager.status(project['id'])
    assert status['state'] == ('cancelled' if failure == 'cancel_before_publish' else 'failed')
    assert status['applied'] == []
    saved = manager.store.read(project['id'])
    assert saved['pages'] == project['pages']
    assert saved['state'] == 'ready'
    for page in saved['pages']:
        for key, content in assets[page['id']].items():
            assert manager.store.asset_path(project['id'], page[key]).read_bytes() == content
    assert manager.gpu_gate.owner is None


@pytest.mark.parametrize('change', [
    {'mask_dilate': -1}, {'mask_dilate': 65}, {'mask_dilate': 1.5},
    {'mask_mode': 'bubble'}, {'bubble_shrink_percent': -0.01},
    {'bubble_shrink_percent': 10.01}, {'bubble_shrink_percent': float('nan')},
    {'bubble_shrink_percent': float('inf')}, {'device': 'cpu'},
    {'path': '/tmp/model'}, {'class_thresholds': {'text': 0}},
])
def test_detection_options_reject_invalid_or_unrelated_settings(change):
    from pydantic import ValidationError
    options = dict(mask_dilate=2, mask_mode='text_onomatopoeia', bubble_enabled=True, bubble_shrink_percent=2)
    with pytest.raises(ValidationError):
        DetectionRequest(expected_revision=0, options=options | change)


@pytest.mark.parametrize('dilation,shrink', [(0, 0), (64, 10)])
def test_detection_options_accept_exact_limits(dilation, shrink):
    request = DetectionRequest(expected_revision=0, options=dict(mask_dilate=dilation,
        mask_mode='all', bubble_enabled=False, bubble_shrink_percent=shrink))
    assert request.options.mask_dilate == dilation
    assert request.options.bubble_shrink_percent == shrink


def test_availability_distinguishes_optional_bubble_model_and_returns_server_defaults(tmp_path):
    manager, _ = setup_manager(tmp_path)
    config = json.loads(manager.config_path.read_text())
    config['rf'].update(path=str(tmp_path / 'rf.safetensors'), mask_dilate=5, mask_mode='onomatopoeia')
    config['rf'].pop('path_env', None)
    Path(config['rf']['path']).write_bytes(b'present')
    config['mangalens'].update(path=str(tmp_path / 'missing.pt'), enabled=False, shrink_ratio=.06)
    config['mangalens'].pop('path_env', None)
    manager.config_path = tmp_path / 'settings.json'
    manager.config_path.write_text(json.dumps(config))
    manager.python = sys.executable
    status = manager.availability()
    assert status['available'] is False
    assert status['available_without_bubbles'] is True
    assert status['errors_without_bubbles'] == []
    assert status['defaults'] == dict(mask_dilate=5, mask_mode='onomatopoeia', bubble_enabled=False, bubble_shrink_percent=6)


@pytest.mark.parametrize('explicit', [False, True])
def test_detection_options_frozen_and_remembered_without_changing_server_config(tmp_path, monkeypatch, explicit):
    manager, project, _ = edited_detection_project(tmp_path, monkeypatch)
    config = json.loads(manager.config_path.read_text())
    config['rf'].update(mask_dilate=5, mask_mode='text')
    config['mangalens'].update(enabled=False, shrink_ratio=.04)
    manager.config_path = tmp_path / 'settings.json'
    original = json.dumps(config)
    manager.config_path.write_text(original)
    chosen = dict(mask_dilate=0, mask_mode='all', bubble_enabled=False, bubble_shrink_percent=10)
    expected = chosen if explicit else dict(mask_dilate=5, mask_mode='text', bubble_enabled=False, bubble_shrink_percent=4)
    monkeypatch.setattr(manager, 'availability', lambda: {'available': False, 'errors': ['missing manga'],
        'available_without_bubbles': True, 'errors_without_bubbles': []})
    stages = []
    async def stage(record, name):
        stages.append(name)
        root = manager._task_dir(project['id'], record['id'])
        frozen = json.loads((root / 'config.json').read_text())
        assert frozen['rf']['mask_mode'] == expected['mask_mode']
        assert frozen['rf']['mask_dilate'] == expected['mask_dilate']
        assert frozen['rf']['class_thresholds'] == config['rf']['class_thresholds']
        assert frozen['device'] == config['device']
        assert frozen['mangalens']['enabled'] is False
        assert frozen['mangalens']['shrink_ratio'] == expected['bubble_shrink_percent'] / 100
        manifest = write_simulated_detection_stage(manager, record, name)
        assert manifest['options'] == expected
    monkeypatch.setattr(manager, '_stage', stage)
    async def run():
        request = DetectionRequest(expected_revision=project['revision'], replace_existing=True,
                                   options=chosen if explicit else None)
        record = await manager.submit(project['id'], request)
        assert record['options'] == expected
        assert manager.store.read(project['id'])['detection_options'] == expected
        await manager.task
    asyncio.run(run())
    assert stages == ['check', 'rf', 'mangalens', 'classify']
    assert manager.config_path.read_text() == original
    assert manager.status(project['id'])['state'] == 'completed'
    assert manager.status(project['id'])['options'] == expected
    for page in manager.store.read(project['id'])['pages']:
        assert page['detection']['options'] == expected
        assert page['detection']['models'] == ['rf']
