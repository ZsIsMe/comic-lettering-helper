"""Independent edge-white collections, revisioned drafts and immutable output files."""
from __future__ import annotations

import json
import re
import shutil
import threading
import uuid
import zipfile
from contextlib import contextmanager
from pathlib import Path

from .projects import atomic_json, digest_file, ProjectConflict
from .repository import now_iso
from imaging.edgewhite import Edit, normalize, render, validate_edit


def natural_key(name):
    return [int(p) if p.isdigit() else p.casefold() for p in re.split(r'(\d+)', name)]


class EdgeWhiteStore:
    def __init__(self, root: Path):
        self.root = root
        self._guard = threading.RLock()
        self._locks: dict[str, threading.RLock] = {}
        self._readers: dict[str, int] = {}
        self.cpu_gate = threading.BoundedSemaphore(2)

    def directory(self, cid):
        if not re.fullmatch(r'[0-9a-f]{32}', cid):
            raise KeyError('項目不存在')
        return self.root / cid

    @contextmanager
    def lock(self, cid):
        self.directory(cid)
        with self._guard:
            lock = self._locks.setdefault(cid, threading.RLock())
        with lock:
            yield

    def read(self, cid):
        with self.lock(cid):
            try:
                return json.loads((self.directory(cid) / 'collection.json').read_text())
            except FileNotFoundError as exc:
                raise KeyError('項目不存在') from exc

    def list(self):
        if not self.root.exists():
            return []
        result = []
        for path in self.root.glob('*/collection.json'):
            if not re.fullmatch(r'[0-9a-f]{32}', path.parent.name):
                continue
            try:
                result.append(self.read(path.parent.name))
            except KeyError:
                pass
        return sorted(result, key=lambda c: c['updated_at'], reverse=True)

    def write(self, collection):
        collection['updated_at'] = now_iso()
        atomic_json(self.directory(collection['id']) / 'collection.json', collection)

    @staticmethod
    def page(collection, page_id):
        for page in collection['pages']:
            if page['id'] == page_id:
                return page
        raise KeyError('圖片不存在')

    def create(self, name, sources):
        if not sources:
            raise ValueError('請選擇原圖')
        cid = uuid.uuid4().hex
        self.root.mkdir(parents=True, exist_ok=True)
        stage = self.root / f'.upload-{cid}'
        stage.mkdir()
        collection = {'version': 1, 'id': cid, 'name': str(name).strip()[:80] or '未命名項目',
            'revision': 0, 'created_at': now_iso(), 'updated_at': now_iso(), 'pages': []}
        stems = set()
        try:
            for filename, source in sorted(sources, key=lambda pair: natural_key(pair[0])):
                stem = Path(filename).stem
                if (not stem or stem in {'.', '..'} or filename != Path(filename).name
                        or any(ord(c) < 32 or c in '\\/' for c in filename)
                        or stem.casefold() in stems or Path(filename).suffix.lower() not in {'.png', '.jpg', '.jpeg'}):
                    raise ValueError('檔名無效、stem 重複或格式不支援')
                stems.add(stem.casefold())
                page_id = uuid.uuid4().hex
                folder = stage / page_id
                folder.mkdir()
                original = folder / ('original' + Path(filename).suffix.lower())
                shutil.copyfile(source, original)
                width, height = normalize(original, folder / 'source.png')
                collection['pages'].append({'id': page_id, 'filename': filename, 'stem': stem,
                    'width': width, 'height': height, 'source_sha256': digest_file(folder / 'source.png'),
                    'original_sha256': digest_file(original), 'edit': Edit().model_dump(),
                    'revision': 0, 'output_revision': 0, 'output': f'{page_id}/source.png'})
            atomic_json(stage / 'collection.json', collection)
            stage.rename(self.directory(cid))
            return collection
        except BaseException:
            shutil.rmtree(stage, ignore_errors=True)
            raise

    def save(self, cid, page_id, revision, edit, output=False):
        with self.lock(cid):
            collection = self.read(cid)
            page = self.page(collection, page_id)
            if page['revision'] != revision:
                raise ProjectConflict('此頁已在其他分頁更新，請重新載入後再編輯')
            normalized = validate_edit(edit, page['width'], page['height'])
            if normalized != page['edit']:
                page['revision'] += 1
                page['edit'] = normalized
            if output:
                path = Path(page_id) / f'output-{uuid.uuid4().hex}.png'
                render(self.directory(cid) / page_id / 'source.png', self.directory(cid) / path, normalized)
                page['output'] = str(path)
                page['output_revision'] = page['revision']
            collection['revision'] += 1
            self.write(collection)
            return collection

    def import_guides(self, cid, revision, workspace):
        with self.lock(cid):
            collection = self.read(cid)
            if collection['revision'] != revision:
                raise ProjectConflict('項目已更新，請重新載入')
            if workspace.version != 1:
                raise ValueError('線位檔必須是版本 1')
            names = {p['filename'] for p in collection['pages']}
            if set(workspace.images) - names:
                raise ValueError('線位檔包含此項目沒有的圖片；請核對完整檔名')
            # Validate every page before a single atomic manifest update.
            for page in collection['pages']:
                if page['filename'] in workspace.images:
                    edit = validate_edit(workspace.images[page['filename']], page['width'], page['height'])
                    if edit != page['edit']:
                        page['edit'] = edit
                        page['revision'] += 1
            collection['revision'] += 1
            self.write(collection)
            return collection

    @staticmethod
    def guides(collection):
        return {'version': 1, 'images': {p['filename']: p['edit'] for p in collection['pages']
            if p['edit']['verticalGuides'] or p['edit']['horizontalGuides']}}

    def download(self, cid):
        with self.lock(cid):
            collection = self.read(cid)
            pending = [p['filename'] for p in collection['pages'] if p['revision'] != p['output_revision']]
            if pending:
                raise ProjectConflict('以下頁面有尚未更新的輸出，請先逐頁保存：' + '、'.join(pending))
            exports = self.directory(cid) / 'exports'
            exports.mkdir(exist_ok=True)
            path = exports / f'{uuid.uuid4().hex}.zip'
            try:
                with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED, compresslevel=1) as archive:
                    for page in collection['pages']:
                        archive.write(self.directory(cid) / page['output'], f"deal/{page['stem']}.png")
                    archive.writestr('edgewhite_guides.json', json.dumps(self.guides(collection), ensure_ascii=False, indent=2))
                release = self.pin(cid)
            except BaseException:
                path.unlink(missing_ok=True)
                raise
            return path, release

    def pin(self, cid):
        with self.lock(cid):
            self.read(cid)
            self._readers[cid] = self._readers.get(cid, 0) + 1
        done = False
        def release():
            nonlocal done
            with self.lock(cid):
                if not done:
                    self._readers[cid] -= 1
                    done = True
        return release

    def delete(self, cid):
        with self.lock(cid):
            self.read(cid)
            if self._readers.get(cid, 0):
                raise ProjectConflict('項目正在下載或讀取圖片，請稍後再刪除')
            shutil.rmtree(self.directory(cid))
