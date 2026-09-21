from __future__ import annotations

from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, Field


WorkflowId = Literal["firered", "qwen2511_lanpaint", "flux2klein_lanpaint"]


class JobState(StrEnum):
    queued = "queued"
    validating = "validating"
    running = "running"
    packaging = "packaging"
    abandoning = "abandoning"
    abandoned = "abandoned"
    completed = "completed"
    failed = "failed"


class WorkflowProgress(BaseModel):
    state: Literal["waiting", "preparing", "running", "completed", "failed", "abandoned"] = "waiting"
    completed: int = 0
    total: int = 0
    generated: int = 0
    passthrough: int = 0
    first_seconds: float | None = None
    warm_average_seconds: float | None = None
    elapsed_seconds: float = 0
    remaining_seconds: float | None = None
    started_at: str | None = None
    finished_at: str | None = None
    active_started_at: str | None = None
    timing_samples: dict[str, float] = Field(default_factory=dict)


class JobRecord(BaseModel):
    id: str
    name: str
    state: JobState = JobState.queued
    workflows: list[WorkflowId]
    pair_count: int
    black_mask_count: int = 0
    workflow_progress: dict[WorkflowId, WorkflowProgress] = Field(default_factory=dict)
    current_workflow: WorkflowId | None = None
    completed_in_current: int = 0
    completed_total: int = 0
    total_runs: int
    message: str = "等待執行"
    error: str | None = None
    created_at: str
    updated_at: str
    finished_at: str | None = None
    download_ready: bool = False
    recovery_attempts: int = 0
    partial_results_accepted: bool = False
    results: dict[str, list[str]] = Field(default_factory=dict)
    result_directory: str | None = None
    archive_path: str | None = None
    project_id: str | None = None
    snapshot_id: str | None = None


class HealthResponse(BaseModel):
    app: str
    comfy_ready: bool
    queue_running: bool
    active_job_id: str | None
    gpu_name: str | None = None
    gpu_memory_used_mib: int | None = None
    gpu_memory_total_mib: int | None = None
    gpu_utilization_percent: int | None = None
    gpu_owner: str | None = None
