#!/usr/bin/env python3
"""Prepare a serial prelayout batch; only --execute permits API/OCR operations.

Use .venv/bin/python. Images/OCR use the existing importer, followed by a BT
import without matching. Keep the same state directory when resuming. An
uncertain write stops the batch; only an applied JSON import can be recovered
by read-only revision and content verification.
"""
from __future__ import annotations

import argparse
import copy
import fcntl
import importlib.util
import json
from pathlib import Path
import re
import sys

SPEC = importlib.util.spec_from_file_location('prelayout_batch_importer', Path(__file__).with_name('import_prelayout.py'))
importer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(importer)
from app.prelayout.question_records import rebind_imported_records  # noqa: E402

Error = importer.ImportErrorSafe


class NoMatchAPI:
    """Fail closed before any matching request reaches the transport."""

    def __init__(self, api):
        self.api = api

    def request(self, method, path, **kwargs):
        if 'matches' in path.split('?', 1)[0].split('/'):
            raise Error(f'此批次禁止匹配：{method} {path}')
        return self.api.request(method, path, **kwargs)


def load(path):
    return json.loads(path.read_text())


def positive(value):
    result = int(value)
    if result <= 0:
        raise argparse.ArgumentTypeError('必須大於 0')
    return result


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument('--manifest', required=True, type=Path)
    result.add_argument('--state-dir', required=True, type=Path)
    result.add_argument('--execute', action='store_true', help='明確啟用串行 API 匯入及 OCR；預設僅本機驗證')
    result.add_argument('--limit', type=positive, help='僅選取清單前 N 話')
    result.add_argument('--base-url', default='http://127.0.0.1:6008')
    result.add_argument('--request-timeout', type=float, default=60)
    result.add_argument('--detection-timeout', type=float, default=3600)
    return result


def jobs_from(args):
    manifest = load(args.manifest.expanduser().resolve())
    if not isinstance(manifest, dict) or manifest.get('version') != 1 or not isinstance(manifest.get('jobs'), list):
        raise Error('manifest 須為 version=1 並包含 jobs 清單')
    jobs, keys, titles = [], set(), set()
    for job in manifest['jobs']:
        if not isinstance(job, dict) or not {'key', 'title', 'image_dir', 'translation', 'expected_pages', 'expected_items'} <= job.keys():
            raise Error('job 欄位不完整')
        key, title = job['key'], job['title']
        if not isinstance(key, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,99}', key):
            raise Error(f'job key 無效：{key!r}')
        if not isinstance(title, str) or not title.strip() or title != title.strip() or len(title) > 80:
            raise Error(f'job title 無效：{title!r}')
        if key in keys or title in titles:
            raise Error(f'job key／title 重複：{key}/{title}')
        keys.add(key); titles.add(title)
        for field in ('image_dir', 'translation'):
            if not isinstance(job[field], str) or not Path(job[field]).is_absolute():
                raise Error(f'{key}/{field} 必須為絕對路徑')
        if Path(job['translation']).suffix.lower() != '.json':
            raise Error(f'{key} 只接受 BT JSON 譯稿')
        for field, minimum in (('expected_pages', 1), ('expected_items', 0)):
            if type(job[field]) is not int or job[field] < minimum:
                raise Error(f'{key}/{field} 無效')
        jobs.append(job)
    if not jobs:
        raise Error('manifest 沒有 jobs')
    return jobs[:args.limit] if args.limit else jobs


def import_args(args, job, state_dir, *, translation=True):
    return argparse.Namespace(image_dir=job['image_dir'], name=job['title'],
                              translation=job['translation'] if translation else None,
                              base_url=args.base_url, request_timeout=args.request_timeout,
                              detection_timeout=args.detection_timeout, check_only=False,
                              state_file=str(state_dir / 'images.json'))


def preflight(args, job, state_dir):
    prepared = importer.prepare(import_args(args, job, state_dir))
    names = [source['name'] for source in prepared['sources']]
    count = sum(map(len, prepared['mapping'].values()))
    if ('translation_sha256' in job
            and job['translation_sha256'] != prepared['manifest']['translation_sha256']):
        raise Error(f'{job["key"]} translation_sha256 與清單不一致')
    if 'images' in job:
        pins = job['images']
        if (not isinstance(pins, list) or any(not isinstance(pin, dict) for pin in pins)
                or len(pins) != len(names) or {pin.get('name') for pin in pins} != set(names)):
            raise Error(f'{job["key"]} 圖片清單與實際頁名不一致')
        by_name = {pin['name']: pin for pin in pins}
        for source in prepared['sources']:
            pin = by_name[source['name']]
            if (pin.get('sha256') != source['sha256'] or pin.get('bytes') != len(source['payload'])
                    or not isinstance(pin.get('source'), str)
                    or Path(pin['source']).expanduser().resolve() != (Path(job['image_dir']) / source['name']).resolve()):
                raise Error(f'{job["key"]}/{source["name"]} 圖片 hash／bytes／來源與清單不一致')
    if (prepared['missing_translation_pages'] or set(prepared['mapping']) != set(names)
            or len(names) != job['expected_pages'] or count != job['expected_items']):
        raise Error(f'{job["key"]} 圖片／JSON 頁面或條數不齊：'
                    f'pages={len(names)}/{job["expected_pages"]}, items={count}/{job["expected_items"]}, '
                    f'missing={prepared["missing_translation_pages"]}')
    # Reject source fields which the store would silently normalize on import.
    for source in prepared['sources']:
        original = prepared['mapping'][source['name']]
        normalized = importer.validate_items(original, source['width'], source['height'])
        for before, after in zip(original, normalized):
            if any(key != '_id' and after.get(key) != value for key, value in before.items()):
                raise Error(f'{job["key"]}/{source["name"]} 含會被匯入器改寫的欄位')
    record = {'version': 1, 'job': job, 'fingerprint': prepared['fingerprint'], 'manifest': prepared['manifest']}
    path = state_dir / 'source.json'
    if path.exists() and load(path) != record:
        raise Error(f'來源檔案或 job 已變更；停止以保留既有項目：{path}')
    if not path.exists():
        importer.atomic_state(path, record)
    return prepared


def verify_json(exported, prepared, project):
    """Verify every supplied field, allowing only generated internal IDs."""
    importer.verify_export(exported, prepared)
    for name, wanted in prepared['mapping'].items():
        for before, after in zip(wanted, exported['transMap'][name]):
            for key, value in before.items():
                if key != '_id' and (key not in after or after[key] != value):
                    raise Error(f'BT 匯出原稿欄位不一致：{name}/{key}')
    expected = importer.merge_template({}, prepared['translation'], project['pages'])
    if 'questionRecords' in expected:
        questions = importer.validate_question_records(expected['questionRecords'])
        mapping = {page['id']: [{**item, '_id': f'ordinal-{i}'} for i, item in enumerate(prepared['mapping'][page['name']])]
                   for page in project['pages']}
        records = rebind_imported_records(questions['records'], project['pages'], mapping)
        version = questions['version'] + 1 if records else 0

        def semantic(value):
            value = copy.deepcopy(value)
            for record in value:
                for text in record['texts']:
                    for key in ('key', 'pageId', 'itemId'):
                        text.pop(key, None)
            return value

        actual = importer.validate_question_records(exported.get('questionRecords'))
        if actual['version'] != version or semantic(actual['records']) != semantic(records):
            raise Error('BT 匯出 questionRecords 內容不一致')


def current(api, prefix, prepared, state, revision):
    project = api.request('GET', prefix)
    if project.get('id') != state['project_id'] or project.get('detection_id') != state['detection_id']:
        raise Error('項目／OCR ID 與 checkpoint 不一致')
    if project.get('name') != prepared['manifest']['name']:
        raise Error('項目名稱與清單不一致；停止以保留人工修改')
    if any('reviewed_revision' in page for page in project.get('pages', [])):
        raise Error('項目包含人工校對完成標記；停止以保留人工修改')
    return importer.check_project(project, prepared, revision)


def execute_job(args, job, directory, prepared, api):
    path = directory / 'json-import.json'
    images_path = directory / 'images.json'
    if not path.exists():
        if not images_path.exists():
            projects = api.request('GET', '/api/prelayout/projects')
            if not isinstance(projects, list):
                raise Error('項目清單格式無效；無法排除同名項目')
            if any(project.get('name') == job['title'] for project in projects):
                raise Error(f'已有同名項目 {job["title"]}，但沒有 images checkpoint；禁止重建')
        images = importer.run(import_args(args, job, directory, translation=False), api=api)
        state = {'version': 1, 'fingerprint': prepared['fingerprint'], 'stage': 'ready', 'pending': None,
                 'project_id': images['project_id'], 'detection_id': images['detection_id'], 'revision': images['revision']}
        importer.atomic_state(path, state)
    state = load(path)
    if state.get('fingerprint') != prepared['fingerprint'] or state.get('stage') not in ('ready', 'done'):
        raise Error(f'JSON checkpoint 與來源不一致或 stage 無效：{path}')
    if not images_path.exists():
        raise Error(f'缺少圖片 checkpoint：{images_path}')
    image_state = load(images_path)
    image_prepared = importer.prepare(import_args(args, job, directory, translation=False))
    if (image_state.get('fingerprint') != image_prepared['fingerprint'] or image_state.get('stage') != 'completed'
            or image_state.get('pending') or image_state.get('project_id') != state['project_id']
            or image_state.get('detection_id') != state['detection_id']):
        raise Error(f'圖片 checkpoint 不一致或尚未完成：{images_path}')
    expected_image_revision = state['revision'] - int(state['stage'] == 'done')
    if image_state.get('revision') != expected_image_revision:
        raise Error(f'圖片／JSON checkpoint revision 不一致：{path}')
    prefix = '/api/prelayout/projects/' + state['project_id']

    def verify(revision):
        project = current(api, prefix, prepared, state, revision)
        verify_json(api.request('GET', prefix + '/export/bt'), prepared, project)
        current(api, prefix, prepared, state, revision)

    def done(revision):
        state.update(stage='done', pending=None, revision=revision)
        importer.atomic_state(path, state)

    if state.get('pending'):
        if state['pending'] != 'import' or state['stage'] != 'ready':
            raise Error(f'未知寫入 pending，禁止重送：{path}')
        # Never retry the write, even when the server still has the old revision.
        verify(state['revision'] + 1)
        done(state['revision'] + 1)
    elif state['stage'] == 'ready':
        current(api, prefix, prepared, state, state['revision'])
        fields = {'kind': 'bt', 'expected_revision': state['revision'], 'apply': 'false'}
        files = [('files', 'translation.json', prepared['upload'])]
        preview = api.request('POST', prefix + '/imports', fields=fields, files=files)
        if (preview.get('project_revision') != state['revision'] or preview.get('pages') != job['expected_pages']
                or preview.get('items') != job['expected_items']):
            raise Error(f'JSON 匯入預覽不一致：{path}')
        current(api, prefix, prepared, state, state['revision'])
        state['pending'] = 'import'
        importer.atomic_state(path, state)
        project = api.request('POST', prefix + '/imports', fields={**fields, 'apply': 'true'}, files=files)
        importer.check_project(project, prepared, state['revision'] + 1)
        verify(state['revision'] + 1)
        done(state['revision'] + 1)
    else:
        verify(state['revision'])
    return {'key': job['key'], 'title': job['title'], 'stage': 'done', 'project_id': state['project_id'],
            'revision': state['revision'], 'pages': job['expected_pages'], 'items': job['expected_items'],
            'checkpoint': str(path), 'matching': 'not_requested'}


def run(args, api=None):
    jobs = jobs_from(args)
    root = args.state_dir.expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    with (root / '.batch.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise Error(f'同一 state-dir 正在使用：{root}') from exc
        report = {'version': 1, 'mode': 'execute' if args.execute else 'dry_run', 'jobs': []}
        # Validate the entire selected batch before constructing any API client.
        for job in jobs:
            prepared = preflight(args, job, root / job['key'])
            report['jobs'].append({'key': job['key'], 'title': job['title'], 'stage': 'preflight',
                                   'pages': len(prepared['sources']), 'items': job['expected_items'],
                                   'fingerprint': prepared['fingerprint']})
        importer.atomic_state(root / 'preflight.json', report)
        print(f'本機預檢完成：{len(jobs)} 話，{sum(job["expected_pages"] for job in jobs)} 頁，'
              f'{sum(job["expected_items"] for job in jobs)} 條；mode={report["mode"]}', file=sys.stderr, flush=True)
        if not args.execute:
            return report
        api = NoMatchAPI(api if api is not None else importer.API(args.base_url, args.request_timeout))
        for index, job in enumerate(jobs):
            directory = root / job['key']
            try:
                print(f'[{index + 1}/{len(jobs)}] 開始 {job["title"]}；checkpoint={directory}', file=sys.stderr, flush=True)
                # Re-read before use, rather than keeping a batch of image bytes in RAM.
                prepared = preflight(args, job, directory)
                report['jobs'][index] = execute_job(args, job, directory, prepared, api)
                importer.atomic_state(root / 'progress.json', report)
                print(f'[{index + 1}/{len(jobs)}] 完成 {job["title"]}；'
                      f'project_id={report["jobs"][index]["project_id"]}', file=sys.stderr, flush=True)
            except BaseException as exc:
                report['error'] = {'key': job['key'], 'message': str(exc), 'checkpoint_dir': str(directory)}
                importer.atomic_state(root / 'progress.json', report)
                if isinstance(exc, KeyboardInterrupt):
                    raise
                raise Error(f'{exc}\n停止於 {job["key"]}；checkpoint={directory}；'
                            'pending 寫入不得重送，請保留同一 state-dir 核對。') from exc
        return report


def main():
    args = parser().parse_args()
    try:
        print(json.dumps(run(args), ensure_ascii=False, indent=2))
    except KeyboardInterrupt:
        print(f'已中斷；保留 checkpoint：{args.state_dir}，未取消伺服器 OCR。', file=sys.stderr)
        return 130
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
