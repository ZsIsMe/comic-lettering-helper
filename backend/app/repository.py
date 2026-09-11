from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

from .schemas import JobRecord


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


class JobRepository:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    def job_dir(self, job_id: str) -> Path:
        return self.root / job_id

    def write(self, record: JobRecord) -> None:
        record.updated_at = now_iso()
        path = self.job_dir(record.id) / "job.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".tmp")
        temporary.write_text(record.model_dump_json(indent=2) + "\n", encoding="utf-8")
        temporary.replace(path)

    def read(self, job_id: str) -> JobRecord:
        path = self.job_dir(job_id) / "job.json"
        if not path.is_file():
            raise KeyError(job_id)
        return JobRecord.model_validate_json(path.read_text(encoding="utf-8"))

    def list(self, limit: int | None = 20) -> list[JobRecord]:
        paths = sorted(self.root.glob("*/job.json"), key=lambda item: item.stat().st_mtime, reverse=True)
        records = []
        selected_paths = paths if limit is None else paths[:limit]
        for path in selected_paths:
            try:
                records.append(JobRecord.model_validate_json(path.read_text(encoding="utf-8")))
            except (ValueError, json.JSONDecodeError):
                continue
        return records
