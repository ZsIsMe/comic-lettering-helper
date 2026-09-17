from __future__ import annotations

import asyncio
import zipfile
from unittest.mock import AsyncMock
from datetime import UTC, datetime

from app.config import Settings
from app.engine import JobManager
from app.repository import JobRepository
from app.schemas import JobRecord, JobState
from PIL import Image


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


def test_all_black_batch_preserves_prepared_pixels_without_comfy(tmp_path):
    manager, repository = make_manager(tmp_path)
    record = make_record()
    record.workflows = ['flux2klein_lanpaint', 'firered', 'qwen2511_lanpaint']
    record.total_runs = 6
    repository.write(record)
    root = repository.job_dir(record.id)
    for stem, color in [('01', (233, 188, 120)), ('02', (25, 40, 80))]:
        (root / 'uploads/pair').mkdir(parents=True, exist_ok=True)
        (root / 'uploads/pair_mask').mkdir(parents=True, exist_ok=True)
        Image.new('RGB', (12, 17), color).save(root / 'uploads/pair' / f'{stem}.png')
        Image.new('L', (12, 17), 0).save(root / 'uploads/pair_mask' / f'{stem}.png')
    manager._wait_comfy = AsyncMock(side_effect=AssertionError('must not contact ComfyUI'))
    asyncio.run(manager._run_job(record.id))
    final = repository.read(record.id)
    assert final.state == JobState.completed and final.completed_total == 6
    manager._wait_comfy.assert_not_called()
    with zipfile.ZipFile(root / 'download.zip') as archive:
        assert len([name for name in archive.namelist() if name.endswith('.png')]) == 6
        assert not any(name.endswith('.pdf') for name in archive.namelist())
    for workflow in record.workflows:
        with Image.open(root / 'inpaint_workflows' / workflow / '01.png') as result:
            assert result.getpixel((0, 0)) == (233, 188, 120)


def test_gpu_reservation_cannot_be_released_by_another_task():
    from app.resources import ResourceGate
    gate = ResourceGate()
    assert gate.claim('detect')
    assert not gate.claim('repair')
    gate.release('repair')
    assert gate.owner == 'detect'
    gate.release('detect')
    assert gate.claim('repair')


def test_output_waits_for_complete_png_and_replaces_old_partial_copy(tmp_path):
    manager, repository = make_manager(tmp_path)
    record = make_record()
    repository.write(record)
    source = manager.settings.comfy_output / "test_01_00001_.png"
    source.parent.mkdir(parents=True)
    Image.new("RGB", (32, 32), "red").save(source)
    complete = source.read_bytes()
    source.write_bytes(complete[:len(complete) // 2])
    target = repository.job_dir(record.id) / "inpaint_workflows/flux2klein_lanpaint/01.png"
    assert manager._sync_available_outputs(record, "flux2klein_lanpaint", "test_", ["01"]) == 0
    assert not target.exists()
    source.write_bytes(complete)
    assert manager._sync_available_outputs(record, "flux2klein_lanpaint", "test_", ["01"]) == 1
    target.write_bytes(complete[:20])
    manager._normalize_outputs(record, "flux2klein_lanpaint", "test_", ["01"])
    assert target.read_bytes() == complete
    assert not target.with_suffix(".tmp").exists()


def test_final_sync_rejects_incomplete_output(tmp_path):
    import pytest
    manager, repository = make_manager(tmp_path)
    record = make_record()
    source = manager.settings.comfy_output / "test_01_00001_.png"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"incomplete PNG")
    with pytest.raises(RuntimeError, match="輸出圖片尚未完整"):
        manager._sync_available_outputs(record, "flux2klein_lanpaint", "test_", ["01"], require_all=True)


def test_pdf_failure_still_packages_images_and_logs(tmp_path):
    manager, repository = make_manager(tmp_path)
    record = make_record()
    record.workflows = ["flux2klein_lanpaint", "firered", "qwen2511_lanpaint"]
    repository.write(record)
    root = repository.job_dir(record.id)
    for workflow in record.workflows:
        dest = root / "inpaint_workflows" / workflow
        dest.mkdir(parents=True)
        Image.new("RGB", (4, 4)).save(dest / "01.png")
    partial = root / "inpaint_workflows" / f"{record.name}-三工作流對比.pdf"
    partial.write_bytes(b"partial")
    manager._generate_compare_pdf = AsyncMock(side_effect=OSError("PDF failure"))
    warning = asyncio.run(manager._package(record, "batch"))
    assert "PDF 生成失敗" in warning
    assert not partial.exists()
    with zipfile.ZipFile(root / "download.zip") as archive:
        assert len([name for name in archive.namelist() if name.endswith(".png")]) == 3
        assert b"PDF failure" in archive.read("logs/pdf.log")


def test_pdf_abandon_does_not_become_success(tmp_path):
    import pytest
    from app.engine import JobAbandoned
    manager, repository = make_manager(tmp_path)
    record = make_record()
    record.workflows = ["flux2klein_lanpaint", "firered", "qwen2511_lanpaint"]
    repository.write(record)
    manager._generate_compare_pdf = AsyncMock(side_effect=JobAbandoned())
    with pytest.raises(JobAbandoned):
        asyncio.run(manager._package(record, "batch"))
    assert not (repository.job_dir(record.id) / "download.zip").exists()


def test_resume_restores_valid_saved_outputs_and_quarantines_partial_raw(tmp_path):
    manager, repository = make_manager(tmp_path)
    record = make_record("abc-def")
    repository.write(record)
    out = manager.settings.comfy_output
    out.mkdir(parents=True)
    raw = out / "web_abcdef_flux_01_00001_.png"
    raw.write_bytes(b"partial PNG")
    saved = repository.job_dir(record.id) / "inpaint_workflows/flux2klein_lanpaint/01.png"
    saved.parent.mkdir(parents=True)
    Image.new("RGB", (16, 16), "green").save(saved)
    manager._prepare_existing_outputs(record, ["01"])
    assert raw.read_bytes() == saved.read_bytes()
    assert (repository.job_dir(record.id) / "incomplete-output-backups" / raw.name).read_bytes() == b"partial PNG"


def test_failure_log_is_retained_without_requiring_live_service(tmp_path):
    manager, repository = make_manager(tmp_path)
    record = make_record()
    log = manager.settings.data_root / "logs/comfyui.log"
    log.parent.mkdir(parents=True)
    log.write_text("original crash evidence")
    manager._save_comfy_failure_log(record.id)
    assert (repository.job_dir(record.id) / "logs/comfyui-failure.log").read_text() == "original crash evidence"


def test_comfy_crash_recovers_once_and_retries_same_job(tmp_path):
    from unittest.mock import Mock
    from app.engine import ComfyUnavailable
    manager, repository = make_manager(tmp_path)
    record = make_record(); repository.write(record)
    manager._run_job = AsyncMock(side_effect=[ComfyUnavailable("disconnected"), None])
    manager.restart_comfy = Mock()
    asyncio.run(manager._run_with_recovery(record.id))
    assert manager._run_job.await_count == 2
    manager.restart_comfy.assert_called_once_with(record.id)
    assert repository.read(record.id).recovery_attempts == 1


def test_repeated_crash_stops_after_one_automatic_recovery(tmp_path):
    import pytest
    from unittest.mock import Mock
    from app.engine import ComfyUnavailable
    manager, repository = make_manager(tmp_path)
    record = make_record(); repository.write(record)
    manager._run_job = AsyncMock(side_effect=ComfyUnavailable("disconnected"))
    manager.restart_comfy = Mock()
    with pytest.raises(ComfyUnavailable):
        asyncio.run(manager._run_with_recovery(record.id))
    assert manager._run_job.await_count == 2
    assert manager.restart_comfy.call_count == 1
    assert repository.read(record.id).recovery_attempts == 1


def test_normal_model_error_does_not_trigger_restart(tmp_path):
    import pytest
    from unittest.mock import Mock
    manager, repository = make_manager(tmp_path)
    record = make_record(); repository.write(record)
    manager._run_job = AsyncMock(side_effect=RuntimeError("invalid model"))
    manager.restart_comfy = Mock()
    with pytest.raises(RuntimeError, match="invalid model"):
        asyncio.run(manager._run_with_recovery(record.id))
    manager.restart_comfy.assert_not_called()


def test_firered_resume_uses_new_timing_log_but_same_output_prefix(tmp_path):
    manager, _ = make_manager(tmp_path)
    _, first = manager._command_for("firered", "batch", "same_")
    _, second = manager._command_for("firered", "batch", "same_")
    assert first["FIRERED_BATCH_NAME"] != second["FIRERED_BATCH_NAME"]
    assert first["FIRERED_OUTPUT_PREFIX"] == second["FIRERED_OUTPUT_PREFIX"] == "same_"


def test_disconnected_comfy_terminates_batch_after_three_checks(tmp_path, monkeypatch):
    from app.engine import ComfyUnavailable
    import pytest
    from unittest.mock import Mock
    manager, repository = make_manager(tmp_path)
    record = make_record(); repository.write(record)
    process = Mock(returncode=None)
    process.wait = AsyncMock()
    process.communicate = AsyncMock(return_value=(b"monitor stopped", None))
    monkeypatch.setattr("app.engine.asyncio.create_subprocess_exec", AsyncMock(return_value=process))
    async def timeout(awaitable, timeout):
        awaitable.close()
        raise TimeoutError()
    monkeypatch.setattr("app.engine.asyncio.wait_for", timeout)
    manager._sync_available_outputs = Mock(return_value=0)
    manager._fetch_json = Mock(side_effect=ConnectionRefusedError())
    async def terminate():
        process.returncode = -15
    manager._terminate_active_process = AsyncMock(side_effect=terminate)
    with pytest.raises(ComfyUnavailable):
        asyncio.run(manager._run_process(record, "flux2klein_lanpaint", ["fake-runner"], {}, "test_", ["01", "02"]))
    assert manager._fetch_json.call_count == 3
    manager._terminate_active_process.assert_awaited_once()
    assert manager.active_process is None
    assert (repository.job_dir(record.id) / "logs/flux2klein_lanpaint_monitor.log").read_bytes() == b"monitor stopped"
