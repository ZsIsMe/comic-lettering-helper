"""API admission and durable progress for the isolated update worker."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time
import uuid

from fastapi import APIRouter, HTTPException, Request
from starlette.responses import JSONResponse

from . import updates
from .request_security import same_page_request
from .update_worker import ACTIVE, atomic


class Installer:
    def __init__(self, settings, manager):
        self.settings, self.manager = settings, manager
        self.root = settings.data_root / 'updates'
        self.state_file = self.root / 'status.json'
        self.lock = threading.RLock()
        self.requests = 0
        self.reserved = False

    def status(self):
        try:
            value = json.loads(self.state_file.read_text())
        except FileNotFoundError:
            return {'state': 'idle', 'message': ''}
        if value['state'] in ACTIVE and value.get('pid'):
            try:
                os.kill(value['pid'], 0)
            except ProcessLookupError:
                value.update(state='failed', message='更新程序已停止，備份已保留；請重試或聯絡管理員')
                atomic(self.state_file, value)
        return value

    def busy(self):
        return self.reserved or self.status()['state'] in ACTIVE

    def launch(self, version):
        with self.lock:
            if self.busy() or self.requests:
                raise HTTPException(409, '目前有上傳、保存、下載或更新正在處理，請稍後再試')
            if self.manager.active_job_id or any(str(r.state) in {'queued', 'validating', 'running', 'packaging', 'abandoning'}
                                                 for r in self.manager.repository.list(limit=None)):
                raise HTTPException(409, '請等待修復任務完成後更新')
            if not self.manager.gpu_gate.claim('application-update'):
                raise HTTPException(409, '請等待偵測或 GPU 任務完成後更新')
            self.reserved = True
            try:
                folder = self.root / uuid.uuid4().hex
                folder.mkdir(parents=True)
                worker = folder / 'worker.py'
                shutil.copyfile(Path(__file__).with_name('update_worker.py'), worker)
                shutil.copyfile(Path(__file__).with_name('release_sources.py'), folder / 'release_sources.py')
                atomic(self.state_file, {'state': 'queued', 'message': '準備更新',
                                        'version': version, 'started_at': time.time()})
                env = dict(os.environ, COMIC_APP_ROOT=str(self.settings.app_root), COMIC_DATA_ROOT=str(self.settings.data_root))
                with (folder / 'worker.log').open('wb') as log:
                    process = subprocess.Popen([sys.executable, str(worker), str(self.settings.app_root),
                        str(folder), str(self.state_file), version, updates.APP_VERSION, 'http://127.0.0.1:6008'],
                        stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True, env=env)
                def finish():
                    process.wait()
                    with self.lock:
                        self.reserved = False
                        self.manager.gpu_gate.release('application-update')
                        value = self.status()
                        if value['state'] == 'queued':
                            value.update(state='failed', message='無法啟動更新程序，請重試')
                            atomic(self.state_file, value)
                threading.Thread(target=finish, daemon=True).start()
                return {'state': 'queued', 'message': '準備更新', 'version': version}
            except Exception:
                self.reserved = False
                self.manager.gpu_gate.release('application-update')
                atomic(self.state_file, {'state': 'failed', 'message': '無法啟動更新程序，應用未變更'})
                raise


class MaintenanceMiddleware:
    def __init__(self, app, installer):
        self.app, self.installer = app, installer

    async def __call__(self, scope, receive, send):
        path = scope.get('path', '')
        guarded = scope['type'] == 'http' and path.startswith('/api/') and path != '/api/health' and not path.startswith('/api/app/')
        if not guarded:
            return await self.app(scope, receive, send)
        with self.installer.lock:
            rejected = self.installer.busy()
            if not rejected:
                self.installer.requests += 1
        if rejected:
            return await JSONResponse({'detail': '應用正在更新，請等待重新連線'}, status_code=503)(scope, receive, send)
        try:
            await self.app(scope, receive, send)
        finally:
            with self.installer.lock:
                self.installer.requests -= 1


def router(installer):
    api = APIRouter(prefix='/api/app')

    @api.get('/update-status')
    def status():
        return installer.status()

    @api.post('/install-update', status_code=202)
    async def install(request: Request):
        if request.headers.get('x-comic-update') != '1':
            raise HTTPException(403, '請從網頁更新按鈕提交')
        if not same_page_request(request):
            raise HTTPException(403, '更新要求必須來自同一個網頁')
        data = await request.json()
        version = data.get('version')
        if updates.version_key(version) is None or updates.version_key(version) <= updates.version_key(updates.APP_VERSION):
            raise HTTPException(400, '只能安裝較新的正式版本')
        # Fresh fixed-repository lookup: do not trust a client URL or a stale check.
        from starlette.concurrency import run_in_threadpool
        try:
            await run_in_threadpool(updates.release_sources.resolve_release, version)
        except Exception:
            raise HTTPException(502, '無法確認正式版本，請稍後重試')
        return installer.launch(version)
    return api
