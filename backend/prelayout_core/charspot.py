"""CharSpot character boxes adapted to the existing cached font calibration."""
from __future__ import annotations

import json
import math
from pathlib import Path
import sys

import cv2
import numpy as np


MODEL_DIRECTORY = 'manga-ocr-charspot-small'


def load_model(models: Path, device: str):
    """Choose the requested runtime explicitly; never switch after a failure."""
    if device not in ('cpu', 'cuda'):
        raise ValueError('CharSpot 設備只接受 cpu（ONNX）或 cuda')
    model_directory = Path(models) / MODEL_DIRECTORY
    sys.path.insert(0, str(model_directory))
    from manga_ocr_charspot_small import MangaOcrCharspotSmall
    return MangaOcrCharspotSmall(model_dir=str(model_directory),
                                backend='onnx' if device == 'cpu' else 'cuda')


def _crop_box(box, width, height, pad=0):
    if not isinstance(box, (list, tuple)) or len(box) != 4:
        raise ValueError('CharSpot 文字框缺少四個座標')
    if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) for value in box):
        raise ValueError('CharSpot 文字框座標無效')
    x1, y1 = max(0, math.floor(box[0]) - pad), max(0, math.floor(box[1]) - pad)
    x2, y2 = min(width, math.ceil(box[2]) + pad), min(height, math.ceil(box[3]) + pad)
    if x2 <= x1 or y2 <= y1:
        raise ValueError('CharSpot 文字框沒有有效面積')
    return x1, y1, x2, y2


def _character_sample(character, mask, origin, index, orientation):
    """Measure CTD ink inside a predicted glyph box in original image pixels."""
    offset_x, offset_y = origin
    result = {
        'line_index': 0,
        'character_index': index,
        'orientation': orientation,
        'ocr_text': str(character.get('char') or ''),
        'detection_score': float(character.get('score') or 0),
        'status': 'invalid_model_box',
    }
    try:
        x1, y1, x2, y2 = _crop_box(character.get('box'), mask.shape[1], mask.shape[0])
    except ValueError:
        return result
    result.update(model_bbox=[x1 + offset_x, y1 + offset_y, x2 + offset_x, y2 + offset_y], status='no_ink')
    ys, xs = np.nonzero(mask[y1:y2, x1:x2])
    if xs.size < 2:
        return result
    box = [x1 + int(xs.min()) + offset_x, y1 + int(ys.min()) + offset_y,
           x1 + int(xs.max()) + 1 + offset_x, y1 + int(ys.max()) + 1 + offset_y]
    result.update(bbox=box, width=box[2] - box[0], height=box[3] - box[1], status='accepted')
    return result


def run_charspot(images, measure, models, device, on_page=None):
    """Return OCR samples for calibrate_ocr_output and apply_calibrated_font_sizes.

    CharSpot handles horizontal/vertical reading order itself. Its boxes are
    relative to the original unrotated crop, and its scores are detection
    heatmap peaks. They are kept as diagnostics without a CTC probability gate.
    """
    images = Path(images)
    ctd = images / 'ctd'
    blocks = json.loads((ctd / 'progressing' / 'block_map.json').read_bytes())['blockMap']
    model = load_model(Path(models), device)
    output = {'ocr_engine': 'charspot_small', 'device': device,
              'score_kind': 'character_center_heatmap', 'pages': {}}
    pages = measure.get('pages') or {}
    for page_index, (name, items) in enumerate(pages.items(), 1):
        image = cv2.imread(str(images / name), cv2.IMREAD_COLOR)
        mask = cv2.imread(str(ctd / 'progressing' / 'mask' / f'{Path(name).stem}.png'), cv2.IMREAD_GRAYSCALE)
        if image is None or mask is None or image.shape[:2] != mask.shape:
            raise ValueError(f'CharSpot 原圖或文字遮罩不完整：{name}')
        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        original_boxes = {int(block.get('source_block_index', index)): block['xyxy_pixel']
                          for index, block in enumerate(blocks[name])}
        output_items = []
        for item_index, item in enumerate(items):
            source_index = int(item.get('source_block_index', item_index))
            # Measurement xyxy may already cover the whole bubble. OCR must
            # still use the detected source text block, including its padding.
            x1, y1, x2, y2 = _crop_box(original_boxes[source_index], image.shape[1], image.shape[0], pad=8)
            result = model.read(rgb[y1:y2, x1:x2])
            orientation = item.get('orientation') or 'vertical'
            characters = [_character_sample(character, mask[y1:y2, x1:x2], (x1, y1), index, orientation)
                          for index, character in enumerate(result.get('chars') or [])]
            output_items.append({**item, 'measure_item_index': item_index,
                                 'ocr_text': str(result.get('text') or ''),
                                 'ocr_characters': characters})
        output['pages'][name] = output_items
        if on_page is not None:
            on_page(page_index, len(pages))
    return output
