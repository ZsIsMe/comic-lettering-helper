"""BT round-trip contract; internal IDs are never written into exported BT data."""
from __future__ import annotations

import copy
import json
import math
import re
import uuid

from .lp_to_meo import _parse_lp
from .build_text_rect_update import build_updated_translate


def identifier(prefix='t'):
    return f'{prefix}_{uuid.uuid4().hex}'


def read_json(raw: bytes | str):
    def reject(value):
        raise ValueError(f'不接受非有限數字：{value}')
    def finite(value):
        parsed = float(value)
        if not math.isfinite(parsed):
            reject(value)
        return parsed
    return json.loads(raw, parse_constant=reject, parse_float=finite)


def validate_measure(data, pages):
    if not isinstance(data, dict) or not isinstance(data.get('pages'), dict) or set(data['pages']) != {page['name'] for page in pages}:
        raise ValueError('量測輸出頁面不完整')
    for page in pages:
        items = data['pages'][page['name']]
        if not isinstance(items, list):
            raise ValueError('量測條目必須是清單')
        for item in items:
            if not isinstance(item, dict):
                raise ValueError('量測條目格式無效')
            box = item.get('xyxy_pixel')
            if not isinstance(box, list) or len(box) != 4:
                raise ValueError('量測框缺少原圖座標')
            for value in box:
                number(value, '量測座標', -max(page['width'], page['height']) * 2, max(page['width'], page['height']) * 3)
            if box[2] < box[0] or box[3] < box[1]:
                raise ValueError('量測框大小無效')
            if 'font_size' in item:
                number(item['font_size'], '量測字級', .01, 100000)
    return data


def number(value, name, low, high):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f'{name} 超出可用範圍')
    return value


def validate_items(items, width, height):
    if not isinstance(items, list) or len(items) > 5000:
        raise ValueError('文字條目格式錯誤或超過每頁 5,000 條')
    result, ids, indices = [], set(), set()
    next_index = max((item.get('index', 0) for item in items if isinstance(item, dict) and type(item.get('index')) is int), default=0) + 1
    for source in items:
        if not isinstance(source, dict):
            raise ValueError('文字條目必須是物件')
        item = copy.deepcopy(source)
        tid = item.setdefault('_id', identifier())
        if not isinstance(tid, str) or not re.fullmatch(r't_[a-f0-9]{32}', tid) or tid in ids:
            raise ValueError('文字 ID 重複或無效')
        ids.add(tid)
        if type(item.get('index')) is not int or item['index'] < 1 or item['index'] in indices:
            item['index'] = next_index; next_index += 1
        indices.add(item['index'])
        text = item.setdefault('text', '')
        if not isinstance(text, str) or len(text) > 50000:
            raise ValueError('文字內容格式錯誤或過長')
        number(item.setdefault('x', .5), '中心 X', -1, 2)
        number(item.setdefault('y', .5), '中心 Y', -1, 2)
        number(item.setdefault('font-size', 40), '字級', 1, 999)
        number(item.setdefault('rotation', 0), '角度', -180, 180)
        number(item.setdefault('stroke-weight', 0), '描邊', 0, 99)
        if item.setdefault('orientation', 'vertical') not in ('horizontal', 'vertical'):
            raise ValueError('排版方向無效')
        for key, default in (('color', '#000000'), ('stroke-color', '#FFFFFF')):
            value = item.setdefault(key, default)
            if not isinstance(value, str) or not re.fullmatch(r'#?[a-fA-F0-9]{6}|black|white', value):
                raise ValueError('文字或描邊顏色無效')
        box = item.get('xyxy_pixel')
        if box is not None:
            if not isinstance(box, list) or len(box) != 4:
                raise ValueError('文字框格式無效')
            for i, value in enumerate(box):
                number(value, '文字框', -max(width, height) * 2, max(width, height) * 3)
            if box[2] < box[0] or box[3] < box[1]:
                raise ValueError('文字框大小無效')
        result.append(item)
    return result


def parse_translation(raw, kind):
    if kind == 'labelplus':
        data = _parse_lp(raw.decode('utf-8-sig').splitlines())
    else:
        data = read_json(raw)
    if not isinstance(data, dict) or not isinstance(data.get('transMap'), dict):
        raise ValueError('缺少 transMap 的 BT／LabelPlus 資料')
    return data


def match_translation(data, measure, image_dir):
    # Preserve upstream matching and quantization; do not mutate the imported source.
    return build_updated_translate(copy.deepcopy(data), measure, image_dir)


def export_item(item):
    return {key: copy.deepcopy(value) for key, value in item.items() if key != '_id'}
