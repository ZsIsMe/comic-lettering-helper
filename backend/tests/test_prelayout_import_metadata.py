import io
import json

import pytest
from PIL import Image

from app.prelayout.store import PrelayoutStore, atomic_json


@pytest.fixture
def chapter(tmp_path):
    image = io.BytesIO()
    Image.new('RGB', (100, 100), 'white').save(image, 'PNG')
    store = PrelayoutStore(tmp_path / 'prelayout')
    project = store.create('metadata', [('1.png', image.getvalue()), ('2.png', image.getvalue())])
    return store, project['id']


def source():
    return {
        'version': [1, 0], 'comment': '整體備註', 'groupList': [{'name': '原始分組', 'custom': 1}],
        'page_summary': {'1.jpg': '本頁概括', '2.png': {'text': '第二頁', 'extra': ['原有資訊']}},
        'custom': {'keep': 1, 'nested': {'old': 2, 'replace': 3}},
        'custom_page_map': {'1.jpg': '不是已知頁面概括，鍵名不變'},
        'transMap': {'1.jpg': [{
            'index': 1, 'text': '原有譯文', 'ocr_text': '日本語原文',
            'baseball_term': '術語', 'term_explanation': '說明',
            'extra': {'nested': {'keep': 1, 'replace': 2}},
            'groupId': 0, 'x': .2, 'y': .3, 'rotation': 45, 'font-size': 70,
            'xyxy_pixel': [1, 2, 10, 20], 'orientation': 'horizontal',
            'color': '#123456', 'stroke-color': '#123456', 'stroke-weight': 4,
            'font_size': 71, 'max_break': 5, 'text-direction': 'horizontal',
            'bbox': [1, 2, 10, 20], 'center_normalized': [.2, .3],
            'match_status': 'manual', 'match_source_block_index': 7, 'need_inpaint': True,
        }]},
    }


def import_json(store, pid, value, apply=True):
    return store.import_translation(pid, json.dumps(value, ensure_ascii=False).encode(), 'bt',
                                    store.read(pid)['revision'], apply)


def import_txt(store, pid, labels='----------------[1]----------------[0.7,0.8,1]\n新TXT譯文\n', apply=True):
    raw = f'1, 0\n-\nTXT分組\n-\nTXT備註\n>>>>>>>>[1.jpg]<<<<<<<<\n{labels}'.encode()
    return store.import_translation(pid, raw, 'labelplus', store.read(pid)['revision'], apply)


def disk_snapshot(store, pid):
    root = store.directory(pid)
    return {str(path.relative_to(root)): path.read_bytes() for path in root.rglob('*') if path.is_file()}


def test_first_import_unknown_information_survives_save_and_export(chapter):
    store, pid = chapter
    import_json(store, pid, source())
    data = store.translation(pid)
    assert data['page_summary'] == {'1.png': '本頁概括', '2.png': {'text': '第二頁', 'extra': ['原有資訊']}}
    assert data['custom_page_map'] == source()['custom_page_map']
    assert data['custom'] == source()['custom']
    original_item = source()['transMap']['1.jpg'][0]
    assert data['transMap']['1.png'][0] == original_item
    page = store.read(pid)['pages'][0]
    items = store.page(pid, page['id'])['items']
    items[0].update(text='修改後譯文', x=.9)
    store.save_page(pid, page['id'], page['revision'], items, 'edit-with-metadata')
    exported = store.translation(pid)['transMap']['1.png'][0]
    assert exported == {**original_item, 'text': '修改後譯文', 'x': .9}
    assert '_id' not in exported


@pytest.mark.parametrize('kind', ['bt', 'labelplus'])
def test_first_minimal_import_does_not_invent_source_information(chapter, kind):
    store, pid = chapter
    if kind == 'bt':
        import_json(store, pid, {'transMap': {'1.png': [{'index': 1, 'text': '只有譯文'}]}})
    else:
        import_txt(store, pid)
    exported = store.translation(pid)
    assert 'page_summary' not in exported
    item = exported['transMap']['1.png'][0]
    assert not {'ocr_text', 'baseball_term', 'term_explanation', 'extra'} & item.keys()


def test_reimport_minimal_json_and_txt_keep_metadata_without_restoring_layout(chapter):
    store, pid = chapter
    import_json(store, pid, source())
    first_id = store.page(pid, store.read(pid)['pages'][0]['id'])['items'][0]['_id']
    compact = {'transMap': {'1.png': [{'index': 1, 'text': '精簡譯文'}]}}
    before = disk_snapshot(store, pid)
    preview = import_json(store, pid, compact, False)
    assert preview['groups'] == source()['groupList']
    assert disk_snapshot(store, pid) == before
    for _ in range(2):
        import_json(store, pid, compact)
        data = store.translation(pid)
        item = data['transMap']['1.png'][0]
        assert item['ocr_text'] == '日本語原文'
        assert item['baseball_term'] == '術語'
        assert item['term_explanation'] == '說明'
        assert item['extra'] == source()['transMap']['1.jpg'][0]['extra']
        assert item['text'] == '精簡譯文'
        assert item['x'] == item['y'] == .5
        assert item['font-size'] == 40 and item['rotation'] == 0
        assert item['orientation'] == 'vertical' and item['color'] == '#000000'
        assert item['stroke-color'] == '#FFFFFF' and item['stroke-weight'] == 0
        assert not {'groupId', 'xyxy_pixel', 'match_status', 'match_source_block_index', 'need_inpaint',
                    'font_size', 'max_break', 'text-direction', 'bbox', 'center_normalized'} & item.keys()
        assert store.page(pid, store.read(pid)['pages'][0]['id'])['items'][0]['_id'] != first_id
    before = disk_snapshot(store, pid)
    preview = import_txt(store, pid, apply=False)
    assert preview['groups'][0]['name'] == 'TXT分組'
    assert disk_snapshot(store, pid) == before
    import_txt(store, pid)
    data = store.translation(pid)
    assert data['transMap']['1.png'][0]['ocr_text'] == '日本語原文'
    assert data['transMap']['1.png'][0]['text'] == '新TXT譯文'
    assert data['page_summary']['1.png'] == '本頁概括'
    assert data['custom'] == source()['custom']
    assert data['comment'] == 'TXT備註'
    assert data['groupList'][0]['name'] == 'TXT分組'


def test_partial_nested_information_and_explicit_clear_have_priority(chapter):
    store, pid = chapter
    import_json(store, pid, source())
    import_json(store, pid, {
        'custom': {'nested': {'replace': 9}},
        'page_summary': {'1.jpg': '', '2.jpg': {'text': '新概括'}},
        'transMap': {'1.jpg': [{'index': 1, 'text': '修改', 'extra': {'nested': {'replace': 8}}}]},
    })
    data = store.translation(pid)
    assert data['custom'] == {'keep': 1, 'nested': {'old': 2, 'replace': 9}}
    assert data['page_summary'] == {'1.png': '', '2.png': {'text': '新概括', 'extra': ['原有資訊']}}
    assert data['transMap']['1.png'][0]['extra'] == {'nested': {'keep': 1, 'replace': 8}}
    import_json(store, pid, {
        'custom': {}, 'custom_page_map': None, 'page_summary': {}, 'comment': '', 'groupList': [],
        'transMap': {'1.png': [{'index': 1, 'text': '', 'ocr_text': None,
                               'baseball_term': '', 'term_explanation': [], 'extra': {}}]},
    })
    data = store.translation(pid)
    assert data['custom'] == {} and data['custom_page_map'] is None
    assert data['page_summary'] == {} and data['comment'] == '' and data['groupList'] == []
    item = data['transMap']['1.png'][0]
    assert item['text'] == '' and item['ocr_text'] is None
    assert item['baseball_term'] == '' and item['term_explanation'] == [] and item['extra'] == {}


@pytest.mark.parametrize('items', [
    [{'index': 2, 'text': '不同編號'}],
    [{'text': '缺編號'}],
    [{'index': 1, 'text': '重複一'}, {'index': 1, 'text': '重複二'}],
    [{'index': True, 'text': '布林值'}],
])
def test_only_explicit_unique_original_indices_inherit_information(chapter, items):
    store, pid = chapter
    import_json(store, pid, source())
    import_json(store, pid, {'transMap': {'1.png': items}})
    assert all('ocr_text' not in item for item in store.translation(pid)['transMap']['1.png'])


def test_generated_index_is_not_used_for_inheritance(chapter):
    store, pid = chapter
    value = source()
    value['transMap']['1.jpg'][0]['index'] = 3
    import_json(store, pid, value)
    import_json(store, pid, {'transMap': {'1.png': [{'index': 2, 'text': '二'}, {'text': '會補為三'}]}})
    items = store.translation(pid)['transMap']['1.png']
    assert items[1]['index'] == 3 and 'ocr_text' not in items[1]


def test_other_pages_and_unknown_images_do_not_borrow_information(chapter):
    store, pid = chapter
    import_json(store, pid, source())
    before = disk_snapshot(store, pid)
    for apply in (False, True):
        with pytest.raises(ValueError, match='原圖'):
            import_json(store, pid, {'transMap': {'missing.png': [{'index': 1, 'text': '不匹配'}]}}, apply)
        assert disk_snapshot(store, pid) == before
    import_json(store, pid, {'transMap': {'2.jpg': [{'index': 1, 'text': '不同頁'}]}})
    data = store.translation(pid)
    assert 'ocr_text' not in data['transMap']['2.png'][0]
    assert data['transMap']['1.png'][0]['ocr_text'] == '日本語原文'


@pytest.mark.parametrize('labels', [
    '----------------[7]----------------[0.5,0.5,1]\n非連號\n',
    '----------------[1]----------------[0.5,0.5,1]\n一\n----------------[1]----------------[0.5,0.5,1]\n二\n',
])
def test_labelplus_nonsequential_or_duplicate_source_labels_do_not_guess(chapter, labels):
    store, pid = chapter
    import_json(store, pid, source())
    import_txt(store, pid, labels)
    assert all('ocr_text' not in item for item in store.translation(pid)['transMap']['1.png'])


def test_ambiguous_existing_index_does_not_inherit_information(chapter):
    store, pid = chapter
    import_json(store, pid, source())
    page = store.read(pid)['pages'][0]
    path = store.directory(pid) / page['state']
    state = json.loads(path.read_text())
    state['items'].append({**state['items'][0], '_id': 't_' + '0' * 32})
    atomic_json(path, state)
    import_json(store, pid, {'transMap': {'1.png': [{'index': 1, 'text': '不猜測'}]}})
    assert 'ocr_text' not in store.translation(pid)['transMap']['1.png'][0]
