import copy
import io
import json
from pathlib import Path
import subprocess
import sys
from urllib.parse import unquote

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image
import pytest

from app.prelayout.api import router
from app.prelayout.discussion_export import render_discussion
from app.prelayout.store import PrelayoutStore


def snapshot():
    return {
        'version': 1, 'comment': '文件備註\n請留意術語',
        'groupList': [{'name': '不應輸出組別', 'font': 'HiddenFont'}],
        'page_summary': {'8.jpg': {'summary': '本頁概括內容', 'note': ['概括註釋']}},
        # Deliberately retain insertion order instead of alphabetical page order.
        'transMap': {'8.jpg': [
            {'index': 1, 'text': '第一條\n譯文', 'ocr_text': '最初の原文\n続き',
             'ocr': 'OCR 備選', 'note': '逐條註解', 'comment': '補充註解',
             'baseball_term': '棒球詞', 'term_explanation': '詞義',
             'notes': {'meaning': ['結構化註釋', '第二義']},
             'font': 'HiddenFont', 'font-size': 33, 'groupId': 0, 'text_has_stroke': True,
             'x': .5, 'y': .5, 'confidence': .9, 'ocr_confidence': .8,
             'match_status': 'matched', 'bbox': [1, 2, 3, 4]},
            {'text': '第二條譯文', 'ocr_text': '二番の原文', 'x': .5, 'y': .5},
        ], '2.jpg': [{'text': '後一頁譯文', 'x': .5, 'y': .5}]},
    }


def reference(page, number, ordinal, item, source=None):
    result = {'key': f'{page["id"]}-{ordinal}', 'pageId': page['id'], 'pageNumber': number,
              'pageName': page['name'], 'itemId': item['_id'], 'itemNumber': ordinal,
              'text': item['text']}
    if source is not None:
        result['source'] = source
    return result


@pytest.fixture
def chapter(tmp_path):
    stream = io.BytesIO()
    Image.new('RGB', (20, 20), 'white').save(stream, 'PNG')
    store = PrelayoutStore(tmp_path / 'prelayout')
    project = store.create('中文項目', [('8.jpg', stream.getvalue()), ('2.jpg', stream.getvalue())])
    store.import_translation(project['id'], json.dumps(snapshot()).encode(), 'bt', 0, True)
    project = store.read(project['id'])
    page = next(page for page in project['pages'] if page['name'] == '8.jpg')
    number = project['pages'].index(page) + 1
    items = store.page(project['id'], page['id'])['items']
    record = {'id': 'q-1', 'note': '問題第一行\n問題第二行',
              'texts': [reference(page, number, 2, items[1]), reference(page, number, 1, items[0])],
              'createdAt': '2026-10-20T10:00:00+08:00', 'updatedAt': '2026-10-20T10:00:00+08:00'}
    store.save_question_records(project['id'], 0, [record])
    return store, project['id'], record


def test_full_text_metadata_and_compact_layout():
    data = snapshot()
    original = copy.deepcopy(data)
    result = render_discussion(data, '中文項目')
    assert result.startswith('# 中文項目｜疑問記錄\n\n請回答問題。')
    assert '（目前沒有疑問記錄。）' in result
    assert result.index('## 疑問記錄') < result.index('## 文件附註') < result.index('## 逐頁全文')
    assert '文件備註\\n請留意術語' in result
    assert result.index('最初の原文') < result.index('第一條\\n譯文') < result.index('二番の原文')
    for text in ('OCR：OCR 備選', '註解：逐條註解', '註解：補充註解', '棒球術語註解：棒球詞',
                 '用語註解：詞義', '結構化註釋', '本頁概括內容', '概括註釋'):
        assert text in result
    assert result.count('本頁概括內容') == 1
    for text in ('HiddenFont', 'font', 'confidence', 'match', 'bbox', 'group', 'text_has_stroke', '不應輸出組別', '```', '｜8.jpg'):
        assert text not in result
    assert '1. 原文：最初の原文\\n続き' in result
    assert '2. 原文：二番の原文' in result
    assert result.index('### 第 1 頁') < result.index('### 第 2 頁')
    assert data == original


def test_saved_question_order_latest_revision_and_read_only(chapter):
    store, pid, record = chapter
    record['note'] = '最新問題\n第二行'
    store.save_question_records(pid, 1, [record])
    before = {path: path.read_bytes() for path in store.directory(pid).rglob('*') if path.is_file()}
    translation = store.translation(pid)
    filename, result = store.discussion(pid)
    assert filename == '中文項目_疑問記錄.md'
    question = result.split('## 逐頁全文')[0]
    assert '1. 問題：最新問題\\n第二行' in question
    assert question.index('文本 2：第二條譯文') < question.index('文本 1：第一條\\n譯文')
    assert '原文：二番の原文' in question and '原文：最初の原文\\n続き' in question
    assert store.translation(pid) == translation
    assert before == {path: path.read_bytes() for path in store.directory(pid).rglob('*') if path.is_file()}


def test_reference_snapshot_never_uses_changed_live_text():
    data = snapshot()
    ref = {'pageNumber': 1, 'pageName': '8.jpg', 'itemNumber': 1, 'text': '舊譯文',
           'source': {'ocr_text': '舊原文', 'font': 'HiddenFont', 'note': {'註解': '舊註釋'}},
           'pageSummary': '舊概括'}
    data['questionRecords'] = {'records': [{'note': '核對', 'texts': [ref]}]}
    question = render_discussion(data, '測試').split('## 文件附註')[0]
    assert '文本 1：舊譯文' in question and '原文：舊原文' in question and '舊註釋' in question
    assert '記錄時本頁概括：舊概括' in question
    assert '最初の原文' not in question and '第一條' not in question and 'HiddenFont' not in question
    ref.pop('source')
    ref.pop('pageSummary')
    question = render_discussion(data, '測試').split('## 文件附註')[0]
    assert '原文：' not in question and '本頁概括' not in question


def test_legacy_reference_enrichment_requires_exact_page_number_and_text():
    data = snapshot()
    ref = {'pageNumber': 1, 'pageName': '8.jpg', 'itemNumber': 1, 'text': '第一條\n譯文'}
    data['questionRecords'] = {'records': [{'note': '核對', 'texts': [ref]}]}
    question = lambda: render_discussion(data, '測試').split('## 文件附註')[0]
    assert '原文：最初の原文' in question()
    ref['pageNumber'] = 2
    assert '原文：' not in question()
    ref['pageNumber'] = 1
    ref['source'] = {}
    assert '原文：' not in question()


def test_missing_fields_are_not_invented_and_markup_is_escaped():
    result = render_discussion({'transMap': {'1.jpg': [{'text': '<script>x</script>\n# heading *bold*'}]}}, '# title')
    assert '原文：' not in result and '本頁概括' not in result and '註解：' not in result
    assert '<script>' not in result and '&lt;script&gt;' in result
    assert r'\n\# heading \*bold\*' in result and r'# \# title' in result


@pytest.mark.parametrize('number', [0, -1, 3, True])
def test_page_out_of_range(number):
    with pytest.raises(ValueError, match='頁數超出'):
        render_discussion(snapshot(), '測試', number)


def test_single_page_keeps_questions_first():
    result = render_discussion(snapshot(), '測試', 2)
    assert '### 第 1 頁' not in result and '### 第 2 頁' in result
    assert '後一頁譯文' in result and '二番の原文' not in result


def test_same_page_question_summary_is_not_repeated():
    data = snapshot()
    references = [{'pageNumber': 1, 'pageName': '8.jpg', 'itemNumber': ordinal,
                   'text': item['text'], 'pageSummary': '相同的記錄概括'}
                  for ordinal, item in enumerate(data['transMap']['8.jpg'], 1)]
    data['questionRecords'] = {'records': [{'note': '核對', 'texts': references}]}
    assert render_discussion(data, '測試').count('相同的記錄概括') == 1
    references[1]['pageSummary'] = '另一個記錄時刻的概括'
    result = render_discussion(data, '測試')
    assert '相同的記錄概括' in result and '另一個記錄時刻的概括' in result


def test_endpoint_attachment_utf8_filename_and_not_found(chapter):
    store, pid, _ = chapter
    app = FastAPI()
    app.include_router(router(store, object(), 1000000))
    with TestClient(app) as client:
        response = client.get(f'/api/prelayout/projects/{pid}/export/discussion')
        assert response.status_code == 200
        assert response.headers['content-type'] == 'text/markdown; charset=utf-8'
        assert response.headers['cache-control'] == 'no-store'
        assert response.headers['content-disposition'].startswith('attachment;')
        assert unquote(response.headers['content-disposition'].split("filename*=UTF-8''")[1]) == '中文項目_疑問記錄.md'
        assert '請回答問題。' in response.content.decode('utf-8')
        assert client.get('/api/prelayout/projects/pl_' + 'f' * 32 + '/export/discussion').status_code == 404
        meo = client.get(f'/api/prelayout/projects/{pid}/export/bt')
        assert meo.headers['content-type'] == 'application/json'
        assert meo.json() == store.translation(pid)


def test_filename_removes_paths_and_control_characters(chapter):
    store, pid, _ = chapter
    project = store.read(pid)
    project['name'] = '../中文/\\項目\r\n'
    store.write(project)
    filename, _ = store.discussion(pid)
    assert '/' not in filename and '\\' not in filename and '\r' not in filename and '\n' not in filename


def test_cli_uses_same_renderer_for_project_and_json(chapter, tmp_path):
    store, pid, _ = chapter
    script = Path(__file__).resolve().parents[2] / 'scripts' / 'export-discussion.py'
    source = tmp_path / 'Meo.json'
    source.write_text(json.dumps(store.translation(pid)), encoding='utf-8')
    for name, path in [('meo', source), ('project', store.directory(pid) / 'project.json')]:
        output = tmp_path / f'{name}.md'
        result = subprocess.run([sys.executable, str(script), str(path), str(output), '--title', '中文項目'],
                                capture_output=True, text=True)
        assert result.returncode == 0, result.stderr
        assert output.read_text(encoding='utf-8') == store.discussion(pid)[1]
        assert subprocess.run([sys.executable, str(script), str(path), str(output)], capture_output=True).returncode != 0
    output = tmp_path / 'invalid.md'
    assert subprocess.run([sys.executable, str(script), str(source), str(output), '--page', '0'], capture_output=True).returncode != 0
    assert not output.exists()


def test_cli_project_rejects_escaping_state_path(tmp_path):
    source = tmp_path / 'project.json'
    source.write_text(json.dumps({'template': {}, 'pages': [{'name': '1.jpg', 'state': '../outside.json'}]}))
    script = Path(__file__).resolve().parents[2] / 'scripts' / 'export-discussion.py'
    result = subprocess.run([sys.executable, str(script), str(source), str(tmp_path / 'no.md')], capture_output=True)
    assert result.returncode != 0 and '工程資料夾' in result.stderr.decode('utf-8')


def test_cli_legacy_question_override_and_page_filter(tmp_path):
    source = tmp_path / 'Meo.json'
    source.write_text(json.dumps(snapshot()), encoding='utf-8')
    questions = tmp_path / 'questions.json'
    records = {'records': [{'note': '相容參數的最新問題', 'texts': [
        {'pageNumber': 1, 'pageName': '8.jpg', 'itemNumber': 2, 'text': '歷史引用'}]}]}
    questions.write_text(json.dumps({'template': {'questionRecords': records}}), encoding='utf-8')
    output = tmp_path / 'result.md'
    script = Path(__file__).resolve().parents[2] / 'scripts' / 'export-discussion.py'
    result = subprocess.run([sys.executable, str(script), str(source), str(output), '--page', '2',
                             '--questions-project', str(questions)], capture_output=True)
    assert result.returncode == 0, result.stderr
    content = output.read_text(encoding='utf-8')
    assert '相容參數的最新問題' in content and '歷史引用' in content
    assert '後一頁譯文' in content and '最初の原文' not in content


def test_legacy_document_placeholder_is_not_a_text_annotation():
    data = {'comment': ' 備註備註備註 ', 'transMap': {'1.jpg': [
        {'text': '譯文', 'ocr_text': '原文', 'comment': '逐條真正註解',
         'baseball_term': '棒球註釋', 'term_explanation': '解釋'}]}}
    before = copy.deepcopy(data)
    result = render_discussion(data, '測試')
    assert '備註備註備註' not in result and '## 文件附註' not in result
    assert '逐條真正註解' in result and '棒球註釋' in result and '解釋' in result
    assert data == before
    data['comment'] = '真正的文件備註'
    assert '真正的文件備註' in render_discussion(data, '測試')


def test_legacy_jpg_summaries_follow_unique_png_page_stem():
    data = {'page_summary': {'001.JPG': '跨格式概括'},
            'transMap': {'001.png': [{'text': '譯文', 'ocr_text': '原文'}]},
            'questionRecords': {'records': [{'note': '問題', 'texts': [
                {'pageNumber': 1, 'pageName': '001.png', 'itemNumber': 1, 'text': '譯文'}]}]}}
    before = copy.deepcopy(data)
    result = render_discussion(data, '測試')
    assert result.count('跨格式概括') == 2
    assert data == before
    data['page_summary']['001.png'] = '精確檔名優先'
    result = render_discussion(data, '測試')
    assert result.count('精確檔名優先') == 2
    assert '跨格式概括' not in result.split('## 未對應頁面的介紹')[0]
    data['page_summary']['001.png'] = None
    assert '跨格式概括' not in render_discussion(data, '測試').split('## 未對應頁面的介紹')[0]
    data['page_summary'] = {'001.jpg': '第一個概括', '001.jpeg': '第二個概括'}
    result = render_discussion(data, '測試')
    assert '記錄時本頁概括' not in result and '#### 本頁概括' not in result
    assert '未對應頁面的介紹' in result and '第一個概括' in result and '第二個概括' in result


def test_orphan_summaries_are_preserved_without_inventing_page_numbers():
    data = {'page_summary': {'001.jpg': '可對應概括', 'old-chapter-61_000.jpg': '不可對應的原始介紹'},
            'transMap': {'001.png': [{'text': '譯文'}], '002.png': []}}
    before = copy.deepcopy(data)
    result = render_discussion(data, '測試')
    assert result.count('可對應概括') == result.count('不可對應的原始介紹') == 1
    page_two = result.split('### 第 2 頁')[1].split('## 未對應頁面的介紹')[0]
    assert '不可對應的原始介紹' not in page_two
    assert '來源頁面：old-chapter-61' in result
    assert data == before


def test_direct_legacy_meo_records_are_chronological_and_undated_slots_stay_fixed():
    data = snapshot()
    texts = [{'pageNumber': 1, 'pageName': '8.jpg', 'itemNumber': ordinal,
              'text': data['transMap']['8.jpg'][ordinal - 1]['text']} for ordinal in (2, 1)]
    records = [
        {'note': '最新問題', 'texts': texts, 'createdAt': '2026-10-20T11:00:00Z'},
        {'note': '無時間問題', 'texts': texts},
        {'note': '同時問題甲', 'texts': texts, 'createdAt': '2026-10-20T10:00:00Z'},
        {'note': '無效時間問題', 'texts': texts, 'createdAt': 'invalid'},
        {'note': '最舊問題', 'texts': texts, 'createdAt': '2026-10-20T12:00:00+08:00',
         'updatedAt': '2026-10-23T10:00:00Z'},
        {'note': '同時問題乙', 'texts': texts, 'createdAt': '2026-10-20T11:00:00+01:00'},
    ]
    data['questionRecords'] = {'version': 8, 'records': records}
    before = copy.deepcopy(data)
    result = render_discussion(data, '測試')
    question = result.split('## 文件附註')[0]
    for number, note in enumerate(['最舊問題', '無時間問題', '同時問題甲', '無效時間問題', '同時問題乙', '最新問題'], 1):
        assert f'{number}. 問題：{note}' in question
    assert question.index('文本 2：第二條譯文') < question.index(r'文本 1：第一條\n譯文')
    assert data == before


def test_legacy_reversed_questions_export_identically_from_store_and_standalone_cli(chapter, tmp_path):
    store, pid, record = chapter
    oldest = {**record, 'id': 'oldest', 'note': '最先建立', 'createdAt': '2026-10-18T10:00:00Z',
              'updatedAt': '2026-10-23T10:00:00Z'}
    newest = {**record, 'id': 'newest', 'note': '最後建立', 'createdAt': '2026-10-22T10:00:00Z'}
    project = store.read(pid)
    project['template']['questionRecords'] = {'version': 3, 'records': [newest, oldest]}
    store.write(project)
    before = {path: path.read_bytes() for path in store.directory(pid).rglob('*') if path.is_file()}
    expected = store.discussion(pid)[1]
    assert expected.index('1. 問題：最先建立') < expected.index('2. 問題：最後建立')
    # Feed the CLI a deliberately old, reversed Meo, independent of store.translation sorting.
    legacy = store.translation(pid)
    legacy['questionRecords']['records'] = [newest, oldest]
    source = tmp_path / 'Meo.json'
    source.write_text(json.dumps(legacy), encoding='utf-8')
    source_before = source.read_bytes()
    script = Path(__file__).resolve().parents[2] / 'scripts' / 'export-discussion.py'
    for index, path in enumerate((source, store.directory(pid) / 'project.json')):
        output = tmp_path / f'ordered-{index}.md'
        result = subprocess.run([sys.executable, str(script), str(path), str(output), '--title', '中文項目'], capture_output=True)
        assert result.returncode == 0, result.stderr
        assert output.read_text(encoding='utf-8') == expected
    assert source.read_bytes() == source_before
    assert before == {path: path.read_bytes() for path in store.directory(pid).rglob('*') if path.is_file()}
