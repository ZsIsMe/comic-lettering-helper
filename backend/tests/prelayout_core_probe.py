"""Exercise real alignment/measurement/OCR-crop code using a deterministic detector stub.

The synthetic detector substitutes neural predictions only; this is not a GPU test.
Run with the external inference Python and PYTHONPATH=backend.
"""
import argparse
import copy
import json
import tempfile
from pathlib import Path
from types import SimpleNamespace
import cv2
import numpy as np
from PIL import Image, ImageDraw
from prelayout_core.worker import run_ctd, load
from prelayout_core.vendor import new_detect_folder as core, measure_ocr
from prelayout_core.data import validate_measure


class FixtureDetector:
    def __init__(self, **_): pass
    def __call__(self, image, **_):
        mask = np.zeros(image.shape[:2], dtype=np.uint8)
        if int(image[100, 100, 0]) == 255:
            return mask, mask, []
        mask[90:280, 95:165] = 255
        line = np.array([[95, 90], [165, 90], [165, 280], [95, 280]], dtype=np.int32)
        return mask, mask, [SimpleNamespace(xyxy=[75, 70, 185, 305], lines=[line])]


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--output', type=Path, required=True); args = parser.parse_args()
    core.TextDetector = FixtureDetector
    with tempfile.TemporaryDirectory(prefix='prelayout-probe-') as temporary:
        root = Path(temporary)
        for method in ('single_char', 'ocr_aligned', 'fixed'):
            folder = root / method; images = folder / 'input'; images.mkdir(parents=True)
            image = Image.new('RGB', (600, 900), 'white'); draw = ImageDraw.Draw(image)
            draw.ellipse((55, 50, 225, 340), outline='black', width=3)
            for y in (95, 150, 210): draw.rectangle((100, y, 145, y + 40), fill='black')
            image.save(images / '001.png'); Image.new('RGB', (600, 900), 'white').save(images / '002.png')
            record = {'pages': [{'name': name, 'width': 600, 'height': 900} for name in ('001.png', '002.png')], 'options': {'method': method, 'font_size': 24, 'step': 2}}
            run_ctd(folder, record, images, root / 'external-model-placeholder')
            measure = validate_measure(load(images / 'ctd' / 'measure.json'), record['pages'])
            assert measure['pages']['001.png'], 'Expected the fixture text region'
            assert measure['pages']['002.png'] == [], 'Blank pages must survive'
            if method == 'single_char':
                single_char_sizes = [item['font_size'] for item in measure['pages']['001.png']]
                assert all('font_size_char_box' not in item for item in measure['pages']['001.png'])
            elif method == 'ocr_aligned':
                assert [item['font_size_char_box'] for item in measure['pages']['001.png']] == single_char_sizes
                for suggested, status in ((16, 'ready'), (80, 'ready'), (16, 'ready_overlap_inherited'), (None, 'no_reliable_characters')):
                    updated = copy.deepcopy(measure)
                    fits = {'pages': {'001.png': [{'measure_item_index': index, 'font_fit': {
                        'status': status, 'suggested_font_size': suggested}}
                        for index in range(len(single_char_sizes))]}}
                    measure_ocr.apply_calibrated_font_sizes(updated, fits)
                    for index, item in enumerate(updated['pages']['001.png']):
                        assert item['font_size'] == max(single_char_sizes[index], suggested or 0)
                        assert item['font_size_char_box'] == single_char_sizes[index]
                        if suggested:
                            assert item['font_size_ocr'] == suggested
                            assert item['font_size_method'] == 'max_char_box_ocr_aligned'
                    # Applying cached OCR twice must not feed the previous result back into the baseline.
                    expected = copy.deepcopy(updated)
                    assert measure_ocr.apply_calibrated_font_sizes(updated, fits) == 0
                    assert updated == expected
            else:
                fixed_items = measure['pages']['001.png']
                assert all(item['font_size'] == 24 and item['font_size_method'] == 'fixed' for item in fixed_items)
                debug = load(images / 'ctd' / 'measure.debug.json')
                assert all(not item['char_boxes'] for item in debug['font_size']['001.png'])
                assert measure['font_size_calculation_settings'] == {'default_font_size': 24.0}
            if method != 'fixed':
                # Exercise real OCR crop/line alignment without a model or font calibration.
                output = measure_ocr.run(str(images / 'ctd' / 'measure.json'), str(images), None,
                    model_path='', alphabet_path='', implementation_path='', device='cuda', pads=[4, 8], minimum_probability=.3,
                    page=None, measure_debug_path=None, source_block_index=None, limit_pages=None, limit_items=None,
                    batch_size=32, save_crops=None, dry_run=True)
                assert set(load(output)['pages']) == {'001.png', '002.png'}
            print(f'{method}: alignment, measurement and source styling contracts passed', flush=True)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps({'passed': True, 'synthetic_detector': True, 'gpu_verified': False, 'methods': ['single_char', 'ocr_aligned', 'fixed']}))


if __name__ == '__main__': main()
