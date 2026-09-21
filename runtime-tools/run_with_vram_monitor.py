#!/usr/bin/env python3
"""Run a command while sampling whole-GPU NVIDIA telemetry once per second."""

from __future__ import annotations

import argparse
import csv
import json
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from inpaint_report_summary import capture_environment


QUERY = (
    "timestamp,index,name,memory.total,memory.used,memory.free,"
    "utilization.gpu,temperature.gpu,power.draw"
)
FIELDS = [
    "nvidia_timestamp",
    "gpu_index",
    "gpu_name",
    "memory_total_mib",
    "memory_used_mib",
    "memory_free_mib",
    "gpu_utilization_percent",
    "temperature_c",
    "power_draw_w",
]


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def number(value: str) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--label", required=True)
    parser.add_argument("--csv", type=Path, required=True)
    parser.add_argument("--summary", type=Path, required=True)
    parser.add_argument("--log", type=Path, required=True)
    parser.add_argument("--interval", type=float, default=1.0)
    parser.add_argument("--comfy-url", help="Local ComfyUI URL for the saved environment snapshot")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("a command is required after --")

    for path in (args.csv, args.summary, args.log):
        path.parent.mkdir(parents=True, exist_ok=True)

    rows: list[dict[str, str]] = []
    sample_errors: list[str] = []
    stop = threading.Event()

    def sample_loop() -> None:
        with args.csv.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=["sampled_at_utc", *FIELDS])
            writer.writeheader()
            while not stop.is_set():
                sampled_at = iso_now()
                result = subprocess.run(
                    [
                        "nvidia-smi",
                        f"--query-gpu={QUERY}",
                        "--format=csv,noheader,nounits",
                    ],
                    text=True,
                    capture_output=True,
                    check=False,
                )
                if result.returncode == 0:
                    for line in result.stdout.splitlines():
                        values = [part.strip() for part in line.split(",")]
                        if len(values) != len(FIELDS):
                            continue
                        row = {"sampled_at_utc": sampled_at, **dict(zip(FIELDS, values))}
                        rows.append(row)
                        writer.writerow(row)
                    handle.flush()
                elif result.stderr.strip():
                    sample_errors.append(result.stderr.strip())
                stop.wait(max(0.2, args.interval))

    # Store alongside the job logs; the PDF reader never substitutes its own host.
    environment_path = args.summary.with_name(args.summary.name.replace("_vram_summary.json", "_environment.json"))
    if environment_path == args.summary:
        environment_path = args.summary.with_name(args.summary.stem + "_environment.json")
    environment_path.write_text(json.dumps(capture_environment(args.comfy_url), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    started_at = iso_now()
    started = time.monotonic()
    monitor = threading.Thread(target=sample_loop, name="vram-monitor", daemon=True)
    monitor.start()
    with args.log.open("w", encoding="utf-8") as log_handle:
        process = subprocess.Popen(command, stdout=log_handle, stderr=subprocess.STDOUT, text=True)
        returncode = process.wait()
    stop.set()
    monitor.join(timeout=max(2.0, args.interval + 1.0))

    used = [number(row["memory_used_mib"]) for row in rows]
    used = [value for value in used if value is not None]
    free = [number(row["memory_free_mib"]) for row in rows]
    free = [value for value in free if value is not None]
    totals = [number(row["memory_total_mib"]) for row in rows]
    totals = [value for value in totals if value is not None]
    summary = {
        "label": args.label,
        "command": command,
        "started_at_utc": started_at,
        "finished_at_utc": iso_now(),
        "elapsed_seconds": round(time.monotonic() - started, 3),
        "returncode": returncode,
        "sample_interval_seconds": args.interval,
        "sample_count": len(rows),
        "gpu_names": sorted({row["gpu_name"] for row in rows}),
        "memory_total_mib": max(totals) if totals else None,
        "memory_used_peak_mib": max(used) if used else None,
        "memory_used_mean_mib": round(sum(used) / len(used), 3) if used else None,
        "memory_used_min_mib": min(used) if used else None,
        "memory_free_min_mib": min(free) if free else None,
        "sample_error_count": len(sample_errors),
        "sample_errors": sorted(set(sample_errors))[:10],
        "telemetry_csv": str(args.csv),
        "command_log": str(args.log),
    }
    args.summary.write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False), flush=True)
    return returncode


if __name__ == "__main__":
    sys.exit(main())
