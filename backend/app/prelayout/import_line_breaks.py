"""Prepare per-item suggestions separately from the editable/exportable translation."""
from collections import Counter

from prelayout_core.build_text_rect_update import match_page_blocks
from prelayout_core.data import validate_items

from .line_breaks import line_break_candidates


LINE_BREAK_SUGGESTIONS_VERSION = 2


def imported_sources(items):
    return {item['_id']: {key: item[key] for key in ('text', 'x', 'y')} for item in items}


def suggestions_for_page(sources, items, page, measures, *, use_matches=False):
    counts = {m['source_block_index']: m['source_line_count'] for m in measures
              if type(m.get('source_block_index')) is int and type(m.get('source_line_count')) is int
              and m['source_line_count'] > 0}
    if not sources or not counts:
        return {}
    if use_matches:
        indices = [item.get('match_source_block_index') for item in items]
    else:
        # JSON positions identify the original balloons even after the editor moves the text.
        anchors = [sources.get(item['_id'], item) for item in items]
        matches = match_page_blocks(anchors, measures, page['width'], page['height'])
        indices = [r['match'].get('source_block_index') if r['match'] else None for r in matches]
    used = Counter(i for i in indices if type(i) is int)
    suggestions = {}
    for item, index in zip(items, indices):
        source = sources.get(item['_id'])
        if (source is None or type(index) is not int or used[index] != 1 or index not in counts
                or use_matches and item.get('match_status') in ('duplicate', 'unmatched')):
            continue
        original = source['text']
        options = line_break_candidates(original, counts[index])
        if options:
            suggestions[item['_id']] = {'original_text': original, 'source_line_count': counts[index],
                                         'candidates': options}
    return suggestions


def upgrade_saved_suggestions(state):
    """Upgrade one legacy page from retained originals/counts, never infer missing data."""
    if (state.get('line_break_suggestions_version') == LINE_BREAK_SUGGESTIONS_VERSION
            or not {'line_break_sources', 'line_break_suggestions'} & state.keys()):
        return None
    suggestions = {}
    for item_id, old in state.get('line_break_suggestions', {}).items():
        if not isinstance(old, dict):
            continue
        source = state.get('line_break_sources', {}).get(item_id, {})
        original = source.get('text', old.get('original_text')) if isinstance(source, dict) else old.get('original_text')
        count = old.get('source_line_count')
        if not isinstance(original, str) or len(original) > 50000 or type(count) is not int or count < 1:
            continue
        candidates = line_break_candidates(original, count)
        if candidates:
            suggestions[item_id] = {'original_text': original, 'source_line_count': count,
                                    'candidates': candidates}
    return {**state, 'line_break_suggestions': suggestions,
            'line_break_suggestions_version': LINE_BREAK_SUGGESTIONS_VERSION}


def validate_archived_suggestions(state, page):
    sources = state.get('line_break_sources', {})
    suggestions = state.get('line_break_suggestions', {})
    if not isinstance(sources, dict) or not isinstance(suggestions, dict):
        raise ValueError('封存斷句資料格式錯誤')
    version = state.get('line_break_suggestions_version', 1)
    if type(version) is not int or version not in (1, LINE_BREAK_SUGGESTIONS_VERSION):
        raise ValueError('封存斷句版本無效')
    anchors = []
    for item_id, source in sources.items():
        if not isinstance(source, dict) or set(source) != {'text', 'x', 'y'}:
            raise ValueError('封存斷句原稿格式錯誤')
        anchors.append({**source, '_id': item_id})
    validate_items(anchors, page['width'], page['height'])
    for item_id, suggestion in suggestions.items():
        if item_id not in sources or not isinstance(suggestion, dict):
            raise ValueError('封存斷句建議缺少原稿')
        original = sources[item_id]['text']
        n = suggestion.get('source_line_count')
        options = suggestion.get('candidates')
        if (suggestion.get('original_text') != original or type(n) is not int or n < 1
                or not isinstance(options, list) or not 1 <= len(options) <= 3):
            raise ValueError('封存斷句行數或原稿不符')
        flat = original.replace('\r', '').replace('\n', '')
        allowed = {count for count in (n + 1, n, n - 1) if count > 0}
        for option in options:
            count = option.get('line_count') if isinstance(option, dict) else None
            if type(count) is not int or count not in allowed:
                raise ValueError('封存斷句候選行數不符')
            allowed.remove(count)
            text = option.get('text')
            if (not isinstance(text, str) or len(text) > 50000 or text.count('\n') + 1 != count
                    or text.replace('\n', '') != flat or not all(line.strip() for line in text.split('\n'))):
                raise ValueError('封存斷句候選與原稿不符')
