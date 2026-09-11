#!/usr/bin/env python3
"""Validate source/Mask pairing and Qwen RGBA alpha direction before inference."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image


IMAGE_EXTS = {".jpg", ".jpeg", ".png"}


def index_images(folder: Path, mask: bool = False) -> dict[str, Path]:
    result = {}
    for path in folder.iterdir():
        if path.name.startswith("._") or not path.is_file():
            continue
        if path.suffix.lower() not in ({".png"} if mask else IMAGE_EXTS):
            continue
        if path.stem in result:
            raise ValueError(f"duplicate stem: {path.stem}")
        result[path.stem] = path
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("--expected", type=int)
    args = parser.parse_args()

    sources = index_images(args.root / "pair")
    masks = index_images(args.root / "pair_mask", mask=True)
    if sources.keys() != masks.keys():
        raise SystemExit(
            json.dumps(
                {
                    "missing_masks": sorted(sources.keys() - masks.keys()),
                    "missing_sources": sorted(masks.keys() - sources.keys()),
                },
                ensure_ascii=False,
            )
        )
    if args.expected is not None and len(sources) != args.expected:
        raise SystemExit(f"expected {args.expected} pairs, found {len(sources)}")

    black_masks = []
    for stem in sorted(sources):
        with Image.open(sources[stem]) as source, Image.open(masks[stem]) as mask_source:
            source_rgb = source.convert("RGB")
            mask = mask_source.convert("L")
            if source_rgb.size != mask.size:
                raise SystemExit(
                    f"{stem}: source/Mask size mismatch {source_rgb.size} != {mask.size}"
                )
            binary = mask.point(lambda value: 255 if value >= 128 else 0)
            if binary.getbbox() is None:
                black_masks.append(stem)
                continue
            alpha = binary.point(lambda value: 0 if value else 255)
            if alpha.getextrema() != (0, 255):
                raise SystemExit(f"{stem}: invalid Qwen alpha direction")

    print(
        json.dumps(
            {
                "root": str(args.root),
                "pairs": len(sources),
                "black_masks": black_masks,
                "black_mask_count": len(black_masks),
                "status": "valid",
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
