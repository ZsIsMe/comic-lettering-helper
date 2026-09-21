#!/usr/bin/env python3
"""Read-only verification for an AutoDL image before it is published."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def tree_sha256(root: Path) -> str:
    """Match: find . -type f ... | sort -z | xargs sha256sum | sha256sum."""
    listing = hashlib.sha256()
    paths = sorted(
        path for path in root.rglob("*")
        if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc" and ".git" not in path.parts
    )
    for path in paths:
        relative = f"./{path.relative_to(root).as_posix()}"
        listing.update(f"{sha256(path)}  {relative}\n".encode())
    return listing.hexdigest()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--app-root", type=Path, default=Path(os.getenv("COMIC_APP_ROOT", "/root/comic-inpaint")))
    parser.add_argument("--comfy-root", type=Path, default=Path(os.getenv("COMFY_ROOT", "/root/ComfyUI")))
    parser.add_argument("--bundled-only", action="store_true", help="Check repository assets without a GPU installation")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    app_root = args.app_root.resolve()
    comfy_root = args.comfy_root.resolve()
    components = json.loads((app_root / "config" / "components.json").read_text(encoding="utf-8"))
    models = json.loads((app_root / "config" / "models.json").read_text(encoding="utf-8"))["models"]
    failures: list[str] = []

    if args.bundled_only:
        for name, expected in components["workflow_sha256"].items():
            path = app_root / "workflows" / name
            if not path.is_file() or sha256(path) != expected:
                failures.append(f"HASH bundled workflow/{name}")
        for name in ("runtime-tools/run_qwen21_batch.py", "frontend/dist/index.html"):
            if not (app_root / name).is_file():
                failures.append(f"MISSING {name}")
        for failure in failures:
            print(failure, file=sys.stderr)
        print(json.dumps({"ok": not failures, "scope": "bundled assets only", "failure_count": len(failures)}))
        return int(bool(failures))

    core = [comfy_root / "main.py", app_root / "frontend" / "dist" / "index.html"]
    for path in core:
        if path.is_file():
            print(f"OK      {path}")
        else:
            failures.append(f"MISSING {path}")

    for directory in components["custom_nodes"]:
        path = comfy_root / "custom_nodes" / directory["directory"]
        if not path.is_dir():
            failures.append(f"MISSING node/{directory['directory']}")
            continue
        if expected_tree := directory.get("tree_sha256"):
            actual_tree = tree_sha256(path)
            if actual_tree != expected_tree:
                failures.append(f"HASH    node/{directory['directory']}")
                continue
        if expected_commit := directory.get("commit"):
            result = subprocess.run(
                ["git", "-C", str(path), "rev-parse", "HEAD"],
                text=True,
                capture_output=True,
                check=False,
            )
            if result.returncode or result.stdout.strip() != expected_commit:
                failures.append(f"COMMIT  node/{directory['directory']}")
                continue
        print(f"OK      node/{directory['directory']}")

    for name, expected in components["workflow_sha256"].items():
        installed = comfy_root / "user" / "default" / "workflows" / Path(name).name
        bundled = app_root / "workflows" / name
        paths = (("bundled", bundled),) if name.endswith('.api.json') else (("installed", installed), ("bundled", bundled))
        for label, path in paths:
            if not path.is_file():
                failures.append(f"MISSING {label} workflow/{name}")
            elif sha256(path) != expected:
                failures.append(f"HASH    {label} workflow/{name}")
            else:
                print(f"OK      {label} workflow/{name}")

    for model in models:
        path = comfy_root / "models" / model["target"]
        if path.is_file():
            if model.get("size_bytes") and path.stat().st_size != model["size_bytes"]:
                failures.append(f"SIZE    model/{model['id']}")
            elif model.get("sha256") and sha256(path) != model["sha256"]:
                failures.append(f"HASH    model/{model['id']}")
            else:
                print(f"OK      model/{model['id']}")
        elif model.get("required", True):
            failures.append(f"MISSING model/{model['id']}: {path}")

    for failure in failures:
        print(failure, file=sys.stderr)
    print(json.dumps({"ok": not failures, "failure_count": len(failures)}, ensure_ascii=False))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
