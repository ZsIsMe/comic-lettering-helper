"""Synthetic store/API regressions for imported line-break suggestions."""
import copy
import io
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from app.config import Settings
from app.prelayout.api import router
from app.prelayout.detection import PrelayoutDetection
from app.prelayout.store import PrelayoutStore, atomic_json
from app.resources import ResourceGate
from prelayout_core.data import identifier


TEXT = '因為今天下雨，\r\n所以我們決定明天出發。'


@pytest.fixture
def chapter(tmp_path):
    buffer = io.BytesIO()
    Image.new('RGB', (300, 400), 'white').save(buffer, 'PNG')
    store = PrelayoutStore(tmp_path / 'prelayout')
    project = store.create('synthetic line breaks', [('1.png', buffer.getvalue()), ('2.png', buffer.getvalue())])
    detector = PrelayoutDetection(Settings(), store, ResourceGate())
    app = FastAPI()
    app.include_router(router(store, detector, 1_000_000))
    with TestClient(app) as client:
        yield store, project, detector, client


def draft(pages=('1.png',), *, duplicate=False):
    item = {'text': TEXT, 'x': .5, 'y': .5, 'font-size': 23, 'rotation': -17,
            'orientation': 'horizontal', 'font': 'fixture-font', 'color': '#123456',
            'stroke-color': '#abcdef', 'stroke-weight': 2, 'ocr_text': '原始日文'}
    return {'version': [1, 0], 'custom': {'retained': True},
            'transMap': {name: [{**copy.deepcopy(item), 'index': index + 1} for index in range(2 if duplicate else 1)]
                         for name in pages}}


def import_json(store, project, client, value, *, apply=True):
    response = client.post(f'/api/prelayout/projects/{project["id"]}/imports',
                           data={'kind': 'bt', 'expected_revision': store.read(project['id'])['revision'],
                                 'apply': str(apply).lower()},
                           files=[('files', ('Meo.json', json.dumps(value, ensure_ascii=False).encode(),
                                             'application/json'))])
    assert response.status_code == 200, response.text
    return response.json()


def prepare_detection(store, project, *, source_counts=(3,), published=False):
    """Write complete synthetic detector output, then exercise the actual publish hook."""
    pid, did = project['id'], identifier('d')
    folder = store.directory(pid) / 'detections' / did
    measures = []
    for index, count in enumerate(source_counts):
        center = .5 if len(source_counts) == 1 else (.25 if index == 0 else .75)
        entry = {'xyxy_pixel': [int(300 * center - 30), 100, int(300 * center + 30), 300],
                 'center_normalized': [center, .5], 'font_size': 32,
                 'orientation': 'vertical', 'source_block_index': index}
        if count is not None:
            entry['source_line_count'] = count
        measures.append(entry)
    measure = {'pages': {page['name']: copy.deepcopy(measures) for page in project['pages']}}
    atomic_json(folder / 'output' / 'measure.json', measure)
    for page in project['pages']:
        atomic_json(folder / 'output' / 'page-measures' / f'{page["id"]}.json', measure['pages'][page['name']])
        atomic_json(folder / 'output' / 'page-characters' / f'{page["id"]}.json', [])
    atomic_json(folder / 'output' / 'complete.json', {'pages': [page['name'] for page in project['pages']]})
    atomic_json(folder / 'task.json', {'id': did, 'project_id': pid, 'state': 'running',
                                     'created_at': '2026-11-26T00:00:00Z', 'pid': None})
    if published:
        current = store.read(pid)
        current['detection_id'] = did
        store.write(current)
    return did, folder


def page_state(store, project, client, index=0):
    response = client.get(f'/api/prelayout/projects/{project["id"]}/pages/{project["pages"][index]["id"]}')
    assert response.status_code == 200, response.text
    return response.json()


def test_detect_then_json_import_prepares_suggestions_without_changing_import_or_export(chapter):
    store, project, detector, client = chapter
    did, folder = prepare_detection(store, project)
    detector.publish(project['id'], did, cleanup=False)
    before_measure = (folder / 'output' / 'measure.json').read_bytes()
    value = draft()
    import_json(store, project, client, value, apply=False)
    assert page_state(store, project, client).get('line_break_suggestions', {}) == {}
    import_json(store, project, client, value)
    state = page_state(store, project, client)
    item = state['items'][0]
    assert item['text'] == TEXT
    for key, original in value['transMap']['1.png'][0].items():
        assert item[key] == original
    assert 'line_break_sources' not in state
    suggestion = state['line_break_suggestions'][item['_id']]
    assert suggestion['original_text'] == TEXT
    assert suggestion['source_line_count'] == 3
    assert {candidate['line_count'] for candidate in suggestion['candidates']} == {4, 3, 2}
    exported = client.get(f'/api/prelayout/projects/{project["id"]}/export/bt')
    assert exported.status_code == 200
    assert exported.json()['transMap']['1.png'] == value['transMap']['1.png']
    assert 'line_break' not in exported.text
    assert (folder / 'output' / 'measure.json').read_bytes() == before_measure


def test_import_then_actual_detection_publication_refreshes_suggestions_without_text_changes(chapter):
    store, project, detector, client = chapter
    import_json(store, project, client, draft())
    before = page_state(store, project, client)
    assert before.get('line_break_suggestions', {}) == {}
    export = store.translation(project['id'])
    did, _ = prepare_detection(store, project)
    detector.publish(project['id'], did, cleanup=False)
    after = page_state(store, project, client)
    assert after['items'] == before['items']
    assert after['revision'] == before['revision']
    assert after['line_break_suggestions'][after['items'][0]['_id']]['source_line_count'] == 3
    assert store.translation(project['id']) == export
    assert detector.status(project['id'])['state'] == 'completed'


def test_normal_save_reload_and_same_item_undo_keep_original_suggestion(chapter):
    store, project, detector, client = chapter
    prepare_detection(store, project, published=True)
    import_json(store, project, client, draft())
    original = page_state(store, project, client)
    item_id = original['items'][0]['_id']
    options = original['line_break_suggestions']
    for operation, text in [('apply-line-break', options[item_id]['candidates'][0]['text']),
                            ('undo-line-break', TEXT)]:
        current = page_state(store, project, client)
        items = copy.deepcopy(current['items'])
        items[0]['text'] = text
        response = client.patch(f'/api/prelayout/projects/{project["id"]}/pages/{project["pages"][0]["id"]}/text',
                                json={'items': items, 'expected_revision': current['revision'],
                                      'operation_id': operation})
        assert response.status_code == 200, response.text
        reloaded = PrelayoutStore(store.root).page(project['id'], project['pages'][0]['id'])
        assert reloaded['items'][0]['_id'] == item_id
        assert reloaded['items'][0]['text'] == text
        assert reloaded['line_break_suggestions'] == options
    assert store.translation(project['id'])['transMap']['1.png'][0]['text'] == TEXT


def test_explicit_rematch_uses_current_match_and_preserves_original_import(chapter):
    store, project, detector, client = chapter
    prepare_detection(store, project, source_counts=(4, 2), published=True)
    value = draft()
    value['transMap']['1.png'][0]['x'] = .25
    import_json(store, project, client, value)
    initial = page_state(store, project, client)
    item_id = initial['items'][0]['_id']
    assert initial['line_break_suggestions'][item_id]['source_line_count'] == 4
    edited = copy.deepcopy(initial['items'])
    edited[0]['x'] = .75
    store.save_page(project['id'], project['pages'][0]['id'], initial['revision'], edited, 'move-to-other-balloon')
    response = client.post(f'/api/prelayout/projects/{project["id"]}/matches/apply',
                           json={'expected_revision': store.read(project['id'])['revision'], 'manual': {}})
    assert response.status_code == 200, response.text
    state = page_state(store, project, client)
    assert state['items'][0]['_id'] == item_id
    assert state['items'][0]['text'] == TEXT
    assert state['items'][0]['match_source_block_index'] == 1
    assert state['line_break_suggestions'][item_id]['source_line_count'] == 2
    assert state['line_break_suggestions'][item_id]['original_text'] == TEXT


def test_partial_page_reimport_replaces_only_imported_pages_suggestion_sources(chapter):
    store, project, detector, client = chapter
    prepare_detection(store, project, published=True)
    import_json(store, project, client, draft(('1.png', '2.png')))
    untouched = page_state(store, project, client, 1)
    old = page_state(store, project, client)
    value = draft()
    value['transMap']['1.png'][0]['text'] = '我們決定明天下午再一起前往圖書館。'
    import_json(store, project, client, value)
    assert page_state(store, project, client, 1) == untouched
    current = page_state(store, project, client)
    new_id = current['items'][0]['_id']
    assert new_id != old['items'][0]['_id']
    assert set(current['line_break_suggestions']) == {new_id}
    assert current['line_break_suggestions'][new_id]['original_text'] == value['transMap']['1.png'][0]['text']


@pytest.mark.parametrize('source_count', [None, 0])
def test_old_measure_without_actual_source_lines_does_not_guess(chapter, source_count):
    store, project, detector, client = chapter
    did, _ = prepare_detection(store, project, source_counts=(source_count,))
    detector.publish(project['id'], did, cleanup=False)
    import_json(store, project, client, draft())
    assert page_state(store, project, client)['line_break_suggestions'] == {}


def test_duplicate_balloon_mapping_does_not_guess_line_count(chapter):
    store, project, detector, client = chapter
    prepare_detection(store, project, published=True)
    import_json(store, project, client, draft(duplicate=True))
    state = page_state(store, project, client)
    assert len(state['items']) == 2
    assert state['line_break_suggestions'] == {}
    store.apply_matches(project['id'], store.read(project['id'])['revision'], {})
    state = page_state(store, project, client)
    assert state['line_break_suggestions'] == {}
    assert any(item['match_status'] == 'duplicate' for item in state['items'])


def disk_snapshot(store, pid):
    return {str(path.relative_to(store.directory(pid))): (path.read_bytes(), path.stat().st_mtime_ns)
            for path in store.directory(pid).rglob('*') if path.is_file()}


def downgrade_to_two_candidates(store, project):
    page = store.read(project['id'])['pages'][0]
    path = store.directory(project['id']) / page['state']
    state = json.loads(path.read_text())
    state.pop('line_break_suggestions_version', None)
    for suggestion in state['line_break_suggestions'].values():
        suggestion['candidates'] = [option for option in suggestion['candidates']
                                    if option['line_count'] <= suggestion['source_line_count']]
    atomic_json(path, state)
    return state


def test_old_saved_candidates_upgrade_on_page_read_once_without_disk_writes(chapter, monkeypatch):
    from app.prelayout import import_line_breaks as module
    store, project, detector, client = chapter
    prepare_detection(store, project, published=True)
    import_json(store, project, client, draft())
    page = store.read(project['id'])['pages'][0]
    store.review_page(project['id'], page['id'], page['revision'], True)
    old = downgrade_to_two_candidates(store, project)
    old['items'][0].update(text='人工修訂\n已保存內容', x=.7)
    atomic_json(store.directory(project['id']) / page['state'], old)
    before = disk_snapshot(store, project['id'])
    calls = []
    real = module.line_break_candidates
    def spy(text, count):
        calls.append((text, count))
        return real(text, count)
    monkeypatch.setattr(module, 'line_break_candidates', spy)
    for _ in range(3):
        current = page_state(store, project, client)
        assert current['items'] == old['items']
        assert current['reviewed_revision'] == old['revision']
        options = current['line_break_suggestions'][old['items'][0]['_id']]
        assert [option['line_count'] for option in options['candidates']] == [4, 3, 2]
        assert options['original_text'] == TEXT
    assert calls == [(TEXT, 3)]
    assert disk_snapshot(store, project['id']) == before
    # A normal text save persists the already cached metadata under the new revision.
    store.save_page(project['id'], project['pages'][0]['id'], current['revision'], current['items'], 'normal-save')
    saved_page = store.read(project['id'])['pages'][0]
    saved = json.loads((store.directory(project['id']) / saved_page['state']).read_text())
    assert saved['line_break_suggestions_version'] == 2
    assert saved['items'] == old['items']
    assert calls == [(TEXT, 3)]
    assert PrelayoutStore(store.root).page(project['id'], saved_page['id'])['line_break_suggestions'] == current['line_break_suggestions']
    assert calls == [(TEXT, 3)]


def test_legacy_page_without_retained_original_information_is_not_guessed(chapter, monkeypatch):
    from app.prelayout import import_line_breaks as module
    store, project, detector, client = chapter
    prepare_detection(store, project, published=True)
    import_json(store, project, client, draft())
    page = store.read(project['id'])['pages'][0]
    path = store.directory(project['id']) / page['state']
    state = json.loads(path.read_text())
    for key in ('line_break_sources', 'line_break_suggestions', 'line_break_suggestions_version'):
        state.pop(key, None)
    atomic_json(path, state)
    before = disk_snapshot(store, project['id'])
    monkeypatch.setattr(module, 'line_break_candidates', lambda *_: pytest.fail('Must not guess from current text/measure'))
    assert page_state(store, project, client).get('line_break_suggestions', {}) == {}
    assert disk_snapshot(store, project['id']) == before


def test_three_candidate_archive_roundtrip_and_old_archive_upgrade(chapter):
    store, project, detector, client = chapter
    prepare_detection(store, project, published=True)
    import_json(store, project, client, draft())
    archive = store.export_archive(project['id'])
    imported = store.import_archive(archive.read_bytes(), 10_000_000)
    archive.unlink()
    state = store.page(imported['id'], imported['pages'][0]['id'])
    options = next(iter(state['line_break_suggestions'].values()))
    assert [option['line_count'] for option in options['candidates']] == [4, 3, 2]
    downgrade_to_two_candidates(store, project)
    archive = store.export_archive(project['id'])
    imported_old = store.import_archive(archive.read_bytes(), 10_000_000)
    archive.unlink()
    state = store.page(imported_old['id'], imported_old['pages'][0]['id'])
    options = next(iter(state['line_break_suggestions'].values()))
    assert [option['line_count'] for option in options['candidates']] == [4, 3, 2]
    assert options['original_text'] == TEXT


@pytest.mark.parametrize('corruption', ['four_options', 'wrong_count', 'duplicate_count', 'changed_text', 'version'])
def test_archive_candidate_validation_rejects_invalid_three_choice_metadata(chapter, corruption):
    from app.prelayout.import_line_breaks import validate_archived_suggestions
    store, project, detector, client = chapter
    prepare_detection(store, project, published=True)
    import_json(store, project, client, draft())
    page = store.read(project['id'])['pages'][0]
    state = json.loads((store.directory(project['id']) / page['state']).read_text())
    options = next(iter(state['line_break_suggestions'].values()))['candidates']
    if corruption == 'four_options':
        options.append(copy.deepcopy(options[0]))
    elif corruption == 'wrong_count':
        options[0]['line_count'] = 5
    elif corruption == 'duplicate_count':
        options[1] = copy.deepcopy(options[0])
    elif corruption == 'changed_text':
        options[0]['text'] += '！'
    else:
        state['line_break_suggestions_version'] = True
    with pytest.raises(ValueError, match='封存斷句'):
        validate_archived_suggestions(state, page)


def test_retained_original_without_recorded_source_count_does_not_guess(chapter, monkeypatch):
    from app.prelayout import import_line_breaks as module
    store, project, detector, client = chapter
    prepare_detection(store, project, published=True)
    import_json(store, project, client, draft())
    state = downgrade_to_two_candidates(store, project)
    for value in state['line_break_suggestions'].values():
        value.pop('source_line_count')
    page = store.read(project['id'])['pages'][0]
    atomic_json(store.directory(project['id']) / page['state'], state)
    before = disk_snapshot(store, project['id'])
    monkeypatch.setattr(module, 'line_break_candidates', lambda *_: pytest.fail('Missing source count must not be guessed'))
    assert page_state(store, project, client)['line_break_suggestions'] == {}
    assert disk_snapshot(store, project['id']) == before
