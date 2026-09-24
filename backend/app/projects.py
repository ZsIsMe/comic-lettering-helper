"""Versioned project assets; never use user names as storage paths."""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import threading
import uuid
from contextlib import contextmanager
from functools import lru_cache
from pathlib import Path, PurePosixPath

from PIL import Image, ImageChops

from .repository import now_iso
from .detection_options import DetectionOptions
from .repair_scope import default_rect, validate_rect, fit_rect, scoped_mask

@lru_cache(maxsize=512)
def _has_repair_mask(path: str, modified_ns: int, size: int) -> bool:
    with Image.open(path) as mask:
        return mask.convert('L').getbbox() is not None


ACTIVE_STATES = {'queued', 'validating', 'running', 'packaging', 'abandoning'}


class ProjectConflict(ValueError):
    pass


def atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f'.{path.name}.{uuid.uuid4().hex}.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(path)


def digest_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def relative_path(value: str) -> PurePosixPath:
    if not isinstance(value, str) or not value or '\\' in value or '\x00' in value:
        raise ValueError('無效資產路徑')
    result = PurePosixPath(value)
    if result.is_absolute() or '..' in result.parts or any(':' in part for part in result.parts):
        raise ValueError('資產路徑超出項目')
    return result


class ProjectStore:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self._guard = threading.Lock()
        self._locks: dict[str, threading.RLock] = {}
        self._readers: dict[str, int] = {}

    def project_dir(self, project_id: str) -> Path:
        if not re.fullmatch(r'[a-zA-Z0-9_-]{1,80}', project_id):
            raise ValueError('無效項目 ID')
        return self.root / project_id

    def lock(self, project_id: str):
        self.project_dir(project_id)
        with self._guard:
            return self._locks.setdefault(project_id, threading.RLock())

    def read(self, project_id: str) -> dict:
        path = self.project_dir(project_id) / 'project.json'
        if not path.is_file():
            raise KeyError(project_id)
        project = json.loads(path.read_text(encoding='utf-8'))
        scope_path = path.with_name('repair_scope.json')
        project['repair_scope'] = json.loads(scope_path.read_text(encoding='utf-8')) if scope_path.exists() else {'enabled': False, 'revision': 0, 'pages': {}}
        for page in project['pages']:
            if page.get('mask_ready'):
                mask_path = self.asset_path(project_id, page['other'])
                stat = mask_path.stat()
                page['has_repair_mask'] = _has_repair_mask(str(mask_path), stat.st_mtime_ns, stat.st_size)
        return project

    def write(self, project: dict) -> None:
        project['updated_at'] = now_iso()
        # Editable bounds are local settings, excluded from project archives/imports.
        atomic_json(self.project_dir(project['id']) / 'project.json', {k: v for k, v in project.items() if k != 'repair_scope'})

    def save_repair_scope(self, project_id: str, page_id: str, revision: int, enabled: bool, rect: dict, apply_all: bool = False, repository=None) -> dict:
        with self.lock(project_id):
            project = self.read(project_id)
            self.require_idle(project, repository)
            scope = project['repair_scope']
            if type(revision) is not int or revision != scope['revision']:
                raise ProjectConflict('作用範圍已更新，請重新載入後再調整')
            if type(enabled) is not bool or type(apply_all) is not bool:
                raise ValueError('作用範圍開關無效')
            page = self.page(project, page_id)
            rect = validate_rect(rect, page['width'], page['height'])
            scope['pages'][page_id] = rect
            if apply_all:
                for item in project['pages']:
                    scope['pages'][item['id']] = fit_rect(rect, item['width'], item['height'])
            scope.update(enabled=enabled, revision=scope['revision'] + 1)
            # Invalidate pending submissions before publishing the new local bounds.
            project['revision'] += 1
            self.write(project)
            atomic_json(self.project_dir(project_id) / 'repair_scope.json', scope)
            return project

    def list(self) -> list[dict]:
        result = []
        for path in self.root.glob('*/project.json'):
            try:
                value = self.read(path.parent.name)
                value['storage_bytes'] = sum(p.stat().st_size for p in path.parent.rglob('*') if p.is_file() and not p.is_symlink())
                result.append(value)
            except (OSError, ValueError):
                continue
        return sorted(result, key=lambda item: item['updated_at'], reverse=True)

    @staticmethod
    def page(project: dict, page_id: str) -> dict:
        for page in project['pages']:
            if page['id'] == page_id:
                return page
        raise KeyError(page_id)

    def asset_path(self, project_id: str, relative: str) -> Path:
        root = self.project_dir(project_id).resolve()
        path = root.joinpath(*relative_path(relative).parts)
        if not path.resolve().is_relative_to(root):
            raise ValueError('資產路徑超出項目')
        if any(part.is_symlink() for part in [path, *path.parents] if part != root.parent):
            raise ValueError('資產不得使用符號連結')
        return path

    def require_idle(self, project: dict, repository=None, *, allow_deleting: bool = False) -> None:
        if project.get('state') not in (('ready', 'deleting', None) if allow_deleting else ('ready', None)):
            raise ProjectConflict('項目正在處理，請等待完成')
        if self._readers.get(project['id'], 0):
            raise ProjectConflict('項目資產正在下載，請等待完成')
        if repository:
            run_ids = {run['id'] for run in project.get('runs', [])}
            for job in repository.list(limit=None):
                if (job.id in run_ids or getattr(job, 'project_id', None) == project['id']) and job.state.value in ACTIVE_STATES:
                    raise ProjectConflict('項目任務正在運行，請先停止並等待完成')

    @contextmanager
    def reader(self, project_id: str):
        with self.lock(project_id):
            project = self.read(project_id)
            if project.get('state') == 'deleting':
                raise ProjectConflict('項目正在刪除')
            self._readers[project_id] = self._readers.get(project_id, 0) + 1
        try:
            yield
        finally:
            with self.lock(project_id):
                self._readers[project_id] -= 1

    def create(self, name: str, sources: dict[str, Path], masks: dict[str, Path] | None = None, *, detection_options: dict | None = None) -> dict:
        if not sources:
            raise ValueError('項目必須包含原圖')
        if masks is not None and not masks.keys() <= sources.keys():
            raise ValueError('Mask 必須按檔名配對已有原圖，不可包含多餘頁面')
        options = DetectionOptions.model_validate(detection_options).model_dump() if detection_options is not None else None
        project_id = uuid.uuid4().hex
        root = self.project_dir(project_id)
        project = {'version': 1, 'id': project_id, 'name': self.clean_name(name), 'revision': 0, 'state': 'ready', 'created_at': now_iso(), 'pages': [], 'runs': [], 'current_run_id': None}
        if options is not None:
            project['detection_options'] = options
        try:
            for order, (stem, original) in enumerate(sorted(sources.items())):
                if Path(stem).name != stem or not stem or stem in ('.', '..'):
                    raise ValueError('無效圖片檔名')
                page_id = uuid.uuid4().hex
                destination = root / 'originals' / f'{page_id}{original.suffix.lower()}'
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(original, destination)
                with Image.open(original) as image:
                    if image.getexif().get(274, 1) != 1:
                        raise ValueError(f'{stem} 含旋轉方向資訊；請先將原圖和 Mask 正規化至相同像素方向')
                    source = image.convert('RGB')
                assets = root / 'assets' / page_id
                assets.mkdir(parents=True)
                source.save(assets / 'source.png')
                thumbnail = source.copy()
                thumbnail.thumbnail((180, 240), Image.Resampling.LANCZOS)
                thumbnail.save(assets / 'thumbnail.png')
                Image.new('RGBA', source.size).save(assets / 'overlay.png')
                Image.new('L', source.size).save(assets / 'edited.png')
                other = Image.new('L', source.size)
                if masks is not None and stem in masks:
                    with Image.open(masks[stem]) as mask:
                        if mask.size != source.size:
                            raise ValueError(f'{stem} 原圖與 Mask 尺寸不一致')
                        other = mask.convert('L').point(lambda v: 255 if v >= 128 else 0)
                other.save(assets / 'other.png')
                project['pages'].append({'id': page_id, 'stem': stem, 'filename': original.name, 'order': order, 'width': source.width, 'height': source.height, 'original': str(destination.relative_to(root)), 'source': f'assets/{page_id}/source.png', 'thumbnail': f'assets/{page_id}/thumbnail.png', 'overlay': f'assets/{page_id}/overlay.png', 'other': f'assets/{page_id}/other.png', 'edited': f'assets/{page_id}/edited.png', 'edit_revision': 0, 'mask_ready': masks is not None and stem in masks, 'source_sha256': digest_file(assets / 'source.png'), 'original_sha256': digest_file(destination), 'normalization': 'RGB PNG; pixel orientation unchanged'})
            self.write(project)
            return project
        except Exception:
            shutil.rmtree(root, ignore_errors=True)
            raise

    @staticmethod
    def clean_name(name: str) -> str:
        return re.sub(r'[\\/\x00-\x1f\x7f]+', '_', str(name)).strip(' ._')[:80] or '未命名項目'

    def save_edit(self, project_id: str, page_id: str, expected_revision: int, overlay: Image.Image, other: Image.Image, edited: Image.Image, detection_metadata: dict | None = None, *, preserve_overlay: bool = False, detected_text: Image.Image | None = None) -> dict:
        with self.lock(project_id):
            project = self.read(project_id)
            if project.get('state') == 'deleting':
                raise ProjectConflict('項目正在刪除')
            page = self.page(project, page_id)
            if page['edit_revision'] != expected_revision:
                raise ProjectConflict('頁面已更新，請重新載入後再保存')
            size = (page['width'], page['height'])
            if any(image.size != size for image in (overlay, other, edited)):
                raise ValueError('編輯圖層必須保持原圖尺寸')
            if overlay.mode != 'RGBA':
                raise ValueError('填色 overlay 必須為 RGBA PNG')
            if detected_text is not None and (detected_text.mode != 'L' or detected_text.size != size):
                raise ValueError('偵測文字 Mask 必須為原尺寸灰階圖')
            # Normal edits prefer repair pixels; external Mask replacement preserves fills.
            other = other.convert('L').point(lambda v: 255 if v >= 128 else 0)
            edited = edited.convert('L').point(lambda v: 255 if v >= 128 else 0)
            overlay = overlay.copy()
            alpha = overlay.getchannel('A').point(lambda v: 255 if v >= 128 else 0)
            if preserve_overlay:
                with Image.open(self.asset_path(project_id, page['other'])) as previous:
                    previous_mask = previous.convert('L').point(lambda v: 255 if v >= 128 else 0)
                changed = ImageChops.difference(previous_mask, other)
                edited = ImageChops.lighter(edited, changed)
                other = ImageChops.multiply(other, ImageChops.invert(alpha))
            else:
                alpha.paste(0, mask=other)
            overlay.putalpha(alpha)
            revision = uuid.uuid4().hex
            target = self.project_dir(project_id) / 'revisions' / revision / page_id
            target.mkdir(parents=True)
            for key, value in [('overlay', overlay), ('other', other), ('edited', edited)]:
                value.save(target / f'{key}.png')
                page[key] = str((target / f'{key}.png').relative_to(self.project_dir(project_id)))
            if detected_text is not None:
                text_path = self.project_dir(project_id) / 'assets' / page_id / f'detected-text-{revision}.png'
                text_path.parent.mkdir(parents=True, exist_ok=True)
                detected_text.save(text_path)
                page['detected_text'] = str(text_path.relative_to(self.project_dir(project_id)))
            page['edit_revision'] += 1
            page['mask_ready'] = True
            page['has_repair_mask'] = other.getbbox() is not None
            if detection_metadata is not None:
                page['detection'] = detection_metadata
            project['revision'] += 1
            self.write(project)
            return project

    def snapshot(self, project_id: str, expected_revision: int) -> dict:
        with self.lock(project_id):
            project = self.read(project_id)
            if project['revision'] != expected_revision:
                raise ProjectConflict('項目已更新，請重新確認輸入')
            if any(not page.get('mask_ready') for page in project['pages']):
                raise ValueError('部分頁面尚未準備 Mask；缺少 Mask 不等於全黑 Mask')
            snapshot_id = uuid.uuid4().hex
            root = self.project_dir(project_id)
            pair_root = root / 'inputs' / snapshot_id / 'export_pair'
            (pair_root / 'other_mask').mkdir(parents=True)
            manifest = {'version': 1, 'id': snapshot_id, 'project_revision': project['revision'], 'created_at': now_iso(), 'pages': []}
            for page in project['pages']:
                scope = project['repair_scope']
                rect = validate_rect(scope['pages'].get(page['id'], default_rect(page['width'], page['height'])), page['width'], page['height']) if scope['enabled'] else None
                with Image.open(self.asset_path(project_id, page['source'])) as original, Image.open(self.asset_path(project_id, page['overlay'])) as overlay, Image.open(self.asset_path(project_id, page['other'])) as mask:
                    base = Image.alpha_composite(original.convert('RGBA'), overlay.convert('RGBA')).convert('RGB')
                    other = mask.convert('L').point(lambda v: 255 if v >= 128 else 0)
                    if rect is not None:
                        other = scoped_mask(other, rect)
                    source_path = pair_root / f"{page['stem']}.png"
                    mask_path = pair_root / 'other_mask' / f"{page['stem']}.png"
                    base.save(source_path)
                    other.save(mask_path)
                manifest['pages'].append({'page_id': page['id'], 'stem': page['stem'], 'edit_revision': page['edit_revision'], 'source': str(source_path.relative_to(root)), 'mask': str(mask_path.relative_to(root)), 'source_sha256': digest_file(source_path), 'mask_sha256': digest_file(mask_path), 'passthrough': other.getbbox() is None})
                if rect is not None:
                    manifest['pages'][-1]['repair_rect'] = rect
            atomic_json(pair_root.parent / 'manifest.json', manifest)
            return manifest
