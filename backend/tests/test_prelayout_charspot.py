"""CharSpot geometry and calibration contracts without model dependencies."""
from pathlib import Path
import importlib.util
import json

import numpy as np
import pytest
from PIL import Image


@pytest.fixture
def adapter():
    from prelayout_core import charspot
    return charspot


@pytest.mark.parametrize('orientation', ['vertical', 'horizontal'])
def test_original_ctd_crop_preserves_geometry_and_detection_score(adapter, tmp_path, monkeypatch, orientation):
    images = tmp_path / 'images'
    masks = images / 'ctd/progressing/mask'
    masks.mkdir(parents=True)
    image = np.full((80, 100, 3), 255, dtype=np.uint8)
    image[18:29, 20:27] = 0
    Image.fromarray(image).save(images / '1.png')
    mask = np.zeros((80, 100), dtype=np.uint8)
    mask[18:29, 20:27] = 255
    Image.fromarray(mask).save(masks / '1.png')
    (masks.parent / 'block_map.json').write_text(json.dumps({'blockMap': {'1.png': [
        {'source_block_index': 7, 'xyxy_pixel': [10, 10, 35, 40]},
    ]}}))
    calls = []

    class Model:
        def read(self, crop):
            # Padding places the original crop origin at (2,2). The enlarged
            # placement rectangle in measure must not be used as OCR input.
            assert crop.shape == (46, 41, 3)
            assert crop[16:27, 18:25].max() == 0
            calls.append(crop.shape)
            return {'text': '大', 'chars': [
                {'char': '大', 'box': [16, 14, 28, 30], 'score': .1},
                {'char': '空', 'box': [0, 0, 2, 2], 'score': .99},
                {'char': '外', 'box': [200, 0, 210, 10], 'score': .99},
            ]}

    monkeypatch.setattr(adapter, 'load_model', lambda models, device: Model())
    measure = {'pages': {'1.png': [{'source_block_index': 7, 'xyxy_pixel': [0, 0, 100, 80],
                                  'orientation': orientation, 'font_size': 24}]}}
    progress = []
    output = adapter.run_charspot(images, measure, tmp_path, 'cpu', lambda *args: progress.append(args))

    assert calls == [(46, 41, 3)]
    assert progress == [(1, 1)]
    assert output['device'] == 'cpu'
    item = output['pages']['1.png'][0]
    assert item['measure_item_index'] == 0
    assert item['source_block_index'] == 7
    assert item['orientation'] == orientation
    char = item['ocr_characters'][0]
    assert char['bbox'] == [20, 18, 27, 29]
    assert char['width'] == 7 and char['height'] == 11
    assert char['detection_score'] == .1 and char['status'] == 'accepted'
    assert 'ocr_probability' not in char
    assert item['ocr_characters'][1]['status'] == 'no_ink'
    assert item['ocr_characters'][2]['status'] == 'invalid_model_box'
    assert measure['pages']['1.png'][0].get('ocr_characters') is None


def test_missing_original_ctd_boxes_fail_before_using_placement_rectangle(adapter, tmp_path, monkeypatch):
    monkeypatch.setattr(adapter, 'load_model', lambda *args: pytest.fail('loaded model'))
    with pytest.raises(FileNotFoundError, match='block_map'):
        adapter.run_charspot(tmp_path, {'pages': {}}, tmp_path, 'cpu')


def test_charspot_device_is_explicit(adapter, tmp_path):
    with pytest.raises(ValueError, match='cpu'):
        adapter.load_model(tmp_path, 'mps')


def test_charspot_calibration_retains_geometry_and_distinct_provenance(monkeypatch, tmp_path):
    monkeypatch.setenv('COMIC_PRELAYOUT_MODEL_ROOT', str(tmp_path))
    path = Path(__file__).parents[1] / 'prelayout_core/vendor/font_size_calibration.py'
    spec = importlib.util.spec_from_file_location('charspot_calibration_test', path)
    calibration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(calibration)
    font = tmp_path / 'fixture.otf'
    font.write_bytes(b'cached ratios only')
    metrics = tmp_path / 'metrics.json'
    metrics.write_text(json.dumps({'schema_version': 1, 'metrics': {'units': 'reference_pixel_ratio'},
                                   'glyphs': {'大': [.8, .8]}}))
    sample = {'line_index': 0, 'character_index': 0, 'ocr_text': '大', 'bbox': [10, 20, 34, 44],
              'width': 24, 'height': 24, 'detection_score': .1, 'status': 'accepted'}
    output = {'ocr_engine': 'charspot_small', 'pages': {'1.png': [
        {'orientation': 'vertical', 'font_size': 24, 'measure_item_index': 0, 'ocr_characters': [sample]},
    ]}}

    assert calibration.calibrate_ocr_output(output, font, metrics) == 1
    assert output['font_calibration']['method'] == 'charspot_small_cached_font_ink_candidate_grid'
    fit = output['pages']['1.png'][0]['font_fit']
    assert fit['suggested_font_size'] == 30
    assert fit['character_results'][0]['detection_score'] == .1
    assert 'ocr_probability' not in fit['character_results'][0]
