"""Detection settings change selection and optional model use, without real inference."""
import builtins
import hashlib
import json
from types import SimpleNamespace
import sys

import cv2
import numpy as np
from PIL import Image
import pytest

from imaging.models import DetectionUnavailable, RFDetector, validate_weights
from imaging.worker import run_stage


@pytest.mark.parametrize('mode,selected', [
    ('text_onomatopoeia', [0, 1]), ('text', [0]), ('onomatopoeia', [1]), ('all', [0, 1, 2, 3]),
])
def test_rf_mask_mode_selects_upstream_classes_and_keeps_thresholds(mode, selected):
    masks = np.zeros((6, 20, 20), bool)
    for index in range(6):
        masks[index, index + 3, 8] = True
    adapter = RFDetector.__new__(RFDetector)
    adapter.np, adapter.cv2 = np, cv2
    adapter.config = {'class_thresholds': {'text': .25, 'onomatopoeia': .2, 'bubble': .5, 'panel': .5},
                      'resolution': 1152, 'mask_dilate': 0, 'mask_mode': mode}
    detection = SimpleNamespace(class_id=[0, 1, 2, 3, 0, 9], confidence=[.9, .9, .9, .9, .1, 1], mask=masks)
    adapter.model = SimpleNamespace(predict=lambda *args, **kwargs: detection)
    result = adapter.predict(np.zeros((20, 20, 3), np.uint8))
    assert np.count_nonzero(result) == len(selected)
    for index in selected:
        assert result[index + 3, 8] == 255


def test_disabled_bubbles_skip_weight_validation_and_all_runtime_imports(tmp_path, monkeypatch):
    rf = tmp_path / 'rf.safetensors'
    rf.write_bytes(b'fake RF file for hash verification only')
    config = {'device': 'cpu', 'rf': {'path': str(rf), 'sha256': hashlib.sha256(rf.read_bytes()).hexdigest()},
              'mangalens': {'path': str(tmp_path / 'missing.pt'), 'sha256': 'missing', 'enabled': False, 'shrink_ratio': .02}}
    validate_weights(config)
    with pytest.raises(DetectionUnavailable, match='mangalens'):
        validate_weights(config | {'mangalens': config['mangalens'] | {'enabled': True}})
    for name, mode in [('source', 'RGB'), ('overlay', 'RGBA'), ('other', 'L'), ('edited', 'L')]:
        Image.new(mode, (140, 140), 'white' if name == 'source' else 0).save(tmp_path / f'{name}.png')
    page = {'id': 'one', 'output': str(tmp_path / 'output'),
            **{key: str(tmp_path / f'{key}.png') for key in ('source', 'overlay', 'other', 'edited')}}
    output = tmp_path / 'output'
    output.mkdir()
    text = Image.new('L', (140, 140))
    text.paste(255, (65, 65, 73, 73))
    text.save(output / 'text_mask.png')
    (output / 'bubbles.json').write_text('[[[1,1],[138,1],[138,138],[1,138]]]')
    for package in ('rfdetr', 'safetensors', 'torch'):
        monkeypatch.setitem(sys.modules, package, SimpleNamespace())
    original_import = builtins.__import__
    def guarded_import(name, *args, **kwargs):
        if name.startswith('ultralytics'):
            raise AssertionError('Disabled bubbles imported ultralytics')
        return original_import(name, *args, **kwargs)
    monkeypatch.setattr(builtins, '__import__', guarded_import)
    def forbidden_mangalens(config):
        raise AssertionError('Disabled bubbles constructed a detector')
    monkeypatch.setattr('imaging.models.MangaLensDetector', forbidden_mangalens)
    manifest, progress = {'pages': [page]}, tmp_path / 'progress.json'
    run_stage('check', manifest, config, progress)
    run_stage('mangalens', manifest, config, progress)
    assert json.loads((output / 'bubbles.json').read_text()) == []
    # Classification must ignore even an injected/stale polygon cache.
    (output / 'bubbles.json').write_text('[[[1,1],[138,1],[138,138],[1,138]]]')
    run_stage('classify', manifest, config, progress)
    diagnostics = json.loads((output / 'diagnostics.json').read_text())
    assert diagnostics['solid_bubbles'] == 0
    assert diagnostics['blocks_debug'][0]['in_bubble'] is False
    assert set(diagnostics['blocks_debug'][0]['direction_checks']) == {'top', 'bottom', 'left', 'right', 'near_ring'}
