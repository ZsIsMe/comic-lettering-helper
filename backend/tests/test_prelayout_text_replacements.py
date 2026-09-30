import copy
import io

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from app.config import Settings
from app.resources import ResourceGate
from app.prelayout.api import router
from app.prelayout.detection import PrelayoutDetection
from app.prelayout.store import Conflict, PrelayoutStore
from prelayout_core.data import identifier


def picture():
    output = io.BytesIO()
    Image.new('RGB', (20, 20), 'white').save(output, 'PNG')
    return output.getvalue()


def entry(text):
    return {'_id': identifier(), 'text': text, 'x': .5, 'y': .5,
            'font-size': 23, 'rotation': -17, 'orientation': 'vertical',
            'color': '#000000', 'stroke-color': '#ffffff', 'stroke-weight': 2,
            'ocr': {'source': 'fixture'}}


@pytest.fixture
def chapter(tmp_path):
    store = PrelayoutStore(tmp_path / 'prelayout')
    project = store.create('synthetic', [('1.png', picture()), ('2.png', picture()), ('3.png', picture())])
    p1, p2, p3 = project['pages']
    a, b, c, d = entry('猫猫\n猫'), entry('猫 $\\猫'), entry('猫\r\n猫'), entry('untouched')
    store.save_page(project['id'], p1['id'], 0, [a, b], 'seed-1')
    store.save_page(project['id'], p2['id'], 0, [c], 'seed-2')
    store.save_page(project['id'], p3['id'], 0, [d], 'seed-3')
    store.review_page(project['id'], p1['id'], 1, True)
    store.review_page(project['id'], p2['id'], 1, True)
    store.review_page(project['id'], p3['id'], 1, True)
    return store, project['id'], (p1, p2, p3), (a, b, c, d)


def selection(*pairs):
    return [{'page_id': page['id'], 'item_id': item['_id']} for page, item in pairs]


def test_replacement_is_non_recursive_and_rejects_oversized_expansion_before_allocating():
    from app.prelayout.text_replacements import replacement
    assert replacement('aaaaa', 'aa', 'aaa') == ('aaaaaaa', 2)
    assert replacement('甲😀甲', '甲', '$1\\甲') == ('$1\\甲😀$1\\甲', 2)
    with pytest.raises(ValueError, match='每框'):
        replacement('甲' * 50000, '甲', '乙' * 50000)


def test_preview_all_pages_read_only_and_selected_subset(chapter):
    store, pid, (p1, p2, p3), (a, b, c, d) = chapter
    before = copy.deepcopy(store.read(pid))
    preview = store.preview_text_replacements(pid, '猫', '犬')
    assert preview['summary'] == {'pages': 2, 'items': 3, 'occurrences': 7}
    assert [m['page_number'] for m in preview['matches']] == [1, 1, 2]
    assert preview['project_revision'] == before['revision']
    assert store.read(pid) == before

    result = store.apply_text_replacements(pid, '猫', '犬', before['revision'],
                                           selection((p2, c)), 'replace-subset')
    assert result['summary'] == {'pages': 1, 'items': 1, 'occurrences': 2}
    current = store.read(pid)
    assert current['revision'] == before['revision'] + 1
    assert current['pages'][0] == before['pages'][0]
    assert current['pages'][2] == before['pages'][2]
    assert 'reviewed_revision' not in current['pages'][1]
    page = store.page(pid, p2['id'])
    assert page['items'][0] == {**c, 'index': 1, 'text': '犬\r\n犬'}
    assert store.translation(pid)['transMap']['2.png'][0]['text'] == '犬\r\n犬'
    assert store.apply_text_replacements(pid, '猫', '犬', before['revision'],
                                         selection((p2, c)), 'replace-subset')['project']['revision'] == current['revision']
    assert store.latest_text_replacement(pid)['can_undo'] is True


def test_literal_special_empty_unicode_newlines_and_noop(chapter):
    store, pid, (p1, p2, p3), (a, b, c, d) = chapter
    before = store.read(pid)
    assert store.preview_text_replacements(pid, 'cat', 'dog')['summary']['items'] == 0
    assert store.preview_text_replacements(pid, '猫', '猫')['summary']['items'] == 0
    assert store.apply_text_replacements(pid, 'cat', 'dog', before['revision'], [], 'no-op')['project'] == before
    assert store.latest_text_replacement(pid) == {'operation': None, 'can_undo': False}
    assert store.read(pid) == before
    special = store.preview_text_replacements(pid, '$\\', '\\$')
    assert special['summary'] == {'pages': 1, 'items': 1, 'occurrences': 1}
    assert special['matches'][0]['after'] == '猫 \\$猫'
    result = store.apply_text_replacements(pid, '$\\', '\\$', before['revision'],
                                           selection((p1, b)), 'special')
    assert result['summary']['occurrences'] == 1
    current = store.read(pid)
    assert store.preview_text_replacements(pid, '\r\n', '')['matches'][0]['after'] == '猫猫'
    empty = store.apply_text_replacements(pid, '猫', '', current['revision'],
                                          selection((p1, a)), 'empty')
    assert store.page(pid, p1['id'])['items'][0]['text'] == '\n'
    assert empty['summary']['occurrences'] == 3
    with pytest.raises(ValueError): store.preview_text_replacements(pid, '', 'x')
    with pytest.raises(ValueError): store.preview_text_replacements(pid, 'x', 'a' * 50001)


def test_undo_keeps_later_layout_and_conflicts_on_text(chapter):
    store, pid, (p1, p2, p3), (a, b, c, d) = chapter
    start = store.read(pid)['revision']
    store.apply_text_replacements(pid, '猫', '犬', start, selection((p1, a), (p2, c)), 'batch')
    page = store.page(pid, p1['id'])
    moved = copy.deepcopy(page['items'])
    moved[0]['x'] = .8
    store.save_page(pid, p1['id'], page['revision'], moved, 'move')
    revision = store.read(pid)['revision']
    undone = store.undo_text_replacement(pid, 'batch', revision, 'undo-batch')
    assert undone['summary'] == {'pages': 2, 'items': 2, 'occurrences': 5}
    assert store.page(pid, p1['id'])['items'][0]['x'] == .8
    assert store.page(pid, p1['id'])['items'][0]['text'] == a['text']
    assert store.page(pid, p2['id'])['items'][0]['text'] == c['text']
    assert 'reviewed_revision' not in store.read(pid)['pages'][0]
    assert store.latest_text_replacement(pid) == {'operation': None, 'can_undo': False}
    assert store.undo_text_replacement(pid, 'batch', revision, 'undo-batch')['project']['revision'] == undone['project']['revision']
    with pytest.raises(Conflict):
        store.undo_text_replacement(pid, 'batch', revision, 'different-undo')

    current = store.read(pid)['revision']
    store.apply_text_replacements(pid, '猫', '犬', current, selection((p1, a)), 'again')
    page = store.page(pid, p1['id'])
    changed = copy.deepcopy(page['items'])
    changed[0]['text'] = 'manual'
    store.save_page(pid, p1['id'], page['revision'], changed, 'text-edit')
    assert store.latest_text_replacement(pid)['can_undo'] is False
    with pytest.raises(Conflict): store.undo_text_replacement(pid, 'again', store.read(pid)['revision'], 'undo-conflict')


def test_stale_duplicate_selection_and_operation_reuse(chapter):
    store, pid, (p1, p2, p3), (a, b, c, d) = chapter
    revision = store.read(pid)['revision']
    with pytest.raises(ValueError):
        store.apply_text_replacements(pid, '猫', '犬', revision, selection((p1, a), (p1, a)), 'dup')
    with pytest.raises(Conflict):
        store.apply_text_replacements(pid, '猫', '犬', revision - 1, selection((p1, a)), 'stale')
    with pytest.raises(Conflict):
        store.apply_text_replacements(pid, '猫', '犬', revision, selection((p3, d)), 'bad-target')
    store.apply_text_replacements(pid, '猫', '犬', revision, selection((p1, a)), 'good')
    with pytest.raises(Conflict):
        store.apply_text_replacements(pid, '猫', '狼', revision, selection((p1, a)), 'good')
    with pytest.raises(Conflict):
        store.undo_text_replacement(pid, 'good', store.read(pid)['revision'], 'good')


def test_newer_batch_must_be_undone_first(chapter):
    store, pid, (p1, p2, p3), (a, b, c, d) = chapter
    first_revision = store.read(pid)['revision']
    store.apply_text_replacements(pid, '猫', '犬', first_revision, selection((p1, a)), 'first')
    second_revision = store.read(pid)['revision']
    store.apply_text_replacements(pid, '猫', '狼', second_revision, selection((p2, c)), 'second')
    assert store.latest_text_replacement(pid)['operation']['operation_id'] == 'second'
    with pytest.raises(Conflict):
        store.undo_text_replacement(pid, 'first', store.read(pid)['revision'], 'undo-first-too-soon')


@pytest.mark.parametrize('failure', ['operation', 'manifest'])
def test_failure_does_not_publish_partial_pages(chapter, monkeypatch, failure):
    import app.prelayout.store as module
    store, pid, (p1, p2, p3), (a, b, c, d) = chapter
    before = copy.deepcopy(store.read(pid))
    saved = module.atomic_json

    def fail(path, value):
        if (failure == 'operation' and 'text-replacements' in str(path)) or (failure == 'manifest' and str(path).endswith('project.json')):
            raise OSError('injected write failure')
        return saved(path, value)

    monkeypatch.setattr(module, 'atomic_json', fail)
    with pytest.raises(OSError):
        store.apply_text_replacements(pid, '猫', '犬', before['revision'],
                                      selection((p1, a), (p2, c)), 'failing')
    assert store.read(pid) == before
    assert store.page(pid, p1['id'])['items'][0]['text'] == a['text']
    assert store.page(pid, p2['id'])['items'][0]['text'] == c['text']


def test_api_strict_contract(chapter):
    store, pid, (p1, p2, p3), (a, b, c, d) = chapter
    app = FastAPI()
    detector = PrelayoutDetection(Settings(), store, ResourceGate())
    app.include_router(router(store, detector, 10_000))
    base = f'/api/prelayout/projects/{pid}/text-replacements'
    with TestClient(app) as client:
        for body in ({'find': '', 'replacement': 'x'}, {'find': 1, 'replacement': 'x'},
                     {'find': '猫', 'replacement': 'x', 'ignore_newlines': True}):
            assert client.post(f'{base}/preview', json=body).status_code == 422
        preview = client.post(f'{base}/preview', json={'find': '猫', 'replacement': '犬'})
        assert preview.status_code == 200
        revision = preview.json()['project_revision']
        body = {'find': '猫', 'replacement': '犬', 'expected_revision': revision,
                'selected': selection((p1, a)), 'operation_id': 'via-api'}
        assert client.post(f'{base}/apply', json={**body, 'expected_revision': True}).status_code == 422
        detector.busy = lambda _: True
        assert client.post(f'{base}/apply', json=body).status_code == 409
        detector.busy = lambda _: False
        assert client.post(f'{base}/apply', json=body).status_code == 200
        assert client.get(f'{base}/latest').json()['can_undo'] is True
        updated = store.read(pid)['revision']
        detector.busy = lambda _: True
        assert client.post(f'{base}/undo', json={'operation_id': 'via-api', 'expected_revision': updated,
                                                 'undo_operation_id': 'api-undo'}).status_code == 409
        detector.busy = lambda _: False
        assert client.post(f'{base}/undo', json={'operation_id': 'via-api', 'expected_revision': updated,
                                                 'undo_operation_id': 'api-undo'}).status_code == 200
        assert client.get(f'{base}/latest').json()['operation'] is None
