"""Validation for project-level questions and their immutable text snapshots."""
from __future__ import annotations

import copy
import json
from datetime import datetime
from pathlib import Path


def _string(value, label, limit, *, nonempty=True):
    if not isinstance(value, str) or len(value) > limit or (nonempty and not value.strip()):
        raise ValueError(f'疑問記錄的{label}格式無效或過長')
    return value


def _timestamp(value):
    _string(value, '時間', 100)
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError as exc:
        raise ValueError('疑問記錄的時間格式無效') from exc
    if parsed.tzinfo is None:
        raise ValueError('疑問記錄的時間必須包含時區')


def validate_records(records):
    if not isinstance(records, list) or len(records) > 2000:
        raise ValueError('疑問記錄須為清單，且不可超過 2,000 條')
    ids, total_texts, total_characters = set(), 0, 0
    for record in records:
        if not isinstance(record, dict) or set(record) != {'id', 'note', 'texts', 'createdAt', 'updatedAt'}:
            raise ValueError('疑問記錄欄位不完整或無效')
        record_id = _string(record['id'], 'ID', 200)
        if record_id in ids:
            raise ValueError('疑問記錄 ID 重複')
        ids.add(record_id)
        total_characters += len(_string(record['note'], '內容', 50000))
        _timestamp(record['createdAt'])
        _timestamp(record['updatedAt'])
        texts = record['texts']
        if not isinstance(texts, list) or not 1 <= len(texts) <= 1000:
            raise ValueError('每條疑問記錄須選擇 1 至 1,000 條文本')
        keys, references = set(), set()
        total_texts += len(texts)
        for text in texts:
            if not isinstance(text, dict) or set(text) != {'key', 'pageId', 'pageNumber', 'pageName', 'itemId', 'itemNumber', 'text'}:
                raise ValueError('疑問記錄的文本引用欄位不完整或無效')
            for field, limit in (('key', 500), ('pageId', 200), ('pageName', 512), ('itemId', 200)):
                _string(text[field], field, limit)
            for field in ('pageNumber', 'itemNumber'):
                if type(text[field]) is not int or not 1 <= text[field] <= 1_000_000:
                    raise ValueError('疑問記錄的頁碼或框號無效')
            total_characters += len(_string(text['text'], '文本快照', 50000, nonempty=False))
            reference = (text['pageId'], text['itemId'])
            if text['key'] in keys or reference in references:
                raise ValueError('同一條疑問記錄不可重複選擇文本')
            keys.add(text['key'])
            references.add(reference)
        if total_texts > 20000 or total_characters > 16_000_000:
            raise ValueError('疑問記錄總量超過限制')
    # Do not resolve against live pages: removed/reimported items remain readable history.
    return copy.deepcopy(records)


def validate_question_records(value):
    if not isinstance(value, dict) or set(value) != {'version', 'records'}:
        raise ValueError('questionRecords 須包含 version 與 records')
    if type(value['version']) is not int or value['version'] < 0:
        raise ValueError('疑問記錄版本無效')
    return {'version': value['version'], 'records': validate_records(value['records'])}


def rebind_imported_records(records, pages, imported_items):
    """BT has no internal item IDs; bind snapshots to replacement items by page and ordinal."""
    result = copy.deepcopy(records)
    for original, record in zip(records, result):
        for text in record['texts']:
            matches = [page for page in pages if page['name'] == text['pageName']]
            if not matches:
                matches = [page for page in pages if Path(page['name']).stem.casefold() == Path(text['pageName']).stem.casefold()]
            if len(matches) != 1:
                continue
            page = matches[0]
            items = imported_items.get(page['id'])
            if items is None or text['itemNumber'] > len(items):
                continue
            item = items[text['itemNumber'] - 1]
            text.update(pageId=page['id'], pageNumber=pages.index(page) + 1,
                        pageName=page['name'], itemId=item['_id'],
                        key=json.dumps([page['id'], item['_id']], ensure_ascii=False, separators=(',', ':')))
        # Distinct historical sources can converge after reimport. Keep their original
        # references rather than merging snapshots or making the archive unreadable.
        if (len({(text['pageId'], text['itemId']) for text in record['texts']}) != len(record['texts'])
                or len({text['key'] for text in record['texts']}) != len(record['texts'])):
            record['texts'] = copy.deepcopy(original['texts'])
    return result
