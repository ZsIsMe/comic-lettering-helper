from __future__ import annotations

import json
import asyncio
import re

from fastapi import APIRouter, Body, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from starlette.concurrency import run_in_threadpool

from .store import Conflict


class ArchiveResponse(FileResponse):
    def __init__(self, path, lease, filename='prelayout.zip', remove=True):
        super().__init__(path, filename=filename)
        self.lease = lease
        self.remove = remove

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            # Also release on a disconnected client, rather than relying on a success-only callback.
            try:
                if self.remove:
                    self.path.unlink(missing_ok=True)
            finally:
                self.lease.__exit__(None, None, None)


def router(store, detector, max_bytes):
    api = APIRouter(prefix='/api/prelayout', tags=['prelayout'])
    upload_slots = asyncio.Semaphore(1)

    def call(function, *args):
        try:
            return function(*args)
        except Conflict as exc:
            raise HTTPException(409, str(exc)) from exc
        except (KeyError, FileNotFoundError) as exc:
            raise HTTPException(404, str(exc)) from exc
        except (ValueError, OSError) as exc:
            raise HTTPException(400, str(exc)) from exc

    async def uploads(files):
        result, total = [], 0
        for file in files:
            chunks = []
            while chunk := await file.read(1024 * 1024):
                total += len(chunk)
                if total > max_bytes:
                    raise HTTPException(413, '上傳資料超過限制')
                chunks.append(chunk)
            result.append((file.filename or '', b''.join(chunks)))
        return result

    @api.get('/availability')
    def availability():
        return detector.availability()

    @api.get('/font')
    def font():
        path = detector.models / 'NotoSansCJKjp-Medium.otf'
        if not path.is_file():
            raise HTTPException(404, '尚未準備預覽字型')
        return FileResponse(path, media_type='font/otf', headers={'Cache-Control': 'private, max-age=86400'})

    @api.get('/projects')
    def projects():
        return call(store.list)

    @api.post('/projects', status_code=201)
    async def create(name: str = Form(''), source_files: list[UploadFile] = File(...)):
        async with upload_slots:
            data = await uploads(source_files)
            return await run_in_threadpool(call, store.create, name, data)

    @api.post('/projects/import', status_code=201)
    async def import_project(archive: UploadFile = File(...)):
        async with upload_slots:
            data = await uploads([archive])
            return await run_in_threadpool(call, store.import_archive, data[0][1], max_bytes)

    @api.get('/projects/{pid}')
    def project(pid: str):
        return call(store.read, pid)

    @api.patch('/projects/{pid}')
    def rename(pid: str, data: dict = Body(...)):
        with store.lock(pid):
            record = call(store.read, pid)
            record['name'] = str(data.get('name', '')).strip()[:80] or record['name']
            record['revision'] += 1
            call(store.write, record)
            return record

    @api.put('/projects/{pid}/groups')
    def groups(pid: str, data: dict = Body(...)):
        return call(store.update_groups, pid, data.get('expected_revision'), data.get('names'))

    @api.delete('/projects/{pid}')
    def delete(pid: str):
        with store.lock(pid):
            if detector.busy(pid):
                raise HTTPException(409, '此項目正在偵測，請等待完成或取消')
            call(store.delete, pid)
            return {'deleted': pid}

    @api.get('/projects/{pid}/pages/{page_id}')
    def page(pid: str, page_id: str):
        with store.lock(pid):
            return call(store.page, pid, page_id)

    @api.patch('/projects/{pid}/pages/{page_id}/text')
    def save(pid: str, page_id: str, data: dict = Body(...)):
        if not isinstance(data.get('operation_id'), str) or not data['operation_id'].strip() or len(data['operation_id']) > 100:
            raise HTTPException(400, '缺少有效操作 ID')
        return call(store.save_page, pid, page_id, data.get('expected_revision'), data.get('items'), data['operation_id'])

    @api.put('/projects/{pid}/pages/{page_id}/review')
    def review(pid: str, page_id: str, data: dict = Body(...)):
        return call(store.review_page, pid, page_id, data.get('expected_revision'), data.get('reviewed'))

    @api.post('/projects/{pid}/imports')
    async def import_data(pid: str, kind: str = Form(...), expected_revision: int = Form(...), apply: bool = Form(False), files: list[UploadFile] = File(...)):
        async with upload_slots:
            data = await uploads(files)
            if kind == 'clean':
                return await run_in_threadpool(call, store.clean_images, pid, data, expected_revision)
            if kind not in ('bt', 'labelplus') or len(data) != 1:
                raise HTTPException(400, '請選擇一份 BT 或 LabelPlus 文件')
            return await run_in_threadpool(call, store.import_translation, pid, data[0][1], kind, expected_revision, apply)

    @api.get('/projects/{pid}/pages/{page_id}/preview')
    def preview(pid: str, page_id: str, edge: int = 1536, clean: bool = False, x: int | None = None, y: int | None = None, w: int | None = None, h: int | None = None):
        values = (x, y, w, h)
        if any(v is not None for v in values) and not all(v is not None for v in values):
            raise HTTPException(400, '局部圖片需完整範圍')
        with store.preview_slots:
            payload, key = call(store.preview, pid, page_id, edge, clean, values if x is not None else None)
        return Response(payload, media_type='image/jpeg', headers={'ETag': f'"{key}"', 'Cache-Control': 'private, max-age=3600'})

    @api.get('/projects/{pid}/export/bt')
    def export_bt(pid: str):
        with store.lock(pid):
            data = call(store.translation, pid)
            return Response(json.dumps(data, ensure_ascii=False, indent=2), media_type='application/json',
                            headers={'Content-Disposition': 'attachment; filename="Meo.json"'})

    @api.post('/projects/{pid}/matches')
    def matches(pid: str):
        return call(store.matches, pid)

    @api.post('/projects/{pid}/matches/apply')
    def apply_matches(pid: str, data: dict = Body(...)):
        return call(store.apply_matches, pid, data.get('expected_revision'), data.get('manual', {}))

    @api.post('/projects/{pid}/detections', status_code=202)
    async def detect(pid: str, data: dict = Body(...)):
        try:
            return await detector.submit(pid, data)
        except (ValueError, KeyError) as exc:
            raise HTTPException(409 if isinstance(exc, Conflict) else 400, str(exc)) from exc

    @api.get('/projects/{pid}/detections')
    def detection(pid: str):
        return call(detector.status, pid)

    @api.get('/projects/{pid}/detections/{did}/log')
    def detection_log(pid: str, did: str):
        if not re.fullmatch(r'd_[a-f0-9]{32}', did):
            raise HTTPException(404, '偵測任務不存在')
        lease = store.reader(pid)
        call(lease.__enter__)
        try:
            path = detector.task_path(pid, did).parent / 'worker.log'
            if not path.is_file():
                raise HTTPException(404, '此任務尚無執行日誌')
            return ArchiveResponse(path, lease, filename=f'{did}.log', remove=False)
        except BaseException:
            lease.__exit__(None, None, None)
            raise

    @api.post('/projects/{pid}/detections/cancel')
    async def cancel(pid: str):
        try:
            return await detector.cancel(pid)
        except Conflict as exc:
            raise HTTPException(409, str(exc)) from exc
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc

    @api.get('/preferences')
    def preferences():
        return call(store.preferences)

    @api.put('/preferences')
    def save_preferences(data: list = Body(...)):
        return call(store.preferences, data)

    return api
