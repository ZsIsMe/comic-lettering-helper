import copy
import io
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from app.prelayout.api import router
from app.prelayout.store import Conflict, PrelayoutStore, atomic_json


@pytest.fixture
def chapter(tmp_path):
    image = io.BytesIO()
    Image.new('RGB', (40, 40), 'white').save(image, 'PNG')
    store = PrelayoutStore(tmp_path / 'prelayout')
    project = store.create('group fonts', [(f'{i}.png', image.getvalue()) for i in (1, 2, 3)])
    pid = project['id']
    data = {
        'groupList': [{'name': '框內', 'custom': {'keep': True}}, {'name': '框外', 'font': 'Outside-Regular'}],
        'page_summary': {'1.png': '頁面概括'}, 'custom': {'preserve': 1},
        'questionRecords': {'version': 0, 'records': []},
        'transMap': {
            '1.png': [{'text': '第一框', 'groupId': 0, 'font': 'Old-Regular', 'ocr_text': '原文',
                       'term_explanation': '註解', 'extra': {'keep': 2}, 'match_status': 'matched'},
                      {'text': '其他組', 'groupId': 1, 'font': 'Outside-Regular'},
                      {'text': '布林組不匹配', 'groupId': False, 'font': 'Boolean-Regular'}],
            '2.png': [{'text': '跨頁框', 'groupId': 0, 'font': 'Old-Regular', 'match_status': 'matched'}],
            '3.png': [{'text': '未修改頁', 'groupId': 1, 'font': 'Outside-Regular'}],
        },
    }
    store.import_translation(pid, json.dumps(data).encode(), 'bt', 0, True)
    for page in store.read(pid)['pages']:
        state = json.loads((store.directory(pid) / page['state']).read_bytes())
        state['operations'] = ['preserved-operation']
        atomic_json(store.directory(pid) / page['state'], state)
        store.review_page(pid, page['id'], page['revision'], True)
    return store, pid


def update(store, pid, fonts=None, names=None):
    return store.update_groups(pid, store.read(pid)['revision'], names or ['框內', '框外'], fonts)


def states(store, pid):
    return [store.page(pid, page['id']) for page in store.read(pid)['pages']]


def disk_snapshot(store, pid):
    root = store.directory(pid)
    return {str(path.relative_to(root)): path.read_bytes() for path in root.rglob('*') if path.is_file()}


def test_group_font_updates_all_matching_pages_and_preserves_other_information(chapter):
    store, pid = chapter
    before = store.read(pid)
    old_states = states(store, pid)
    result = update(store, pid, {'0': 'Example-Bold'})
    assert result['revision'] == before['revision'] + 1
    assert result['template'] == {**before['template'], 'groupList': [
        {'name': '框內', 'custom': {'keep': True}, 'font': 'Example-Bold'},
        before['template']['groupList'][1]]}
    assert result['pages'][2] == before['pages'][2]
    for i, state in enumerate(states(store, pid)):
        expected_items = copy.deepcopy(old_states[i]['items'])
        for item in expected_items:
            if type(item.get('groupId')) is int and item['groupId'] == 0:
                item.update(font='Example-Bold', match_status='manual')
        assert state['items'] == expected_items
        assert state['operations'] == ['preserved-operation']
        if i < 2:
            assert state['revision'] == old_states[i]['revision'] + 1
            assert 'reviewed_revision' not in state
            old_path = store.directory(pid) / before['pages'][i]['state']
            assert json.loads(old_path.read_bytes())['items'] == old_states[i]['items']


def test_manual_override_survives_rename_and_empty_mapping_then_explicit_reapply(chapter):
    store, pid = chapter
    update(store, pid, {'0': 'Example-Bold'})
    page = states(store, pid)[0]
    page['items'][0]['font'] = 'Manual-Light'
    store.save_page(pid, page['id'], page['revision'], page['items'], 'manual-font')
    before_pages = store.read(pid)['pages']
    update(store, pid, names=['對話', '框外'])
    update(store, pid, {}, names=['對話', '框外'])
    assert store.read(pid)['pages'] == before_pages
    assert states(store, pid)[0]['items'][0]['font'] == 'Manual-Light'
    # Reapply even when the default did not change, while already-correct pages stay intact.
    update(store, pid, {'0': 'Example-Bold'}, names=['對話', '框外'])
    assert states(store, pid)[0]['items'][0]['font'] == 'Example-Bold'
    assert store.read(pid)['pages'][1:] == before_pages[1:]


def test_clear_default_keeps_every_individual_font(chapter):
    store, pid = chapter
    update(store, pid, {'0': 'Example-Bold'})
    before_pages = store.read(pid)['pages']
    before_items = [page['items'] for page in states(store, pid)]
    result = update(store, pid, {'0': None})
    assert 'font' not in result['template']['groupList'][0]
    assert result['pages'] == before_pages
    assert [page['items'] for page in states(store, pid)] == before_items


def test_empty_apply_groups_updates_defaults_without_touching_pages(chapter):
    store, pid = chapter
    before = store.read(pid)
    before_states = states(store, pid)
    result = store.update_groups(pid, before['revision'], ['框內', '框外'],
                                 {'0': 'DefaultOnly-Bold', '1': 'DefaultOnly-Light'}, [])
    assert [group['font'] for group in result['template']['groupList']] == ['DefaultOnly-Bold', 'DefaultOnly-Light']
    assert result['revision'] == before['revision'] + 1
    assert result['pages'] == before['pages']
    assert states(store, pid) == before_states


def test_apply_subset_only_changes_selected_font_groups(chapter):
    store, pid = chapter
    before = store.read(pid)
    before_states = states(store, pid)
    result = store.update_groups(pid, before['revision'], ['框內', '框外'],
                                 {'0': 'Inside-Bold', '1': 'Outside-Light'}, ['1'])
    assert [group['font'] for group in result['template']['groupList']] == ['Inside-Bold', 'Outside-Light']
    assert result['pages'][1] == before['pages'][1]
    after_states = states(store, pid)
    assert after_states[1] == before_states[1]
    for index in (0, 2):
        expected_items = copy.deepcopy(before_states[index]['items'])
        for item in expected_items:
            if type(item.get('groupId')) is int and item['groupId'] == 1:
                item.update(font='Outside-Light', match_status='manual')
        assert after_states[index]['items'] == expected_items
        assert after_states[index]['revision'] == before_states[index]['revision'] + 1
        assert 'reviewed_revision' not in after_states[index]


@pytest.mark.parametrize('fonts, apply_groups', [
    ({'0': 'Font'}, '0'), ({'0': 'Font'}, {}), ({'0': 'Font'}, [0]),
    ({'0': 'Font'}, [True]), ({'0': 'Font'}, [{}]), ({'0': 'Font'}, ['00']),
    ({'0': 'Font'}, ['0', '0']), ({'0': 'Font'}, ['1']),
    ({'0': 'Font', '1': None}, ['0', '1']), (None, ['0']), ({}, ['0']),
])
def test_invalid_apply_font_groups_rejected_before_any_writes(chapter, fonts, apply_groups):
    store, pid = chapter
    before = disk_snapshot(store, pid)
    with pytest.raises(ValueError):
        store.update_groups(pid, store.read(pid)['revision'], ['框內', '框外'], fonts, apply_groups)
    assert disk_snapshot(store, pid) == before


def test_export_and_reimport_keep_group_and_individual_fonts(chapter):
    store, pid = chapter
    update(store, pid, {'0': 'Example-Bold'})
    exported = store.translation(pid)
    store.import_translation(pid, json.dumps(exported).encode(), 'bt', store.read(pid)['revision'], True)
    assert store.translation(pid) == exported


def test_stale_revision_leaves_all_files_unchanged(chapter):
    store, pid = chapter
    before = disk_snapshot(store, pid)
    with pytest.raises(Conflict):
        store.update_groups(pid, store.read(pid)['revision'] - 1, ['框內', '框外'], {'0': 'New-Regular'})
    assert disk_snapshot(store, pid) == before


@pytest.mark.parametrize('fonts', [
    [], 'Example', {'00': 'Font'}, {'01': 'Font'}, {'-1': 'Font'}, {'1.0': 'Font'},
    {'2': 'Font'}, {'9999999999999999999999': 'Font'}, {0: 'Font'}, {True: 'Font'},
    {'0': ''}, {'0': '   '}, {'0': 'A' * 513}, {'0': False}, {'0': []},
    {'0': 'Font\n'}, {'0': 'Font\x00'}, {'0': 'Font\x7f'}, {'0': 'Font\x85'},
    {'0': 'Valid-Regular', '1': ''},
])
def test_invalid_font_mapping_rejected_before_any_writes(chapter, fonts):
    store, pid = chapter
    before = disk_snapshot(store, pid)
    with pytest.raises(ValueError):
        update(store, pid, fonts)
    assert disk_snapshot(store, pid) == before


@pytest.mark.parametrize('revision', [True, False, None, '1', 1.0, -1])
def test_revision_must_be_a_nonnegative_integer(chapter, revision):
    store, pid = chapter
    before = disk_snapshot(store, pid)
    with pytest.raises(ValueError):
        store.update_groups(pid, revision, ['框內', '框外'], {'0': 'Font'})
    assert disk_snapshot(store, pid) == before


@pytest.mark.parametrize('fail_at', ['second-page', 'manifest'])
def test_write_failure_never_publishes_partial_group_or_page_changes(chapter, monkeypatch, fail_at):
    from app.prelayout import store as module
    store, pid = chapter
    before = disk_snapshot(store, pid)
    old_manifest = store.read(pid)
    written_pages = 0

    def fail(path, value):
        nonlocal written_pages
        path = Path(path)
        if path.name != 'project.json':
            written_pages += 1
        if ((fail_at == 'second-page' and written_pages == 2)
                or (fail_at == 'manifest' and path.name == 'project.json')):
            raise OSError('synthetic write failure')
        atomic_json(path, value)

    monkeypatch.setattr(module, 'atomic_json', fail)
    with pytest.raises(OSError, match='synthetic'):
        update(store, pid, {'0': 'Example-Bold'})
    assert store.read(pid) == old_manifest
    # New immutable orphan files may remain, but every old file and reference stays intact.
    after = disk_snapshot(store, pid)
    assert all(after[path] == raw for path, raw in before.items())
    assert states(store, pid)[0]['items'][0]['font'] == 'Old-Regular'


def test_groups_api_accepts_font_mapping_and_reports_invalid_input(chapter):
    store, pid = chapter
    app = FastAPI()
    detector = SimpleNamespace(busy=lambda _: False)
    app.include_router(router(store, detector, 10_000))
    with TestClient(app) as client:
        path = f'/api/prelayout/projects/{pid}/groups'
        result = client.put(path, json={'expected_revision': store.read(pid)['revision'],
                                       'names': ['框內', '框外'], 'fonts': {'0': 'Example-Bold'}})
        assert result.status_code == 200
        assert result.json()['template']['groupList'][0]['font'] == 'Example-Bold'
        assert states(store, pid)[1]['items'][0]['font'] == 'Example-Bold'
        before_pages = store.read(pid)['pages']
        result = client.put(path, json={'expected_revision': store.read(pid)['revision'],
                                       'names': ['框內', '框外'], 'fonts': {'0': 'DefaultOnly-Regular'},
                                       'apply_font_groups': []})
        assert result.status_code == 200
        assert result.json()['template']['groupList'][0]['font'] == 'DefaultOnly-Regular'
        assert result.json()['pages'] == before_pages
        assert client.put(path, json={'expected_revision': True, 'names': ['框內', '框外']}).status_code == 400
        detector.busy = lambda _: True
        before = disk_snapshot(store, pid)
        assert client.put(path, json={'expected_revision': store.read(pid)['revision'],
                                      'names': ['框內', '框外'], 'fonts': {'0': 'Other-Regular'}}).status_code == 409
        assert disk_snapshot(store, pid) == before
