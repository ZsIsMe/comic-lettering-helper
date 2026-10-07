"""HTTP project lifecycle. GPU inference remains in the existing JobManager."""
from __future__ import annotations

import json
import re
import shutil
import tempfile
import uuid
import zipfile
from pathlib import Path

from fastapi import APIRouter, Body, File, Form, HTTPException, Query, Response, UploadFile
from fastapi.responses import StreamingResponse
from PIL import Image
import numpy as np
from starlette.concurrency import run_in_threadpool
from starlette.background import BackgroundTask

from .projects import ACTIVE_STATES, ProjectConflict, ProjectStore, atomic_json, digest_file, relative_path
from .detection_options import DetectionOptions
from .repository import now_iso
from .schemas import JobRecord, WorkflowProgress
from .storage import save_uploads
from .comfy_cleanup import CleanupConflict
from .upload_progress import UploadProgressRegistry
from .repair_scope import MAX_SCOPE_BYTES, parse_external_scope

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
            if relative == 'repair_scope.json' or relative in thumbnails or relative.split('/')[0] in {'exports', 'logs'} or path.is_dir():
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


def _validate_round_composition(stage: Path, project: dict, runs: dict, verify_asset) -> None:
    path = stage / 'compositions' / 'rounds' / 'selection.json'
    if not path.is_file():
        return
    state = json.loads(path.read_text())
    if (not isinstance(state, dict) or state.get('version') != 2
            or not isinstance(state.get('revision'), int) or state['revision'] < 0
            or not isinstance(state.get('workflow_codes'), dict)
            or not isinstance(state.get('candidates'), list)
            or not isinstance(state.get('pages'), dict)):
        raise ValueError('輪次合成記錄格式無效')
    project_pages = {page['id']: page for page in project['pages']}
    if set(state['pages']) != set(project_pages):
        raise ValueError('輪次合成頁面與項目不一致')
    codes = state['workflow_codes']
    if any(type(code) is not int or not 2 <= code <= 65535 for code in codes.values()) or len(set(codes.values())) != len(codes):
        raise ValueError('輪次合成候選代碼無效')
    candidates = {}
    for candidate in state['candidates']:
        if not isinstance(candidate, dict):
            raise ValueError('輪次合成候選無效')
        run_id, workflow = candidate.get('run_id'), candidate.get('workflow')
        if not isinstance(run_id, str) or not isinstance(workflow, str):
            raise ValueError('輪次合成候選引用無效')
        linked = runs.get(run_id)
        if linked is None:
            raise ValueError('輪次合成候選引用未知修復任務')
        run, record, snapshot = linked
        key = f'{run_id}:{workflow}'
        if (workflow not in run['workflows'] or workflow not in record.workflows
                or candidate.get('snapshot_id') != run['snapshot_id']
                or candidate.get('code') != codes.get(key) or key in candidates
                or type(candidate.get('selected')) is not bool
                or not isinstance(candidate.get('page_errors'), dict)
                or any(page_id not in {page['page_id'] for page in snapshot['pages']} or not isinstance(error, str)
                       for page_id, error in candidate['page_errors'].items())
                or not (record.state.value == 'completed' or
                        (record.state.value == 'failed' and record.partial_results_accepted))):
            raise ValueError('輪次合成候選與修復任務不一致')
        candidates[key] = candidate
    if set(candidates) != set(codes):
        raise ValueError('輪次合成候選代碼與清單不一致')
    candidate_by_code = {item['code']: item for item in candidates.values()}
    for page_id, frozen in state['pages'].items():
        page = project_pages[page_id]
        if (not isinstance(frozen, dict) or frozen.get('stem') != page['stem']
                or frozen.get('width') != page['width'] or frozen.get('height') != page['height']
                or type(frozen.get('confirmed')) is not bool
                or type(frozen.get('passthrough')) is not bool
                or type(frozen.get('mask_ready')) is not bool):
            raise ValueError('輪次合成凍結頁面與項目不一致')
        base_rel = f'base/{page_id}.png'
        mask_rel = f'masks/{page_id}.png'
        assignment_rel = frozen.get('assignment')
        if (frozen.get('base') != base_rel
                or frozen.get('mask') not in (None, mask_rel)
                or not isinstance(assignment_rel, str)
                or re.fullmatch(rf'assignments/{re.escape(page_id)}\.(0|[1-9][0-9]*)\.png', assignment_rel) is None
                or int(assignment_rel.rsplit('.', 2)[1]) > state['revision']):
            raise ValueError('輪次合成凍結資產路徑無效')
        base_path = verify_asset(f'compositions/rounds/{base_rel}')
        if digest_file(base_path) != frozen.get('base_sha256'):
            raise ValueError('輪次合成凍結底圖校驗失敗')
        with Image.open(base_path) as image:
            if image.format != 'PNG' or image.mode != 'RGB' or image.size != (page['width'], page['height']):
                raise ValueError('輪次合成凍結底圖無效')
            base_pixels = np.asarray(image).copy()
        if frozen['mask'] is not None:
            with Image.open(verify_asset(f'compositions/rounds/{mask_rel}')) as image:
                if image.format != 'PNG' or image.mode != 'L' or image.size != (page['width'], page['height']):
                    raise ValueError('輪次合成凍結 Mask 無效')
                image.verify()
        with Image.open(verify_asset(f'compositions/rounds/{assignment_rel}')) as image:
            if image.format != 'PNG' or image.size != (page['width'], page['height']):
                raise ValueError('輪次合成像素來源圖無效')
            assignment = np.asarray(image)
            if assignment.dtype != np.uint16:
                raise ValueError('輪次合成像素來源圖必須為 uint16')
            used_codes = {int(code) for code in np.unique(assignment)} - {0, 1}
        if not used_codes <= set(candidate_by_code):
            raise ValueError('輪次合成像素來源代碼無效')
        if frozen['passthrough'] and used_codes:
            raise ValueError('輪次合成直通頁面包含候選像素')
        for code in used_codes:
            candidate = candidate_by_code[code]
            run, _, snapshot = runs[candidate['run_id']]
            snapshot_page = next((item for item in snapshot['pages'] if item['page_id'] == page_id), None)
            if snapshot_page is None or page_id in candidate['page_errors']:
                raise ValueError('輪次合成像素來源不適用於此頁')
            with Image.open(verify_asset(f"runs/{run['id']}/inpaint_workflows/{candidate['workflow']}/{page['stem']}.png")) as image:
                if image.format != 'PNG' or image.size != (page['width'], page['height']):
                    raise ValueError('輪次合成候選圖片無效')
                image.verify()
            with Image.open(verify_asset(snapshot_page['source'])) as image:
                if not np.array_equal(np.asarray(image.convert('RGB')), base_pixels):
                    raise ValueError('輪次合成候選底圖與凍結底圖不一致')


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
        project.pop('repair_scope', None)
        if project.get('version') != 1 or not project.get('pages'):
            raise ValueError('項目缺少原圖或版本不支援')
        if 'detection_options' in project:
            project['detection_options'] = DetectionOptions.model_validate(project['detection_options']).model_dump()
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
        run_records = {}
        for run in project.get('runs', []):
            old_id = run['id']
            if len(relative_path(run['snapshot_id']).parts) != 1:
                raise ValueError('輸入快照 ID 無效')
            relative_path(old_id)
            if '/' in old_id or old_id in mapping:
                raise ValueError('修復記錄 ID 無效或重複')
            snapshot_path = verify_asset(f"inputs/{run['snapshot_id']}/manifest.json")
            snapshot = json.loads(snapshot_path.read_text())
            project_pages = {page['id']: page for page in project['pages']}
            snapshot_pages = snapshot.get('pages')
            if (snapshot.get('id') != run['snapshot_id'] or not isinstance(snapshot_pages, list)
                    or not snapshot_pages or any(not isinstance(page, dict) for page in snapshot_pages)):
                raise ValueError('輸入快照頁面無效')
            selected_ids = [page.get('page_id') for page in snapshot_pages]
            if (any(not isinstance(page_id, str) or page_id not in page_ids for page_id in selected_ids)
                    or len(selected_ids) != len(set(selected_ids))
                    or selected_ids != [page['id'] for page in project['pages'] if page['id'] in selected_ids]):
                raise ValueError('輸入快照頁面無效或順序不一致')
            for page in snapshot['pages']:
                if page.get('stem') != project_pages[page['page_id']]['stem']:
                    raise ValueError('輸入快照頁面檔名不一致')
                for key in ['source', 'mask']:
                    expected = (f"inputs/{run['snapshot_id']}/export_pair/"
                                f"{'other_mask/' if key == 'mask' else ''}{page['stem']}.png")
                    if page.get(key) != expected:
                        raise ValueError('快照資產超出該次輸入範圍')
                    path = verify_asset(page[key])
                    if digest_file(path) != page[f'{key}_sha256']:
                        raise ValueError('輸入快照校驗失敗')
            record = JobRecord.model_validate_json(verify_asset(f'runs/{old_id}/job.json').read_text())
            if record.id != old_id or record.state.value in ACTIVE_STATES:
                raise ValueError('封存含未完成的執行中任務')
            if (record.snapshot_id not in (None, run['snapshot_id'])
                    or record.pair_count != len(snapshot_pages)
                    or record.total_runs != len(snapshot_pages) * len(record.workflows)
                    or (record.page_ids and record.page_ids != selected_ids)):
                raise ValueError('修復記錄與輸入快照不一致')
            if record.state.value == 'completed':
                for workflow in record.workflows:
                    names = record.results.get(workflow, [])
                    expected_names = {f"{page['stem']}.png" for page in snapshot_pages}
                    result_dir = stage / 'runs' / old_id / 'inpaint_workflows' / workflow
                    actual_names = {path.name for path in result_dir.iterdir() if path.is_file()} if result_dir.is_dir() else set()
                    if len(names) != len(snapshot_pages) or set(names) != expected_names or actual_names != expected_names:
                        raise ValueError('已完成修復記錄缺少頁面結果')
                    for name in names:
                        with Image.open(verify_asset(f'runs/{old_id}/inpaint_workflows/{workflow}/{name}')) as image:
                            stem = name[:-4]
                            page_info = next(project_pages[page['page_id']] for page in snapshot_pages if page['stem'] == stem)
                            if image.format != 'PNG' or image.size != (page_info['width'], page_info['height']):
                                raise ValueError('已完成修復結果格式或尺寸不一致')
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
            run_records[old_id] = (run, record, snapshot)
        _validate_round_composition(stage, project, run_records, verify_asset)
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
                selection = _remap(json.loads(path.read_text()), mapping)
                if path.parent.name == 'rounds' and selection.get('version') == 2:
                    selection['workflow_codes'] = {
                        f"{candidate['run_id']}:{candidate['workflow']}": candidate['code']
                        for candidate in selection['candidates']
                    }
                atomic_json(path, selection)
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


def create_project_router(settings, repository, manager, store: ProjectStore, comfy_cleanup=None) -> APIRouter:
    router = APIRouter(prefix='/api/projects', tags=['projects'])
    max_bytes = settings.max_upload_mb * 1024 * 1024
    upload_progress = UploadProgressRegistry()

    @router.get('')
    def list_projects():
        projects = store.list()
        for project in projects:
            for run in project.get('runs', []):
                root = repository.job_dir(run['id'])
                project['storage_bytes'] += sum(path.stat().st_size for path in root.rglob('*') if path.is_file() and not path.is_symlink())
        return projects

    @router.post('', status_code=201)
    async def create(name: str = Form('未命名項目'), source_files: list[UploadFile] = File(...), mask_files: list[UploadFile] | None = File(None), detection_options: str | None = Form(None), repair_scope_file: UploadFile | None = File(None), progress_id: str | None = Query(None, pattern=r'^[0-9a-f]{32}$')):
        registered = False
        try:
            # FastAPI has parsed the multipart body before entering this handler.
            # The browser reports transfer progress; this tracks validated files
            # and persisted pages without changing the existing POST contract.
            total_files = len(source_files) + len(mask_files or [])
            if progress_id is not None:
                upload_progress.register(progress_id, total_files)
                registered = True

            def validated(completed: int, _total: int, filename: str, *, offset: int = 0):
                upload_progress.update(progress_id, stage='validating', completed=offset + completed,
                                       total=total_files, filename=filename)

            def created(completed: int, total: int, filename: str):
                upload_progress.update(progress_id, stage='creating', completed=completed,
                                       total=total, filename=filename)

            def validated_mask(completed: int, total: int, filename: str):
                validated(completed, total, filename, offset=len(source_files))

            options = DetectionOptions.model_validate_json(detection_options).model_dump() if detection_options is not None else None
            if manager.gpu_gate.owner is not None:
                raise ProjectConflict('GPU 任務運行期間暫停上傳')
            repair_scope = parse_external_scope(await repair_scope_file.read(MAX_SCOPE_BYTES + 1)) if repair_scope_file is not None else None
            with tempfile.TemporaryDirectory(prefix='comic-project-upload-') as temporary:
                sources = await save_uploads(source_files, Path(temporary) / 'source', max_bytes,
                                             progress=validated if registered else None)
                masks = None
                if mask_files:
                    if any(Path(file.filename or '').suffix.lower() != '.png' for file in mask_files):
                        raise ValueError('Mask 只接受 PNG')
                    masks = await save_uploads(mask_files, Path(temporary) / 'mask', max_bytes,
                                               progress=validated_mask if registered else None)
                project = await run_in_threadpool(store.create, name, sources, masks,
                                                 detection_options=options, progress=created if registered else None,
                                                 repair_scope=repair_scope)
                if registered:
                    total_pages = len(project['pages'])
                    upload_progress.update(progress_id, stage='completed', completed=total_pages,
                                           total=total_pages, filename=None)
                return project
        except BaseException as exc:
            if registered:
                upload_progress.update(progress_id, stage='failed', error=str(exc) or '建立項目已中斷')
            if isinstance(exc, Exception):
                fail(exc)
            raise

    @router.get('/upload-progress/{progress_id}')
    def get_upload_progress(progress_id: str, response: Response):
        response.headers['Cache-Control'] = 'no-store'
        try:
            return upload_progress.read(progress_id)
        except KeyError as exc:
            raise HTTPException(404, '上傳進度尚未建立或已過期', headers={'Cache-Control': 'no-store'}) from exc

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
                owned_jobs = [job for job in repository.list(limit=None) if getattr(job, 'project_id', None) == pid]
                if comfy_cleanup is not None:
                    try:
                        comfy_cleanup.delete_project_jobs(owned_jobs)
                    except CleanupConflict as exc:
                        raise ProjectConflict(str(exc)) from exc
                project['state'] = 'deleting'
                store.write(project)
                # Include owned jobs interrupted between job.json and project.json publication.
                for job in owned_jobs:
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

    @router.get('/{pid}/repair-scope/export')
    def export_scope(pid: str):
        try:
            content = json.dumps(store.export_repair_scope(pid), ensure_ascii=False, indent=2).encode('utf-8')
            return Response(content, media_type='application/json', headers={
                'Content-Disposition': 'attachment; filename="repair_scope.json"',
                'Cache-Control': 'no-store',
            })
        except Exception as exc:
            fail(exc)

    @router.put('/{pid}/pages/{page_id}/repair-scope')
    def repair_scope(pid: str, page_id: str, body: dict = Body(...)):
        try:
            if set(body) - {'revision', 'enabled', 'rect', 'apply_all'}:
                raise ValueError('頁面作用範圍只接受 revision、enabled、rect、apply_all；裁切 JSON 請在新建項目時匯入')
            return store.save_repair_scope(pid, page_id, body.get('revision'), body.get('enabled'), body.get('rect'), body.get('apply_all', False), repository)
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
            if 'page_ids' in body and not isinstance(body['page_ids'], list):
                raise ValueError('頁面選擇無效')
            if any(record.state.value in ACTIVE_STATES for record in repository.list(limit=None)):
                raise ProjectConflict('已有修復任務等待恢復或正在運行')
            claimed = manager.gpu_gate.claim(job_id)
            if not claimed:
                raise ProjectConflict('已有 GPU 任務正在處理')
            def prepare():
                with store.lock(pid):
                    project = store.read(pid)
                    store.require_idle(project, repository)
                    snapshot = store.snapshot(pid, body.get('expected_revision'), body.get('page_ids'))
                    job_dir = repository.job_dir(job_id)
                    geometry = {page['stem']: page['repair_rect'] for page in snapshot['pages'] if 'repair_rect' in page}
                    if geometry:
                        atomic_json(job_dir / 'input_geometry.json', geometry)
                    for page in snapshot['pages']:
                        for key, folder in [('source', 'pair'), ('mask', 'pair_mask')]:
                            destination = job_dir / 'uploads' / folder / f"{page['stem']}.png"
                            destination.parent.mkdir(parents=True, exist_ok=True)
                            shutil.copyfile(store.asset_path(pid, page[key]), destination)
                    from datetime import datetime
                    timestamp = now_iso()
                    record = JobRecord(id=job_id, name=f"{project['name']}_{datetime.now().astimezone().strftime('%m%d_%H%M%S')}", project_id=pid, snapshot_id=snapshot['id'], page_ids=[page['page_id'] for page in snapshot['pages']], workflows=[item for item in ORDER if item in workflows], pair_count=len(snapshot['pages']), black_mask_count=sum(page['passthrough'] for page in snapshot['pages']), total_runs=len(snapshot['pages']) * len(workflows), created_at=timestamp, updated_at=timestamp)
                    record.workflow_progress = {workflow: WorkflowProgress(total=record.pair_count) for workflow in record.workflows}
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
