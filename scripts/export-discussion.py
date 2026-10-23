#!/usr/bin/env python3
"""Read a prelayout project.json or Meo.json and export discussion Markdown."""
import argparse
import copy
import json
from pathlib import Path
import sys

# The same renderer powers the installed web application's download endpoint.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from app.prelayout.discussion_export import render_discussion


def read_source(source):
    source = Path(source)
    data = json.loads(source.read_text(encoding='utf-8-sig'))
    if 'transMap' in data:
        return data, source.stem
    template = copy.deepcopy(data['template'])
    root = source.parent.resolve()
    pages = {}
    for page in data['pages']:
        relative = Path(page['state'])
        if relative.is_absolute():
            raise ValueError('頁面檔案必須使用工程資料夾內的相對路徑')
        state_path = (root / relative).resolve()
        if not state_path.is_relative_to(root):
            raise ValueError('頁面檔案必須位於工程資料夾內')
        state = json.loads(state_path.read_text(encoding='utf-8-sig'))
        pages[page['name']] = state['items']
    template['transMap'] = pages
    return template, data.get('name') or source.stem


def export_page(source, page_number=None, title=None, questions_project=None):
    data, name = read_source(source)
    if questions_project is not None:
        questions = json.loads(Path(questions_project).read_text(encoding='utf-8-sig'))
        questions = questions.get('template', questions)
        data['questionRecords'] = copy.deepcopy(questions.get('questionRecords', {'version': 0, 'records': []}))
    return render_discussion(data, title or name, page_number)


def export(source, title=None):
    return export_page(source, title=title)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--title')
    parser.add_argument('--page', type=int, help='只匯出指定頁的正文（從 1 開始）')
    parser.add_argument('--questions-project', type=Path,
                        help='兼容舊流程：從另一份 project.json 讀取疑問；正文仍只讀 source')
    args = parser.parse_args()
    if args.source.resolve() == args.output.resolve():
        parser.error('輸出不可覆蓋來源檔案')
    content = export_page(args.source, args.page, args.title, args.questions_project)
    with args.output.open('x', encoding='utf-8') as stream:
        stream.write(content)
    print(f'{args.output.resolve()}\n{len(content):,} 字元')


if __name__ == '__main__':
    main()
