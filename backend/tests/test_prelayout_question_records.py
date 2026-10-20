import copy
import io
import json
import zipfile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from app.prelayout.api import router
from app.prelayout.question_records import validate_records
from app.prelayout.store import Conflict, PrelayoutStore
from prelayout_core.data import identifier


@pytest.fixture
def chapter(tmp_path):
    image = io.BytesIO()
    Image.new('RGB', (20, 20), 'white').save(image, 'PNG')
    store = PrelayoutStore(tmp_path / 'prelayout')
    project = store.create('questions fixture', [('1.png', image.getvalue()), ('2.png', image.getvalue())])
    for page in project['pages']:
        store.save_page(project['id'], page['id'], 0,
                        [{'_id': identifier(), 'text': '原文快照', 'x': .5, 'y': .5}], f'seed-{page["id"]}')
        store.review_page(project['id'], page['id'], 1, True)
    texts = []
    for number, page in enumerate(project['pages'], 1):
        item = store.page(project['id'], page['id'])['items'][0]
        texts.append({'key': json.dumps([page['id'], item['_id']]), 'pageId': page['id'], 'pageNumber': number,
                      'pageName': page['name'], 'itemId': item['_id'], 'itemNumber': 1, 'text': item['text']})
    record = {'id': 'question-1', 'note': '兩頁用詞是否一致？', 'texts': texts,
              'createdAt': '2026-10-19T10:00:00.000Z', 'updatedAt': '2026-10-19T10:00:00.000Z'}
    return store, project['id'], record


def disk_snapshot(store, pid):
    return {str(path.relative_to(store.directory(pid))): path.read_bytes()
            for path in store.directory(pid).rglob('*') if path.is_file()}


def test_read_has_no_side_effect_and_crud_preserves_all_pages(chapter):
    store, pid, record = chapter
    before = store.read(pid)
    original_disk = disk_snapshot(store, pid)
    assert store.question_records(pid) == {'version': 0, 'records': []}
    assert disk_snapshot(store, pid) == original_disk
    first = store.save_question_records(pid, 0, [record])
    assert first == {'version': 1, 'records': [record]}
    after = store.read(pid)
    assert after['pages'] == before['pages']
    assert after['revision'] == before['revision'] + 1
    assert after['template']['questionRecords'] == first
    assert set(disk_snapshot(store, pid)) == set(original_disk)
    for path, payload in original_disk.items():
        if path != 'project.json':
            assert disk_snapshot(store, pid)[path] == payload
    assert store.question_records(pid) == first
    first['records'][0]['note'] = 'caller mutation'
    assert store.question_records(pid)['records'][0]['note'] == record['note']
    edited = {**record, 'note': '更新疑問', 'updatedAt': '2026-10-19T10:01:00+00:00'}
    assert store.save_question_records(pid, 1, [edited])['version'] == 2
    assert store.save_question_records(pid, 2, []) == {'version': 3, 'records': []}
    assert store.read(pid)['pages'] == before['pages']


def test_independent_version_and_retry_prevent_lost_updates(chapter):
    store, pid, record = chapter
    result = store.save_question_records(pid, 0, [record])
    saved_disk = disk_snapshot(store, pid)
    assert store.save_question_records(pid, 0, [record]) == result
    assert disk_snapshot(store, pid) == saved_disk
    with pytest.raises(Conflict):
        store.save_question_records(pid, 0, [{**record, 'note': 'another tab'}])
    page = store.read(pid)['pages'][0]
    store.save_page(pid, page['id'], 1, [], 'remove-source')
    # A historical reference survives source removal, and page edits do not invalidate its own version.
    assert store.question_records(pid) == result
    assert store.save_question_records(pid, 1, [{**record, 'note': 'still editable'}])['version'] == 2


@pytest.mark.parametrize('mutation', [
    lambda r: r.update(note=' '),
    lambda r: r.update(note=123),
    lambda r: r.update(note='x' * 50001),
    lambda r: r.update(texts=[]),
    lambda r: r.update(createdAt='not-a-date'),
    lambda r: r.update(updatedAt='2026-10-19T10:00:00'),
    lambda r: r.update(extra='unknown'),
    lambda r: r['texts'][0].update(pageId=12),
    lambda r: r['texts'][0].update(itemNumber=True),
    lambda r: r['texts'][0].update(pageNumber=0),
    lambda r: r['texts'][0].update(text=None),
    lambda r: r['texts'][0].pop('pageName'),
    lambda r: r['texts'].append(copy.deepcopy(r['texts'][0])),
])
def test_invalid_record_rejected_before_any_write(chapter, mutation):
    store, pid, record = chapter
    original = disk_snapshot(store, pid)
    mutation(record)
    with pytest.raises(ValueError):
        store.save_question_records(pid, 0, [record])
    assert disk_snapshot(store, pid) == original


def test_duplicate_ids_and_invalid_versions_rejected(chapter):
    store, pid, record = chapter
    with pytest.raises(ValueError):
        store.save_question_records(pid, 0, [record, record])
    for version in (True, 0.0, '0', -1, None):
        with pytest.raises(ValueError):
            store.save_question_records(pid, version, [record])


def test_export_and_bt_import_preserve_readable_snapshots(chapter):
    store, pid, record = chapter
    store.save_question_records(pid, 0, [record])
    exported = store.translation(pid)
    assert exported['questionRecords']['records'] == [record]
    # BT imports regenerate internal text IDs; snapshot names and text remain self-contained.
    before = store.read(pid)
    store.import_translation(pid, json.dumps(exported).encode(), 'bt', before['revision'], True)
    imported = store.question_records(pid)
    assert imported['version'] == 2
    live_item = store.page(pid, before['pages'][0]['id'])['items'][0]
    assert live_item['_id'] != record['texts'][0]['itemId']
    assert imported['records'][0]['texts'][0]['itemId'] == live_item['_id']
    assert imported['records'][0]['texts'][0]['key'] == json.dumps([before['pages'][0]['id'], live_item['_id']], separators=(',', ':'))
    assert imported['records'][0]['texts'][0]['pageName'] == '1.png'
    assert imported['records'][0]['texts'][0]['text'] == '原文快照'
    # An imported newer answer invalidates a previously opened records editor.
    exported['questionRecords']['records'][0]['note'] = 'AI 校對後疑問'
    store.import_translation(pid, json.dumps(exported).encode(), 'bt', store.read(pid)['revision'], True)
    assert store.question_records(pid)['version'] == 3
    with pytest.raises(Conflict):
        store.save_question_records(pid, 1, [record])


@pytest.mark.parametrize('kind', ['bt', 'labelplus'])
def test_import_without_questions_preserves_existing_records(chapter, kind):
    store, pid, record = chapter
    existing = store.save_question_records(pid, 0, [record])
    if kind == 'bt':
        data = store.translation(pid)
        data.pop('questionRecords')
        raw = json.dumps(data).encode()
    else:
        raw = '1, 0\n-\n對話\n-\n備註\n>>>>>>>>[1.png]<<<<<<<<\n----------------[1]----------------[0.5,0.5,1]\n新文本\n'.encode()
    store.import_translation(pid, raw, kind, store.read(pid)['revision'], True)
    imported = store.question_records(pid)
    assert imported['version'] == existing['version'] + 1
    assert imported['records'][0]['note'] == record['note']
    assert [text['text'] for text in imported['records'][0]['texts']] == [text['text'] for text in record['texts']]
    assert imported['records'][0]['texts'][0]['itemId'] == store.page(pid, record['texts'][0]['pageId'])['items'][0]['_id']


def test_bt_roundtrip_to_another_project_rebinds_page_ids_and_keeps_missing_history(chapter):
    store, pid, record = chapter
    record['texts'].append({**record['texts'][0], 'key': 'missing-history', 'pageId': 'removed-page',
                            'pageName': 'removed.png', 'itemId': 'removed-item', 'text': '已移除的歷史文字'})
    store.save_question_records(pid, 0, [record])
    exported = store.translation(pid)
    source = store.directory(pid) / 'originals' / '1.png'
    other = store.create('fresh project', [('1.png', source.read_bytes()), ('2.png', source.read_bytes())])
    store.import_translation(other['id'], json.dumps(exported).encode(), 'bt', 0, True)
    texts = store.question_records(other['id'])['records'][0]['texts']
    assert texts[0]['pageId'] == other['pages'][0]['id']
    assert texts[0]['itemId'] == store.page(other['id'], other['pages'][0]['id'])['items'][0]['_id']
    assert texts[0]['text'] == record['texts'][0]['text']
    assert texts[-1] == record['texts'][-1]


def test_invalid_bt_questions_rejected_in_preview_and_apply(chapter):
    store, pid, record = chapter
    original = disk_snapshot(store, pid)
    data = store.translation(pid)
    data['questionRecords'] = {'version': 0, 'records': [{**record, 'texts': []}]}
    for apply in (False, True):
        with pytest.raises(ValueError):
            store.import_translation(pid, json.dumps(data).encode(), 'bt', store.read(pid)['revision'], apply)
        assert disk_snapshot(store, pid) == original


def test_archive_roundtrip_and_invalid_questions(chapter):
    store, pid, record = chapter
    existing = store.save_question_records(pid, 0, [record])
    archive = store.export_archive(pid)
    try:
        raw = archive.read_bytes()
    finally:
        archive.unlink()
    imported = store.import_archive(raw, 10_000_000)
    assert imported['id'] != pid
    assert store.question_records(imported['id']) == existing
    assert imported['pages'] == store.read(pid)['pages']
    malicious = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(raw)) as source, zipfile.ZipFile(malicious, 'w') as target:
        for name in source.namelist():
            payload = source.read(name)
            if name == 'prelayout/project.json':
                project = json.loads(payload)
                project['template']['questionRecords']['version'] = -1
                payload = json.dumps(project).encode()
            target.writestr(name, payload)
    with pytest.raises(ValueError):
        store.import_archive(malicious.getvalue(), 10_000_000)
    assert len(store.list()) == 2


def test_api_read_update_conflict_and_export(chapter):
    store, pid, record = chapter
    app = FastAPI()
    app.include_router(router(store, object(), 10_000_000))
    url = f'/api/prelayout/projects/{pid}/question-records'
    with TestClient(app) as client:
        assert client.get(url).json() == {'version': 0, 'records': []}
        saved = client.put(url, json={'expected_version': 0, 'records': [record]})
        assert saved.status_code == 200 and saved.json()['version'] == 1
        assert client.get(url).json() == saved.json()
        assert client.put(url, json={'expected_version': 0, 'records': [record]}).status_code == 200
        assert client.put(url, json={'expected_version': 0, 'records': []}).status_code == 409
        assert client.put(url, json={'expected_version': True, 'records': []}).status_code == 400
        assert client.put(url, json={'expected_version': 1}).status_code == 400
        assert client.get(f'/api/prelayout/projects/{pid}/export/bt').json()['questionRecords'] == saved.json()
        assert client.put(url, json={'expected_version': 1, 'records': []}).json() == {'version': 2, 'records': []}
        assert client.get('/api/prelayout/projects/pl_' + '0' * 32 + '/question-records').status_code == 404


def test_original_snapshot_metadata_survives_bt_and_archive_roundtrips(chapter):
    store, pid, record = chapter
    record['texts'].reverse()  # Export and rebind preserve click order, including page order reversal.
    first, second = record['texts']
    first['source'] = {'ocr_text': '日本語\n原文', 'baseball_term': {'term': 'GM', 'notes': ['總經理']},
                       'term_explanation': None, 'future_annotation': {'reviewed': False}}
    first['pageSummary'] = {'text': '第二頁概括', 'tags': ['棒球']}
    second['source'] = {}
    second['pageSummary'] = None
    existing = store.save_question_records(pid, 0, [record])
    exported = store.translation(pid)
    assert exported['questionRecords'] == existing
    original_sources = [(copy.deepcopy(text['source']), copy.deepcopy(text['pageSummary'])) for text in record['texts']]
    store.import_translation(pid, json.dumps(exported).encode(), 'bt', store.read(pid)['revision'], True)
    imported = store.question_records(pid)['records'][0]['texts']
    assert [text['pageNumber'] for text in imported] == [2, 1]
    assert [(text['source'], text['pageSummary']) for text in imported] == original_sources
    archive = store.export_archive(pid)
    try:
        other = store.import_archive(archive.read_bytes(), 10_000_000)
    finally:
        archive.unlink()
    assert store.question_records(other['id']) == store.question_records(pid)
    imported[0]['source']['baseball_term']['notes'].append('caller mutation')
    assert store.question_records(pid)['records'][0]['texts'][0]['source']['baseball_term']['notes'] == ['總經理']


@pytest.mark.parametrize('field,value', [
    ('source', None), ('source', []), ('source', 'not an object'),
    ('source', {'value': float('nan')}), ('source', {'value': float('inf')}),
    ('source', {'value': float('-inf')}), ('source', {1: 'non-string key'}),
    ('source', {'value': ('not', 'JSON')}), ('source', {'value': {'set'}}),
    ('pageSummary', float('nan')), ('pageSummary', {'nested': [float('inf')]}),
    ('pageSummary', (1, 2)), ('unknown', 'extra reference field'),
])
def test_invalid_source_snapshots_rejected_before_write(chapter, field, value):
    store, pid, record = chapter
    original = disk_snapshot(store, pid)
    record['texts'][0][field] = value
    with pytest.raises(ValueError):
        store.save_question_records(pid, 0, [record])
    assert disk_snapshot(store, pid) == original


@pytest.mark.parametrize('value', [None, '', 0, False, [], {}, ['概括', {'text': '內容'}]])
def test_page_summary_accepts_any_json_value_and_is_optional(chapter, value):
    _, _, record = chapter
    assert validate_records([record]) == [record]
    assert 'source' not in validate_records([record])[0]['texts'][0]
    assert 'pageSummary' not in validate_records([record])[0]['texts'][0]
    record['texts'][0]['pageSummary'] = value
    assert validate_records([record])[0]['texts'][0]['pageSummary'] == value


@pytest.mark.parametrize('field', ['source', 'pageSummary'])
def test_original_snapshot_metadata_counts_towards_total_limit(chapter, field):
    _, _, record = chapter
    value = '原' * 16_000_000
    record['texts'][0][field] = {'ocr_text': value} if field == 'source' else value
    with pytest.raises(ValueError, match='總量超過限制'):
        validate_records([record])


def test_validated_original_snapshots_are_deep_copies(chapter):
    _, _, record = chapter
    record['texts'][0]['source'] = {'unknown': [{'note': '原文'}]}
    record['texts'][0]['pageSummary'] = {'notes': ['概括']}
    copied = validate_records([record])
    record['texts'][0]['source']['unknown'][0]['note'] = '後改'
    record['texts'][0]['pageSummary']['notes'].append('後改')
    assert copied[0]['texts'][0]['source'] == {'unknown': [{'note': '原文'}]}
    assert copied[0]['texts'][0]['pageSummary'] == {'notes': ['概括']}
