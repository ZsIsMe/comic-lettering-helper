"""Keep optional source information without restoring stale editing state."""
from __future__ import annotations

import copy
import re
from collections import Counter
from pathlib import Path


ITEM_STATE_FIELDS = {
    '_id', 'index', 'text', 'groupId', 'x', 'y', 'font-size', 'rotation',
    'orientation', 'color', 'stroke-color', 'stroke-weight', 'xyxy_pixel',
    'need_inpaint', 'font_size', 'max_break', 'text-direction', 'bbox', 'center_normalized',
}


def merge_information(previous, incoming):
    """Missing keys survive; explicit values, including empty/null, take priority."""
    if not isinstance(previous, dict) or not isinstance(incoming, dict) or not incoming:
        return copy.deepcopy(incoming)
    result = copy.deepcopy(previous)
    for key, value in incoming.items():
        result[key] = merge_information(previous.get(key), value)
    return result


def normalize_page_summary(value, pages):
    # Only this known per-page map has image-name keys. Other dictionaries may
    # contain arbitrary names and must not be reinterpreted as page references.
    if not isinstance(value, dict):
        return copy.deepcopy(value)
    result = {}
    for name, summary in value.items():
        exact = next((page for page in pages if page['name'] == name), None)
        matches = [page for page in pages if Path(page['name']).stem.casefold() == Path(name).stem.casefold()]
        page = exact or (matches[0] if len(matches) == 1 else None)
        canonical = page['name'] if page else name
        if canonical in result:
            raise ValueError('多個頁面概括對應到同一圖片')
        result[canonical] = copy.deepcopy(summary)
    return result


def merge_template(previous, incoming, pages):
    previous = {key: copy.deepcopy(value) for key, value in previous.items()
                if key != 'questionRecords'}
    incoming = copy.deepcopy(incoming)
    for template in (previous, incoming):
        if 'page_summary' in template:
            template['page_summary'] = normalize_page_summary(template['page_summary'], pages)
    result = merge_information(previous, incoming)
    # These are format/editor structures rather than extensible metadata maps.
    for key in ('version', 'groupList', 'questionRecords'):
        if key in incoming:
            result[key] = copy.deepcopy(incoming[key])
    return result


def labelplus_indices(raw):
    """Track explicit LP labels before its legacy parser supplies ordinal indices."""
    result, current = {}, None
    for line in raw.decode('utf-8-sig').splitlines():
        if line.startswith('>>>>>>>>['):
            current = line.replace('>>>>>>>>[', '').replace(']<<<<<<<<', '')
            result[current] = []
        elif current is not None and line.startswith('----------------['):
            match = re.match(r'^----------------\[([0-9]+)\]----------------', line)
            result[current].append(int(match[1]) if match else None)
    return result


def preserve_item_information(previous, incoming, original_indices=None):
    if not isinstance(incoming, list):
        return incoming  # Leave malformed input to the existing validator.
    old_counts = Counter(item.get('index') for item in previous
                         if type(item.get('index')) is int and item['index'] > 0)
    new_counts = Counter(item.get('index') for item in incoming if isinstance(item, dict)
                         and type(item.get('index')) is int and item['index'] > 0)
    old_items = {item['index']: item for item in previous
                 if type(item.get('index')) is int and old_counts[item['index']] == 1}
    original_counts = Counter(original_indices or [])
    result = []
    for position, source in enumerate(incoming):
        item = copy.deepcopy(source)
        index = item.get('index') if isinstance(item, dict) else None
        eligible = type(index) is int and index > 0 and new_counts[index] == 1
        if original_indices is not None:
            # Non-sequential LP labels are not the ordinal indices produced by
            # the parser. Do not guess their association with existing items.
            eligible = (eligible and position < len(original_indices)
                        and original_indices[position] == index and original_counts[index] == 1)
        old = old_items.get(index) if eligible else None
        if old is not None:
            metadata = {key: value for key, value in old.items()
                        if key not in ITEM_STATE_FIELDS and not key.startswith('match_')}
            for key, value in metadata.items():
                item[key] = merge_information(value, item[key]) if key in item else copy.deepcopy(value)
        result.append(item)
    return result
