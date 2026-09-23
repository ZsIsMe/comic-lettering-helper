from __future__ import annotations

import copy
import hashlib
import io
import json
import os
import re
import shutil
import tempfile
import threading
import zipfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image

from prelayout_core.data import identifier, read_json, validate_items, validate_measure, parse_translation, export_item, match_translation
from prelayout_core.characters import character_pages


class Conflict(ValueError):
    pass


def now():
    return datetime.now(timezone.utc).isoformat()


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2).encode()
    fd, temporary = tempfile.mkstemp(prefix='.writing-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def filename(value):
    if not isinstance(value, str) or not value or Path(value).name != value or '\\' in value or any(ord(c) < 32 for c in value):
        raise ValueError('檔名不可包含路徑或控制字元')
    return value


def natural(value):
    return [int(v) if v.isdigit() else v.casefold() for v in re.split(r'(\d+)', value)]


class PrelayoutStore:
    def __init__(self, root: Path, forbidden=()):
        self.root = Path(root).resolve()
        for directory in forbidden:
            directory = Path(directory).resolve()
            if self.root == directory or self.root in directory.parents or directory in self.root.parents:
                raise ValueError('預排版資料目錄不可與修圖 projects／jobs 目錄重疊')
        self.projects = self.root / 'projects'
        self._locks = {}
        self._guard = threading.Lock()
        self.preview_slots = threading.BoundedSemaphore(2)
        self._readers = {}

    @contextmanager
    def lock(self, pid):
        with self._guard:
            lock = self._locks.setdefault(pid, threading.RLock())
        with lock:
            yield

    def directory(self, pid):
        if not re.fullmatch(r'pl_[a-f0-9]{32}', pid):
            raise KeyError('預排版項目不存在')
        path = self.projects / pid
        if not path.is_dir() or path.is_symlink():
            raise KeyError('預排版項目不存在')
        return path

    @contextmanager
    def reader(self, pid):
        # Immutable asset references remain readable during save/import; deletion waits by conflict.
        with self.lock(pid):
            project, root = self.read(pid), self.directory(pid)
            self._readers[pid] = self._readers.get(pid, 0) + 1
        try:
            yield project, root
        finally:
            with self.lock(pid):
                self._readers[pid] -= 1

    def delete(self, pid):
        with self.lock(pid):
            if self._readers.get(pid):
                raise Conflict('項目正在讀取或封存，請稍後再刪除')
            shutil.rmtree(self.directory(pid))

    def read(self, pid):
        return read_json((self.directory(pid) / 'project.json').read_bytes())

    def write(self, project):
        project['updated_at'] = now()
        atomic_json(self.directory(project['id']) / 'project.json', project)

    def update_groups(self, pid, expected_revision, names):
        with self.lock(pid):
            project = self.read(pid)
            if project['revision'] != expected_revision:
                raise Conflict('項目已有更新，請重新載入分組')
            if not isinstance(names, list) or len(names) > 1000:
                raise ValueError('分組格式錯誤或超過 1,000 組')
            existing = project.get('template', {}).get('groupList', [])
            groups, seen = [], set()
            for index, value in enumerate(names):
                if not isinstance(value, str):
                    raise ValueError('分組名稱格式錯誤')
                name = value.strip()
                if not name or len(name) > 80:
                    raise ValueError('分組名稱須為 1 至 80 個字元')
                key = name.casefold()
                if key in seen:
                    raise ValueError(f'分組名稱重複：{name}')
                seen.add(key)
                previous = existing[index] if isinstance(existing, list) and index < len(existing) else None
                groups.append(copy.deepcopy(previous) if isinstance(previous, dict) and previous.get('name') == name else {'name': name})
            project.setdefault('template', {})['groupList'] = groups
            project['revision'] += 1
            self.write(project)
            return project

    def list(self):
        if not self.projects.exists():
            return []
        result = []
        for path in self.projects.glob('pl_*/project.json'):
            with self.lock(path.parent.name):
                try:
                    result.append(self.read(path.parent.name))
                except (KeyError, FileNotFoundError, ValueError):
                    continue
        return sorted(result, key=lambda p: p['updated_at'], reverse=True)

    def create(self, name, uploads):
        if not uploads:
            raise ValueError('請上傳原圖')
        pid = identifier('pl')
        self.projects.mkdir(parents=True, exist_ok=True)
        folder = Path(tempfile.mkdtemp(prefix='.create-', dir=self.projects))
        try:
            (folder / 'originals').mkdir()
            pages, names, stems = [], set(), set()
            for name_in, data in sorted(uploads, key=lambda f: natural(f[0])):
                if name_in.startswith('._'):
                    continue
                name_in = filename(name_in)
                if Path(name_in).suffix.lower() not in ('.png', '.jpg', '.jpeg'):
                    raise ValueError('原圖只接受 PNG／JPG／JPEG')
                stem = Path(name_in).stem.casefold()
                if name_in.casefold() in names or stem in stems:
                    raise ValueError('圖片檔名或 stem 重複')
                names.add(name_in.casefold()); stems.add(stem)
                with Image.open(io.BytesIO(data)) as image:
                    if image.format not in ('PNG', 'JPEG'):
                        raise ValueError('原圖內容必須是 PNG／JPEG')
                    if image.getexif().get(274, 1) != 1:
                        raise ValueError(f'{name_in} 含 EXIF 旋轉，請先統一圖片方向以免排版錯位')
                    width, height = image.size
                    if width * height > 120_000_000:
                        raise ValueError('單張圖片超過 1.2 億像素')
                    image.load()
                (folder / 'originals' / name_in).write_bytes(data)
                page_id = identifier('p')
                relative = f'pages/{page_id}/0.json'
                atomic_json(folder / relative, {'revision': 0, 'items': [], 'operations': []})
                pages.append({'id': page_id, 'name': name_in, 'width': width, 'height': height,
                              'sha256': hashlib.sha256(data).hexdigest(), 'revision': 0, 'state': relative, 'clean': None})
            if not pages:
                raise ValueError('沒有可用原圖')
            project = {'id': pid, 'schema_version': 1, 'name': str(name).strip()[:80] or '未命名預排版',
                       'created_at': now(), 'updated_at': now(), 'pages': pages, 'revision': 0,
                       'template': {'version': [1, 0], 'groupList': [], 'comment': ''}, 'detection_id': None}
            atomic_json(folder / 'project.json', project)
            folder.rename(self.projects / pid)
            return project
        except BaseException:
            shutil.rmtree(folder, ignore_errors=True)
            raise

    def page(self, pid, page_id):
        project = self.read(pid)
        page = next((p for p in project['pages'] if p['id'] == page_id), None)
        if page is None:
            raise KeyError('頁面不存在')
        state = read_json((self.directory(pid) / page['state']).read_bytes())
        measure, characters = [], []
        did = project.get('detection_id')
        if did:
            path = self.directory(pid) / 'detections' / did / 'output' / 'measure.json'
            page_path = path.parent / 'page-measures' / f'{page_id}.json'
            if page_path.exists():
                measure = read_json(page_path.read_bytes())
            elif path.exists():
                data = read_json(path.read_bytes())
                measure = data.get('pages', {}).get(page['name'], [])
            character_path = path.parent / 'page-characters' / f'{page_id}.json'
            if not character_path.exists():
                # Older tasks already have the OCR/debug output. Derive all compact
                # pages once, so subsequent page reads never parse a whole chapter.
                with self.lock(pid):
                    if not character_path.exists():
                        for cid, values in character_pages(path.parent, project['pages']).items():
                            atomic_json(path.parent / 'page-characters' / f'{cid}.json', values)
            characters = read_json(character_path.read_bytes())
        return {**page, **state, 'measure': measure, 'character_boxes': characters}

    def save_page(self, pid, page_id, revision, items, operation_id):
        with self.lock(pid):
            project = self.read(pid)
            page = next((p for p in project['pages'] if p['id'] == page_id), None)
            if page is None:
                raise KeyError('頁面不存在')
            state = read_json((self.directory(pid) / page['state']).read_bytes())
            if operation_id in state.get('operations', []):
                return self.page(pid, page_id)
            if revision != page['revision']:
                raise Conflict('此頁已有較新版本，請保留草稿並重新載入')
            items = validate_items(items, page['width'], page['height'])
            updated = page['revision'] + 1
            relative = f'pages/{page_id}/{updated}-{identifier()}.json'
            operations = (state.get('operations', []) + [operation_id])[-128:]
            atomic_json(self.directory(pid) / relative, {'revision': updated, 'items': items, 'operations': operations})
            page.update(revision=updated, state=relative)
            project['revision'] += 1
            self.write(project)
            return self.page(pid, page_id)

    def translation(self, pid):
        project = self.read(pid)
        return {**copy.deepcopy(project['template']), 'transMap': {
            page['name']: [export_item(item) for item in read_json((self.directory(pid) / page['state']).read_bytes())['items']]
            for page in project['pages']}}

    def import_translation(self, pid, raw, kind, expected_revision, apply=False):
        with self.lock(pid):
            project = self.read(pid)
            if project['revision'] != expected_revision:
                raise Conflict('項目已更新，請重新預覽匯入內容')
            data = parse_translation(raw, kind)
            mapping, unknown = {}, []
            for name, items in data['transMap'].items():
                page = next((p for p in project['pages'] if p['name'] == name), None)
                if page is None:
                    candidates = [p for p in project['pages'] if Path(p['name']).stem.casefold() == Path(name).stem.casefold()]
                    page = candidates[0] if len(candidates) == 1 else None
                if page is None:
                    unknown.append(name); continue
                if page['id'] in mapping:
                    raise ValueError('多個譯稿頁面對應到同一圖片')
                mapping[page['id']] = validate_items(items, page['width'], page['height'])
            if unknown:
                raise ValueError('譯稿找不到對應原圖：' + '、'.join(unknown[:12]))
            summary = {'pages': len(mapping), 'items': sum(map(len, mapping.values())),
                       'groups': data.get('groupList', []), 'project_revision': project['revision']}
            if not apply:
                return summary
            if kind == 'labelplus':
                for items in mapping.values():
                    for item in items:
                        item['match_status'] = 'unmatched'
                if project.get('detection_id'):
                    path = self.directory(pid) / 'detections' / project['detection_id'] / 'output' / 'measure.json'
                    imported = {**data, 'transMap': {page['name']: mapping[page['id']]
                                for page in project['pages'] if page['id'] in mapping}}
                    matched = match_translation(imported, read_json(path.read_bytes()), self.directory(pid) / 'originals')
                    for page in project['pages']:
                        if page['id'] in mapping:
                            mapping[page['id']] = validate_items(matched['transMap'][page['name']], page['width'], page['height'])
            # Build every immutable page revision first, then publish a single manifest.
            for page in project['pages']:
                if page['id'] not in mapping:
                    continue
                items = mapping[page['id']]
                revision = page['revision'] + 1
                relative = f'pages/{page["id"]}/{revision}-{identifier()}.json'
                atomic_json(self.directory(pid) / relative, {'revision': revision, 'items': items, 'operations': []})
                page.update(revision=revision, state=relative)
            project['template'] = {k: v for k, v in data.items() if k != 'transMap'}
            project['revision'] += 1
            (self.directory(pid) / 'imports').mkdir(exist_ok=True)
            (self.directory(pid) / 'imports' / f'{identifier()}.{kind}').write_bytes(raw)
            if kind == 'labelplus':
                atomic_json(self.directory(pid) / 'imports' / f'{identifier()}_meo.json', data)
            self.write(project)
            return project

    def clean_images(self, pid, uploads, expected_revision=None):
        with self.lock(pid):
            project = self.read(pid)
            if expected_revision is not None and project['revision'] != expected_revision:
                raise Conflict('項目已有更新，請重新上傳去字圖')
            root = self.directory(pid)
            pending, seen = [], set()
            for name, data in uploads:
                if name.startswith('._'):
                    continue
                filename(name)
                if Path(name).suffix.lower() not in ('.png', '.jpg', '.jpeg'):
                    raise ValueError('去字圖只接受 PNG／JPG／JPEG')
                matches = [p for p in project['pages'] if p['name'] == name or Path(p['name']).stem.casefold() == Path(name).stem.casefold()]
                if len(matches) != 1 or matches[0]['id'] in seen:
                    raise ValueError(f'去字圖無法唯一配對：{name}')
                page = matches[0]; seen.add(page['id'])
                with Image.open(io.BytesIO(data)) as image:
                    if image.format not in ('PNG', 'JPEG') or image.size != (page['width'], page['height']) or image.getexif().get(274, 1) != 1:
                        raise ValueError(f'去字圖尺寸／方向不一致：{name}')
                    image.load()
                relative = f'clean/{identifier()}{Path(name).suffix.lower()}'
                pending.append((page, relative, data))
            for page, relative, data in pending:
                (root / 'clean').mkdir(exist_ok=True)
                (root / relative).write_bytes(data)
                page['clean'] = relative
                page['clean_kind'] = 'uploaded'
            project['revision'] += 1
            self.write(project)
            return project

    def preview(self, pid, page_id, edge=1536, clean=False, region=None):
        with self.reader(pid) as (project, root):
            page = next((p for p in project['pages'] if p['id'] == page_id), None)
            if page is None:
                raise KeyError('頁面不存在')
            if edge not in (384, 768, 1536, 3072):
                raise ValueError('預覽級別無效')
            if region is not None:
                x, y, w, h = region
                if min(x, y) < 0 or min(w, h) < 1 or max(w, h) > 8192 or x + w > page['width'] or y + h > page['height']:
                    raise ValueError('局部預覽範圍無效')
            path = root / (page['clean'] if clean and page['clean'] else f'originals/{page["name"]}')
            key = hashlib.sha256(f'{page["sha256"]}:{page["clean"] if clean else "source"}:{edge}:{region}'.encode()).hexdigest()
            cache = root / 'previews' / f'{key}.jpg'
            with self.lock(f'preview:{pid}:{key}'):
                with self.lock(f'preview-cache:{pid}'):
                    if cache.exists():
                        payload = cache.read_bytes()
                        os.utime(cache, None)
                        return payload, key
                with Image.open(path) as source:
                    if region is None:
                        # JPEG can reduce its decoder working set before materializing pixels.
                        source.draft('RGB', (edge, edge))
                        source.thumbnail((edge, edge))
                        image = source.convert('RGB')
                    else:
                        image = source.crop((x, y, x + w, y + h)).convert('RGB')
                        image.thumbnail((edge, edge))
                    output = io.BytesIO(); image.save(output, 'JPEG', quality=88)
                    payload = output.getvalue(); image.close()
                with self.lock(f'preview-cache:{pid}'):
                    cache.parent.mkdir(exist_ok=True)
                    cache.write_bytes(payload)
                    files = sorted(cache.parent.glob('*.jpg'), key=lambda f: f.stat().st_mtime)
                    total = sum(f.stat().st_size for f in files)
                    for old in files:
                        if total <= 256 * 1024 * 1024:
                            break
                        total -= old.stat().st_size; old.unlink()
                return payload, key

    def export_archive(self, pid):
        with self.reader(pid) as (project, root):
            self.root.mkdir(parents=True, exist_ok=True)
            fd, name = tempfile.mkstemp(prefix='prelayout-', suffix='.zip', dir=self.root)
            os.close(fd)
            try:
                with zipfile.ZipFile(name, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=1) as archive:
                    archive.writestr('prelayout/project.json', json.dumps(project, ensure_ascii=False))
                    for page in project['pages']:
                        for relative in (f'originals/{page["name"]}', page['state'], page['clean']):
                            if relative:
                                archive.write(root / relative, f'prelayout/{relative}')
                    for path in (root / 'imports').glob('*'):
                        if path.is_file() and not path.is_symlink():
                            archive.write(path, f'prelayout/{path.relative_to(root)}')
                    # Only the immutable, published detection referenced by this snapshot belongs in it.
                    did = project.get('detection_id')
                    if did:
                        folder = root / 'detections' / did
                        task = read_json((folder / 'task.json').read_bytes())
                        task.update(pid=None, state='completed')
                        archive.writestr(f'prelayout/detections/{did}/task.json', json.dumps(task, ensure_ascii=False))
                        for path in (folder / 'output').rglob('*'):
                            if path.is_file() and not path.is_symlink():
                                archive.write(path, f'prelayout/{path.relative_to(root)}')
                return Path(name)
            except BaseException:
                Path(name).unlink(missing_ok=True)
                raise

    def matches(self, pid):
        with self.lock(pid):
            project = self.read(pid)
            if not project.get('detection_id'):
                raise ValueError('請先完成 CTD 偵測')
            path = self.directory(pid) / 'detections' / project['detection_id'] / 'output' / 'measure.json'
            original = self.translation(pid)
            data = match_translation(original, read_json(path.read_bytes()), self.directory(pid) / 'originals')
            manual = sum(item.get('match_status') == 'manual' for items in original['transMap'].values() for item in items)
            total = sum(len(items) for items in data['transMap'].values())
            return {'project_revision': project['revision'], 'data': data, 'summary': {'manual': manual, 'automatic': total - manual}}

    def apply_matches(self, pid, expected_revision, manual):
        """Publish one matching transaction without touching the read-only measure version."""
        with self.lock(pid):
            project = self.read(pid)
            if project['revision'] != expected_revision:
                raise Conflict('匹配預覽已過期，請重新預覽後再套用')
            if not isinstance(manual, dict) or any(not isinstance(ids, list) or any(not isinstance(i, str) for i in ids) for ids in manual.values()):
                raise ValueError('手動文字選取格式無效')
            candidate = self.matches(pid)['data']['transMap']
            for page in project['pages']:
                source = read_json((self.directory(pid) / page['state']).read_bytes())['items']
                matched = candidate.get(page['name'], [])
                if len(source) != len(matched):
                    raise ValueError('匹配輸出與原文字數量不同，未套用')
                selected = set(manual.get(page['id'], []))
                if not selected.issubset({item['_id'] for item in source}):
                    raise Conflict('選取文字已不存在，請重新預覽')
                items = [old if old.get('match_status') == 'manual' and old['_id'] not in selected else {**new, '_id': old['_id']}
                         for old, new in zip(source, matched)]
                if items == source:
                    continue
                items = validate_items(items, page['width'], page['height'])
                revision = page['revision'] + 1
                relative = f'pages/{page["id"]}/{revision}-{identifier()}.json'
                atomic_json(self.directory(pid) / relative, {'revision': revision, 'items': items, 'operations': []})
                page.update(revision=revision, state=relative)
            project['revision'] += 1
            self.write(project)
            return project

    def import_archive(self, raw, max_bytes):
        self.projects.mkdir(parents=True, exist_ok=True)
        stage = Path(tempfile.mkdtemp(prefix='.import-', dir=self.projects))
        try:
            with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                entries = archive.infolist()
                names = [entry.filename for entry in entries]
                if len(names) != len(set(names)) or len(names) > 30000 or sum(e.file_size for e in entries) > max_bytes:
                    raise ValueError('封存含重複檔案或超過解壓限制')
                for entry in entries:
                    name = entry.filename
                    relative = Path(name)
                    if '\\' in name or relative.is_absolute() or '..' in relative.parts or relative.parts[:1] != ('prelayout',) or name.rstrip('/') != relative.as_posix():
                        raise ValueError('封存路徑無效')
                    if len(relative.parts) > 1 and relative.parts[1] not in ('project.json', 'originals', 'clean', 'pages', 'imports', 'detections'):
                        raise ValueError('封存包含非預排版資產')
                    if not entry.is_dir() and len(relative.parts) > 2 and relative.suffix.lower() not in ('.png', '.jpg', '.jpeg', '.json', '.bt', '.labelplus', '.npz'):
                        raise ValueError('封存包含不支援的資產類型')
                    if (entry.external_attr >> 16) & 0o170000 == 0o120000:
                        raise ValueError('封存不可包含符號連結')
                    path = stage / relative
                    if entry.is_dir():
                        path.mkdir(parents=True, exist_ok=True)
                    else:
                        path.parent.mkdir(parents=True, exist_ok=True)
                        with archive.open(entry) as source, path.open('wb') as target:
                            shutil.copyfileobj(source, target)
            content = stage / 'prelayout'
            project = read_json((content / 'project.json').read_bytes())
            if not isinstance(project, dict) or project.get('schema_version') != 1 or not isinstance(project.get('pages'), list) or not project['pages'] or not isinstance(project.get('template'), dict) or type(project.get('revision')) is not int:
                raise ValueError('不是支援的預排版封存')
            def asset(relative, prefix):
                if not isinstance(relative, str) or '\\' in relative or Path(relative).is_absolute() or '..' in Path(relative).parts or Path(relative).parts[:1] != (prefix,):
                    raise ValueError('資產引用不在預排版封存內')
                path = content / relative
                if not path.is_file():
                    raise ValueError('封存缺少必要資產')
                return path
            ids, names = set(), set()
            for page in project['pages']:
                if not isinstance(page, dict) or type(page.get('revision')) is not int or page['revision'] < 0:
                    raise ValueError('封存頁面格式／修訂無效')
                filename(page['name'])
                if not re.fullmatch(r'p_[a-f0-9]{32}', page['id']) or page['id'] in ids or Path(page['name']).stem.casefold() in names:
                    raise ValueError('頁面 ID／名稱重複或無效')
                ids.add(page['id']); names.add(Path(page['name']).stem.casefold())
                source = asset(f'originals/{page["name"]}', 'originals')
                with Image.open(source) as image:
                    if image.format not in ('PNG', 'JPEG') or image.width * image.height > 120_000_000 or image.size != (page['width'], page['height']) or image.getexif().get(274, 1) != 1:
                        raise ValueError('封存原圖尺寸／方向不符')
                    image.load()
                if hashlib.sha256(source.read_bytes()).hexdigest() != page['sha256']:
                    raise ValueError('封存原圖雜湊不符')
                state = read_json(asset(page['state'], 'pages').read_bytes())
                if Path(page['state']).parts[:2] != ('pages', page['id']) or state['revision'] != page['revision']:
                    raise ValueError('封存修訂不一致')
                state['items'] = validate_items(state['items'], page['width'], page['height'])
                state['operations'] = []
                atomic_json(content / page['state'], state)
                if page.get('clean'):
                    with Image.open(asset(page['clean'], 'clean')) as image:
                        image.load()
                        if image.size != (page['width'], page['height']) or image.getexif().get(274, 1) != 1:
                            raise ValueError('封存去字圖尺寸不符')
            did = project.get('detection_id')
            if did:
                if not re.fullmatch(r'd_[a-f0-9]{32}', did):
                    raise ValueError('偵測 ID 無效')
                measure = read_json(asset(f'detections/{did}/output/measure.json', 'detections').read_bytes())
                validate_measure(measure, project['pages'])
                task = read_json(asset(f'detections/{did}/task.json', 'detections').read_bytes())
                if task.get('id') != did or task.get('state') != 'completed':
                    raise ValueError('封存偵測任務與已發布結果不符')
                completed = read_json(asset(f'detections/{did}/output/complete.json', 'detections').read_bytes())
                if completed.get('pages') != [p['name'] for p in project['pages']]:
                    raise ValueError('封存偵測結果頁面不完整')
                # Derived caches in an archive must never override the validated source.
                for page in project['pages']:
                    atomic_json(content / f'detections/{did}/output/page-measures/{page["id"]}.json', measure['pages'][page['name']])
                output = content / f'detections/{did}/output'
                for cid, values in character_pages(output, project['pages'], measure.get('font_size_calculation_method')).items():
                    atomic_json(output / 'page-characters' / f'{cid}.json', values)
            project['id'] = identifier('pl')
            project['created_at'] = project['updated_at'] = now()
            project['name'] = str(project['name'])[:80]
            project['imported'] = True
            for task_path in list((content / 'detections').glob('*/task.json')):
                task = read_json(task_path.read_bytes())
                old_id = task_path.parent.name
                new_id = identifier('d')
                task.update(id=new_id, project_id=project['id'], pid=None)
                if task.get('state') != 'completed':
                    task.update(state='cancelled', message='從封存匯入；未恢復原伺服器程序')
                atomic_json(task_path, task)
                task_path.parent.rename(task_path.parent.with_name(new_id))
                if old_id == project.get('detection_id'):
                    project['detection_id'] = new_id
            atomic_json(content / 'project.json', project)
            content.rename(self.projects / project['id'])
            return project
        except (KeyError, TypeError, AttributeError, zipfile.BadZipFile) as exc:
            raise ValueError('預排版封存格式不完整或無效') from exc
        finally:
            shutil.rmtree(stage, ignore_errors=True)

    def preferences(self, items=None):
        with self.lock('preferences'):
            path = self.root / 'preferences' / 'clipboard.json'
            if items is not None:
                if len(items) > 200:
                    raise ValueError('常用文字框最多 200 筆')
                atomic_json(path, validate_items(items, 100000, 100000))
            return read_json(path.read_bytes()) if path.exists() else []
