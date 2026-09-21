#!/usr/bin/env python3
"""Create one four-column comparison page for the three final workflows."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw
from inpaint_report_summary import collect_report, draw_cover, diffusion_model_files, saved_prompts
try:
    from natsort import natsorted
except ImportError:
    natsorted = sorted

from make_inpaint_compare_pdf import (
    DEFAULT_ALPHA,
    _as_jpeg_image,
    _center_text,
    _fit_in_box,
    _load_cjk_font,
    index_images,
    mask_has_edit_pixels,
    overlay_pink,
)


PAGE_W = 3308  # A3 landscape at 200 DPI
PAGE_H = 2339
MARGIN = 44
GAP = 22
TITLE_H = 54
LABEL_H = 42
LABELS = ("原圖+Mask", "Flux2 Klein+LanPaint", "FireRed FP8", "Qwen Image 2.1 INT8")


def paste_centered(canvas: Image.Image, image: Image.Image, box: tuple[int, int, int, int]) -> None:
    x0, y0, x1, y1 = box
    fitted = _fit_in_box(image, x1 - x0, y1 - y0)
    canvas.paste(fitted, (x0 + (x1 - x0 - fitted.width) // 2, y0 + (y1 - y0 - fitted.height) // 2))


def build_pdf(root: Path, output: Path, alpha: float, *, logs_dir: Path | None = None, job_file: Path | None = None, environment_file: Path | None = None) -> Path:
    originals = index_images(root / "pair")
    masks = index_images(root / "pair_mask")
    result_maps = (
        index_images(root / "result_flux2klein_lanpaint"),
        index_images(root / "result_firered"),
        index_images(root / "result_qwen2511_lanpaint"),
    )
    stems = []
    for stem in natsorted(originals):
        mask_path = masks.get(stem)
        if mask_path is not None and not mask_has_edit_pixels(mask_path):
            print(f"略過全黑 Mask：{stem}")
            continue
        stems.append(stem)
    if not stems:
        raise SystemExit("所有 Mask 都是全黑，沒有需要加入 PDF 的圖片")
    title_font = _load_cjk_font(38)
    label_font = _load_cjk_font(25)
    keys = ("flux2klein_lanpaint", "firered", "qwen2511_lanpaint")
    report = collect_report(root, logs_dir, job_file, environment_file,
        prompts={key: saved_prompts(mapping[stem] for stem in originals if stem in mapping)
                 for key, mapping in zip(keys, result_maps)},
        model_files={key: diffusion_model_files(mapping[stem] for stem in originals if stem in mapping)
                     for key, mapping in zip(keys, result_maps)}, counts={
        "pairs": len(originals), "black": len(originals) - len(stems),
        "results": {key: sum(stem in mapping for stem in originals)
                    for key, mapping in zip(("flux2klein_lanpaint", "firered", "qwen2511_lanpaint"), result_maps)},
    })
    cover = draw_cover(report, PAGE_W, PAGE_H, _load_cjk_font)
    pages = [_as_jpeg_image(cover)]
    cover.close()
    col_w = (PAGE_W - 2 * MARGIN - 3 * GAP) // 4
    top = MARGIN + TITLE_H + LABEL_H
    bottom = PAGE_H - MARGIN

    for index, stem in enumerate(stems, 1):
        page = Image.new("RGB", (PAGE_W, PAGE_H), "white")
        draw = ImageDraw.Draw(page)
        _center_text(draw, stem, PAGE_W // 2, MARGIN + TITLE_H // 2, title_font)
        with Image.open(originals[stem]) as orig, Image.open(masks[stem]) as mask:
            images = [overlay_pink(orig, mask, alpha)]
        for mapping in result_maps:
            path = mapping.get(stem)
            if path is None:
                images.append(None)
            else:
                with Image.open(path) as image:
                    images.append(image.convert("RGB").copy())
        for col, (label, image) in enumerate(zip(LABELS, images)):
            x0 = MARGIN + col * (col_w + GAP)
            _center_text(draw, label, x0 + col_w // 2, MARGIN + TITLE_H + LABEL_H // 2, label_font)
            if image is not None:
                paste_centered(page, image, (x0, top, x0 + col_w, bottom))
                image.close()
        pages.append(_as_jpeg_image(page))
        page.close()
        print(f"[{index}/{len(stems)}] {stem}")

    output.parent.mkdir(parents=True, exist_ok=True)
    pages[0].save(output, format="PDF", save_all=True, append_images=pages[1:], resolution=200.0)
    for page in pages:
        page.close()
    return output


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("-o", "--output", type=Path, required=True)
    parser.add_argument("--alpha", type=float, default=DEFAULT_ALPHA)
    parser.add_argument("--logs-dir", type=Path, help="任務日誌目錄")
    parser.add_argument("--job-file", type=Path, help="任務 job.json")
    parser.add_argument("--environment-file", type=Path, help="生成機器環境快照 JSON")
    args = parser.parse_args()
    print(f"已寫入：{build_pdf(args.root.resolve(), args.output.resolve(), args.alpha, logs_dir=args.logs_dir, job_file=args.job_file, environment_file=args.environment_file)}")


if __name__ == "__main__":
    main()
