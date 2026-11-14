"""Exercise storage switches with real geometry and a deterministic detector.

Only model imports and neural predictions are substituted; these tests do not
load weights or assert GPU execution.
"""
import importlib
import json
import sys
from types import SimpleNamespace

import cv2
import numpy as np
import pytest
from PIL import Image, ImageDraw

from prelayout_core.worker import finalize_output, load, run_ctd
from prelayout_core.preview import load_overlay


class FixtureDetector:
    def __init__(self, **_):
        pass

    def __call__(self, image, **_):
        mask = np.zeros(image.shape[:2], dtype=np.uint8)
        if int(image[100, 100, 0]) == 255:
            return mask, mask, []
        mask[90:280, 95:165] = 255
        line = np.array([[95, 90], [165, 90], [165, 280], [95, 280]], dtype=np.int32)
        return mask, mask, [SimpleNamespace(xyxy=[75, 70, 185, 305], lines=[line])]


@pytest.fixture
def core(monkeypatch):
    """Import the production geometry without installing the model runtime."""
    from prelayout_core import vendor

    missing = object()
    names = ('detect_folder', 'new_detect_folder')
    modules = {name: sys.modules.get(f'prelayout_core.vendor.{name}', missing) for name in names}
    attributes = {name: getattr(vendor, name, missing) for name in names}
    monkeypatch.setitem(sys.modules, 'torch', SimpleNamespace())
    monkeypatch.setitem(sys.modules, 'tqdm', SimpleNamespace(tqdm=lambda values, **_: values))
    monkeypatch.setitem(sys.modules, 'prelayout_core.vendor.inference', SimpleNamespace(TextDetector=FixtureDetector))
    monkeypatch.setitem(sys.modules, 'prelayout_core.vendor.utils.textmask', SimpleNamespace(REFINEMASK_ANNOTATION=1))
    for name in names:
        sys.modules.pop(f'prelayout_core.vendor.{name}', None)
    try:
        yield importlib.import_module('prelayout_core.vendor.new_detect_folder')
    finally:
        for name in names:
            key = f'prelayout_core.vendor.{name}'
            if modules[name] is missing:
                sys.modules.pop(key, None)
            else:
                sys.modules[key] = modules[name]
            if attributes[name] is missing:
                if hasattr(vendor, name):
                    delattr(vendor, name)
            else:
                setattr(vendor, name, attributes[name])


def fixture_images(folder):
    folder.mkdir(parents=True)
    image = Image.new('RGB', (600, 900), 'white')
    draw = ImageDraw.Draw(image)
    draw.ellipse((55, 50, 225, 340), outline='black', width=3)
    for y in (95, 150, 210):
        draw.rectangle((100, y, 145, y + 40), fill='black')
    image.save(folder / '001.png')
    Image.new('RGB', (600, 900), 'white').save(folder / '002.png')


@pytest.mark.parametrize('method', ['fixed', 'single_char', 'ocr_aligned'])
def test_headless_storage_keeps_measurements_and_rgba_without_diagnostics(tmp_path, monkeypatch, core, method):
    from prelayout_core.vendor.analyze_text_core import enrich_measure_map

    images = tmp_path / 'task' / 'input'
    fixture_images(images)
    names = ['001.png', '002.png']
    record = {'device': 'mps', 'pages': [{'name': name, 'width': 600, 'height': 900} for name in names],
              'options': {'method': method, 'font_size': 24, 'step': 2}}
    align = core._align_pages
    calls = []

    def capture_align(*args, **kwargs):
        calls.append(kwargs.copy())
        return align(*args, **kwargs)

    monkeypatch.setattr(core, '_align_pages', capture_align)
    run_ctd(images.parent, record, images, tmp_path / 'unused-model-directory')
    assert calls[0]['need_neck'] is True
    assert calls[0]['save_neck_preview'] is False
    assert calls[0]['save_align_masks'] is False
    assert calls[0]['save_center_preview'] is False
    output = images / 'ctd'
    assert not (output / 'backgrounds').exists()
    assert not list((output / 'progressing' / 'align' / 'masks').glob('*.npz'))
    assert not list((output / 'progressing' / 'align' / 'neck').glob('*.png'))
    for name in names:
        with load_overlay(output / 'inpainted' / name.replace('.png', '.npz')) as patch:
            assert patch.mode == 'RGBA' and patch.size == (600, 900)
            if name == '002.png':
                assert patch.getchannel('A').getbbox() is None
            else:
                assert patch.getchannel('A').getbbox() is not None

    # Enable the diagnostic outputs and compare the actual numerical result.
    paths = core._ensure_dirs(str(output))
    block = load(output / 'progressing' / core.BLOCK_MAP_JSON)
    lines = load(output / 'progressing' / core.LINE_TRANS_MAP_JSON)
    aligned, _ = align(str(images), paths, block, need_neck=True)
    expected, _ = core._build_measure_maps(
        str(images), paths, block, lines, aligned,
        font_size_calculation_method={'single_char': 'char_box', 'fixed': 'fixed'}.get(method, 'ocr_aligned'),
        default_font_size=24, font_size_step=2,
    )
    _, errors = enrich_measure_map(images, expected)
    assert not errors
    assert load(output / 'measure.json') == expected
    assert len(list((output / 'progressing' / 'align' / 'masks').glob('*.npz'))) == len(names)
    assert not list((output / 'inpainted').glob('*.png'))
    # The end of a task keeps complete page results and discards only raw analysis.
    for page, page_id in zip(record['pages'], ['page-1', 'page-2']):
        page['id'] = page_id
    if method == 'ocr_aligned':
        (output / 'measure_ocr.json').write_text(json.dumps({'pages': {name: [] for name in names}}))
    finalize_output(output, record)
    assert not (output / 'progressing').exists()
    assert not (output / 'measure.debug.json').exists()
    assert not (output / 'measure_ocr.json').exists()
    assert load(output / 'measure.json') == expected
    assert set(p.name for p in (output / 'page-characters').glob('*.json')) == {'page-1.json', 'page-2.json'}
    assert not any('\n' in p.read_text() for p in (output / 'page-measures').glob('*.json'))


def test_neck_preview_switch_preserves_split_result_and_summary(tmp_path, monkeypatch, core):
    image = np.full((100, 100, 3), 255, dtype=np.uint8)
    mask = np.zeros((100, 100), dtype=np.uint8)
    mask[35:60, 40:50] = 255
    image[mask > 0] = 0
    partition = np.zeros((100, 100), dtype=np.uint8)
    partition[10:90, 10:90] = 255
    candidates = {0: {'partition': partition, 'completion': {'status': 'unchanged'}}}
    groups = [{'source_block_indices': [0], 'guides': [{'start': [10, 50], 'end': [90, 50]}]}]
    monkeypatch.setattr(core, '_split_bubble_candidates', lambda *_: (candidates, groups))
    boxes = [[30, 25, 60, 75]]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    initial = core._align_block_boxes(image, mask, boxes, base_img=image, prepared_gray=gray)
    values = []
    for enabled in (True, False):
        folder = tmp_path / str(enabled)
        folder.mkdir()
        preview = folder / 'page.png'
        summary = folder / 'page.json'
        values.append(core._align_concavity_blocks(
            image, mask, boxes, initial, gray, str(preview), str(summary), 'page.png',
            save_neck_preview=enabled,
        ))
        assert preview.exists() is enabled
        assert load(summary) == values[-1][1]
    assert json.dumps(values[0], cls=core.NumpyEncoder, sort_keys=True) == json.dumps(values[1], cls=core.NumpyEncoder, sort_keys=True)
