from __future__ import annotations

import tempfile
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StrictInt, ValidationError
from starlette.concurrency import run_in_threadpool

from .edgewhite import EdgeWhiteStore
from .projects import ProjectConflict
from imaging.edgewhite import Edit


class Save(BaseModel):
    model_config = ConfigDict(extra='forbid')
    revision: StrictInt = Field(ge=0)
    edit: Edit
    output: bool = False


class Workspace(BaseModel):
    model_config = ConfigDict(extra='forbid')
    version: StrictInt
    images: dict[str, Edit] = Field(max_length=10000)


class Import(BaseModel):
    model_config = ConfigDict(extra='forbid')
    revision: StrictInt = Field(ge=0)
    workspace: Workspace


class LeasedFile(FileResponse):
    def __init__(self, path, release, *, temporary=False, **kwargs):
        super().__init__(path, **kwargs)
        self.release = release
        self.temporary = temporary

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            if self.temporary:
                Path(self.path).unlink(missing_ok=True)
            self.release()


def create_edgewhite_router(settings, gpu_gate, store=None):
    store = store or EdgeWhiteStore(settings.data_root / 'edgewhite')
    router = APIRouter(prefix='/api/edgewhite', tags=['edgewhite'])
    max_bytes = settings.max_upload_mb * 1024 * 1024

    def work(callback, *args):
        try:
            with store.cpu_gate:
                return callback(*args)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        except ProjectConflict as exc:
            raise HTTPException(409, str(exc)) from exc
        except (ValueError, OSError, ValidationError) as exc:
            raise HTTPException(400, str(exc)) from exc

    def require_idle():
        if gpu_gate.owner:
            raise HTTPException(409, 'GPU 任務處理中，暫停新增上傳與整批下載；已載入圖片仍可編輯')

    @router.get('')
    def listing():
        return work(store.list)

    @router.post('', status_code=201)
    async def create(name: str = Form(''), source_files: list[UploadFile] = File(...)):
        require_idle()
        if len(source_files) > 10000:
            raise HTTPException(400, '一次最多匯入 10000 張圖片')
        with tempfile.TemporaryDirectory(prefix='edgewhite-upload-') as temporary:
            files, size = [], 0
            for index, upload in enumerate(source_files):
                filename = upload.filename or ''
                if filename.startswith('._'):
                    continue
                path = Path(temporary) / str(index)
                with path.open('wb') as handle:
                    while data := await upload.read(1024 * 1024):
                        size += len(data)
                        if size > max_bytes:
                            raise HTTPException(413, '整批上傳超過大小限制')
                        await run_in_threadpool(handle.write, data)
                files.append((filename, path))
            require_idle()
            return await run_in_threadpool(work, store.create, name, files)

    @router.get('/{cid}')
    def get(cid: str):
        return work(store.read, cid)

    @router.delete('/{cid}')
    def delete(cid: str, confirm: bool = False):
        if not confirm:
            raise HTTPException(400, '請確認刪除項目')
        work(store.delete, cid)
        return {'deleted': True}

    @router.get('/{cid}/pages/{page_id}/source')
    def source(cid: str, page_id: str):
        def response():
            with store.lock(cid):
                store.page(store.read(cid), page_id)
                return LeasedFile(store.directory(cid) / page_id / 'source.png', store.pin(cid),
                    media_type='image/png', headers={'Cache-Control': 'private, max-age=31536000, immutable'})
        return work(response)

    @router.put('/{cid}/pages/{page_id}')
    def save(cid: str, page_id: str, body: Save):
        return work(store.save, cid, page_id, body.revision, body.edit, body.output)

    @router.get('/{cid}/guides')
    def guides(cid: str):
        return JSONResponse(store.guides(work(store.read, cid)), headers={'Content-Disposition': 'attachment; filename="edgewhite_guides.json"'})

    @router.put('/{cid}/guides')
    def import_guides(cid: str, body: Import):
        require_idle()
        return work(store.import_guides, cid, body.revision, body.workspace)

    @router.post('/{cid}/guides')
    async def upload_guides(cid: str, revision: int = Form(...), workspace_file: UploadFile = File(...)):
        require_idle()
        data = await workspace_file.read(16 * 1024 * 1024 + 1)
        if len(data) > 16 * 1024 * 1024:
            raise HTTPException(413, '線位 JSON 超過 16 MB')
        def parse_and_import():
            try:
                workspace = Workspace.model_validate_json(data)
            except (ValidationError, ValueError) as exc:
                raise ValueError('線位 JSON 無法解析或欄位格式不正確') from exc
            return store.import_guides(cid, revision, workspace)
        return await run_in_threadpool(work, parse_and_import)

    @router.get('/{cid}/download')
    def download(cid: str):
        require_idle()
        path, release = work(store.download, cid)
        return LeasedFile(path, release, temporary=True, filename='edgewhite-results.zip', media_type='application/zip')

    return router
