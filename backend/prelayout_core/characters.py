"""Read-only character overlays adapted from ctd_overlay_processor/processor.py.

Keep the desktop OCR/font-fit acceptance rules, without importing Qt or models.
Only compact geometry and font-size values are exposed to the web editor.
"""
from __future__ import annotations

import math
from pathlib import Path

from .data import read_json


def positive(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0


def index(value, fallback=0):
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return fallback


def compact(character, source_index, line_index, character_index, fit=None):
    box = character.get('bbox')
    if not isinstance(box, list) or len(box) != 4 or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in box):
        return None
    if box[2] <= box[0] or box[3] <= box[1]:
        return None
    width, height = character.get('width'), character.get('height')
    result = {'bbox': box[:], 'width': width if positive(width) else box[2] - box[0],
              'height': height if positive(height) else box[3] - box[1],
              'source_block_index': source_index, 'line_index': line_index, 'character_index': character_index}
    for target, source in [('estimated_font_size', 'estimated_pixel_size'), ('calculated_font_size', 'pixel_size')]:
        value = fit.get(source) if fit is not None else character.get(target)
        if positive(value):
            result[target] = value
    return result


def character_boxes(debug, ocr, page_name, method=None):
    result = []
    use_ocr = method == 'ocr_aligned' or (method not in ('single_char', 'char_box') and page_name in (ocr.get('pages') or {}))
    if use_ocr:
        for fallback, block in enumerate((ocr.get('pages') or {}).get(page_name, []) or []):
            if not isinstance(block, dict):
                continue
            fits = {(index(f.get('line_index')), index(f.get('character_index'))): f
                    for f in (block.get('font_fit') or {}).get('character_results', []) or [] if isinstance(f, dict)}
            for char in block.get('ocr_characters', []) or []:
                if not isinstance(char, dict) or char.get('status') != 'accepted':
                    continue
                line, position = index(char.get('line_index')), index(char.get('character_index'))
                fit = fits.get((line, position))
                if not fit or fit.get('accepted') is not True or not positive(fit.get('pixel_size')):
                    continue
                item = compact(char, index(block.get('source_block_index'), fallback), line, position, fit)
                if item:
                    result.append(item)
    else:
        for fallback, block in enumerate((debug.get('font_size') or {}).get(page_name, []) or []):
            if not isinstance(block, dict):
                continue
            horizontal = (block.get('font_size_debug') or {}).get('orientation') == 'horizontal'
            lines = {}
            for char in block.get('char_boxes', []) or []:
                if not isinstance(char, dict):
                    continue
                line = index(char.get('line_index'))
                item = compact(char, index(block.get('source_block_index'), fallback), line, 0)
                if item:
                    lines.setdefault(line, []).append(item)
            for items in lines.values():
                axis = 0 if horizontal else 1
                items.sort(key=lambda item: (item['bbox'][axis] + item['bbox'][axis + 2], item['bbox'][1 - axis] + item['bbox'][3 - axis]))
                for position, item in enumerate(items):
                    result.append({**item, 'character_index': position})
    return result


def character_pages(folder: Path, pages, method=None):
    def load(name):
        path = folder / name
        return read_json(path.read_bytes()) if path.exists() else {}
    debug, ocr = load('measure.debug.json'), load('measure_ocr.json')
    if method is None and (debug or ocr):
        method = load('measure.json').get('font_size_calculation_method')
    return {page['id']: character_boxes(debug, ocr, page['name'], method) for page in pages}
