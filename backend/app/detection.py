"""Persistent optional detection tasks sharing the existing repair GPU gate."""
from __future__ import annotations

import asyncio
from copy import deepcopy
import json
import os
from pathlib import Path
import time
import urllib.request
import uuid

from fastapi import APIRouter, HTTPException
from PIL import Image, ImageChops
from pydantic import BaseModel, Field

from .detection_options import DetectionOptions
from .projects import ProjectConflict, atomic_json
from .repository import now_iso

ACTIVE = {'queued', 'checking', 'rf', 'mangalens', 'classify', 'saving', 'cancelling', 'recovery_required'}


class DetectionRequest(BaseModel):
    expected_revision: int = Field(ge=0)
    page_ids: list[str] | None = None
    replace_existing: bool = False
    options: DetectionOptions | None = None


def pid_alive(pid):
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


class DetectionManager:
    def __init__(self, settings, store, gpu_gate):
        self.settings, self.store, self.gpu_gate = settings, store, gpu_gate
        self.config_path = Path(os.environ.get('COMIC_DETECTION_CONFIG', str(settings.app_root / 'config/detection-models.json')))
        self.python = os.environ.get('COMIC_DETECTION_PYTHON', '')
        self.task = None
        self.process = None
        self.active_id = None
        self.active_project = None
        self.cancel_requested = False

    def availability(self):
        # This imports only the stdlib adapter configuration, not torch/cv2.
        from imaging.models import load_config, validate_weights, detection_options
        errors, errors_without_bubbles = [], []
        device = None
        defaults = None
        try:
            config = load_config(self.config_path)
            device = config['device']
            defaults = DetectionOptions(**detection_options(config)).model_dump()
            for enabled, target in ((True, errors), (False, errors_without_bubbles)):
                candidate = deepcopy(config)
                candidate['mangalens']['enabled'] = enabled
                try:
                    validate_weights(candidate, verify_hash=False)
                except (OSError, KeyError, ValueError, RuntimeError) as exc:
                    target.append(str(exc))
        except (OSError, KeyError, ValueError, RuntimeError) as exc:
            errors.append(str(exc))
            errors_without_bubbles.append(str(exc))
        if not self.python or not Path(self.python).is_file() or not os.access(self.python, os.X_OK):
            message = '請設定 COMIC_DETECTION_PYTHON 為獨立偵測環境的 Python 執行檔'
            errors.append(message)
            errors_without_bubbles.append(message)
        return {'available': not errors, 'errors': errors, 'gpu_verified': False,
                'available_without_bubbles': not errors_without_bubbles,
                'errors_without_bubbles': errors_without_bubbles, 'defaults': defaults,
                'active_id': self.active_id, 'device': device}

    def _task_dir(self, project_id, detection_id):
        if not isinstance(detection_id, str) or len(detection_id) != 32 or any(c not in '0123456789abcdef' for c in detection_id):
            raise ValueError('無效偵測 ID')
        return self.store.project_dir(project_id) / 'detections' / detection_id

    def _write(self, record):
        record['updated_at'] = now_iso()
        atomic_json(self._task_dir(record['project_id'], record['id']) / 'status.json', record)

    def status(self, project_id):
        project = self.store.read(project_id)
        detection_id = project.get('detection_id')
        if not detection_id:
            return None
        path = self._task_dir(project_id, detection_id)
        value = json.loads((path / 'status.json').read_text())
        progress = path / 'progress.json'
        if progress.is_file():
            try:
                value['progress'] = json.loads(progress.read_text())
            except (OSError, ValueError):
                pass
        return value

    def _unlock_project(self, project_id, detection_id):
        with self.store.lock(project_id):
            project = self.store.read(project_id)
            if project.get('detection_id') == detection_id and project.get('state') == 'detecting':
                project['state'] = 'ready'
                self.store.write(project)

    async def start(self):
        # Resume requires a fresh explicit request. Never replay a CUDA stage.
        for path in self.store.root.glob('*/detections/*/status.json'):
            try:
                record = json.loads(path.read_text())
                if record.get('state') not in ACTIVE:
                    continue
                if pid_alive(record.get('pid')):
                    record['state'] = 'recovery_required'
                    record['error'] = '服務已重啟；偵測程序仍存在，等待程序退出後再恢復'
                    if self.gpu_gate.claim(record['id']):
                        self.active_id, self.active_project = record['id'], record['project_id']
                else:
                    record['state'] = 'failed'
                    record['error'] = '服務重啟中斷偵測；已保留結果快取，請重新發起'
                    record['pid'] = None
                    self._unlock_project(record['project_id'], record['id'])
                self._write(record)
            except (OSError, KeyError, ValueError):
                continue

    async def stop(self):
        self.cancel_requested = True
        if self.process and self.process.returncode is None:
            self.process.terminate()
        if self.task:
            await self.task

    async def submit(self, project_id, request):
        available = self.availability()
        from imaging.models import load_config, detection_options
        try:
            frozen_config = load_config(self.config_path)
            options = request.options or DetectionOptions(**detection_options(frozen_config))
        except (OSError, KeyError, ValueError, RuntimeError) as exc:
            raise ValueError(str(exc)) from exc
        enabled = options.bubble_enabled
        ready = available['available'] if enabled else available.get('available_without_bubbles', available['available'])
        if not ready:
            errors = available['errors'] if enabled else available.get('errors_without_bubbles', available['errors'])
            raise ValueError('；'.join(errors))
        # These four user settings only affect this task's frozen configuration.
        frozen_config['rf'].update(mask_dilate=options.mask_dilate, mask_mode=options.mask_mode)
        frozen_config['mangalens'].update(enabled=enabled, shrink_ratio=options.bubble_shrink_percent / 100)
        effective_options = options.model_dump()
        detection_id = uuid.uuid4().hex
        if not self.gpu_gate.claim(detection_id):
            raise ProjectConflict('GPU 正在處理其他任務')
        try:
            with self.store.lock(project_id):
                project = self.store.read(project_id)
                self.store.require_idle(project)
                if project.get('state') == 'deleting':
                    raise ProjectConflict('項目正在刪除')
                if project['revision'] != request.expected_revision:
                    raise ProjectConflict('項目已更新，請重新載入後再偵測')
                ids = request.page_ids if request.page_ids is not None else [p['id'] for p in project['pages']]
                if not ids or len(set(ids)) != len(ids):
                    raise ValueError('請選擇不重複的頁面')
                selected = [self.store.page(project, page_id) for page_id in ids]
                root = self._task_dir(project_id, detection_id)
                root.mkdir(parents=True)
                pages = []
                for page in selected:
                    entry = {'id': page['id'], 'expected_revision': page['edit_revision'],
                             'output': str(root / 'outputs' / page['id'])}
                    # Revisions/assets are immutable while the project is locked.
                    for key in ('source', 'overlay', 'other', 'edited'):
                        entry[key] = str(self.store.asset_path(project_id, page[key]))
                    if request.replace_existing:
                        # Reset only the isolated task input. Authoritative layers
                        # remain intact until every output has been validated.
                        inputs = root / 'inputs' / page['id']
                        inputs.mkdir(parents=True)
                        for key, mode in (('overlay', 'RGBA'), ('other', 'L'), ('edited', 'L')):
                            path = inputs / f'{key}.png'
                            Image.new(mode, (page['width'], page['height'])).save(path)
                            entry[key] = str(path)
                    pages.append(entry)
                atomic_json(root / 'manifest.json', {'version': 1, 'pages': pages,
                                                   'replace_existing': request.replace_existing,
                                                   'options': effective_options})
                # Freeze config, including environment-resolved model paths.
                for name in ('rf', 'mangalens'):
                    frozen_config[name].pop('path_env', None)
                atomic_json(root / 'config.json', frozen_config)
                record = {'id': detection_id, 'project_id': project_id, 'state': 'queued', 'pid': None,
                          'device': frozen_config['device'],
                          'replace_existing': request.replace_existing,
                          'options': effective_options,
                          'created_at': now_iso(), 'total': len(pages), 'error': None, 'applied': []}
                self._write(record)
                project.update(state='detecting', detection_id=detection_id, detection_options=effective_options)
                self.store.write(project)
            self.active_id, self.active_project = detection_id, project_id
            self.cancel_requested = False
            self.task = asyncio.create_task(self._run(record))
            return record
        except BaseException:
            self.gpu_gate.release(detection_id)
            raise

    def _comfy_release(self):
        def call(endpoint, payload=None):
            req = urllib.request.Request(self.settings.comfy_url + endpoint,
                data=None if payload is None else json.dumps(payload).encode(),
                headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, timeout=20) as response:
                body = response.read()
                return json.loads(body) if body else {}
        for before in (True, False):
            queue = call('/queue')
            if not isinstance(queue.get('queue_running'), list) or not isinstance(queue.get('queue_pending'), list):
                raise RuntimeError('無法確認 ComfyUI 佇列，未啟動偵測')
            if queue['queue_running'] or queue['queue_pending']:
                raise ProjectConflict('ComfyUI 有正在執行或排隊的外部工作，未啟動偵測')
            if before:
                call('/free', {'unload_models': True, 'free_memory': True})
                time.sleep(1)

    async def _stage(self, record, stage):
        root = self._task_dir(record['project_id'], record['id'])
        record['state'] = 'checking' if stage == 'check' else stage
        record['stage_started_at'] = now_iso()
        self._write(record)
        # Clear stale progress before launching a new stage.
        atomic_json(root / 'progress.json', {'stage': stage, 'completed': 0, 'total': record['total']})
        env = dict(os.environ)
        env['PYTHONPATH'] = str(self.settings.app_root / 'backend')
        env['PYTHONUNBUFFERED'] = '1'
        env['HF_HUB_OFFLINE'] = '1'
        env['TRANSFORMERS_OFFLINE'] = '1'
        env['YOLO_OFFLINE'] = 'true'
        env['YOLO_AUTOINSTALL'] = 'false'
        runtime_cache = self.settings.data_root / 'runtime-cache'
        for directory in ('ultralytics', 'matplotlib'):
            (runtime_cache / directory).mkdir(parents=True, exist_ok=True)
        env['YOLO_CONFIG_DIR'] = str(runtime_cache / 'ultralytics')
        env['MPLCONFIGDIR'] = str(runtime_cache / 'matplotlib')
        with (root / 'worker.log').open('ab') as log:
            self.process = await asyncio.create_subprocess_exec(self.python, '-m', 'imaging.worker',
                '--stage', stage, '--manifest', str(root / 'manifest.json'), '--config', str(root / 'config.json'),
                '--progress', str(root / 'progress.json'), cwd=str(self.settings.app_root), env=env,
                stdout=log, stderr=asyncio.subprocess.STDOUT, start_new_session=True)
            record['pid'] = self.process.pid
            self._write(record)
            if self.cancel_requested:
                self.process.terminate()
            code = await self.process.wait()
        self.process = None
        record['pid'] = None
        self._write(record)
        if self.cancel_requested:
            raise asyncio.CancelledError()
        if code:
            progress = json.loads((root / 'progress.json').read_text())
            raise RuntimeError(progress.get('error') or f'偵測階段 {stage} 失敗（退出碼 {code}），請查看工作日誌')

    def _apply(self, record):
        root = self._task_dir(record['project_id'], record['id'])
        device = record.get('device', 'cuda:0')
        options = record.get('options')
        models = ['rf', 'mangalens'] if options is None or options['bubble_enabled'] else ['rf']
        manifest = json.loads((root / 'manifest.json').read_text())
        with self.store.lock(record['project_id']):
            if self.cancel_requested:
                raise asyncio.CancelledError()
            project = self.store.read(record['project_id'])
            # Verify the whole batch before writing any authoritative edit.
            for entry in manifest['pages']:
                page = self.store.page(project, entry['id'])
                if page['edit_revision'] != entry['expected_revision']:
                    raise ProjectConflict('偵測期間頁面已更新，結果保留在快取，未覆蓋編輯')
                output = Path(entry['output'])
                with Image.open(output / 'overlay.png') as overlay, Image.open(output / 'other.png') as other, Image.open(output / 'edited.png') as edited, Image.open(output / 'text_mask.png') as detected_text:
                    if overlay.mode != 'RGBA' or other.mode != 'L' or edited.mode != 'L' or detected_text.mode != 'L':
                        raise ValueError('偵測輸出圖層格式不正確')
                    if any(image.size != (page['width'], page['height']) for image in (overlay, other, edited, detected_text)):
                        raise ValueError('偵測輸出圖層尺寸不一致')
                    for image in (overlay, other, edited, detected_text):
                        image.load()
                    if ImageChops.multiply(overlay.getchannel('A'), other).getbbox():
                        raise ValueError('偵測輸出兩類選區重疊')
            for entry in manifest['pages']:
                output = Path(entry['output'])
                with Image.open(output / 'overlay.png') as overlay, Image.open(output / 'other.png') as other, Image.open(output / 'edited.png') as edited, Image.open(output / 'text_mask.png') as detected_text:
                    self.store.save_edit(record['project_id'], entry['id'], entry['expected_revision'], overlay, other, edited,
                        detection_metadata={'id': record['id'], 'models': models, 'device': device,
                            'options': options,
                            'replace_existing': record.get('replace_existing', False),
                            'cache': str(output.relative_to(self.store.project_dir(record['project_id'])))},
                        detected_text=detected_text)
                record['applied'].append(entry['id'])
                self._write(record)

    async def _run(self, record):
        try:
            if record.get('device', 'cuda:0') == 'cuda:0':
                await asyncio.to_thread(self._comfy_release)
            for stage in ('check', 'rf', 'mangalens', 'classify'):
                if self.cancel_requested:
                    raise asyncio.CancelledError()
                await self._stage(record, stage)
            if self.cancel_requested:
                raise asyncio.CancelledError()
            record['state'] = 'saving'
            self._write(record)
            await asyncio.to_thread(self._apply, record)
            record['state'] = 'completed'
        except asyncio.CancelledError:
            record['state'] = 'cancelled'
        except Exception as exc:
            record['state'], record['error'] = 'failed', str(exc)
        finally:
            # Do not free ownership while a process might still touch CUDA.
            if self.process and self.process.returncode is None:
                self.process.terminate()
                await self.process.wait()
            self.process = None
            record['pid'] = None
            try:
                self._write(record)
                self._unlock_project(record['project_id'], record['id'])
            finally:
                self.gpu_gate.release(record['id'])
                self.active_id = self.active_project = None

    async def cancel(self, project_id):
        record = self.status(project_id)
        if not record or record['state'] not in ACTIVE:
            raise ProjectConflict('沒有可停止的偵測任務')
        if record['state'] == 'recovery_required':
            raise ProjectConflict('重啟前程序需先退出；之後使用恢復操作')
        if project_id != self.active_project:
            raise ProjectConflict('任務狀態不一致，請重新載入')
        self.cancel_requested = True
        if self.process and self.process.returncode is None:
            self.process.terminate()
        return {'state': 'cancelling', 'id': record['id']}

    def recover(self, project_id):
        record = self.status(project_id)
        if not record or record['state'] != 'recovery_required':
            raise ProjectConflict('沒有待恢復的偵測任務')
        if pid_alive(record.get('pid')):
            raise ProjectConflict('偵測程序仍存在，GPU 保留尚不能解除')
        record.update(state='failed', pid=None, error='中斷程序已退出；可重新發起偵測')
        self._write(record)
        self._unlock_project(project_id, record['id'])
        self.gpu_gate.release(record['id'])
        if self.active_id == record['id']:
            self.active_id = self.active_project = None
        return record


def create_detection_router(manager):
    router = APIRouter(prefix='/api', tags=['detection'])

    def error(exc):
        code = 409 if isinstance(exc, ProjectConflict) else 404 if isinstance(exc, KeyError) else 400
        return HTTPException(code, str(exc))

    @router.get('/detection/availability')
    def availability():
        return manager.availability()

    @router.post('/projects/{project_id}/detect', status_code=202)
    async def detect(project_id: str, request: DetectionRequest):
        try:
            return await manager.submit(project_id, request)
        except (OSError, ValueError, KeyError) as exc:
            raise error(exc) from exc

    @router.get('/projects/{project_id}/detection')
    def status(project_id: str):
        try:
            return manager.status(project_id)
        except (OSError, ValueError, KeyError) as exc:
            raise error(exc) from exc

    @router.post('/projects/{project_id}/detection/cancel')
    async def cancel(project_id: str):
        try:
            return await manager.cancel(project_id)
        except (OSError, ValueError, KeyError) as exc:
            raise error(exc) from exc

    @router.post('/projects/{project_id}/detection/recover')
    def recover(project_id: str):
        try:
            return manager.recover(project_id)
        except (OSError, ValueError, KeyError) as exc:
            raise error(exc) from exc

    return router
