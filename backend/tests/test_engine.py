from __future__ import annotations

import asyncio
import zipfile
from datetime import UTC, datetime

from app.config import Settings
from app.engine import JobManager
from app.repository import JobRepository
from app.schemas import JobRecord, JobState


def make_manager(tmp_path):
    settings = Settings(
        app_root=tmp_path / "app",
        comfy_root=tmp_path / "ComfyUI",
        data_root=tmp_path / "data",
        python_bin="python",
    )
    repository = JobRepository(settings.jobs_root)
    return JobManager(settings, repository), repository


def make_record(job_id: str = "job-1") -> JobRecord:
    timestamp = datetime.now(UTC).isoformat()
    return JobRecord(
        id=job_id,
        name="測試任務",
        state=JobState.running,
        workflows=["flux2klein_lanpaint"],
        pair_count=2,
        total_runs=2,
        created_at=timestamp,
        updated_at=timestamp,
    )


def test_current_archive_contains_only_completed_results_and_logs(tmp_path) -> None:
    manager, repository = make_manager(tmp_path)
    record = make_record()
    repository.write(record)
    job_dir = repository.job_dir(record.id)
    result = job_dir / "inpaint_workflows" / "flux2klein_lanpaint" / "01.png"
    result.parent.mkdir(parents=True)
    result.write_bytes(b"png")
    log = job_dir / "logs" / "flux2klein_lanpaint.log"
    log.parent.mkdir(parents=True)
    log.write_text("running", encoding="utf-8")

    _, archive = manager.build_current_archive(record.id)

    with zipfile.ZipFile(archive) as handle:
        assert sorted(handle.namelist()) == [
            "inpaint_workflows/flux2klein_lanpaint/01.png",
            "logs/flux2klein_lanpaint.log",
        ]


def test_abandon_marks_a_queued_job_for_safe_stop(tmp_path) -> None:
    manager, repository = make_manager(tmp_path)
    record = make_record()
    record.state = JobState.queued
    repository.write(record)

    updated = asyncio.run(manager.abandon(record.id))

    assert updated.state == JobState.abandoning
    assert record.id in manager.abandon_requested


def test_finalize_abandoned_keeps_completed_images_downloadable(tmp_path) -> None:
    manager, repository = make_manager(tmp_path)
    record = make_record()
    record.state = JobState.abandoning
    record.results = {"flux2klein_lanpaint": ["01.png"]}
    repository.write(record)
    result = repository.job_dir(record.id) / "inpaint_workflows" / "flux2klein_lanpaint" / "01.png"
    result.parent.mkdir(parents=True)
    result.write_bytes(b"png")

    manager._finalize_abandoned(record.id)

    updated = repository.read(record.id)
    assert updated.state == JobState.abandoned
    assert updated.completed_total == 1
    assert updated.download_ready is True
    assert (repository.job_dir(record.id) / "download.zip").is_file()
