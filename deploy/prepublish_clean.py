#!/usr/bin/env python3
"""List or remove only application-generated data before an image is published."""

from __future__ import annotations

import argparse
import os
import shutil
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--data-root", type=Path, default=Path(os.getenv("COMIC_DATA_ROOT", "/root/autodl-tmp/comic-inpaint")))
    parser.add_argument("--comfy-root", type=Path, default=Path(os.getenv("COMFY_ROOT", "/root/ComfyUI")))
    parser.add_argument("--prelayout-root", type=Path, default=Path(os.environ["COMIC_PRELAYOUT_DATA_ROOT"]) if os.getenv("COMIC_PRELAYOUT_DATA_ROOT") else None)
    return parser.parse_args()


def validate_root(path: Path) -> Path:
    resolved = path.resolve()
    if resolved in {Path("/"), Path("/root"), Path("/root/autodl-tmp"), Path("/root/ComfyUI")}:
        raise ValueError(f"refusing broad cleanup root: {resolved}")
    return resolved


def main() -> int:
    args = parse_args()
    data_root = validate_root(args.data_root)
    comfy_root = args.comfy_root.resolve()
    prelayout_root = validate_root(args.prelayout_root or data_root / 'prelayout')
    protected = [Path(os.getenv('COMIC_APP_ROOT', '/root/comic-inpaint')).resolve(),
                 Path(os.getenv('COMIC_PRELAYOUT_MODEL_ROOT', '/root/models/comic-prelayout')).resolve()]
    for root in protected:
        if prelayout_root == root or prelayout_root in root.parents or root in prelayout_root.parents:
            raise ValueError(f'refusing prelayout cleanup overlapping application/models: {prelayout_root}')
    targets: list[Path] = []
    targets.extend(path for path in (data_root / "projects", data_root / "jobs", data_root / "logs", data_root / "run") if path.exists())
    targets.extend(path for path in (prelayout_root / 'projects', prelayout_root / 'preferences') if path.exists())
    targets.extend(prelayout_root.glob('prelayout-*.zip'))
    for pattern in ("web_*", "qwenlanpaint_rgba_*.png"):
        targets.extend((comfy_root / "input").glob(pattern))
    targets.extend((comfy_root / "output").glob("web_*.png"))

    mode = "REMOVE" if args.apply else "DRY-RUN"
    for path in sorted(set(targets)):
        print(f"{mode} {path}")
        if args.apply:
            if path.is_dir() and not path.is_symlink():
                shutil.rmtree(path)
            else:
                path.unlink(missing_ok=True)
    if not targets:
        print("Nothing to clean.")
    elif not args.apply:
        print("No files changed. Re-run with --apply after reviewing every path.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
