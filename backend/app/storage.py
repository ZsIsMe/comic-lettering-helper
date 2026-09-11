from __future__ import annotations

import hashlib
import re
from pathlib import Path, PurePath

from fastapi import UploadFile
from PIL import Image


IMAGE_EXTS = {".png", ".jpg", ".jpeg"}
SAFE_NAME = re.compile(r"[^0-9A-Za-z._\-\u0080-\uffff]+")


def basename(raw: str | None) -> str:
    value = (raw or "").replace("\\", "/")
    original_name = PurePath(value).name
    if original_name.startswith("._"):
        raise ValueError("無效或不支援的檔名")
    name = original_name
    name = SAFE_NAME.sub("_", name).strip(" .")
    if not name:
        raise ValueError("無效或不支援的檔名")
    if Path(name).suffix.lower() not in IMAGE_EXTS:
        raise ValueError(f"不支援的圖片格式：{name}")
    return name


async def save_uploads(files: list[UploadFile], destination: Path, max_bytes: int) -> dict[str, Path]:
    destination.mkdir(parents=True, exist_ok=True)
    indexed: dict[str, Path] = {}
    total = 0
    for upload in files:
        name = basename(upload.filename)
        stem = Path(name).stem
        if stem in indexed:
            raise ValueError(f"重複頁碼／檔名 stem：{stem}")
        target = destination / name
        digest = hashlib.sha256()
        with target.open("wb") as handle:
            while chunk := await upload.read(1024 * 1024):
                total += len(chunk)
                if total > max_bytes:
                    raise ValueError("上傳資料超過大小限制")
                digest.update(chunk)
                handle.write(chunk)
        try:
            with Image.open(target) as image:
                image.verify()
        except Exception as exc:
            target.unlink(missing_ok=True)
            raise ValueError(f"圖片無法讀取：{name}") from exc
        indexed[stem] = target
    return indexed


def validate_pairs(sources: dict[str, Path], masks: dict[str, Path]) -> tuple[list[str], list[str]]:
    if sources.keys() != masks.keys():
        missing_masks = sorted(sources.keys() - masks.keys())
        missing_sources = sorted(masks.keys() - sources.keys())
        raise ValueError(f"配對失敗；缺少 Mask={missing_masks}，缺少原圖={missing_sources}")
    if not sources:
        raise ValueError("至少需要一組原圖與 Mask")

    black_masks: list[str] = []
    stems = sorted(sources)
    for stem in stems:
        with Image.open(sources[stem]) as source, Image.open(masks[stem]) as mask_source:
            if source.size != mask_source.size:
                raise ValueError(f"{stem} 尺寸不一致：{source.size} != {mask_source.size}")
            mask = mask_source.convert("L").point(lambda value: 255 if value >= 128 else 0)
            if mask.getbbox() is None:
                black_masks.append(stem)
    return stems, black_masks
