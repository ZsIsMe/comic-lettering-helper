#!/usr/bin/env python3
"""Import first-level images and optional BT/LabelPlus text through the public API.

Run with .venv/bin/python. Checkpoints never substitute for server revision checks.
LabelPlus has one structural newline after each text block; additional newlines
belong to the text. Ambiguous blank lines before a following page are rejected.
"""
from __future__ import annotations

import argparse
import copy
import fcntl
import hashlib
import io
import json
import math
import mimetypes
import os
from pathlib import Path
import re
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from collections import Counter

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from prelayout_core.data import parse_translation, validate_items  # noqa: E402
from app.prelayout.import_metadata import merge_template  # noqa: E402
from app.prelayout.question_records import validate_question_records  # noqa: E402
from app.prelayout.detection import ACTIVE  # noqa: E402


class ImportErrorSafe(ValueError):
    """A safe stop requiring inspection rather than an automatic retry."""


class API:
    def __init__(self, base_url, timeout=60):
        self.base_url, self.timeout = base_url.rstrip('/'), timeout

    def request(self, method, path, *, data=None, fields=None, files=None):
        headers = {'Accept': 'application/json'}
        body = None
        if fields is not None:
            boundary = 'prelayout-' + uuid.uuid4().hex
            chunks = []
            for key, value in fields.items():
                chunks.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
            for key, name, payload in files or []:
                # All filenames are prevalidated. JSON quoting protects quotes in filenames.
                disposition = f'form-data; name="{key}"; filename={json.dumps(name, ensure_ascii=False)}'
                mime = mimetypes.guess_type(name)[0] or 'application/octet-stream'
                chunks.extend([f'--{boundary}\r\nContent-Disposition: {disposition}\r\nContent-Type: {mime}\r\n\r\n'.encode(), payload, b'\r\n'])
            chunks.append(f'--{boundary}--\r\n'.encode())
            body = b''.join(chunks)
            headers['Content-Type'] = f'multipart/form-data; boundary={boundary}'
        elif data is not None:
            body = json.dumps(data, ensure_ascii=False, allow_nan=False).encode()
            headers['Content-Type'] = 'application/json'
        request = urllib.request.Request(self.base_url + path, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            detail = exc.read(8192).decode('utf-8', 'replace')
            raise ImportErrorSafe(f'{method} {path}: HTTP {exc.code}: {detail}') from exc


def atomic_state(path, state):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.writing-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(state, stream, ensure_ascii=False, allow_nan=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def digest(payload):
    return hashlib.sha256(payload).hexdigest()


def natural(name):
    return [int(part) if part.isdigit() else part.casefold() for part in re.split(r'(\d+)', name)]


def labelplus(raw):
    """Keep legacy structural parsing, replacing only its whitespace-lossy texts."""
    text = raw.decode('utf-8-sig')
    lines = text.splitlines(keepends=True)
    heads = [(i, re.fullmatch(r'>>>>>>>>\[(.+)\]<<<<<<<<', line.rstrip('\r\n')))
             for i, line in enumerate(lines) if line.startswith('>>>>>>>>[')]
    if not heads or any(match is None for _, match in heads):
        raise ImportErrorSafe('TXT 必須是有圖片標頭的 LabelPlus，不能是普通文字檔')
    names = [match[1] for _, match in heads]
    if len(names) != len(set(names)):
        raise ImportErrorSafe('LabelPlus 含重複圖片標頭')
    data = parse_translation(raw, 'labelplus')
    # The same single-terminator rule applies to the comment metadata.
    separator = next(i for i in range(2, heads[0][0]) if lines[i].rstrip('\r\n') == '-')
    comment = ''.join(lines[separator + 1:heads[0][0]])
    comment = comment[:-2] if comment.endswith('\r\n') else comment[:-1] if comment.endswith(('\n', '\r')) else comment
    changed = comment != data['comment']
    data['comment'] = comment
    for position, (start, match) in enumerate(heads):
        end = heads[position + 1][0] if position + 1 < len(heads) else len(lines)
        labels = [i for i in range(start + 1, end) if lines[i].startswith('----------------[')]
        items = data['transMap'].get(match[1], [])
        if len(items) != len(labels) or any(line.strip() for line in lines[start + 1:(labels[0] if labels else end)]):
            raise ImportErrorSafe('LabelPlus 標籤格式無效或包含無法歸屬的文字')
        for number, label in enumerate(labels):
            if not re.fullmatch(r'----------------\[\d+\]----------------\[[^\]]+\]', lines[label].rstrip('\r\n')):
                raise ImportErrorSafe('LabelPlus 標籤格式無效')
            stop = labels[number + 1] if number + 1 < len(labels) else end
            value = ''.join(lines[label + 1:stop])
            # A line terminator closes the text block, not part of its text.
            value = value[:-2] if value.endswith('\r\n') else value[:-1] if value.endswith(('\n', '\r')) else value
            if stop == end and position + 1 < len(heads) and value.endswith(('\n', '\r')):
                raise ImportErrorSafe('LabelPlus 頁面之間有歧義空行；請移除分隔空行或改用 BT JSON')
            changed |= value != items[number]['text']
            items[number]['text'] = value
    return data, changed


def prepare(args):
    if any(not math.isfinite(value) or value <= 0 for value in (args.request_timeout, args.detection_timeout)):
        raise ImportErrorSafe('timeout 必須是有限且大於 0 的秒數')
    folder = Path(args.image_dir).expanduser().resolve()
    if not folder.is_dir():
        raise ImportErrorSafe(f'原圖資料夾不存在：{folder}')
    sources, stems = [], set()
    for path in sorted(folder.iterdir(), key=lambda p: natural(p.name)):
        if not path.is_file() or path.name.startswith('._') or path.suffix.lower() not in ('.png', '.jpg', '.jpeg'):
            continue
        if any(ord(c) < 32 for c in path.name) or '\\' in path.name:
            raise ImportErrorSafe(f'圖片檔名無效：{path.name!r}')
        if path.stem.casefold() in stems:
            raise ImportErrorSafe(f'圖片 stem 重複：{path.name}')
        stems.add(path.stem.casefold())
        payload = path.read_bytes()
        try:
            with Image.open(io.BytesIO(payload)) as image:
                if image.format not in ('PNG', 'JPEG') or image.getexif().get(274, 1) != 1:
                    raise ImportErrorSafe(f'圖片格式或 EXIF 旋轉無效：{path.name}')
                if image.width * image.height > 120_000_000:
                    raise ImportErrorSafe(f'圖片超過 1.2 億像素：{path.name}')
                image.load()
                width, height = image.size
        except (OSError, SyntaxError, Image.DecompressionBombError) as exc:
            raise ImportErrorSafe(f'壞圖：{path.name}: {exc}') from exc
        sources.append({'name': path.name, 'sha256': digest(payload), 'width': width, 'height': height, 'payload': payload})
    if not sources:
        raise ImportErrorSafe('資料夾第一層沒有有效 PNG／JPG／JPEG 圖片')
    name = (args.name if args.name is not None else folder.name).strip()
    if not name or len(name) > 80:
        raise ImportErrorSafe('項目名稱須為 1–80 字元')
    translation, upload, kind, format_name, translation_hash, translation_path = None, None, None, None, None, None
    mapping = {}
    if args.translation:
        path = Path(args.translation).expanduser().resolve()
        translation_path = str(path)
        raw = path.read_bytes()
        translation_hash = digest(raw)
        if path.suffix.lower() == '.txt':
            translation, changed = labelplus(raw)
            format_name, kind = 'labelplus', 'bt' if changed else 'labelplus'
            upload = json.dumps(translation, ensure_ascii=False, allow_nan=False).encode() if changed else raw
        elif path.suffix.lower() == '.json':
            def unique_pairs(pairs):
                result = {}
                for key, value in pairs:
                    if key in result:
                        raise ImportErrorSafe(f'JSON 含重複鍵：{key}')
                    result[key] = value
                return result
            json.loads(raw, object_pairs_hook=unique_pairs)
            translation = parse_translation(raw, 'bt')
            format_name, kind, upload = 'bt', 'bt', raw
        else:
            raise ImportErrorSafe('譯稿只接受 BT JSON 或 LabelPlus TXT')
        for key, items in translation['transMap'].items():
            if not isinstance(key, str):
                raise ImportErrorSafe('譯稿頁名必須是文字')
            found = [source for source in sources if source['name'] == key]
            if not found:
                found = [source for source in sources if Path(source['name']).stem.casefold() == Path(key).stem.casefold()]
            if len(found) != 1:
                raise ImportErrorSafe(f'譯稿找不到唯一原圖：{key}')
            source = found[0]
            if source['name'] in mapping:
                raise ImportErrorSafe(f'多個譯稿頁面對應到同一圖片：{key}')
            validate_items(items, source['width'], source['height'])
            mapping[source['name']] = [{**copy.deepcopy(item), 'text': item.get('text', '')} for item in items]
        if not mapping:
            raise ImportErrorSafe('譯稿沒有頁面')
        merge_template({}, translation, sources)
        if 'questionRecords' in translation:
            validate_question_records(translation['questionRecords'])
    manifest = {'base_url': args.base_url.rstrip('/'), 'image_dir': str(folder), 'name': name,
                'translation_path': translation_path, 'translation_sha256': translation_hash,
                'sources': [{k: v for k, v in source.items() if k != 'payload'} for source in sources]}
    fingerprint = digest(json.dumps(manifest, ensure_ascii=False, sort_keys=True).encode())
    identity = {k: manifest[k] for k in ('base_url', 'image_dir', 'name', 'translation_path')}
    return {'sources': sources, 'translation': translation, 'mapping': mapping, 'upload': upload, 'kind': kind,
            'translation_format': format_name, 'manifest': manifest, 'identity': identity, 'fingerprint': fingerprint,
            'missing_translation_pages': [s['name'] for s in sources if s['name'] not in mapping]}


def require_available(api):
    availability = api.request('GET', '/api/prelayout/availability')
    if availability.get('methods', {}).get('ocr_aligned') is not True:
        raise ImportErrorSafe('ocr_aligned 尚未就緒，請先準備模型與執行環境')
    if availability.get('gpu_owner') is not None:
        raise ImportErrorSafe(f'GPU 忙碌：{availability["gpu_owner"]}')
    return availability


def check_project(project, prepared, revision=None):
    if revision is not None and project.get('revision') != revision:
        raise ImportErrorSafe(f'項目 revision 已變更（預期 {revision}，目前 {project.get("revision")}）；停止以保留後續人工編輯')
    pages = project.get('pages', [])
    expected = prepared['manifest']['sources']
    if [{key: page.get(key) for key in ('name', 'sha256', 'width', 'height')} for page in pages] != expected:
        raise ImportErrorSafe('伺服器原圖頁面／hash 與 checkpoint 輸入不一致')
    return project


def verify_export(exported, prepared):
    trans_map = exported.get('transMap')
    if not isinstance(trans_map, dict) or set(trans_map) != {s['name'] for s in prepared['sources']}:
        raise ImportErrorSafe('BT 匯出頁面不完整')
    statuses = Counter()
    # Matching may change geometry and match fields, but source information must survive.
    layout_fields = {'_id', 'index', 'x', 'y', 'font-size', 'font_size', 'rotation', 'orientation',
                     'color', 'stroke-color', 'stroke-weight', 'xyxy_pixel', 'bbox', 'center_normalized',
                     'max_break', 'text-direction', 'need_inpaint'}
    for source in prepared['sources']:
        name = source['name']
        wanted, actual = prepared['mapping'].get(name, []), trans_map[name]
        if not isinstance(actual, list) or [i.get('text') for i in actual] != [i['text'] for i in wanted]:
            raise ImportErrorSafe(f'BT 匯出文字／計數不一致（包含換行與空白）：{name}')
        for before, after in zip(wanted, actual):
            for key, value in before.items():
                if key not in layout_fields and not key.startswith('match_') and after.get(key) != value:
                    raise ImportErrorSafe(f'BT 匯出 metadata 不一致：{name}/{key}')
            statuses[after.get('match_status', 'unmatched')] += 1
    if prepared['translation']:
        expected = merge_template({}, prepared['translation'], prepared['sources'])
        for key, value in expected.items():
            if key not in ('transMap', 'questionRecords') and exported.get(key) != value:
                raise ImportErrorSafe(f'BT 匯出 metadata 不一致：{key}')
    return {key: statuses[key] for key in ('auto', 'unmatched', 'duplicate', 'manual')}


def run(args, api=None):
    prepared = prepare(args)
    api = api or API(args.base_url, args.request_timeout)
    path = Path(args.state_file).expanduser().resolve() if args.state_file else ROOT / 'var/prelayout-imports' / (prepared['fingerprint'] + '.json')
    report = {'checkpoint': str(path), 'fingerprint': prepared['fingerprint'],
              'page_count': len(prepared['sources']), 'item_count': sum(map(len, prepared['mapping'].values())),
              'translation_format': prepared['translation_format'], 'import_kind': prepared['kind'],
              'missing_translation_pages': prepared['missing_translation_pages']}
    if args.check_only:
        require_available(api)
        return {**report, 'stage': 'check_only'}
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.with_suffix(path.suffix + '.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise ImportErrorSafe(f'同一匯入正在執行：{path}') from exc
        if not path.exists() and not args.state_file:
            for other in path.parent.glob('*.json'):
                previous = json.loads(other.read_text())
                if previous.get('identity') == prepared['identity'] and previous.get('fingerprint') != prepared['fingerprint']:
                    raise ImportErrorSafe(f'輸入檔案已變更；既有 checkpoint：{other}。請先人工核對，不會重新建項目')
        state = json.loads(path.read_text()) if path.exists() else {
            'version': 1, 'fingerprint': prepared['fingerprint'], 'identity': prepared['identity'],
            'manifest': prepared['manifest'], 'stage': 'new', 'pending': None}
        if state.get('fingerprint') != prepared['fingerprint'] or state.get('manifest') != prepared['manifest']:
            raise ImportErrorSafe(f'輸入檔案或參數與 checkpoint 不一致：{path}')
        if state.get('pending'):
            raise ImportErrorSafe(f'前次 mutation 結果不明，禁止自動重送：{state["pending"]}；checkpoint={path}；project_id={state.get("project_id", "unknown")}')

        def save(**updates):
            state.update(updates)
            atomic_state(path, state)

        def mutate(operation, endpoint, **kwargs):
            save(pending=operation)
            # A transport error, invalid response, or interruption deliberately leaves pending set.
            return api.request('POST', endpoint, **kwargs)

        def current():
            project = api.request('GET', prefix)
            if project.get('id') != state['project_id']:
                raise ImportErrorSafe('伺服器回傳不同項目 ID')
            return check_project(project, prepared, state['revision'])

        try:
            if state['stage'] == 'new':
                require_available(api)
                project = mutate('create', '/api/prelayout/projects', fields={'name': prepared['manifest']['name']},
                                 files=[('source_files', s['name'], s['payload']) for s in prepared['sources']])
                if isinstance(project.get('id'), str) and project['id']:
                    save(project_id=project['id'])
                check_project(project, prepared, 0)
                if not isinstance(project.get('id'), str) or not project['id']:
                    raise ImportErrorSafe('建立項目回應缺少 ID')
                save(stage='created', project_id=project['id'], revision=project['revision'], pending=None)
            prefix = '/api/prelayout/projects/' + state['project_id']
            if state['stage'] == 'created':
                current()
                require_available(api)
                task = mutate('detection', prefix + '/detections', data={'method': 'ocr_aligned', 'font_size': 24, 'step': 2})
                if not task.get('id') or task.get('project_id') != state['project_id']:
                    raise ImportErrorSafe('偵測提交回應 ID 不一致')
                save(stage='waiting', detection_id=task['id'], pending=None)
            if state['stage'] == 'waiting':
                deadline = time.monotonic() + args.detection_timeout
                while True:
                    task = api.request('GET', prefix + '/detections')
                    if not isinstance(task, dict) or task.get('id') != state['detection_id'] or task.get('project_id') != state['project_id']:
                        raise ImportErrorSafe('偵測任務 ID 與 checkpoint 不一致')
                    if task.get('state') == 'completed':
                        project = api.request('GET', prefix)
                        check_project(project, prepared, state['revision'] + 1)
                        if project.get('detection_id') != state['detection_id']:
                            raise ImportErrorSafe('項目 detection_id 與完成任務不一致')
                        save(stage='detected', revision=project['revision'])
                        break
                    if task.get('state') not in ACTIVE | {'running'}:
                        raise ImportErrorSafe(f'偵測未完成：{task.get("state")} {task.get("message", "")}')
                    project = api.request('GET', prefix)
                    # Publication writes the project before task.json becomes completed.
                    # Accept that exact increment while continuing to wait, never apply early.
                    published = project.get('revision') == state['revision'] + 1 and project.get('detection_id') == state['detection_id']
                    check_project(project, prepared, state['revision'] + int(published))
                    if time.monotonic() >= deadline:
                        raise ImportErrorSafe('等待偵測逾時；未取消伺服器 OCR，同命令可繼續等待')
                    time.sleep(min(1, max(0, deadline - time.monotonic())))
            if state['stage'] == 'detected' and prepared['translation'] is not None:
                current()
                fields = {'kind': prepared['kind'], 'expected_revision': state['revision'], 'apply': 'false'}
                files = [('files', 'translation.json' if prepared['kind'] == 'bt' else 'translation.txt', prepared['upload'])]
                preview = api.request('POST', prefix + '/imports', fields=fields, files=files)
                if (preview.get('project_revision') != state['revision'] or preview.get('pages') != len(prepared['mapping'])
                        or preview.get('items') != report['item_count']):
                    raise ImportErrorSafe('匯入預覽 revision／頁數／條數不一致')
                current()
                project = mutate('import', prefix + '/imports', fields={**fields, 'apply': 'true'}, files=files)
                check_project(project, prepared, state['revision'] + 1)
                save(stage='imported', revision=project['revision'], pending=None)
            if state['stage'] == 'imported':
                current()
                preview = api.request('POST', prefix + '/matches')
                if preview.get('project_revision') != state['revision']:
                    raise ImportErrorSafe('匹配預覽 revision 已過期')
                verify_export(preview['data'], prepared)
                current()
                project = mutate('match', prefix + '/matches/apply', data={'expected_revision': state['revision'], 'manual': {}})
                check_project(project, prepared, state['revision'] + 1)
                save(stage='matched', revision=project['revision'], pending=None)
            if state['stage'] not in ('detected', 'matched', 'completed'):
                raise ImportErrorSafe(f'未知 checkpoint stage：{state["stage"]}')
            project = current()
            if project.get('detection_id') != state['detection_id']:
                raise ImportErrorSafe('最終項目 detection_id 不一致')
            counts = verify_export(api.request('GET', prefix + '/export/bt'), prepared)
            current()  # Reject edits concurrent with export verification.
            save(stage='completed')
            return {**report, 'stage': 'completed', 'project_id': state['project_id'],
                    'detection_id': state['detection_id'], 'revision': state['revision'], 'matches': counts}
        except KeyboardInterrupt:
            print(f'checkpoint={path}；project_id={state.get("project_id", "unknown")}；'
                  f'stage={state["stage"]}；pending={state.get("pending")}', file=sys.stderr)
            raise
        except Exception as exc:
            raise ImportErrorSafe(f'{exc}\ncheckpoint={path}；project_id={state.get("project_id", "unknown")}；stage={state["stage"]}') from exc


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument('image_dir', help='只讀第一層 PNG/JPG/JPEG 原圖資料夾')
    result.add_argument('--translation', help='可選 BT JSON 或 LabelPlus TXT')
    result.add_argument('--name', help='項目名稱，預設原圖資料夾名稱')
    result.add_argument('--base-url', default='http://127.0.0.1:6008')
    result.add_argument('--state-file', help='自訂 checkpoint 路徑')
    result.add_argument('--check-only', action='store_true', help='只驗證輸入及服務 availability，不建立項目')
    result.add_argument('--request-timeout', type=float, default=60)
    result.add_argument('--detection-timeout', type=float, default=3600)
    return result


def main():
    args = parser().parse_args()
    if any(not math.isfinite(value) or value <= 0 for value in (args.request_timeout, args.detection_timeout)):
        parser().error('timeout 必須是有限且大於 0 的秒數')
    try:
        print(json.dumps(run(args), ensure_ascii=False, indent=2))
    except KeyboardInterrupt:
        print('已中斷；未取消伺服器 OCR。以相同命令讀取 checkpoint 繼續；pending mutation 需人工核對。', file=sys.stderr)
        return 130
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
