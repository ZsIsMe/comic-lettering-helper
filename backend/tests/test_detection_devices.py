"""Device selection tests use stand-ins; real MPS/CUDA inference is separate acceptance."""
from __future__ import annotations

import json
from pathlib import Path
import sys
from types import SimpleNamespace

import numpy as np
from PIL import Image
import pytest

from imaging.models import (
    DetectionUnavailable, MangaLensDetector, RFDetector,
    device_metrics, load_config, require_device,
)
from imaging.worker import run_stage


class ForbiddenBackend:
    def __getattr__(self, name):
        raise AssertionError(f'Unselected accelerator accessed: {name}')


def mps_torch(available=True):
    return SimpleNamespace(
        cuda=ForbiddenBackend(),
        backends=SimpleNamespace(mps=SimpleNamespace(is_built=lambda: True, is_available=lambda: available)),
        mps=SimpleNamespace(current_allocated_memory=lambda: 12 * 1024 * 1024,
                            driver_allocated_memory=lambda: 24 * 1024 * 1024,
                            recommended_max_memory=lambda: 8192 * 1024 * 1024),
        device=lambda name: name,
    )


@pytest.mark.parametrize('device', ['cuda:0', 'mps', 'cpu'])
def test_explicit_device_is_loaded_unchanged(tmp_path, device):
    path = tmp_path / 'config.json'
    path.write_text(json.dumps({'version': 1, 'device': device, 'rf': {'path': 'rf'}, 'mangalens': {'path': 'mangalens'}}))
    assert load_config(path)['device'] == device


@pytest.mark.parametrize('device', [None, '', 'auto', 'cuda', 'mps:0', 'cuda:1'])
def test_ambiguous_or_unconfigured_device_is_rejected(device):
    with pytest.raises(DetectionUnavailable, match='明確指定'):
        require_device({'device': device})


def test_cpu_does_not_probe_any_accelerator(monkeypatch):
    torch = SimpleNamespace(cuda=ForbiddenBackend(), backends=ForbiddenBackend(), mps=ForbiddenBackend())
    monkeypatch.setitem(sys.modules, 'torch', torch)
    config = {'device': 'cpu'}
    assert require_device(config) is torch
    assert device_metrics(config, torch) == {'device': 'cpu'}
    assert device_metrics(config, torch, inference=True) == {'device': 'cpu'}
    assert config['device'] == 'cpu'


def test_mps_unavailable_cannot_fall_back_to_cpu(monkeypatch):
    monkeypatch.setitem(sys.modules, 'torch', mps_torch(available=False))
    config = {'device': 'mps'}
    with pytest.raises(DetectionUnavailable, match='不會退回 CPU'):
        require_device(config)
    assert config['device'] == 'mps'


def test_mps_success_and_metrics_never_touch_cuda(monkeypatch):
    torch = mps_torch()
    monkeypatch.setitem(sys.modules, 'torch', torch)
    assert require_device({'device': 'mps'}) is torch
    for inference in (False, True):
        metrics = device_metrics({'device': 'mps'}, torch, inference=inference)
        assert metrics['device'] == 'mps'
        assert metrics['mps_allocated_mb'] == 12
        assert metrics['mps_driver_allocated_mb'] == 24
        assert 'peak_allocated_mb' not in metrics
        assert 'free_vram_mb' not in metrics


def test_cuda_unavailable_does_not_try_mps(monkeypatch):
    torch = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False), backends=ForbiddenBackend(), mps=ForbiddenBackend())
    monkeypatch.setitem(sys.modules, 'torch', torch)
    with pytest.raises(DetectionUnavailable, match='CUDA GPU'):
        require_device({'device': 'cuda:0'})


def test_cuda_minimum_memory_still_enforced(monkeypatch):
    torch = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: True, mem_get_info=lambda index: (1024, 8192)),
                            backends=ForbiddenBackend(), mps=ForbiddenBackend())
    monkeypatch.setitem(sys.modules, 'torch', torch)
    with pytest.raises(DetectionUnavailable, match='顯存不足'):
        require_device({'device': 'cuda:0', 'minimum_free_vram_mb': 4096})


def test_production_config_remains_cuda():
    path = Path(__file__).resolve().parents[2] / 'config/detection-models.json'
    assert load_config(path)['device'] == 'cuda:0'


def test_rf_constructor_and_weights_have_explicit_device(monkeypatch):
    calls = {}
    monkeypatch.setitem(sys.modules, 'torch', mps_torch())
    class FakeRF:
        def __init__(self, **kwargs):
            calls['constructor'] = kwargs
            self.model = SimpleNamespace(model=SimpleNamespace(load_state_dict=lambda state, strict: calls.update(strict=strict)), device=None)
    monkeypatch.setitem(sys.modules, 'rfdetr', SimpleNamespace(RFDETRSeg2XLarge=FakeRF))
    monkeypatch.setitem(sys.modules, 'safetensors', SimpleNamespace())
    monkeypatch.setitem(sys.modules, 'safetensors.torch', SimpleNamespace(load_file=lambda path, device: calls.update(weight_device=device)))
    config = {'device': 'mps', 'rf': {'path': 'local.safetensors', 'resolution': 1152, 'num_select': 160}}
    adapter = RFDetector(config)
    assert calls['constructor']['device'] == 'mps'
    assert calls['constructor']['pretrain_weights'] is None
    assert calls['weight_device'] == 'cpu'
    assert calls['strict'] is True
    assert adapter.model.model.device == 'mps'


def test_mangalens_passes_selected_mps_to_predict(monkeypatch):
    calls = {}
    monkeypatch.setitem(sys.modules, 'torch', mps_torch())
    class FakeYOLO:
        def __init__(self, path, task):
            calls.update(path=path, task=task)
        def predict(self, image, **kwargs):
            calls.update(kwargs)
            return [SimpleNamespace(masks=None)]
    monkeypatch.setitem(sys.modules, 'ultralytics', SimpleNamespace(YOLO=FakeYOLO))
    config = {'device': 'mps', 'mangalens': {'path': 'mangalens.pt', 'image_size': 1600, 'confidence': .25, 'iou': .7}}
    result = MangaLensDetector(config).predict(np.zeros((32, 32, 3), np.uint8))
    assert result == []
    assert calls['device'] == 'mps'
    assert calls['retina_masks'] is True


def test_worker_mps_check_and_inference_metrics_avoid_cuda(tmp_path, monkeypatch):
    torch = mps_torch()
    monkeypatch.setitem(sys.modules, 'torch', torch)
    for package in ('rfdetr', 'safetensors', 'ultralytics'):
        monkeypatch.setitem(sys.modules, package, SimpleNamespace())
    monkeypatch.setattr('imaging.models.validate_weights', lambda config: None)
    for name, mode in [('source', 'RGB'), ('overlay', 'RGBA'), ('other', 'L'), ('edited', 'L')]:
        Image.new(mode, (32, 32)).save(tmp_path / f'{name}.png')
    page = {'id': 'one', 'output': str(tmp_path / 'output'), **{key: str(tmp_path / f'{key}.png') for key in ('source', 'overlay', 'other', 'edited')}}
    manifest = {'pages': [page]}
    progress = tmp_path / 'progress.json'
    config = {'device': 'mps'}
    run_stage('check', manifest, config, progress)
    assert json.loads(progress.read_text())['device'] == 'mps'
    monkeypatch.setattr('imaging.models.RFDetector', lambda config: SimpleNamespace(predict=lambda rgb: np.zeros(rgb.shape[:2], np.uint8)))
    run_stage('rf', manifest, config, progress)
    value = json.loads(progress.read_text())
    assert value['device'] == 'mps'
    assert value['completed'] == 1
    assert value['mps_allocated_mb'] == 12
    assert (tmp_path / 'output/text_mask.png').is_file()
