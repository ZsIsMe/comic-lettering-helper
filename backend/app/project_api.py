"""HTTP project lifecycle. GPU inference remains in the existing JobManager."""
from __future__ import annotations

import json
import shutil
import tempfile
import uuid
import zipfile
from pathlib import Path

from fastapi import APIRouter, Body, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from PIL import Image
from starlette.concurrency import run_in_threadpool
from starlette.background import BackgroundTask

from .projects import ACTIVE_STATES, ProjectConflict, ProjectStore, atomic_json, digest_file, relative_path
from .repository import now_iso
from .schemas import JobRecord
from .storage import save_uploads

ORDER = ['flux2klein_lanpaint', 'firered', 'qwen2511_lanpaint']


def fail(exc: Exception):
    if isinstance(exc, KeyError):
        raise HTTPException(404, '項目、頁面或資產不存在') from exc
    if isinstance(exc, ProjectConflict):
        raise HTTPException(409, str(exc)) from exc
    if isinstance(exc, (ValueError, OSError, zipfile.BadZipFile)):
        raise HTTPException(400, str(exc)) from exc
    raise exc


def project_download(store: ProjectStore, pid: str, path: Path, filename: str, media_type='application/zip'):
    # Acquire before returning response so delete cannot win before streaming starts.
    reader = store.reader(pid)
    reader.__enter__()
    try:
        handle = path.open('rb')
    except BaseException:
        reader.__exit__(None, None, None)
        raise

    closed = False

    def close():
        nonlocal closed
        if not closed:
            closed = True
            handle.close()
            reader.__exit__(None, None, None)

    async def stream():
        try:
            while chunk := await run_in_threadpool(handle.read, 1024 * 1024):
                yield chunk
        finally:
            close()
    from urllib.parse import quote
    return StreamingResponse(stream(), media_type=media_type, headers={'Content-Disposition': f"attachment; filename*=UTF-8''{quote(filename)}", 'Content-Length': str(path.stat().st_size)}, background=BackgroundTask(close))


def _write_zip(path: Path, entries: dict[str, Path], extra: dict | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_STORED) as archive:
        for relative, source in sorted(entries.items()):
            archive.write(source, relative)
        if extra is not None:
            archive.writestr('archive.json', json.dumps(extra, ensure_ascii=False))


def export_project(store: ProjectStore, repository, pid: str) -> Path:
    with store.lock(pid):
        project = store.read(pid)
        store.require_idle(project, repository)
        root = store.project_dir(pid)
        entries = {}
        thumbnails = {page.get('thumbnail') for page in project['pages']}
        for path in root.rglob('*'):
            relative = str(path.relative_to(root))
            if relative in thumbnails or relative.split('/')[0] in {'exports', 'logs'} or path.is_dir():
                continue
            if path.is_symlink():
                raise ValueError('項目封存不接受符號連結')
            if relative.split('/')[0] == 'detections' and 'outputs' not in path.relative_to(root).parts:
                continue
            entries[relative] = path
        for run in project['runs']:
            job = repository.read(run['id'])
            if getattr(job, 'project_id', None) not in (None, pid):
                raise ValueError('修復記錄不屬於此項目')
            job_root = repository.job_dir(job.id)
            for path in job_root.rglob('*'):
                if not path.is_file() or path.name.endswith(('.zip', '.tmp')) or 'pdf-stage' in path.relative_to(job_root).parts:
                    continue
                if path.is_symlink():
                    raise ValueError('修復記錄包含符號連結')
                rel = path.relative_to(job_root)
                arc = f'logs/{job.id}/' + str(rel.relative_to('logs')) if rel.parts[0] == 'logs' else f'runs/{job.id}/{rel}'
                entries[arc] = path
            if run['id'] == project.get('current_run_id'):
                snapshot = json.loads((root / 'inputs' / run['snapshot_id'] / 'manifest.json').read_text())
                for page in snapshot['pages']:
                    entries[f"ctd_inpainted/export_pair/{page['stem']}.png"] = store.asset_path(pid, page['source'])
                    entries[f"ctd_inpainted/export_pair/other_mask/{page['stem']}.png"] = store.asset_path(pid, page['mask'])
                for path in (job_root / 'inpaint_workflows').rglob('*'):
                    if path.is_file():
                        entries[f'ctd_inpainted/export_pair/inpaint_workflows/{path.relative_to(job_root / "inpaint_workflows")}'] = path
        result = root / 'exports' / f'project-{uuid.uuid4().hex}.zip'
        _write_zip(result, entries, {'format': 'comic-inpaint-project', 'version': 1, 'files': {name: digest_file(path) for name, path in entries.items()}})
        return result


def _remap(value, mapping):
    if isinstance(value, dict):
        return {key: _remap(item, mapping) for key, item in value.items()}
    if isinstance(value, list):
        return [_remap(item, mapping) for item in value]
    if isinstance(value, str):
        return '/'.join(mapping.get(part, part) for part in value.split('/'))
    return value


def import_project(store: ProjectStore, repository, archive_path: Path, max_bytes: int) -> dict:
    """Validate every byte and relative reference before creating any persistent ID."""
    with tempfile.TemporaryDirectory(prefix='comic-project-import-') as temporary:
        stage = Path(temporary)
        with zipfile.ZipFile(archive_path) as archive:
            infos = archive.infolist()
            if len(infos) > 50000 or sum(info.file_size for info in infos) > max_bytes:
                raise ValueError('封存解壓資料超過限制')
            names = set()
            for info in infos:
                normalized = relative_path(info.filename)
                if str(normalized) != info.filename.rstrip('/'):
                    raise ValueError('封存路徑不規範')
                if info.is_dir():
                    continue
                if info.filename in names or ((info.external_attr >> 16) & 0o170000) == 0o120000:
                    raise ValueError('封存包含重複路徑或符號連結')
                names.add(info.filename)
            manifest_info = archive.getinfo('archive.json')
            if manifest_info.file_size > 16 * 1024 * 1024:
                raise ValueError('封存清單過大')
            manifest = json.loads(archive.read('archive.json'))
            if manifest.get('format') != 'comic-inpaint-project' or manifest.get('version') != 1:
                raise ValueError('不支援的項目封存版本')
            if set(manifest.get('files', {})) != names - {'archive.json'}:
                raise ValueError('封存檔案與清單不一致')
            allowed_roots = {'project.json', 'originals', 'assets', 'ctd_inpainted', 'revisions', 'inputs', 'compositions', 'result', 'runs', 'logs', 'detections'}
            for name, expected in manifest['files'].items():
                parts = relative_path(name).parts
                if parts[0] not in allowed_roots:
                    raise ValueError('封存包含未知資料類型')
                destination = stage.joinpath(*parts)
                destination.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(name) as source, destination.open('wb') as target:
                    shutil.copyfileobj(source, target, 1024 * 1024)
                if digest_file(destination) != expected:
                    raise ValueError(f'封存內容校驗失敗：{name}')
        project = json.loads((stage / 'project.json').read_text())
        if project.get('version') != 1 or not project.get('pages'):
            raise ValueError('項目缺少原圖或版本不支援')
        stems, page_ids = set(), set()
        def verify_asset(relative):
            path = stage.joinpath(*relative_path(relative).parts)
            if not path.is_file():
                raise ValueError(f'項目缺少引用資產：{relative}')
            return path
        for page in project['pages']:
            store.project_dir(page['id'])  # Validate IDs before using them for derived asset paths.
            if page['stem'] in stems or page['id'] in page_ids or len(relative_path(page['stem']).parts) != 1 or page['stem'] in ('.', '..'):
                raise ValueError('項目頁面重複或檔名無效')
            stems.add(page['stem']); page_ids.add(page['id'])
            for key in ['original', 'source', 'overlay', 'other', 'edited']:
                permitted = {'originals'} if key == 'original' else {'assets', 'revisions', 'ctd_inpainted'}
                if relative_path(page[key]).parts[0] not in permitted:
                    raise ValueError('頁面引用不屬於持久資產')
                with Image.open(verify_asset(page[key])) as image:
                    if image.size != (page['width'], page['height']):
                        raise ValueError('匯入頁面資產尺寸不一致')
                    if key == 'source' and image.mode != 'RGB':
                        raise ValueError('工作底圖必須為 RGB')
                    if key == 'overlay' and image.mode != 'RGBA':
                        raise ValueError('填色圖層必須為 RGBA')
                    image.verify()
            if page.get('detected_text') is not None:
                text_parts = relative_path(page['detected_text']).parts
                if text_parts[0] != 'assets':
                    raise ValueError('偵測文字 Mask 路徑必須位於項目 assets 內')
                with Image.open(verify_asset(page['detected_text'])) as detected_text:
                    if detected_text.format != 'PNG' or detected_text.mode != 'L' or detected_text.size != (page['width'], page['height']):
                        raise ValueError('偵測文字 Mask 必須為原尺寸灰階 PNG')
                    detected_text.verify()
            if page.get('thumbnail') is not None:
                thumbnail_parts = relative_path(page['thumbnail']).parts
                if thumbnail_parts[0] != 'assets':
                    raise ValueError('縮圖路徑必須位於項目 assets 內')
            # Thumbnails are disposable; always rebuild from the validated RGB source.
            thumbnail_relative = f"assets/{page['id']}/thumbnail.png"
            thumbnail_path = stage / thumbnail_relative
            thumbnail_path.parent.mkdir(parents=True, exist_ok=True)
            with Image.open(verify_asset(page['source'])) as source:
                thumbnail = source.copy()
                thumbnail.thumbnail((180, 240), Image.Resampling.LANCZOS)
                thumbnail.save(thumbnail_path)
            page['thumbnail'] = thumbnail_relative
        mapping = {project['id']: uuid.uuid4().hex}
        jobs = []
        for run in project.get('runs', []):
            old_id = run['id']
            if len(relative_path(run['snapshot_id']).parts) != 1:
                raise ValueError('輸入快照 ID 無效')
            relative_path(old_id)
            if '/' in old_id or old_id in mapping:
                raise ValueError('修復記錄 ID 無效或重複')
            snapshot_path = verify_asset(f"inputs/{run['snapshot_id']}/manifest.json")
            snapshot = json.loads(snapshot_path.read_text())
            if {p['page_id'] for p in snapshot['pages']} != page_ids:
                raise ValueError('輸入快照頁面不完整')
            for page in snapshot['pages']:
                for key in ['source', 'mask']:
                    if relative_path(page[key]).parts[:3] != ('inputs', run['snapshot_id'], 'export_pair'):
                        raise ValueError('快照資產超出該次輸入範圍')
                    path = verify_asset(page[key])
                    if digest_file(path) != page[f'{key}_sha256']:
                        raise ValueError('輸入快照校驗失敗')
            record = JobRecord.model_validate_json(verify_asset(f'runs/{old_id}/job.json').read_text())
            if record.id != old_id or record.state.value in ACTIVE_STATES:
                raise ValueError('封存含未完成的執行中任務')
            if record.state.value == 'completed':
                for workflow in record.workflows:
                    names = record.results.get(workflow, [])
                    if set(names) != {f'{stem}.png' for stem in stems}:
                        raise ValueError('已完成修復記錄缺少頁面結果')
                    for name in names:
                        with Image.open(verify_asset(f'runs/{old_id}/inpaint_workflows/{workflow}/{name}')) as image:
                            image.verify()
            selection_path = stage / 'compositions' / old_id / 'selection.json'
            if selection_path.is_file():
                selection = json.loads(selection_path.read_text())
                if selection.get('run_id') != old_id or selection.get('snapshot_id') != run['snapshot_id']:
                    raise ValueError('合成記錄引用與修復任務不一致')
                for page in selection.get('pages', {}).values():
                    assignment = relative_path(page['assignment'])
                    verify_asset(f'compositions/{old_id}/{assignment}')
            mapping[old_id] = uuid.uuid4().hex
            jobs.append(record)
        new_project = _remap(project, mapping)
        new_project['state'] = 'ready'
        new_project.pop('detection_id', None)
        new_project['created_at'] = now_iso()
        pid = new_project['id']
        destination = store.project_dir(pid)
        created_jobs = []
        try:
            destination.mkdir()
            for child in stage.iterdir():
                if child.name not in {'runs', 'logs', 'project.json'}:
                    shutil.move(str(child), destination / child.name)
            for old_id, new_id in mapping.items():
                for category in ('compositions', 'result'):
                    old_composition = destination / category / old_id
                    if old_composition.is_dir():
                        old_composition.rename(old_composition.with_name(new_id))
            for path in (destination / 'compositions').glob('*/selection.json'):
                atomic_json(path, _remap(json.loads(path.read_text()), mapping))
            for record in jobs:
                old_id = record.id
                new_id = mapping[old_id]
                job_dir = repository.job_dir(new_id)
                created_jobs.append(job_dir)
                shutil.move(str(stage / 'runs' / old_id), job_dir)
                logs = stage / 'logs' / old_id
                if logs.is_dir():
                    shutil.move(str(logs), job_dir / 'logs')
                update = {'id': new_id, 'project_id': pid, 'result_directory': None, 'archive_path': None}
                repository.write(record.model_copy(update=update))
                result_entries = {str(p.relative_to(job_dir)): p for sub in ('inpaint_workflows', 'logs') for p in (job_dir / sub).rglob('*') if p.is_file()}
                if record.download_ready:
                    _write_zip(job_dir / 'download.zip', result_entries)
            store.write(new_project)
            return new_project
        except Exception:
            shutil.rmtree(destination, ignore_errors=True)
            for job_dir in created_jobs:
                shutil.rmtree(job_dir, ignore_errors=True)
            raise


def create_project_router(settings, repository, manager, store: ProjectStore) -> APIRouter:
    router = APIRouter(prefix='/api/projects', tags=['projects'])
    max_bytes = settings.max_upload_mb * 1024 * 1024

    @router.get('')
    def list_projects():
        projects = store.list()
        for project in projects:
            for run in project.get('runs', []):
                root = repository.job_dir(run['id'])
                project['storage_bytes'] += sum(path.stat().st_size for path in root.rglob('*') if path.is_file() and not path.is_symlink())
        return projects

    @router.post('', status_code=201)
    async def create(name: str = Form('未命名項目'), source_files: list[UploadFile] = File(...), mask_files: list[UploadFile] | None = File(None)):
        try:
            if manager.gpu_gate.owner is not None:
                raise ProjectConflict('GPU 任務運行期間暫停上傳')
            with tempfile.TemporaryDirectory(prefix='comic-project-upload-') as temporary:
                sources = await save_uploads(source_files, Path(temporary) / 'source', max_bytes)
                masks = None
                if mask_files:
                    if any(Path(file.filename or '').suffix.lower() != '.png' for file in mask_files):
                        raise ValueError('Mask 只接受 PNG')
                    masks = await save_uploads(mask_files, Path(temporary) / 'mask', max_bytes)
                return await run_in_threadpool(store.create, name, sources, masks)
        except Exception as exc:
            fail(exc)

    @router.post('/import', status_code=201)
    async def import_archive(archive: UploadFile = File(...)):
        try:
            if manager.gpu_gate.owner is not None:
                raise ProjectConflict('GPU 任務運行期間暫停匯入')
            with tempfile.TemporaryDirectory(prefix='comic-project-zip-') as temporary:
                path = Path(temporary) / 'project.zip'
                total = 0
                with path.open('wb') as handle:
                    while chunk := await archive.read(1024 * 1024):
                        total += len(chunk)
                        if total > max_bytes:
                            raise ValueError('上傳封存超過大小限制')
                        handle.write(chunk)
                return await run_in_threadpool(import_project, store, repository, path, max_bytes)
        except Exception as exc:
            fail(exc)

    @router.get('/{pid}')
    def get_project(pid: str):
        try:
            with store.lock(pid):
                return store.read(pid)
        except Exception as exc:
            fail(exc)

    @router.patch('/{pid}')
    def rename(pid: str, body: dict = Body(...)):
        try:
            with store.lock(pid):
                project = store.read(pid)
                store.require_idle(project, repository)
                if body.get('expected_revision') != project['revision']:
                    raise ProjectConflict('項目已更新，請重新載入')
                project['name'] = store.clean_name(body['name'])
                project['revision'] += 1
                store.write(project)
                return project
        except Exception as exc:
            fail(exc)

    @router.delete('/{pid}')
    def delete(pid: str, confirm: bool = False):
        try:
            if not confirm:
                raise ValueError('請先確認刪除項目及其所有資料')
            with store.lock(pid):
                project = store.read(pid)
                store.require_idle(project, repository, allow_deleting=True)
                project['state'] = 'deleting'
                store.write(project)
                # Include owned jobs interrupted between job.json and project.json publication.
                for job in repository.list(limit=None):
                    if getattr(job, 'project_id', None) == pid:
                        shutil.rmtree(repository.job_dir(job.id))
                shutil.rmtree(store.project_dir(pid))
                return {'deleted': pid}
        except Exception as exc:
            fail(exc)

    @router.get('/{pid}/assets/{relative:path}')
    def asset(pid: str, relative: str):
        try:
            with store.lock(pid):
                store.read(pid)
                path = store.asset_path(pid, relative)
                if path.suffix.lower() not in {'.png', '.jpg', '.jpeg'} or not path.is_file():
                    raise KeyError(relative)
                return project_download(store, pid, path, path.name, 'image/png' if path.suffix.lower() == '.png' else 'image/jpeg')
        except Exception as exc:
            fail(exc)

    @router.put('/{pid}/pages/{page_id}/edit')
    async def edit(pid: str, page_id: str, expected_revision: int = Form(...), overlay: UploadFile = File(...), other: UploadFile = File(...), edited: UploadFile = File(...)):
        try:
            import io
            images = []
            for upload in (overlay, other, edited):
                data = await upload.read(max_bytes + 1)
                if len(data) > max_bytes:
                    raise ValueError('編輯圖層超過大小限制')
                with Image.open(io.BytesIO(data)) as image:
                    if image.format != 'PNG':
                        raise ValueError('編輯圖層只接受 PNG')
                    images.append(image.copy())
            def save():
                with store.lock(pid):
                    if store.read(pid).get('state') != 'ready':
                        raise ProjectConflict('項目正在偵測或刪除，暫時不能編輯')
                    return store.save_edit(pid, page_id, expected_revision, *images)
            return await run_in_threadpool(save)
        except Exception as exc:
            fail(exc)

    @router.post('/{pid}/masks')
    async def replace_masks(pid: str, expected_revision: int = Form(...), confirm_replace: bool = Form(False), mask_files: list[UploadFile] = File(...)):
        try:
            if manager.gpu_gate.owner is not None:
                raise ProjectConflict('GPU 任務運行期間暫停上傳')
            if not confirm_replace:
                raise ValueError('請確認更換 Mask；現有填色和人工保護將保留')
            if any(Path(file.filename or '').suffix.lower() != '.png' for file in mask_files):
                raise ValueError('Mask 只接受 PNG')
            with tempfile.TemporaryDirectory(prefix='comic-project-masks-') as temporary:
                masks = await save_uploads(mask_files, Path(temporary), max_bytes)
                def replace():
                    with store.lock(pid):
                        project = store.read(pid)
                        store.require_idle(project, repository)
                        if project['revision'] != expected_revision:
                            raise ProjectConflict('項目已更新，請重新載入')
                        if set(masks) != {page['stem'] for page in project['pages']}:
                            raise ValueError('Mask 必須完整配對全部原圖')
                        loaded = {}
                        for page in project['pages']:
                            with Image.open(masks[page['stem']]) as image:
                                if image.size != (page['width'], page['height']):
                                    raise ValueError('Mask 尺寸不一致')
                                loaded[page['id']] = image.copy()
                        for page in project['pages']:
                            with Image.open(store.asset_path(pid, page['overlay'])) as overlay_image, Image.open(store.asset_path(pid, page['edited'])) as edited_image:
                                store.save_edit(pid, page['id'], page['edit_revision'], overlay_image, loaded[page['id']], edited_image, preserve_overlay=True)
                        return store.read(pid)
                return await run_in_threadpool(replace)
        except Exception as exc:
            fail(exc)

    @router.post('/{pid}/jobs', status_code=202)
    async def submit_job(pid: str, body: dict = Body(...)):
        job_id = uuid.uuid4().hex
        claimed = False
        try:
            workflows = body.get('workflows', [])
            if not workflows or len(set(workflows)) != len(workflows) or any(item not in ORDER for item in workflows):
                raise ValueError('工作流選擇無效')
            if any(record.state.value in ACTIVE_STATES for record in repository.list(limit=None)):
                raise ProjectConflict('已有修復任務等待恢復或正在運行')
            claimed = manager.gpu_gate.claim(job_id)
            if not claimed:
                raise ProjectConflict('已有 GPU 任務正在處理')
            def prepare():
                with store.lock(pid):
                    project = store.read(pid)
                    store.require_idle(project, repository)
                    snapshot = store.snapshot(pid, body.get('expected_revision'))
                    job_dir = repository.job_dir(job_id)
                    for page in snapshot['pages']:
                        for key, folder in [('source', 'pair'), ('mask', 'pair_mask')]:
                            destination = job_dir / 'uploads' / folder / f"{page['stem']}.png"
                            destination.parent.mkdir(parents=True, exist_ok=True)
                            shutil.copyfile(store.asset_path(pid, page[key]), destination)
                    from datetime import datetime
                    timestamp = now_iso()
                    record = JobRecord(id=job_id, name=f"{project['name']}_{datetime.now().astimezone().strftime('%m%d_%H%M%S')}", project_id=pid, snapshot_id=snapshot['id'], workflows=[item for item in ORDER if item in workflows], pair_count=len(snapshot['pages']), black_mask_count=sum(page['passthrough'] for page in snapshot['pages']), total_runs=len(snapshot['pages']) * len(workflows), created_at=timestamp, updated_at=timestamp)
                    repository.write(record)
                    project['runs'].append({'id': job_id, 'snapshot_id': snapshot['id'], 'workflows': record.workflows, 'created_at': timestamp})
                    project['current_run_id'] = job_id
                    project['revision'] += 1
                    store.write(project)
                    return record
            record = await run_in_threadpool(prepare)
            await manager.enqueue(job_id)
            return record
        except BaseException as exc:
            if claimed:
                manager.gpu_gate.release(job_id)
                # Keep a durable failed record if snapshot creation reached publication.
                try:
                    record = repository.read(job_id)
                    from .schemas import JobState
                    record.state = JobState.failed
                    record.error = str(exc)
                    repository.write(record)
                except KeyError:
                    shutil.rmtree(repository.job_dir(job_id), ignore_errors=True)
            fail(exc)

    @router.get('/{pid}/export-pair')
    def pair_archive(pid: str):
        try:
            with store.lock(pid):
                project = store.read(pid)
                store.require_idle(project, repository)
                snapshot = store.snapshot(pid, project['revision'])
                entries = {}
                for page in snapshot['pages']:
                    entries[f"export_pair/{page['stem']}.png"] = store.asset_path(pid, page['source'])
                    entries[f"export_pair/other_mask/{page['stem']}.png"] = store.asset_path(pid, page['mask'])
                path = store.project_dir(pid) / 'exports' / f'pair-{uuid.uuid4().hex}.zip'
                _write_zip(path, entries)
                return project_download(store, pid, path, f"{project['name']}-底圖與Mask.zip")
        except Exception as exc:
            fail(exc)

    @router.get('/{pid}/export')
    def complete_archive(pid: str):
        try:
            with store.lock(pid):
                path = export_project(store, repository, pid)
                return project_download(store, pid, path, f"{store.read(pid)['name']}-完整項目.zip")
        except Exception as exc:
            fail(exc)

    return router
