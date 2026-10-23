"""Render a self-contained discussion document from a translation snapshot."""
from __future__ import annotations

import html
import json
import re
from pathlib import Path

from .question_records import chronological_records


# Editing, detection and storage details do not help answer textual questions.
LAYOUT_FIELDS = {
    '_id', 'id', 'index', 'groupId', 'group', 'groupList', 'font', 'font-family',
    'font-size', 'font_size', 'font-weight', 'font_weight', 'rotation', 'orientation',
    'color', 'stroke-color', 'stroke-weight', 'x', 'y', 'width', 'height',
    'position', 'coordinates', 'coords', 'bbox', 'box', 'polygon', 'points',
    'xyxy_pixel', 'center_normalized', 'text-direction', 'need_inpaint', 'max_break',
    'confidence', 'score', 'probability', 'revision', 'sha256', 'state', 'clean', 'text_has_stroke',
    'clean_kind', 'name', 'original', 'mask', 'operations',
}
LABELS = {
    'ocr_text': '原文', 'text': '譯文', 'ocr': 'OCR',
    'note': '註解', 'notes': '註解', 'comment': '註解', 'comments': '註解',
    'baseball_term': '棒球術語註解', 'term_explanation': '用語註解',
    'summary': '概括',
}


def literal(value):
    """Keep every value on one Markdown line without allowing injected markup."""
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, separators=(', ', ': '))
    text = text.replace('\r\n', '\n').replace('\r', '\n').replace('\n', r'\n')
    text = html.escape(text, quote=False)
    return re.sub(r'([`*_\[\]#!|])', r'\\\1', text)


def _meaningful(value):
    return value is not None and value != '' and value != [] and value != {}


def _information(data, excluded=()):
    if not isinstance(data, dict):
        return []
    return [(key, value) for key, value in data.items()
            if key not in LAYOUT_FIELDS and key not in excluded
            and not key.startswith(('match_', 'font_', 'font-', 'confidence', 'group_'))
            and not key.endswith(('_confidence', '_score')) and _meaningful(value)]


def _fields(data, prefix='', excluded=()):
    information = _information(data, excluded)
    information.sort(key=lambda field: {'ocr_text': 0, 'text': 1}.get(field[0], 2))
    return [f'{prefix}{literal(LABELS.get(key, key))}：{literal(value)}  '
            for key, value in information]


def _summary_key(summaries, name):
    if not isinstance(summaries, dict):
        return None
    if name in summaries:
        return name
    matches = [key for key in summaries
               if Path(key).stem.casefold() == Path(name).stem.casefold()]
    return matches[0] if len(matches) == 1 else None


def _page_summary(summaries, name):
    key = _summary_key(summaries, name)
    return summaries[key] if key is not None else None


def _reference_source(data, reference):
    # A saved source (including an explicit empty snapshot) takes precedence.
    if 'source' in reference:
        return reference['source'], None
    pages = data['transMap']
    number = reference.get('pageNumber')
    name = reference.get('pageName')
    ordinal = reference.get('itemNumber')
    names = list(pages)
    if (type(number) is int and 1 <= number <= len(names) and names[number - 1] == name
            and type(ordinal) is int and 1 <= ordinal <= len(pages[name])):
        item = pages[name][ordinal - 1]
        if item.get('text') == reference.get('text'):
            summaries = data.get('page_summary', {})
            summary = _page_summary(summaries, name)
            return item, summary
    return {}, None


def render_discussion(data, title, page_number=None):
    """Preserve source page order and historical question selection order, read-only."""
    pages = data.get('transMap')
    if not isinstance(pages, dict):
        raise ValueError('來源須包含 transMap')
    if page_number is not None and (type(page_number) is not int or not 1 <= page_number <= len(pages)):
        raise ValueError('頁數超出來源範圍')
    lines = [f'# {literal(title)}｜疑問記錄', '', '請回答問題。', '', '## 疑問記錄', '']
    records = chronological_records(data.get('questionRecords', {}).get('records', []))
    if not records:
        lines += ['（目前沒有疑問記錄。）', '']
    for number, record in enumerate(records, 1):
        lines += [f'{number}. 問題：{literal(record["note"])}', '', '   關聯文本：', '']
        seen_summaries = set()
        for reference in record['texts']:
            lines += [f'   - 第 {reference["pageNumber"]} 頁｜文本 {reference["itemNumber"]}：'
                      f'{literal(reference["text"])}  ']
            source, summary = _reference_source(data, reference)
            lines += _fields(source, '     ', {'text'})
            if 'pageSummary' in reference:
                summary = reference['pageSummary']
            if _meaningful(summary):
                key = (reference['pageNumber'], reference['pageName'],
                       json.dumps(summary, ensure_ascii=False, sort_keys=True))
                if key not in seen_summaries:
                    lines += [f'     記錄時本頁概括：{literal(summary)}  ']
                    seen_summaries.add(key)
        lines += ['']
    # This legacy template placeholder is not a textual annotation. Keep it in
    # Meo/project data, but do not present it as content for the proofreader.
    document = {key: value for key, value in data.items()
                if not (key == 'comment' and isinstance(value, str) and value.strip() == '備註備註備註')}
    metadata = _fields(document, excluded={'version', 'transMap', 'page_summary', 'questionRecords'})
    if metadata:
        lines += ['## 文件附註', ''] + metadata + ['']
    lines += ['## 逐頁全文', '']
    summaries = data.get('page_summary', {})
    for number, (name, items) in enumerate(pages.items(), 1):
        if page_number is not None and number != page_number:
            continue
        lines += [f'### 第 {number} 頁', '']
        summary = _page_summary(summaries, name)
        if _meaningful(summary):
            lines += ['#### 本頁概括', '', literal(summary), '']
        lines += ['#### 文本', '']
        for ordinal, item in enumerate(items, 1):
            fields = _fields(item)
            # A text ordinal remains addressable even when its text is explicitly empty.
            if not fields:
                lines += [f'{ordinal}. （無文字資訊）', '']
            else:
                lines += [f'{ordinal}. {fields[0]}'] + [f'   {line}' for line in fields[1:]] + ['']
    if page_number is None and isinstance(summaries, dict):
        mapped = {_summary_key(summaries, name) for name in pages}
        unmatched = [(name, value) for name, value in summaries.items()
                     if name not in mapped and _meaningful(value)]
        if unmatched:
            lines += ['## 未對應頁面的介紹', '', '以下介紹保留來源頁名，未能唯一對應工程頁碼。', '']
            for number, (name, value) in enumerate(unmatched, 1):
                lines += [f'{number}. 來源頁面：{literal(name)}  ',
                          f'   介紹：{literal(value)}', '']
    return '\n'.join(lines).rstrip() + '\n'
