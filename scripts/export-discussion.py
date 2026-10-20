#!/usr/bin/env python3
"""Read a prelayout project.json or Meo.json and export a discussion Markdown."""
import argparse
import json
import re
from datetime import datetime
from pathlib import Path


LAYOUT = {
    'x', 'y', 'rotation', 'orientation', 'font-size', 'color', 'stroke-color',
    'stroke-weight', 'xyxy_pixel', 'match_status', 'match_source_block_index',
    '_id', 'index', 'groupId', 'width', 'height', 'sha256', 'revision', 'id',
    'state', 'clean', 'clean_kind', 'name', 'original', 'mask', 'operations',
}
LABELS = {'text': 'Text', 'ocr': 'OCR', 'ocr_text': 'OCR', 'comment': '註解',
          'note': '註解', 'summary': '匯總'}


def block(value):
    """Use a safe fenced block to preserve exact whitespace and Markdown characters."""
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2)
    fence = '`' * max(3, max((len(s) for s in re.findall(r'`+', text)), default=0) + 1)
    return f'{fence}text\n{text}\n{fence}\n'


def fields(data, excluded=()):
    lines = []
    for key, value in data.items():
        if key in LAYOUT or key in excluded or value is None or value == '' or value == [] or value == {}:
            continue
        lines.extend([f'**{LABELS.get(key, key)}**', '', block(value)])
    return lines


def export_page(source, page_number=None, title=None, questions_project=None):
    """Compact export from the original translation JSON, without workbench data."""
    data = json.loads(source.read_text(encoding='utf-8-sig'))
    names = list(data['transMap'])
    if page_number is not None and not 1 <= page_number <= len(names):
        raise ValueError('頁數超出來源範圍')
    def literal(value):
        text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
        return text.replace('\r\n', '\n').replace('\r', '\n').replace('\n', r'\n')
    heading = (f'第 {page_number} 頁' if page_number else '全文討論稿')
    lines = [f'# {title or source.stem}｜{heading}', '', '請回答問題。', '']
    records = data.get('questionRecords', {}).get('records', [])
    if questions_project is not None:
        project = json.loads(questions_project.read_text(encoding='utf-8-sig'))
        records = project['template'].get('questionRecords', {}).get('records', [])
    if records:
        lines += ['## 疑問記錄', '']
        for n, record in enumerate(records, 1):
            lines += [f'{n}. 問題：{literal(record["note"])}', '', '   關聯文本：', '']
            for ref in record['texts']:
                lines += [f'   - 第 {ref["pageNumber"]} 頁｜{ref["pageName"]}｜'
                          f'文本 {ref["itemNumber"]}：{literal(ref["text"])}  ']
                source_info = ref.get('source', {})
                # Legacy records may have no source snapshot. Only enrich a reference
                # when its saved text still exactly identifies the current item.
                if not source_info:
                    candidates = data['transMap'].get(ref['pageName'], [])
                    position = ref['itemNumber'] - 1
                    if 0 <= position < len(candidates) and candidates[position].get('text') == ref['text']:
                        source_info = {k: v for k, v in candidates[position].items()
                                       if k not in LAYOUT and k != 'text'}
                reference_labels = {'ocr_text': '原文', 'baseball_term': '棒球術語註解',
                                    'term_explanation': '用語註解'}
                for key, value in source_info.items():
                    lines += [f'     {reference_labels.get(key, key)}：{literal(value)}  ']
                if 'pageSummary' in ref:
                    lines += [f'     本頁概括：{literal(ref["pageSummary"])}  ']
            lines += ['']
    labels = {'ocr_text': '原文', 'text': '譯文', 'baseball_term': '棒球術語註解',
              'term_explanation': '用語註解', 'note': '註解', 'comment': '註解'}
    for number, name in enumerate(names, 1):
        if page_number is not None and number != page_number:
            continue
        if page_number is None:
            lines += [f'## 第 {number} 頁', '']
        subsection = '##' if page_number else '###'
        summary = data.get('page_summary', {}).get(name)
        if summary:
            lines += [f'{subsection} 本頁概括', '', literal(summary), '']
        lines += [f'{subsection} 文本', '']
        for ordinal, item in enumerate(data['transMap'][name], 1):
            lines += [f'{ordinal}. 原文：{literal(item.get("ocr_text", ""))}  ',
                      f'   譯文：{literal(item.get("text", ""))}  ']
            for key, value in item.items():
                if key not in LAYOUT and key not in {'ocr_text', 'text'} and isinstance(value, str) and value:
                    lines += [f'   {labels.get(key, key)}：{literal(value)}  ']
            lines += ['']
    return '\n'.join(lines).rstrip() + '\n'


def export(source, title=None):
    data = json.loads(source.read_text(encoding='utf-8-sig'))
    if 'transMap' in data:
        return export_page(source, title=title)
    else:
        template = data['template']
        pages = []
        for page in data['pages']:
            state_path = (source.parent / page['state']).resolve()
            if not state_path.is_relative_to(source.parent.resolve()):
                raise ValueError('頁面檔案必須位於工程資料夾內')
            state = json.loads(state_path.read_text(encoding='utf-8-sig'))
            # Carry textual page/state metadata without assets or layout details.
            metadata = {**page, **{k: v for k, v in state.items() if k != 'items'}}
            pages.append((metadata, state['items']))
    name = title or data.get('name') or source.stem
    total = sum(len(items) for _, items in pages)
    lines = [f'# {name}｜全文討論稿', '', '請回答問題。', '',
             f'匯出時間：{datetime.now().astimezone().isoformat(timespec="seconds")}', '',
             f'共 {len(pages)} 頁，{total} 條文本。頁面與文本依來源順序，疑問引用依原選取順序。', '',
             '## 疑問記錄', '']
    records = template.get('questionRecords', {}).get('records', [])
    if not records:
        lines += ['（目前沒有疑問記錄。）', '']
    for index, record in enumerate(records, 1):
        lines += [f'### Q{index:03d}', '', block(record['note'])]
        for order, ref in enumerate(record['texts'], 1):
            lines += [f'{order}. 第 {ref["pageNumber"]} 頁｜{ref["pageName"]}｜'
                      f'文本 {ref["itemNumber"]}（記錄時內容）', '', block(ref['text'])]
    metadata = fields(template, {'version', 'transMap', 'groupList', 'questionRecords'})
    if metadata:
        lines += ['## 文件附註', ''] + metadata
    groups = template.get('groupList', [])
    lines += ['## 逐頁全文', '']
    for number, (page, items) in enumerate(pages, 1):
        lines += [f'### 第 {number} 頁｜{page["name"]}', '', f'本頁文本：{len(items)} 條。', '']
        page_info = fields(page)
        if page_info:
            lines += ['#### 頁面資訊', ''] + page_info
        for ordinal, item in enumerate(items, 1):
            lines += [f'#### {number:03d}-{ordinal:03d}｜原文本編號 {item.get("index", ordinal)}', '']
            gid = item.get('groupId')
            if type(gid) is int and 0 <= gid < len(groups):
                lines += [f'分組：{groups[gid].get("name", gid)}', '']
            lines += fields(item)
    return '\n'.join(lines).rstrip() + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--title')
    parser.add_argument('--page', type=int, help='只匯出原始 JSON 的指定頁（從 1 開始），使用精簡格式')
    parser.add_argument('--questions-project', type=Path,
                        help='從目前工程 project.json 讀取最新疑問，正文仍使用原始 JSON')
    args = parser.parse_args()
    if args.source.resolve() == args.output.resolve():
        parser.error('輸出不可覆蓋來源檔案')
    content = (export_page(args.source, args.page, args.title, args.questions_project)
               if args.page or args.questions_project
               else export(args.source, args.title))
    # Refuse accidental overwrites of an existing preview.
    with args.output.open('x', encoding='utf-8') as stream:
        stream.write(content)
    print(f'{args.output.resolve()}\n{len(content):,} 字元')


if __name__ == '__main__':
    main()
