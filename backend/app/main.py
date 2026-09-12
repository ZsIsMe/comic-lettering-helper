from __future__ import annotations

import re
import shutil
import subprocess
import urllib.error
import urllib.request
import uuid
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import settings
from .engine import JobManager
from .repository import JobRepository, now_iso
from .schemas import HealthResponse, JobRecord, WorkflowId
from .storage import save_uploads, validate_pairs
from .projects import ProjectStore
from .project_api import create_project_router, project_download
from .composition import build_composition_router
from .detection import DetectionManager, create_detection_router
from .edgewhite_api import create_edgewhite_router


repository = JobRepository(settings.jobs_root)
manager = JobManager(settings, repository)
project_store = ProjectStore(settings.data_root / "projects")
detection_manager = DetectionManager(settings, project_store, manager.gpu_gate)


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings.jobs_root.mkdir(parents=True, exist_ok=True)
    await detection_manager.start()
    await manager.start()
    yield
    await manager.stop()
    await detection_manager.stop()


app = FastAPI(title="漫畫去字工作台", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


WORKFLOW_ORDER: list[WorkflowId] = ["flux2klein_lanpaint", "firered", "qwen2511_lanpaint"]


def present_job(record: JobRecord) -> JobRecord:
    job_dir = repository.job_dir(record.id)
    return record.model_copy(
        update={
            "result_directory": str(job_dir / "inpaint_workflows"),
            "archive_path": str(job_dir / "download.zip"),
        }
    )


def parse_workflows(value: str) -> list[WorkflowId]:
    requested = [item.strip() for item in value.split(",") if item.strip()]
    if not requested or len(requested) != len(set(requested)) or any(item not in WORKFLOW_ORDER for item in requested):
        raise HTTPException(400, "工作流選擇無效")
    return [item for item in WORKFLOW_ORDER if item in requested]


def safe_job_name(value: str) -> str:
    name = re.sub(r"[\\/\x00-\x1f\x7f]+", "_", value).strip(" ._")
    return name[:80] or "未命名批次"


def timestamped_job_name(value: str) -> str:
    timestamp = datetime.now().astimezone().strftime("%m%d_%H%M%S")
    return f"{safe_job_name(value)}_{timestamp}"


def comfy_ready() -> bool:
    try:
        with urllib.request.urlopen(f"{settings.comfy_url}/system_stats", timeout=2):
            return True
    except (TimeoutError, urllib.error.URLError):
        return False


def gpu_stats() -> tuple[str | None, int | None, int | None, int | None]:
    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=name,memory.used,memory.total,utilization.gpu",
                "--format=csv,noheader,nounits",
            ],
            text=True,
            capture_output=True,
            timeout=3,
            check=True,
        )
        name, used, total, utilization = [part.strip() for part in result.stdout.splitlines()[0].split(",")]
        return name, int(float(used)), int(float(total)), int(float(utilization))
    except (FileNotFoundError, subprocess.SubprocessError, ValueError, IndexError):
        return None, None, None, None


@app.get("/api/health", response_model=HealthResponse)
def health() -> HealthResponse:
    gpu_name, gpu_used, gpu_total, gpu_utilization = gpu_stats()
    return HealthResponse(
        app="ok",
        comfy_ready=comfy_ready(),
        queue_running=manager.worker_task is not None and not manager.worker_task.done(),
        active_job_id=manager.active_job_id,
        gpu_name=gpu_name,
        gpu_memory_used_mib=gpu_used,
        gpu_memory_total_mib=gpu_total,
        gpu_utilization_percent=gpu_utilization,
        gpu_owner=manager.gpu_gate.owner,
    )


@app.get("/api/jobs", response_model=list[JobRecord])
def list_jobs() -> list[JobRecord]:
    return [present_job(record) for record in repository.list(limit=None)]


@app.get("/api/jobs/{job_id}", response_model=JobRecord)
def get_job(job_id: str) -> JobRecord:
    try:
        return present_job(repository.read(job_id))
    except KeyError as exc:
        raise HTTPException(404, "任務不存在") from exc


@app.post("/api/jobs", response_model=JobRecord, status_code=202)
async def create_job(
    name: str = Form("未命名批次"),
    workflows: str = Form("flux2klein_lanpaint"),
    source_files: list[UploadFile] = File(...),
    mask_files: list[UploadFile] = File(...),
) -> JobRecord:
    active_states = {"queued", "validating", "running", "packaging", "abandoning"}
    if any(record.state.value in active_states for record in repository.list(limit=None)):
        raise HTTPException(409, "已有任務正在處理，請先等待完成或放棄目前任務")
    selected = parse_workflows(workflows)
    job_id = str(uuid.uuid4())
    if not manager.gpu_gate.claim(job_id):
        raise HTTPException(409, "GPU 已被其他偵測或修復任務使用")
    job_dir = repository.job_dir(job_id)
    max_bytes = settings.max_upload_mb * 1024 * 1024
    try:
        sources = await save_uploads(source_files, job_dir / "uploads" / "pair", max_bytes)
        if any(Path(file.filename or "").suffix.lower() != ".png" for file in mask_files):
            raise ValueError("Mask 目前只接受 PNG")
        masks = await save_uploads(mask_files, job_dir / "uploads" / "pair_mask", max_bytes)
        stems, black_masks = validate_pairs(sources, masks)
    except ValueError as exc:
        shutil.rmtree(job_dir, ignore_errors=True)
        manager.gpu_gate.release(job_id)
        raise HTTPException(400, str(exc)) from exc
    except BaseException:
        shutil.rmtree(job_dir, ignore_errors=True)
        manager.gpu_gate.release(job_id)
        raise

    timestamp = now_iso()
    record = JobRecord(
        id=job_id,
        name=timestamped_job_name(name),
        workflows=selected,
        pair_count=len(stems),
        black_mask_count=len(black_masks),
        total_runs=len(stems) * len(selected),
        created_at=timestamp,
        updated_at=timestamp,
    )
    try:
        repository.write(record)
        await manager.enqueue(job_id)
    except BaseException:
        manager.gpu_gate.release(job_id)
        shutil.rmtree(job_dir, ignore_errors=True)
        raise
    return present_job(record)


@app.post("/api/jobs/{job_id}/abandon", response_model=JobRecord)
async def abandon_job(job_id: str) -> JobRecord:
    try:
        return present_job(await manager.abandon(job_id))
    except KeyError as exc:
        raise HTTPException(404, "任務不存在") from exc
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@app.get("/api/jobs/{job_id}/download-current")
def download_current_job(job_id: str) -> FileResponse:
    try:
        job = repository.read(job_id)
        if job.project_id:
            with project_store.lock(job.project_id):
                record, archive = manager.build_current_archive(job_id)
                return project_download(project_store, job.project_id, archive, f"{record.name}-目前結果.zip")
        record, archive = manager.build_current_archive(job_id)
    except KeyError as exc:
        raise HTTPException(404, "任務不存在") from exc
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    return FileResponse(archive, media_type="application/zip", filename=f"{record.name}-目前結果.zip")


@app.get("/api/jobs/{job_id}/download")
def download_job(job_id: str) -> FileResponse:
    record = get_job(job_id)
    if record.project_id:
        with project_store.lock(record.project_id):
            record = get_job(job_id)
            archive = repository.job_dir(job_id) / "download.zip"
            if not record.download_ready or not archive.is_file():
                raise HTTPException(409, "結果尚未完成")
            return project_download(project_store, record.project_id, archive, f"{record.name}.zip")
    archive = repository.job_dir(job_id) / "download.zip"
    if not record.download_ready or not archive.is_file():
        raise HTTPException(409, "結果尚未完成")
    return FileResponse(archive, media_type="application/zip", filename=f"{record.name}.zip")


app.include_router(create_project_router(settings, repository, manager, project_store))
app.include_router(build_composition_router(project_store, repository))
app.include_router(create_detection_router(detection_manager))
app.include_router(create_edgewhite_router(settings, manager.gpu_gate))

frontend_dist = settings.app_root / "frontend" / "dist"
if frontend_dist.is_dir():
    app.mount("/", StaticFiles(directory=frontend_dist, html=True), name="frontend")
