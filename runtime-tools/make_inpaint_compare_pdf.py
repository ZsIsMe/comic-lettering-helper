#!/usr/bin/env python3
"""將原圖、mask、inpainted 三資料夾合成左右對比 PDF。

左欄：原圖疊半透明粉紅色 mask；右欄：inpainted。缺檔側留空。

>>> from pathlib import Path
>>> _stem_key(Path("16_01.jpg"))
'16_01'
"""

from __future__ import annotations

import argparse
import os
import sys
from io import BytesIO
from pathlib import Path

import numpy as np
try:
    from natsort import natsorted
except ImportError:
    natsorted = sorted
from PIL import Image, ImageDraw, ImageFont

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}
PINK_RGB = np.array([255, 105, 180], dtype=np.float32)  # #FF69B4
DEFAULT_ALPHA = 0.4
DEFAULT_PDF_NAME = "去字修復對比.pdf"

# A4 橫向、200 DPI，雙欄漫畫頁幾乎 1:1 放下 1080 寬圖
PAGE_W = 2339
PAGE_H = 1654
MARGIN = 40
GAP = 28
TITLE_H = 48
LABEL_H = 40

CJK_FONT_CANDIDATES = (
    "/System/Library/Fonts/Supplemental/Songti.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
    "C:/Windows/Fonts/msjh.ttc",
    "C:/Windows/Fonts/msyh.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",
)


def _stem_key(path: Path) -> str:
    return path.stem


def index_images(folder: Path) -> dict[str, Path]:
    """只掃一層圖檔，忽略子資料夾與 macOS `._*` 資源分叉。"""
    mapping: dict[str, Path] = {}
    if not folder.is_dir():
        raise FileNotFoundError(f"資料夾不存在：{folder}")
    for path in folder.iterdir():
        if not path.is_file() or path.name.startswith("._"):
            continue
        if path.suffix.lower() not in IMAGE_EXTS:
            continue
        key = _stem_key(path)
        if key in mapping:
            print(f"警告：{folder} 內 stem 重複，沿用 {mapping[key].name}，忽略 {path.name}", file=sys.stderr)
            continue
        mapping[key] = path
    return mapping


def mask_has_edit_pixels(mask_path: Path) -> bool:
    """Return False only when the mask is completely black."""
    with Image.open(mask_path) as mask:
        return mask.convert("L").getbbox() is not None


def overlay_pink(orig: Image.Image, mask: Image.Image, alpha: float = DEFAULT_ALPHA) -> Image.Image:
    """只在 mask 亮部疊粉紅；黑底完全不改原圖。

    >>> orig = Image.new("RGB", (2, 1), (0, 0, 0))
    >>> mask = Image.new("L", (2, 1), 0)
    >>> mask.putpixel((1, 0), 255)
    >>> out = overlay_pink(orig, mask, alpha=0.5)
    >>> out.getpixel((0, 0))
    (0, 0, 0)
    >>> out.getpixel((1, 0))
    (128, 52, 90)
    """
    orig_rgb = orig.convert("RGB")
    mask_l = mask.convert("L")
    if mask_l.size != orig_rgb.size:
        mask_l = mask_l.resize(orig_rgb.size, Image.Resampling.NEAREST)

    orig_arr = np.asarray(orig_rgb, dtype=np.float32)
    weight = (np.asarray(mask_l, dtype=np.float32) / 255.0 * alpha)[..., None]
    blended = orig_arr * (1.0 - weight) + PINK_RGB * weight
    return Image.fromarray(np.clip(np.rint(blended), 0, 255).astype(np.uint8), mode="RGB")


def _load_report_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    # Pillow's bundled default font needs no system or CJK font installation.
    return ImageFont.load_default(size=size)


def _load_cjk_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    """Compatibility alias for callers of older report helpers."""
    return _load_report_font(size)


def _fit_in_box(image: Image.Image, box_w: int, box_h: int) -> Image.Image:
    fitted = image.convert("RGB").copy()
    fitted.thumbnail((box_w, box_h), Image.Resampling.LANCZOS)
    return fitted


def _center_text(
    draw: ImageDraw.ImageDraw,
    text: str,
    cx: int,
    cy: int,
    font: ImageFont.ImageFont,
    fill: tuple[int, int, int] = (32, 32, 32),
) -> None:
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text((cx - tw / 2 - bbox[0], cy - th / 2 - bbox[1]), text, font=font, fill=fill)


def _paste_centered(canvas: Image.Image, image: Image.Image, box: tuple[int, int, int, int]) -> None:
    x0, y0, x1, y1 = box
    box_w, box_h = x1 - x0, y1 - y0
    fitted = _fit_in_box(image, box_w, box_h)
    px = x0 + (box_w - fitted.width) // 2
    py = y0 + (box_h - fitted.height) // 2
    canvas.paste(fitted, (px, py))


def compose_page(
    stem: str,
    orig: Image.Image | None,
    mask: Image.Image | None,
    inpainted: Image.Image | None,
    alpha: float,
    title_font: ImageFont.ImageFont,
    label_font: ImageFont.ImageFont,
) -> Image.Image:
    page = Image.new("RGB", (PAGE_W, PAGE_H), (255, 255, 255))
    draw = ImageDraw.Draw(page)

    _center_text(draw, stem.encode("ascii", "backslashreplace").decode("ascii"), PAGE_W // 2, MARGIN + TITLE_H // 2, title_font)

    col_w = (PAGE_W - 2 * MARGIN - GAP) // 2
    img_top = MARGIN + TITLE_H + LABEL_H
    img_bottom = PAGE_H - MARGIN
    left_box = (MARGIN, img_top, MARGIN + col_w, img_bottom)
    right_box = (MARGIN + col_w + GAP, img_top, MARGIN + 2 * col_w + GAP, img_bottom)

    left_cx = MARGIN + col_w // 2
    right_cx = MARGIN + col_w + GAP + col_w // 2
    label_cy = MARGIN + TITLE_H + LABEL_H // 2
    _center_text(draw, "Source + Mask", left_cx, label_cy, label_font)
    _center_text(draw, "Inpainted", right_cx, label_cy, label_font)

    if orig is not None:
        left = overlay_pink(orig, mask, alpha) if mask is not None else orig.convert("RGB")
        _paste_centered(page, left, left_box)

    if inpainted is not None:
        _paste_centered(page, inpainted, right_box)

    return page


def _as_jpeg_image(image: Image.Image, quality: int = 88) -> Image.Image:
    """轉成 JPEG 再寫入 PDF，避免 RGB zlib 把檔案撐得過大。"""
    buf = BytesIO()
    image.convert("RGB").save(buf, format="JPEG", quality=quality, optimize=True)
    buf.seek(0)
    jpeg = Image.open(buf)
    jpeg.load()
    jpeg._buffer = buf  # 避免 BytesIO 被回收
    return jpeg


def _open_image(path: Path | None) -> Image.Image | None:
    if path is None:
        return None
    return Image.open(path)


def build_pdf(
    orig_dir: Path,
    mask_dir: Path,
    inpainted_dir: Path,
    output: Path,
    alpha: float = DEFAULT_ALPHA,
) -> Path:
    orig_map = index_images(orig_dir)
    mask_map = index_images(mask_dir)
    inpainted_map = index_images(inpainted_dir)

    all_stems = natsorted(orig_map.keys())
    if not all_stems:
        raise SystemExit(f"原圖資料夾沒有可用圖檔：{orig_dir}")
    stems = []
    for stem in all_stems:
        mask_path = mask_map.get(stem)
        if mask_path is not None and not mask_has_edit_pixels(mask_path):
            print(f"略過全黑 Mask：{stem}")
            continue
        stems.append(stem)
    if not stems:
        raise SystemExit("所有 Mask 都是全黑，沒有需要加入 PDF 的圖片")

    title_font = _load_cjk_font(36)
    label_font = _load_cjk_font(26)
    pages: list[Image.Image] = []

    for i, stem in enumerate(stems, start=1):
        orig_path = orig_map.get(stem)
        mask_path = mask_map.get(stem)
        inpainted_path = inpainted_map.get(stem)
        if mask_path is None:
            print(f"警告：{stem} 缺 mask，左欄僅放原圖", file=sys.stderr)
        if inpainted_path is None:
            print(f"警告：{stem} 缺 inpainted，右欄留空", file=sys.stderr)

        orig = _open_image(orig_path)
        mask = _open_image(mask_path)
        inpainted = _open_image(inpainted_path)
        try:
            page = compose_page(stem, orig, mask, inpainted, alpha, title_font, label_font)
        finally:
            for image in (orig, mask, inpainted):
                if image is not None:
                    image.close()

        pages.append(_as_jpeg_image(page))
        page.close()
        print(f"[{i}/{len(stems)}] {stem}")

    output.parent.mkdir(parents=True, exist_ok=True)
    first, rest = pages[0], pages[1:]
    first.save(
        output,
        format="PDF",
        save_all=True,
        append_images=rest,
        resolution=200.0,
    )
    for page in pages:
        page.close()
    return output


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="由原圖 / mask / inpainted 三資料夾產生去字修復對比 PDF。",
    )
    parser.add_argument("orig_dir", type=Path, help="原圖資料夾（只掃一層，不進入子資料夾）")
    parser.add_argument("mask_dir", type=Path, help="mask 資料夾")
    parser.add_argument("inpainted_dir", type=Path, help="inpainted 資料夾")
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        default=None,
        help=f"輸出 PDF 路徑（預設：原圖資料夾/{DEFAULT_PDF_NAME}）",
    )
    parser.add_argument(
        "--alpha",
        type=float,
        default=DEFAULT_ALPHA,
        help=f"粉紅疊圖透明度 0–1（預設 {DEFAULT_ALPHA}）",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if not 0.0 <= args.alpha <= 1.0:
        print("錯誤：--alpha 必須在 0 到 1 之間", file=sys.stderr)
        return 2
    output = args.output or (args.orig_dir / DEFAULT_PDF_NAME)
    pdf_path = build_pdf(
        orig_dir=args.orig_dir.expanduser().resolve(),
        mask_dir=args.mask_dir.expanduser().resolve(),
        inpainted_dir=args.inpainted_dir.expanduser().resolve(),
        output=output.expanduser().resolve(),
        alpha=args.alpha,
    )
    print(f"已寫入：{pdf_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
