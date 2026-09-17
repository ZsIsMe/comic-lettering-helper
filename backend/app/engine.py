from __future__ import annotations

import asyncio
import json
import os
import signal
import shutil
import urllib.error
import urllib.request
import zipfile
import time
from contextlib import suppress
from pathlib import Path

from PIL import Image

from .config import Settings
from .repository import JobRepository
from .schemas import JobRecord, JobState, WorkflowId
from .resources import ResourceGate
from .storage import validate_pairs


WORKFLOW_META: dict[WorkflowId, dict[str, str]] = {
    "firered": {
        "prefix": "firered",
        "result_dir": "firered",
    },
    "qwen2511_lanpaint": {
        "prefix": "qwen",
        "result_dir": "qwen2511_lanpaint",
    },
    "flux2klein_lanpaint": {
        "prefix": "flux",
        "result_dir": "flux2klein_lanpaint",
    },
}


class ComfyUnavailable(RuntimeError):
    """The model service stopped responding; safe to attempt one recovery."""


class JobAbandoned(Exception):
    """Raised inside the worker after the user requests a safe stop."""


class JobManager:
    def __init__(self, settings: Settings, repository: JobRepository) -> None:
        self.settings = settings
        self.repository = repository
        self.queue: asyncio.Queue[str] | None = None
        self.worker_task: asyncio.Task | None = None
        self.active_job_id: str | None = None
        self.active_process: asyncio.subprocess.Process | None = None
        self.abandon_requested: set[str] = set()
        self.restart_comfy = None
        self.gpu_gate = ResourceGate()

    async def start(self) -> None:
        if self.worker_task is None or self.worker_task.done():
            self.queue = asyncio.Queue()
            self.worker_task = asyncio.create_task(self._worker(), name="single-gpu-worker")
        reserved = False
        for record in reversed(self.repository.list(limit=None)):
            if record.state == JobState.abandoning:
                self._finalize_abandoned(record.id)
            elif record.state in {JobState.queued, JobState.validating, JobState.running, JobState.packaging}:
                record.state = JobState.queued
                record.message = "服務重啟，等待續跑"
                record.error = None
                self.repository.write(record)
                if not reserved:
                    self.gpu_gate.claim(record.id)
                    reserved = True
                await self.queue.put(record.id)

    async def stop(self) -> None:
        if self.worker_task:
            self.worker_task.cancel()
            with suppress(asyncio.CancelledError):
                await self.worker_task
        self.worker_task = None
        self.queue = None

    async def enqueue(self, job_id: str) -> None:
        if self.queue is None:
            raise RuntimeError("任務隊列尚未啟動")
        await self.queue.put(job_id)

    async def abandon(self, job_id: str) -> JobRecord:
        record = self.repository.read(job_id)
        if record.state in {JobState.completed, JobState.failed, JobState.abandoned}:
            raise ValueError("此任務已經結束，不能再放棄")
        self.abandon_requested.add(job_id)
        record.state = JobState.abandoning
        record.message = "正在停止目前工作；已完成結果會保留"
        self.repository.write(record)
        if self.active_job_id == job_id:
            await self._interrupt_comfy()
            await self._terminate_active_process()
        return self.repository.read(job_id)

    def build_current_archive(self, job_id: str) -> tuple[JobRecord, Path]:
        record = self.repository.read(job_id)
        job_dir = self.repository.job_dir(job_id)
        if record.download_ready:
            archive = job_dir / "download.zip"
            if archive.is_file():
                return record, archive
        results = job_dir / "inpaint_workflows"
        if not results.is_dir() or not any(path.is_file() for path in results.rglob("*")):
            raise ValueError("目前還沒有已完成的圖片可下載")
        archive = job_dir / "current-download.zip"
        self._write_archive(job_dir, archive)
        return record, archive

    async def _worker(self) -> None:
        if self.queue is None:
            raise RuntimeError("任務隊列尚未啟動")
        queue = self.queue
        while True:
            job_id = await queue.get()
            while not self.gpu_gate.claim(job_id):
                await asyncio.sleep(0.2)
            self.active_job_id = job_id
            try:
                await self._run_with_recovery(job_id)
            except asyncio.CancelledError:
                await self._terminate_active_process()
                raise
            except JobAbandoned:
                self._finalize_abandoned(job_id)
            except Exception as exc:
                record = self.repository.read(job_id)
                if job_id in self.abandon_requested or record.state == JobState.abandoning:
                    self._finalize_abandoned(job_id)
                else:
                    record.state = JobState.failed
                    record.completed_total = sum(len(items) for items in record.results.values())
                    record.message = "任務已停止；已完成圖片可下載" if record.completed_total else "任務失敗"
                    record.error = str(exc)
                    self._save_comfy_failure_log(record.id)
                    self.repository.write(record)
            finally:
                self.abandon_requested.discard(job_id)
                self.active_process = None
                self.active_job_id = None
                self.gpu_gate.release(job_id)
                queue.task_done()

    async def _run_with_recovery(self, job_id: str) -> None:
        while True:
            try:
                await self._run_job(job_id)
                return
            except ComfyUnavailable:
                record = self.repository.read(job_id)
                self._raise_if_abandoned(job_id)
                self._save_comfy_failure_log(job_id)
                if record.recovery_attempts >= 1 or self.restart_comfy is None:
                    raise
                record.recovery_attempts += 1
                record.message = "ComfyUI 已失聯，正在自動重啟並續跑（1/1）；已完成圖片保留"
                self.repository.write(record)
                logs = self.repository.job_dir(job_id) / "logs"
                backup = logs / "before-auto-recovery"
                backup.mkdir(parents=True, exist_ok=True)
                for log in logs.iterdir():
                    if log.is_file():
                        shutil.copy2(log, backup / log.name)
                await asyncio.to_thread(self.restart_comfy, job_id)
                self._raise_if_abandoned(job_id)

    def _save_comfy_failure_log(self, job_id: str) -> None:
        """Keep the original service evidence before the user restarts it."""
        source = self.settings.data_root / "logs/comfyui.log"
        target = self.repository.job_dir(job_id) / "logs/comfyui-failure.log"
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            with source.open("rb") as log:
                log.seek(0, 2)
                log.seek(max(0, log.tell() - 2_000_000))
                target.write_bytes(log.read())
        except OSError:
            pass  # Logging must not prevent releasing a failed job's GPU reservation.

    def _raise_if_abandoned(self, job_id: str) -> None:
        record = self.repository.read(job_id)
        if job_id in self.abandon_requested or record.state == JobState.abandoning:
            raise JobAbandoned

    async def _interrupt_comfy(self) -> None:
        request = urllib.request.Request(
            f"{self.settings.comfy_url}/interrupt",
            data=b"{}",
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with suppress(OSError):
            await asyncio.to_thread(urllib.request.urlopen, request, timeout=3)

    async def _terminate_active_process(self) -> None:
        process = self.active_process
        if process is None or process.returncode is not None:
            return
        with suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGTERM)
        try:
            await asyncio.wait_for(process.wait(), timeout=10)
        except TimeoutError:
            with suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
            await process.wait()

    async def _wait_comfy(self, timeout_seconds: int = 180) -> None:
        deadline = asyncio.get_running_loop().time() + timeout_seconds
        while asyncio.get_running_loop().time() < deadline:
            try:
                await asyncio.to_thread(self._fetch_json, f"{self.settings.comfy_url}/system_stats")
                return
            except (OSError, json.JSONDecodeError):
                await asyncio.sleep(2)
        raise ComfyUnavailable("ComfyUI 尚未就緒，請使用網頁重啟服務")

    @staticmethod
    def _fetch_json(url: str) -> dict:
        with urllib.request.urlopen(url, timeout=3) as response:
            return json.load(response)

    def _prepare_comfy_input(self, record: JobRecord) -> tuple[str, list[str]]:
        job_dir = self.repository.job_dir(record.id)
        sources = job_dir / "uploads" / "pair"
        masks = job_dir / "uploads" / "pair_mask"
        batch_name = f"web_{record.id.replace('-', '')[:12]}"
        batch_root = self.settings.comfy_input / batch_name
        if batch_root.exists():
            shutil.rmtree(batch_root)
        source_target = batch_root / "pair"
        mask_target = batch_root / "pair_mask"
        source_target.mkdir(parents=True)
        mask_target.mkdir(parents=True)
        for path in sources.iterdir():
            if path.is_file():
                shutil.copy2(path, source_target / f"{path.stem}{path.suffix.lower()}")
        for path in masks.iterdir():
            if path.is_file():
                shutil.copy2(path, mask_target / f"{path.stem}.png")

        stems = sorted(path.stem for path in source_target.iterdir() if path.is_file())
        for stem in stems:
            source = next(path for path in source_target.iterdir() if path.is_file() and path.stem == stem)
            mask = mask_target / f"{stem}.png"
            shutil.copy2(source, self.settings.comfy_input / f"{batch_name}_{source.name}")
            shutil.copy2(mask, self.settings.comfy_input / f"{batch_name}_mask_{mask.name}")
        return batch_name, stems

    def _prepare_existing_outputs(self, record: JobRecord, stems: list[str]) -> None:
        for workflow in record.workflows:
            prefix = f"web_{record.id.replace('-', '')[:12]}_{WORKFLOW_META[workflow]['prefix']}_"
            for stem in stems:
                valid = False
                for raw in self.settings.comfy_output.glob(f"{prefix}{stem}_*.png"):
                    try:
                        with Image.open(raw) as image:
                            image.verify()
                        with Image.open(raw) as image:
                            image.load()
                        valid = True
                    except (OSError, SyntaxError, ValueError):
                        backup = self.repository.job_dir(record.id) / "incomplete-output-backups" / raw.name
                        backup.parent.mkdir(parents=True, exist_ok=True)
                        shutil.move(raw, backup)
                saved = self.repository.job_dir(record.id) / "inpaint_workflows" / workflow / f"{stem}.png"
                if valid or not saved.is_file():
                    continue
                try:
                    with Image.open(saved) as image:
                        image.verify()
                    with Image.open(saved) as image:
                        image.load()
                except (OSError, SyntaxError, ValueError):
                    continue
                raw = self.settings.comfy_output / f"{prefix}{stem}_00001_.png"
                raw.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(saved, raw)

    async def _run_job(self, job_id: str) -> None:
        self._raise_if_abandoned(job_id)
        record = self.repository.read(job_id)
        record.state = JobState.validating
        record.message = "檢查圖片與 Mask"
        self.repository.write(record)
        job_dir = self.repository.job_dir(job_id)
        source_dir = job_dir / "uploads" / "pair"
        mask_dir = job_dir / "uploads" / "pair_mask"
        sources = {path.stem: path for path in source_dir.iterdir() if path.is_file()}
        masks = {path.stem: path for path in mask_dir.iterdir() if path.is_file()}
        stems, black_masks = validate_pairs(sources, masks)
        if len(black_masks) == len(stems):
            for workflow in record.workflows:
                target = job_dir / "inpaint_workflows" / workflow
                target.mkdir(parents=True, exist_ok=True)
                for stem in stems:
                    self._raise_if_abandoned(job_id)
                    with Image.open(sources[stem]) as source:
                        source.convert("RGB").save(target / f"{stem}.png")
                record.results[workflow] = [f"{stem}.png" for stem in stems]
            logs = job_dir / "logs"
            logs.mkdir(parents=True, exist_ok=True)
            (logs / "passthrough.json").write_text(json.dumps({"stems": stems, "reason": "all_masks_black"}), encoding="utf-8")
            record.state = JobState.completed
            record.completed_total = record.total_runs
            record.completed_in_current = len(stems)
            record.download_ready = True
            record.message = f"全部完成；{len(stems)} 頁無需推理，直接沿用底圖"
            self._write_archive(job_dir, job_dir / "download.zip")
            self.repository.write(record)
            return
        await self._wait_comfy()
        self._raise_if_abandoned(job_id)
        batch_name, stems = self._prepare_comfy_input(record)
        self._prepare_existing_outputs(record, stems)
        expected = len(stems)

        record.state = JobState.running
        record.message = "開始串行推理"
        self.repository.write(record)
        for workflow in record.workflows:
            self._raise_if_abandoned(job_id)
            record = self.repository.read(job_id)
            record.current_workflow = workflow
            record.completed_in_current = 0
            record.message = f"正在運行 {workflow}"
            self.repository.write(record)
            prefix = f"web_{record.id.replace('-', '')[:12]}_{WORKFLOW_META[workflow]['prefix']}_"
            command, env = self._command_for(workflow, batch_name, prefix)
            await self._run_process(record, workflow, command, env, prefix, stems)
            self._normalize_outputs(record, workflow, prefix, stems)

        self._raise_if_abandoned(job_id)
        record = self.repository.read(job_id)
        record.state = JobState.packaging
        record.current_workflow = None
        record.message = "整理圖片與下載包"
        self.repository.write(record)
        pdf_warning = await self._package(record, batch_name)
        record = self.repository.read(job_id)
        record.state = JobState.completed
        record.completed_total = record.total_runs
        record.download_ready = True
        record.message = pdf_warning or "全部完成"
        self.repository.write(record)
        self._cleanup_comfy_staging(batch_name, record)

    def _command_for(self, workflow: WorkflowId, batch_name: str, prefix: str) -> tuple[list[str], dict[str, str]]:
        env = os.environ.copy()
        if workflow == "firered":
            env.update(
                FIRERED_BASE_WORKFLOW=str(self.settings.workflow_root / "FireRed-v12-newprompt-latent-mask-FP8Mixed-FP8Text.json"),
                FIRERED_BATCH_NAME=f"{batch_name}_firered_{time.time_ns()}",
                FIRERED_PAIR_DIR=f"{batch_name}/pair",
                FIRERED_MASK_DIR=f"{batch_name}/pair_mask",
                FIRERED_OUTPUT_PREFIX=prefix,
                FIRERED_SKIP_STEMS="",
                FIRERED_LOAD_FLAT="1",
                FIRERED_FLAT_NAME_PREFIX=f"{batch_name}_",
                FIRERED_MASK_FLAT_NAME_PREFIX=f"{batch_name}_mask_",
                FIRERED_PRESERVE_WORKFLOW="1",
            )
            command = [self.settings.python_bin, str(self.settings.tools_root / "firered_batch_runner.py")]
        else:
            model = "qwenlanpaint" if workflow == "qwen2511_lanpaint" else "flux2lanpaint"
            command = [
                self.settings.python_bin,
                str(self.settings.tools_root / "run_independent_edit_models_batch.py"),
                "--model",
                model,
                "--input-root",
                batch_name,
                "--skip",
                "--output-prefix",
                prefix,
                "--poll-interval",
                "1",
            ]
        return command, env

    async def _run_process(
        self,
        record: JobRecord,
        workflow: WorkflowId,
        command: list[str],
        env: dict[str, str],
        prefix: str,
        stems: list[str],
    ) -> None:
        expected = len(stems)
        logs = self.repository.job_dir(record.id) / "logs"
        logs.mkdir(parents=True, exist_ok=True)
        log_path = logs / f"{workflow}.log"
        monitor_command = [
            self.settings.python_bin,
            str(self.settings.tools_root / "run_with_vram_monitor.py"),
            "--label",
            workflow,
            "--csv",
            str(logs / f"{workflow}_vram.csv"),
            "--summary",
            str(logs / f"{workflow}_vram_summary.json"),
            "--log",
            str(log_path),
            "--interval",
            "1",
            "--",
            *command,
        ]
        process = await asyncio.create_subprocess_exec(
            *monitor_command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=env,
            start_new_session=True,
        )
        self.active_process = process
        health_ticks = 0
        health_failures = 0
        service_error = None
        try:
            while True:
                try:
                    returncode = await asyncio.wait_for(process.wait(), timeout=1)
                    break
                except TimeoutError:
                    latest = self.repository.read(record.id)
                    completed = self._sync_available_outputs(latest, workflow, prefix, stems)
                    latest.completed_in_current = min(completed, expected)
                    current_index = latest.workflows.index(workflow)
                    latest.completed_total = current_index * expected + latest.completed_in_current
                    self.repository.write(latest)
                    self._raise_if_abandoned(record.id)
                    health_ticks += 1
                    if health_ticks % 5 == 0:
                        try:
                            await asyncio.to_thread(self._fetch_json, f"{self.settings.comfy_url}/system_stats")
                            health_failures = 0
                        except (OSError, ValueError):
                            health_failures += 1
                        if health_failures >= 3:
                            service_error = "ComfyUI 連續失聯，任務已停止並保留結果。請使用頁面上方重啟 ComfyUI，再續跑未完成圖片。"
                            await self._terminate_active_process()
                            returncode = process.returncode
                            break
            monitor_output, _ = await process.communicate()
            latest = self.repository.read(record.id)
            self._sync_available_outputs(latest, workflow, prefix, stems)
            self.repository.write(latest)
        except BaseException:
            await self._terminate_active_process()
            raise
        finally:
            if self.active_process is process:
                self.active_process = None
        (logs / f"{workflow}_monitor.log").write_bytes(monitor_output)
        self._raise_if_abandoned(record.id)
        completed = len(self.repository.read(record.id).results.get(workflow, []))
        if service_error:
            raise ComfyUnavailable(service_error)
        if returncode != 0 or completed != expected:
            try:
                await asyncio.to_thread(self._fetch_json, f"{self.settings.comfy_url}/system_stats")
            except (OSError, ValueError):
                raise ComfyUnavailable("ComfyUI 已停止回應；已完成圖片會保留。請重啟 ComfyUI 後續跑未完成圖片。") from None
            raise RuntimeError(f"{workflow} 未完整完成：returncode={returncode}, expected={expected}, actual={completed}")

    def _sync_available_outputs(
        self,
        record: JobRecord,
        workflow: WorkflowId,
        prefix: str,
        stems: list[str],
        *,
        require_all: bool = False,
    ) -> int:
        destination = self.repository.job_dir(record.id) / "inpaint_workflows" / WORKFLOW_META[workflow]["result_dir"]
        destination.mkdir(parents=True, exist_ok=True)
        names: list[str] = []
        for stem in stems:
            matches = sorted(self.settings.comfy_output.glob(f"{prefix}{stem}_*.png"))
            if not matches:
                if require_all:
                    raise RuntimeError(f"缺少輸出：{workflow}/{stem}")
                continue
            target = destination / f"{stem}.png"
            # A visible ComfyUI filename may still be in the middle of PNG writes.
            # Validate the copied snapshot before publishing it to downloads.
            temporary = target.with_suffix(".tmp")
            try:
                if target.is_file() and not require_all:
                    with Image.open(target) as image:
                        image.verify()
                    with Image.open(target) as image:
                        image.load()
                else:
                    raise OSError("Refresh output snapshot")
            except (OSError, SyntaxError, ValueError):
                try:
                    shutil.copy2(matches[-1], temporary)
                    with Image.open(temporary) as image:
                        image.verify()
                    with Image.open(temporary) as image:
                        image.load()
                    temporary.replace(target)
                except (OSError, SyntaxError, ValueError) as exc:
                    if require_all:
                        raise RuntimeError(f"輸出圖片尚未完整：{workflow}/{stem}") from exc
                    continue
                finally:
                    temporary.unlink(missing_ok=True)
            names.append(target.name)
        record.results[workflow] = names
        return len(names)

    def _normalize_outputs(self, record: JobRecord, workflow: WorkflowId, prefix: str, stems: list[str]) -> None:
        self._sync_available_outputs(record, workflow, prefix, stems, require_all=True)
        self.repository.write(record)

    async def _package(self, record: JobRecord, batch_name: str) -> str | None:
        job_dir = self.repository.job_dir(record.id)
        logs = job_dir / "logs"
        logs.mkdir(parents=True, exist_ok=True)
        warning = None
        if set(record.workflows) == set(WORKFLOW_META):
            try:
                await self._generate_compare_pdf(record, batch_name)
            except JobAbandoned:
                raise
            except Exception as exc:
                warning = "圖片已完成；比較 PDF 生成失敗，圖片與日誌仍可下載"
                with (logs / "pdf.log").open("a", encoding="utf-8") as log:
                    log.write(f"\nPDF 附加輸出失敗：{type(exc).__name__}: {exc}\n")
                pdf = job_dir / "inpaint_workflows" / f"{record.name}-三工作流對比.pdf"
                pdf.unlink(missing_ok=True)
        self._raise_if_abandoned(record.id)
        self._write_archive(job_dir, job_dir / "download.zip")
        return warning

    async def _generate_compare_pdf(self, record: JobRecord, batch_name: str) -> None:
        job_dir = self.repository.job_dir(record.id)
        results = job_dir / "inpaint_workflows"
        logs = job_dir / "logs"
        stage = job_dir / "pdf-stage"
        stage.mkdir(parents=True, exist_ok=True)
        links = {
            "pair": self.settings.comfy_input / batch_name / "pair",
            "pair_mask": self.settings.comfy_input / batch_name / "pair_mask",
            "result_firered": results / "firered",
            "result_qwen2511_lanpaint": results / "qwen2511_lanpaint",
            "result_flux2klein_lanpaint": results / "flux2klein_lanpaint",
        }
        for name, target in links.items():
            link = stage / name
            link.unlink(missing_ok=True)
            link.symlink_to(target, target_is_directory=True)
        pdf = results / f"{record.name}-三工作流對比.pdf"
        process = await asyncio.create_subprocess_exec(
            self.settings.python_bin,
            str(self.settings.tools_root / "make_three_model_inpaint_compare_pdf.py"),
            str(stage),
            "-o",
            str(pdf),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            start_new_session=True,
        )
        self.active_process = process
        try:
            output, _ = await process.communicate()
        finally:
            if self.active_process is process:
                self.active_process = None
        (logs / "pdf.log").write_bytes(output)
        self._raise_if_abandoned(record.id)
        if process.returncode != 0:
            raise RuntimeError("比較 PDF 生成失敗")

    @staticmethod
    def _write_archive(job_dir: Path, archive: Path) -> None:
        temporary = archive.with_suffix(".tmp")
        temporary.unlink(missing_ok=True)
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_STORED) as handle:
            results = job_dir / "inpaint_workflows"
            logs = job_dir / "logs"
            for root in (results, logs):
                if not root.is_dir():
                    continue
                for path in root.rglob("*"):
                    if path.is_file():
                        handle.write(path, path.relative_to(job_dir))
        temporary.replace(archive)

    def _finalize_abandoned(self, job_id: str) -> None:
        record = self.repository.read(job_id)
        record.state = JobState.abandoned
        record.current_workflow = None
        record.completed_total = sum(len(record.results.get(workflow, [])) for workflow in record.workflows)
        record.download_ready = record.completed_total > 0
        record.error = None
        record.message = "已放棄；可下載已完成結果" if record.download_ready else "已放棄；尚無完成結果"
        self.repository.write(record)
        job_dir = self.repository.job_dir(job_id)
        if record.download_ready:
            self._write_archive(job_dir, job_dir / "download.zip")
        batch_name = f"web_{record.id.replace('-', '')[:12]}"
        self._cleanup_comfy_staging(batch_name, record)

    def _cleanup_comfy_staging(self, batch_name: str, record: JobRecord) -> None:
        """Remove only this completed job's temporary ComfyUI files."""
        shutil.rmtree(self.settings.comfy_input / batch_name, ignore_errors=True)
        for path in self.settings.comfy_input.glob(f"{batch_name}_*"):
            if path.is_file() or path.is_symlink():
                path.unlink(missing_ok=True)
        for workflow in record.workflows:
            prefix = f"web_{record.id.replace('-', '')[:12]}_{WORKFLOW_META[workflow]['prefix']}_"
            for path in self.settings.comfy_output.glob(f"{prefix}*.png"):
                path.unlink(missing_ok=True)
