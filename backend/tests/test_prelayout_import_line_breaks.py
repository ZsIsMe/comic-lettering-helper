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
from app.prelayout.import_line_breaks import LINE_BREAK_SUGGESTIONS_VERSION
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


def import_json(store, project, client, value, *, apply=True, apply_ctd_breaks=None):
    fields = {'kind': 'bt', 'expected_revision': store.read(project['id'])['revision'],
              'apply': str(apply).lower()}
    if apply_ctd_breaks is not None:
        fields['apply_ctd_breaks'] = str(apply_ctd_breaks).lower()
    response = client.post(f'/api/prelayout/projects/{project["id"]}/imports',
                           data=fields,
                           files=[('files', ('Meo.json', json.dumps(value, ensure_ascii=False).encode(),
                                             'application/json'))])
    assert response.status_code == 200, response.text
    return response.json()


def import_lp(store, project, client, text=TEXT, *, apply=True, coordinates=((.5, .5),), apply_ctd_breaks=None):
    labels = ''.join(f'----------------[{index}]----------------[{x},{y},1]\n{text}\n'
                     for index, (x, y) in enumerate(coordinates, 1))
    raw = ('1, 0\n-\n對話\n-\n備註\n>>>>>>>>[1.png]<<<<<<<<\n' + labels).encode()
    fields = {'kind': 'labelplus', 'expected_revision': store.read(project['id'])['revision'],
              'apply': str(apply).lower()}
    if apply_ctd_breaks is not None:
        fields['apply_ctd_breaks'] = str(apply_ctd_breaks).lower()
    response = client.post(f'/api/prelayout/projects/{project["id"]}/imports',
                           data=fields,
                           files=[('files', ('LP.txt', raw, 'text/plain'))])
    assert response.status_code == 200, response.text
    return response.json()


def import_with_defaults(chapter, kind, *, text=TEXT, apply=True):
    store, project, _, client = chapter
    if kind == 'labelplus':
        return import_lp(store, project, client, text, apply=apply, apply_ctd_breaks=True)
    value = draft()
    value['transMap']['1.png'][0]['text'] = text
    return import_json(store, project, client, value, apply=apply, apply_ctd_breaks=True)


def exact_candidate(state):
    item_id = state['items'][0]['_id']
    suggestion = state['line_break_suggestions'][item_id]
    return next(option['text'] for option in suggestion['candidates']
                if option['line_count'] == suggestion['source_line_count'])


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


@pytest.mark.parametrize('apply_ctd_breaks', [None, False])
def test_detect_then_json_import_prepares_suggestions_without_changing_import_or_export(chapter, apply_ctd_breaks):
    store, project, detector, client = chapter
    did, folder = prepare_detection(store, project)
    detector.publish(project['id'], did, cleanup=False)
    before_measure = (folder / 'output' / 'measure.json').read_bytes()
    value = draft()
    import_json(store, project, client, value, apply=False, apply_ctd_breaks=apply_ctd_breaks)
    assert page_state(store, project, client).get('line_break_suggestions', {}) == {}
    import_json(store, project, client, value, apply_ctd_breaks=apply_ctd_breaks)
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


def test_direction_edits_regenerate_candidates_from_imported_text(chapter, monkeypatch):
    from app.prelayout import import_line_breaks as module
    store, project, detector, client = chapter
    prepare_detection(store, project, published=True)
    value = draft()
    value['transMap']['1.png'][0]['text'] = 'Wi Wi Wi 小米 打球 一起 練習'
    original = value['transMap']['1.png'][0]['text']
    calls = []
    real = module.line_break_candidates

    def spy(text, count, orientation, *, line_capacity):
        calls.append((text, orientation, line_capacity))
        return real(text, count, orientation, line_capacity=line_capacity)

    monkeypatch.setattr(module, 'line_break_candidates', spy)
    import_json(store, project, client, value)
    state = page_state(store, project, client)
    for direction, size in [('vertical', 23), ('horizontal', 23), ('horizontal', 30)]:
        item = {**state['items'][0], 'orientation': direction, 'font-size': size, 'text': '我手動改過'}
        state = store.save_page(project['id'], project['pages'][0]['id'], state['revision'],
                                [item], f'change-{direction}-{size}')
        assert state['items'][0]['text'] == '我手動改過'
        assert state['line_break_suggestions'][item['_id']]['candidates'] == real(
            original, 3, direction, line_capacity=60 / size if direction == 'horizontal' else 200 // size)
    assert calls == [(original, 'horizontal', 60 / 23), (original, 'vertical', 8),
                     (original, 'horizontal', 60 / 23), (original, 'horizontal', 2)]


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


@pytest.mark.parametrize('old_version', [1, 2, 3])
def test_old_saved_candidates_upgrade_on_page_read_once_without_disk_writes(chapter, monkeypatch, old_version):
    from app.prelayout import import_line_breaks as module
    store, project, detector, client = chapter
    prepare_detection(store, project, published=True)
    import_json(store, project, client, draft())
    page = store.read(project['id'])['pages'][0]
    store.review_page(project['id'], page['id'], page['revision'], True)
    old = downgrade_to_two_candidates(store, project)
    old['line_break_suggestions_version'] = old_version
    old['items'][0].update(text='人工修訂\n已保存內容', x=.7)
    atomic_json(store.directory(project['id']) / page['state'], old)
    before = disk_snapshot(store, project['id'])
    calls = []
    real = module.line_break_candidates
    def spy(text, count, orientation, *, line_capacity):
        calls.append((text, count, orientation))
        return real(text, count, orientation, line_capacity=line_capacity)
    monkeypatch.setattr(module, 'line_break_candidates', spy)
    for _ in range(3):
        current = page_state(store, project, client)
        assert current['items'] == old['items']
        assert current['reviewed_revision'] == old['revision']
        options = current['line_break_suggestions'][old['items'][0]['_id']]
        assert [option['line_count'] for option in options['candidates']] == [4, 3, 2]
        assert options['original_text'] == TEXT
    assert calls == [(TEXT, 3, 'horizontal')]
    assert disk_snapshot(store, project['id']) == before
    # A normal text save persists the already cached metadata under the new revision.
    store.save_page(project['id'], project['pages'][0]['id'], current['revision'], current['items'], 'normal-save')
    saved_page = store.read(project['id'])['pages'][0]
    saved = json.loads((store.directory(project['id']) / saved_page['state']).read_text())
    assert saved['line_break_suggestions_version'] == LINE_BREAK_SUGGESTIONS_VERSION
    assert saved['items'] == old['items']
    assert calls == [(TEXT, 3, 'horizontal')]
    assert PrelayoutStore(store.root).page(project['id'], saved_page['id'])['line_break_suggestions'] == current['line_break_suggestions']
    assert calls == [(TEXT, 3, 'horizontal')]


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


@pytest.mark.parametrize('old_version', [1, 2, 3])
def test_three_candidate_archive_roundtrip_and_old_archive_upgrade(chapter, old_version):
    store, project, detector, client = chapter
    prepare_detection(store, project, published=True)
    import_json(store, project, client, draft())
    archive = store.export_archive(project['id'])
    imported = store.import_archive(archive.read_bytes(), 10_000_000)
    archive.unlink()
    state = store.page(imported['id'], imported['pages'][0]['id'])
    options = next(iter(state['line_break_suggestions'].values()))
    assert [option['line_count'] for option in options['candidates']] == [4, 3, 2]
    old = downgrade_to_two_candidates(store, project)
    old['line_break_suggestions_version'] = old_version
    page = store.read(project['id'])['pages'][0]
    for suggestion in old['line_break_suggestions'].values():
        suggestion.pop('source_extent_px', None)
    atomic_json(store.directory(project['id']) / page['state'], old)
    archive = store.export_archive(project['id'])
    imported_old = store.import_archive(archive.read_bytes(), 10_000_000)
    archive.unlink()
    state = store.page(imported_old['id'], imported_old['pages'][0]['id'])
    options = next(iter(state['line_break_suggestions'].values()))
    assert [option['line_count'] for option in options['candidates']] == [4, 3, 2]
    assert options['original_text'] == TEXT


@pytest.mark.parametrize('corruption', ['four_options', 'wrong_count', 'duplicate_count', 'changed_text', 'extent', 'version'])
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
    elif corruption == 'extent':
        next(iter(state['line_break_suggestions'].values()))['source_extent_px'] = [1, 'bad']
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


@pytest.mark.parametrize('kind', ['labelplus', 'bt'])
def test_requested_default_applies_exact_ctd_count_and_preserves_imported_source(chapter, kind):
    store, project, detector, client = chapter
    _, folder = prepare_detection(store, project, published=True)
    before_measure = (folder / 'output' / 'measure.json').read_bytes()
    import_with_defaults(chapter, kind, apply=False)
    assert page_state(store, project, client)['items'] == []
    import_with_defaults(chapter, kind)
    state = page_state(store, project, client)
    item = state['items'][0]
    suggestion = state['line_break_suggestions'][item['_id']]
    original = TEXT.replace('\r\n', '\n') if kind == 'labelplus' else TEXT
    assert suggestion['original_text'] == original
    assert [option['line_count'] for option in suggestion['candidates']] == [4, 3, 2]
    assert item['text'] == exact_candidate(state)
    assert item['text'].count('\n') == 2
    assert item['text'].replace('\n', '') == original.replace('\r', '').replace('\n', '')
    stored_page = store.read(project['id'])['pages'][0]
    saved = json.loads((store.directory(project['id']) / stored_page['state']).read_bytes())
    assert saved['line_break_sources'][item['_id']] == {'text': original, 'x': .5, 'y': .5}
    exported = client.get(f'/api/prelayout/projects/{project["id"]}/export/bt')
    assert exported.status_code == 200
    assert exported.json()['transMap']['1.png'][0]['text'] == item['text']
    assert (folder / 'output' / 'measure.json').read_bytes() == before_measure


@pytest.mark.parametrize('kind', ['labelplus', 'bt'])
def test_default_never_substitutes_other_count_if_exact_count_is_infeasible(chapter, kind):
    store, project, detector, client = chapter
    prepare_detection(store, project, source_counts=(2,), published=True)
    text = '中华人民\n共和国'
    import_with_defaults(chapter, kind, text=text)
    state = page_state(store, project, client)
    assert state['items'][0]['text'] == text
    suggestion = state['line_break_suggestions'][state['items'][0]['_id']]
    assert [c['line_count'] for c in suggestion['candidates']] == [1]


@pytest.mark.parametrize('count', [None, 0])
def test_lp_without_recorded_ctd_count_still_imports_original_lines(chapter, count):
    store, project, detector, client = chapter
    prepare_detection(store, project, source_counts=(count,), published=True)
    import_lp(store, project, client, apply_ctd_breaks=True)
    state = page_state(store, project, client)
    assert state['items'][0]['text'] == TEXT.replace('\r\n', '\n')
    assert state['line_break_suggestions'] == {}


@pytest.mark.parametrize('coordinates,status', [
    (((.5, .5), (.5, .5)), 'duplicate'),
    (((.95, .05),), 'unmatched'),
])
def test_lp_ambiguous_or_unmatched_frames_keep_imported_lines(chapter, coordinates, status):
    store, project, detector, client = chapter
    prepare_detection(store, project, published=True)
    import_lp(store, project, client, coordinates=coordinates, apply_ctd_breaks=True)
    state = page_state(store, project, client)
    assert all(item['match_status'] == status for item in state['items'])
    assert all(item['text'] == TEXT.replace('\r\n', '\n') for item in state['items'])
    assert state['line_break_suggestions'] == {}


@pytest.mark.parametrize('kind', ['labelplus', 'bt'])
def test_first_detection_can_apply_requested_default_once_without_later_reapplying(chapter, kind):
    store, project, detector, client = chapter
    import_with_defaults(chapter, kind)
    before = page_state(store, project, client)
    did, _ = prepare_detection(store, project)
    detector.publish(project['id'], did, cleanup=False)
    after = page_state(store, project, client)
    assert after['items'][0]['text'] == exact_candidate(after)
    assert after['items'][0]['text'].count('\n') == 2
    assert after['revision'] == before['revision'] + 1
    first_text = after['items'][0]['text']
    did, _ = prepare_detection(store, project, source_counts=(4,))
    detector.publish(project['id'], did, cleanup=False)
    again = page_state(store, project, client)
    assert again['items'][0]['text'] == first_text
    assert again['revision'] == after['revision']
    assert again['line_break_suggestions'][again['items'][0]['_id']]['source_line_count'] == 4


@pytest.mark.parametrize('kind', ['labelplus', 'bt'])
@pytest.mark.parametrize('edit', ['new_lines', 'roundtrip'])
def test_edit_before_first_detection_cancels_deferred_default_even_after_undo(chapter, kind, edit):
    store, project, detector, client = chapter
    import_with_defaults(chapter, kind)
    original = page_state(store, project, client)
    edited_items = copy.deepcopy(original['items'])
    edited_items[0]['text'] = original['items'][0]['text'].replace('\r', '').replace('\n', '')
    edited = store.save_page(project['id'], project['pages'][0]['id'], original['revision'],
                             edited_items, 'remove-imported-break')
    if edit == 'roundtrip':
        edited = store.save_page(project['id'], project['pages'][0]['id'], edited['revision'],
                                 original['items'], 'restore-imported-break')
    did, _ = prepare_detection(store, project)
    detector.publish(project['id'], did, cleanup=False)
    after = page_state(store, project, client)
    assert after['items'] == edited['items']
    assert after['revision'] == edited['revision']
    assert after['line_break_suggestions'][after['items'][0]['_id']]['source_line_count'] == 3


@pytest.mark.parametrize('kind', ['labelplus', 'bt'])
def test_review_before_first_detection_keeps_reviewed_text_from_deferred_default(chapter, kind):
    store, project, detector, client = chapter
    import_with_defaults(chapter, kind)
    before = page_state(store, project, client)
    store.review_page(project['id'], project['pages'][0]['id'], before['revision'], True)
    did, _ = prepare_detection(store, project)
    detector.publish(project['id'], did, cleanup=False)
    after = page_state(store, project, client)
    assert after['items'] == before['items']
    assert after['revision'] == before['revision']


@pytest.mark.parametrize('kind', ['labelplus', 'bt'])
def test_manual_line_breaks_after_immediate_default_survive_rematch_and_redetection(chapter, kind):
    store, project, detector, client = chapter
    prepare_detection(store, project, published=True)
    import_with_defaults(chapter, kind)
    state = page_state(store, project, client)
    items = copy.deepcopy(state['items'])
    items[0]['text'] = state['items'][0]['text'].replace('\n', '')
    manual = store.save_page(project['id'], project['pages'][0]['id'], state['revision'],
                            items, 'manual-newline-choice')
    store.apply_matches(project['id'], store.read(project['id'])['revision'], {})
    assert page_state(store, project, client)['items'][0]['text'] == manual['items'][0]['text']
    did, _ = prepare_detection(store, project, source_counts=(4,))
    detector.publish(project['id'], did, cleanup=False)
    assert page_state(store, project, client)['items'][0]['text'] == manual['items'][0]['text']


@pytest.mark.parametrize('kind', ['labelplus', 'bt'])
def test_first_detection_without_exact_candidate_consumes_deferred_default(chapter, kind):
    store, project, detector, client = chapter
    text = '中华人民\n共和国'
    import_with_defaults(chapter, kind, text=text)
    did, _ = prepare_detection(store, project, source_counts=(2,))
    detector.publish(project['id'], did, cleanup=False)
    state = page_state(store, project, client)
    assert state['items'][0]['text'] == text
    assert [c['line_count'] for c in state['line_break_suggestions'][state['items'][0]['_id']]['candidates']] == [1]
    did, _ = prepare_detection(store, project, source_counts=(1,))
    detector.publish(project['id'], did, cleanup=False)
    state = page_state(store, project, client)
    assert state['items'][0]['text'] == text


@pytest.mark.parametrize('kind', ['labelplus', 'bt'])
def test_editing_one_pending_frame_allows_other_frame_to_receive_ctd_default(chapter, kind):
    store, project, detector, client = chapter
    if kind == 'labelplus':
        import_lp(store, project, client, coordinates=((.25, .5), (.75, .5)), apply_ctd_breaks=True)
    else:
        value = draft(duplicate=True)
        for item, x in zip(value['transMap']['1.png'], [.25, .75]):
            item['x'] = x
        import_json(store, project, client, value, apply_ctd_breaks=True)
    before = page_state(store, project, client)
    items = copy.deepcopy(before['items'])
    items[0]['text'] = '人工指定\n換行'
    store.save_page(project['id'], project['pages'][0]['id'], before['revision'], items, 'edit-one-frame')
    did, _ = prepare_detection(store, project, source_counts=(3, 3))
    detector.publish(project['id'], did, cleanup=False)
    state = page_state(store, project, client)
    assert state['items'][0]['text'] == items[0]['text']
    second = state['items'][1]
    suggestion = state['line_break_suggestions'][second['_id']]
    assert second['text'] == next(c['text'] for c in suggestion['candidates'] if c['line_count'] == 3)


def test_reimporting_meo_without_opt_in_replaces_old_lp_deferred_default(chapter):
    store, project, detector, client = chapter
    import_lp(store, project, client, apply_ctd_breaks=True)
    import_json(store, project, client, draft())
    before = page_state(store, project, client)
    did, _ = prepare_detection(store, project)
    detector.publish(project['id'], did, cleanup=False)
    after = page_state(store, project, client)
    assert after['items'] == before['items']
    assert after['items'][0]['text'] == TEXT
    assert len(after['line_break_suggestions']) == 1


def test_review_then_reopen_does_not_reinstate_pending_import_default(chapter):
    store, project, detector, client = chapter
    import_lp(store, project, client, apply_ctd_breaks=True)
    before = page_state(store, project, client)
    page_id = project['pages'][0]['id']
    store.review_page(project['id'], page_id, before['revision'], True)
    store.review_page(project['id'], page_id, before['revision'], False)
    did, _ = prepare_detection(store, project)
    detector.publish(project['id'], did, cleanup=False)
    assert page_state(store, project, client)['items'] == before['items']


def test_pending_defaults_survive_archive_import_until_first_detection(chapter):
    store, project, detector, client = chapter
    import_lp(store, project, client, apply_ctd_breaks=True)
    archive = store.export_archive(project['id'])
    try:
        restored = store.import_archive(archive.read_bytes(), 10_000_000)
    finally:
        archive.unlink()
    did, _ = prepare_detection(store, restored)
    detector.publish(restored['id'], did, cleanup=False)
    after = page_state(store, restored, client)
    assert after['items'][0]['text'] == exact_candidate(after)
    assert after['items'][0]['text'].count('\n') == 2
    assert page_state(store, project, client)['items'][0]['text'] == TEXT.replace('\r\n', '\n')


@pytest.mark.parametrize('kind', ['labelplus', 'bt'])
@pytest.mark.parametrize('apply_ctd_breaks', [None, False])
@pytest.mark.parametrize('detected_first', [False, True])
def test_declined_or_omitted_ctd_option_keeps_multiline_source_and_only_generates_candidates(
        chapter, kind, apply_ctd_breaks, detected_first):
    store, project, detector, client = chapter
    text = '因為今天下雨，\n\n所以我們決定明天出發。'
    if detected_first:
        prepare_detection(store, project, published=True)
    if kind == 'labelplus':
        import_lp(store, project, client, text=text, apply_ctd_breaks=apply_ctd_breaks)
    else:
        value = draft()
        value['transMap']['1.png'][0]['text'] = text
        import_json(store, project, client, value, apply_ctd_breaks=apply_ctd_breaks)
    before = page_state(store, project, client)
    assert before['items'][0]['text'] == text
    if not detected_first:
        assert not before['line_break_suggestions']
        did, _ = prepare_detection(store, project)
        detector.publish(project['id'], did, cleanup=False)
    after = page_state(store, project, client)
    assert after['items'][0]['text'] == text
    assert after['revision'] == before['revision']
    suggestion = after['line_break_suggestions'][after['items'][0]['_id']]
    assert suggestion['original_text'] == text
    assert [option['line_count'] for option in suggestion['candidates']] == [4, 3, 2]
    stored_page = store.read(project['id'])['pages'][0]
    state = json.loads((store.directory(project['id']) / stored_page['state']).read_bytes())
    assert not state.get('line_break_pending_ids')
    assert store.translation(project['id'])['transMap']['1.png'][0]['text'] == text


def test_version_three_particle_candidate_upgrades_without_changing_manual_text(chapter):
    store, project, detector, client = chapter
    prepare_detection(store, project, source_counts=(2,), published=True)
    value = draft()
    source = '這是我們的決定。'
    value['transMap']['1.png'][0]['text'] = source
    import_json(store, project, client, value)
    page = store.read(project['id'])['pages'][0]
    store.review_page(project['id'], page['id'], page['revision'], True)
    state_path = store.directory(project['id']) / page['state']
    old = json.loads(state_path.read_bytes())
    item_id = old['items'][0]['_id']
    old['items'][0]['text'] = '我已經\n人工修改過了'
    old['line_break_suggestions_version'] = 3
    old['line_break_suggestions'][item_id] = {
        'original_text': source, 'source_line_count': 2,
        'candidates': [{'line_count': 2, 'text': '這是我們\n的決定。'}],
    }
    atomic_json(state_path, old)
    before = disk_snapshot(store, project['id'])
    current = page_state(store, project, client)
    assert current['line_break_suggestions_version'] == LINE_BREAK_SUGGESTIONS_VERSION
    assert current['revision'] == old['revision']
    assert current['reviewed_revision'] == old['revision']
    assert current['items'] == old['items']
    suggestion = current['line_break_suggestions'][item_id]
    assert suggestion['original_text'] == source
    selected = next(option['text'] for option in suggestion['candidates'] if option['line_count'] == 2)
    assert selected != old['line_break_suggestions'][item_id]['candidates'][0]['text']
    assert not any(line.startswith('的') for line in selected.split('\n'))
    assert selected.replace('\n', '') == source
    assert disk_snapshot(store, project['id']) == before
