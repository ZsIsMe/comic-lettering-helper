"""Per-workflow progress from runner events; no inferred image-quality checks."""
from __future__ import annotations

import json
import math
from datetime import datetime
from pathlib import Path

from .schemas import WorkflowProgress

WORKFLOW_NAMES = {
    'qwen2511_lanpaint': 'Qwen Image 2.1 INT8',
    'firered': 'FireRed FP8',
    'flux2klein_lanpaint': 'Flux2 Klein + LanPaint',
}


class TimingReader:
    """Consume complete JSON lines only, retaining incomplete writes for next poll."""
    def __init__(self, path: Path):
        self.path = path
        self.offset = 0

    def read(self) -> list[dict]:
        if not self.path.exists():
            return []
        rows = []
        with self.path.open('rb') as handle:
            if self.path.stat().st_size < self.offset:
                self.offset = 0
            handle.seek(self.offset)
            while line := handle.readline():
                if not line.endswith(b'\n'):
                    break
                self.offset = handle.tell()
                try:
                    row = json.loads(line)
                except (ValueError, UnicodeDecodeError):
                    continue
                if isinstance(row, dict):
                    rows.append(row)
        return rows


def update_progress(progress: WorkflowProgress, rows: list[dict], *, completed: int,
                    passthrough: int, black_count: int, elapsed: float, now: str) -> None:
    progress.completed = min(completed, progress.total)
    progress.passthrough = passthrough
    progress.elapsed_seconds = round(max(0, elapsed), 3)
    for row in rows:
        if row.get('event') == 'item_start' and not row.get('empty_mask_passthrough'):
            progress.state = 'running'
            progress.active_started_at = row.get('time') or row.get('started_at')
        if row.get('status') != 'completed' or row.get('empty_mask_passthrough'):
            continue
        seconds = row.get('elapsed_seconds')
        stem = row.get('stem')
        if not isinstance(stem, str) or not isinstance(seconds, (int, float)) or isinstance(seconds, bool):
            continue
        if not math.isfinite(seconds) or seconds < 0:
            continue
        progress.timing_samples.setdefault(stem, float(seconds))
        progress.state = 'running'
        progress.active_started_at = None
    values = list(progress.timing_samples.values())
    progress.generated = len(values)
    progress.first_seconds = values[0] if values else None
    progress.warm_average_seconds = sum(values[1:]) / len(values[1:]) if len(values) > 1 else None
    remaining = max(0, progress.total - black_count - (progress.completed - passthrough))
    progress.remaining_seconds = None
    if remaining == 0:
        progress.remaining_seconds = 0
    elif progress.warm_average_seconds is not None:
        active_elapsed = 0
        if progress.active_started_at:
            try:
                active_elapsed = max(0, (datetime.fromisoformat(now) - datetime.fromisoformat(progress.active_started_at)).total_seconds())
            except (ValueError, TypeError):
                pass
        average = progress.warm_average_seconds
        # Keep remaining queued images in the estimate even if the active image is slow.
        progress.remaining_seconds = round(max(0, average - active_elapsed) + (remaining - 1) * average, 3)
