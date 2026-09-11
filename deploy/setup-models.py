#!/usr/bin/env python3
"""Check or create the public-library model links used by the workflows."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path)
    parser.add_argument("--comfy-root", type=Path, default=Path(os.getenv("COMFY_ROOT", "/root/ComfyUI")))
    parser.add_argument("--apply", action="store_true", help="Create missing links; default is check only")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    app_root = Path(__file__).resolve().parents[1]
    config_path = args.config or app_root / "config" / "models.json"
    payload = json.loads(config_path.read_text(encoding="utf-8"))
    model_root = args.comfy_root.resolve() / "models"
    errors: list[str] = []

    for model in payload["models"]:
        target = model_root / model["target"]
        sources = [Path(value) for value in model.get("source_candidates", [])]
        source = next((path for path in sources if path.is_file()), None)
        label = model["id"]

        if target.exists() or target.is_symlink():
            if not target.exists():
                errors.append(f"BROKEN {label}: {target}")
                continue
            if target.is_symlink() and source and target.resolve() != source.resolve():
                errors.append(f"CONFLICT {label}: {target} -> {target.resolve()}")
                continue
            expected_size = model.get("size_bytes")
            if expected_size and target.stat().st_size != expected_size:
                errors.append(f"SIZE    {label}: expected={expected_size}, actual={target.stat().st_size}")
                continue
            print(f"OK      {label}: {target}")
            continue

        if source is None:
            if model.get("required", True):
                errors.append(f"MISSING {label}: no source candidate exists")
            else:
                print(f"OPTIONAL {label}: source unavailable")
            continue

        if args.apply:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.symlink_to(source)
            expected_size = model.get("size_bytes")
            if expected_size and target.stat().st_size != expected_size:
                target.unlink(missing_ok=True)
                errors.append(f"SIZE    {label}: source is not the tested file")
                continue
            print(f"LINKED  {label}: {target} -> {source}")
        else:
            print(f"PLAN    {label}: {target} -> {source}")

    for error in errors:
        print(error, file=sys.stderr)
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
