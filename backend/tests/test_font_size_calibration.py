"""Font calibration regression tests require no inference runtime or model weights."""
import importlib.util
import json
from pathlib import Path

import pytest


@pytest.fixture
def calibration(monkeypatch, tmp_path):
    monkeypatch.setenv('COMIC_PRELAYOUT_MODEL_ROOT', str(tmp_path))
    path = Path(__file__).parents[1] / 'prelayout_core/vendor/font_size_calibration.py'
    spec = importlib.util.spec_from_file_location('font_calibration_test', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    font = tmp_path / 'fixture.otf'
    font.write_bytes(b'fixture: only cached ink ratios are used')
    metrics = tmp_path / 'metrics.json'
    metrics.write_text(json.dumps({'schema_version': 1, 'metrics': {'units': 'reference_pixel_ratio'},
                                 'glyphs': {'パ': [.917, .838], 'シ': [.826, .816],
                                            'リ': [.579, .814], 'ー': [.805, .124], 'ド': [.6, .832]}}))
    return module, font, metrics


def test_overlapping_ocr_lines_do_not_double_weight_clipped_glyph(calibration):
    module, font, metrics = calibration
    samples = [
        ('パ', 0, 0, [124, 1095, 136, 1107]),
        ('パ', 2, 0, [124, 1094, 136, 1107]),
        ('シ', 2, 2, [184, 1090, 205, 1108]),
        ('リ', 3, 0, [209, 1121, 224, 1146]),
        ('ー', 3, 1, [230, 1131, 256, 1136]),
        ('ド', 3, 2, [264, 1121, 281, 1146]),
    ]
    item = {'orientation': 'horizontal', 'font_size': 17, 'ocr_characters': [
        {'ocr_text': glyph, 'line_index': line, 'character_index': index, 'bbox': box, 'status': 'accepted'}
        for glyph, line, index, box in samples]}
    fit = module.fit_ocr_item(item, font_path=font, metrics_path=metrics)
    assert fit['suggested_font_size'] == 28
    duplicate, fuller = fit['character_results'][:2]
    assert duplicate['reason'] == 'duplicate_overlapping_character'
    assert duplicate['duplicate_of'] == {'line_index': 2, 'character_index': 0}
    assert fuller['reason'] == 'font_size_outlier'
    assert fit['accepted_character_count'] == 4
    assert len(fit['filtered_char_boxes']) == 4
    assert all(box['ocr_text'] != 'パ' for box in fit['filtered_char_boxes'])


@pytest.mark.parametrize('orientation', ['horizontal', 'vertical'])
def test_repeated_glyphs_at_distinct_positions_are_retained(calibration, orientation):
    module, font, metrics = calibration
    boxes = [[0, 0, 18, 16], [20, 0, 38, 16], [0, 20, 18, 36]]
    item = {'orientation': orientation, 'ocr_characters': [
        {'ocr_text': 'パ', 'line_index': index, 'character_index': 0, 'bbox': box, 'status': 'accepted'}
        for index, box in enumerate(boxes)]}
    fit = module.fit_ocr_item(item, font_path=font, metrics_path=metrics)
    assert fit['accepted_character_count'] == 3
    assert fit['rejected_character_count'] == 0


def test_missing_positions_are_not_merged(calibration):
    module, font, metrics = calibration
    item = {'ocr_characters': [
        {'ocr_text': 'パ', 'line_index': index, 'character_index': 0, 'width': 18, 'height': 16, 'status': 'accepted'}
        for index in range(2)]}
    fit = module.fit_ocr_item(item, font_path=font, metrics_path=metrics)
    assert fit['accepted_character_count'] == 2
