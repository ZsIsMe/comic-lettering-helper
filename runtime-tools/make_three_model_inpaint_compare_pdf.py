#!/usr/bin/env python3
"""Create comparison pages for the selected final workflows."""

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
    _load_report_font,
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
WORKFLOW_LABELS = {
    "flux2klein_lanpaint": "Flux2 Klein+LanPaint",
    "firered": "FireRed FP8",
    "qwen2511_lanpaint": "Qwen Image 2.1 INT8",
}


def paste_centered(canvas: Image.Image, image: Image.Image, box: tuple[int, int, int, int]) -> None:
    x0, y0, x1, y1 = box
    fitted = _fit_in_box(image, x1 - x0, y1 - y0)
    canvas.paste(fitted, (x0 + (x1 - x0 - fitted.width) // 2, y0 + (y1 - y0 - fitted.height) // 2))


def build_pdf(root: Path, output: Path, alpha: float, *, logs_dir: Path | None = None, job_file: Path | None = None, environment_file: Path | None = None, workflows: tuple[str, ...] | None = None) -> Path:
    if workflows is None:
        workflows = tuple(WORKFLOW_LABELS)
    if not workflows or len(set(workflows)) != len(workflows) or set(workflows) - WORKFLOW_LABELS.keys():
        raise ValueError("至少選擇一個有效且不重複的工作流")
    workflows = tuple(key for key in WORKFLOW_LABELS if key in workflows)
    originals = index_images(root / "pair")
    masks = index_images(root / "pair_mask")
    result_maps = {key: index_images(root / f"result_{key}") for key in workflows}
    stems = []
    for stem in natsorted(originals):
        mask_path = masks.get(stem)
        if mask_path is not None and not mask_has_edit_pixels(mask_path):
            print(f"略過全黑 Mask：{stem}")
            continue
        stems.append(stem)
    if not stems:
        raise SystemExit("所有 Mask 都是全黑，沒有需要加入 PDF 的圖片")
    title_font = _load_report_font(38)
    label_font = _load_report_font(25)
    report = collect_report(root, logs_dir, job_file, environment_file,
        prompts={key: saved_prompts(result_maps[key][stem] for stem in originals if stem in result_maps[key])
                 for key in workflows},
        model_files={key: diffusion_model_files(result_maps[key][stem] for stem in originals if stem in result_maps[key])
                     for key in workflows}, counts={
        "pairs": len(originals), "black": len(originals) - len(stems),
        "results": {key: sum(stem in result_maps[key] for stem in originals) for key in workflows},
    }, workflows=workflows)
    cover = draw_cover(report, PAGE_W, PAGE_H, _load_report_font)
    pages = [_as_jpeg_image(cover)]
    cover.close()
    labels = ("Source + Mask", *(WORKFLOW_LABELS[key] for key in workflows))
    col_w = (PAGE_W - 2 * MARGIN - (len(labels) - 1) * GAP) // len(labels)
    top = MARGIN + TITLE_H + LABEL_H
    bottom = PAGE_H - MARGIN

    for index, stem in enumerate(stems, 1):
        page = Image.new("RGB", (PAGE_W, PAGE_H), "white")
        draw = ImageDraw.Draw(page)
        _center_text(draw, stem.encode("ascii", "backslashreplace").decode("ascii"), PAGE_W // 2, MARGIN + TITLE_H // 2, title_font)
        with Image.open(originals[stem]) as orig, Image.open(masks[stem]) as mask:
            images = [overlay_pink(orig, mask, alpha)]
        for key in workflows:
            path = result_maps[key].get(stem)
            if path is None:
                images.append(None)
            else:
                with Image.open(path) as image:
                    images.append(image.convert("RGB").copy())
        for col, (label, image) in enumerate(zip(labels, images)):
            x0 = MARGIN + col * (col_w + GAP)
            _center_text(draw, label, x0 + col_w // 2, MARGIN + TITLE_H + LABEL_H // 2, label_font)
            if image is not None:
                paste_centered(page, image, (x0, top, x0 + col_w, bottom))
                image.close()
        pages.append(_as_jpeg_image(page))
        page.close()
        print(f"[{index}/{len(stems)}] {stem}")

    output.parent.mkdir(parents=True, exist_ok=True)
    import json
    output.with_suffix(".report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
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
    parser.add_argument("--workflows", nargs="+", choices=tuple(WORKFLOW_LABELS), help="本次選擇的工作流；未指定時沿用三套全選")
    args = parser.parse_args()
    print(f"已寫入：{build_pdf(args.root.resolve(), args.output.resolve(), args.alpha, logs_dir=args.logs_dir, job_file=args.job_file, environment_file=args.environment_file, workflows=tuple(args.workflows) if args.workflows else None)}")


if __name__ == "__main__":
    main()
