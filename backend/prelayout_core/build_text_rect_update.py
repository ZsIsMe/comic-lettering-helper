"""依翻譯稿與本地 OCR 結果，產出更新後的 JSON 或未匹配文字報告。

用法：
  python build_text_rect_update.py --translate path/to/translate.json

  # 或自行指定 OCR 結果路徑（省略時為 translate 同目錄下 text_rect.json）
  python build_text_rect_update.py --translate path/to/translate.json \\
      --text-rect path/to/text_rect.json

  # 只輸出翻譯稿中沒有命中 OCR 框的文字
  python build_text_rect_update.py --translate path/to/translate.json \\
      --mode unmatched-text

可選：--text-rect、--tolerance（預設 50）、--mode、--font-size-step（預設 1）、
--font-size-min（預設 0）、--output（update 模式省略時為 translate 同目錄下 stem_bt.json）。
圖片尺寸會依 text_rect.json 同資料夾內的對應圖片讀取，不使用 JSON 內的 page_width/page_height。

匹配規則：
- 將翻譯點的歸一化座標換算成像素 (tx, ty)。
- 條件 B：(tx, ty) 落在擴張容差後的 OCR 框內；左下角 (x1, y1) 固定不動，僅往右上擴張，即
  [x1, y1-tol, x2+tol, y2+tol]。
- 多框命中：在仍滿足條件 B 的候選中，取**未擴張原框**的右上角 (x2, y1) 與 (tx, ty) 最近者（平方距離最小）。
- 唯一命中（僅一條翻譯對應該 OCR 框）：以 OCR 的 center_normalized 覆蓋 x/y，
  寫入 orientation、xyxy_pixel，並將 OCR 的 font_size 量化後寫入 "font-size"（見下方字級量化），
  再依 OCR 的 text_color、text_has_stroke、need_inpaint 寫入 color、stroke-color、stroke-weight。
- 多條翻譯命中同一 OCR 框：全部走混合處理——保留各自原 x/y；以原中心 (tx, ty) 生成
  50×50 軸對齊方框寫入 xyxy_pixel；orientation、"font-size" 與樣式仍取自該 OCR 框。
- 未命中：保留原 x/y；以原中心 (tx, ty) 生成 50×50 軸對齊方框寫入 xyxy_pixel。
  若同頁存在其他已成功 OCR 匹配的條目，且中心距離 < 頁面對角線 / 4，
  則 orientation、"font-size" 與樣式繼承自最近的成功匹配；否則 orientation="vertical"，
  "font-size" 為量化後的預設值 40，樣式為預設黑字白描邊且 stroke-weight=0。
- 會寫入 match_status：auto / duplicate / unmatched，供 GUI 標記需要人工確認的條目。

字級量化（--font-size-min、--font-size-step）：
- 合法字號為 min, min+step, min+2*step, …（step 最小 1）。
- 將原始 font_size 對齊至上述序列中最近者；等距時取較大；低於 min 時取 min。
- step=1、min=0 時等同四捨五入到整數（18.5 → 19）。
- 例：min=10、step=2 → 10, 12, 14, …；18.5 → 18，19.0 → 20。
"""

from __future__ import annotations

import argparse
import json
import math
from collections import Counter
from pathlib import Path
from typing import Any

TOLERANCE_PX = 50
DEFAULT_ORIENTATION = "vertical"
DEFAULT_FONT_SIZE = 40
DEFAULT_FONT_SIZE_STEP = 1
DEFAULT_FONT_SIZE_MIN = 0
FALLBACK_BOX_SIZE_PX = 50
OUTPUT_FONT_SIZE_KEY = "font-size"
OUTPUT_COLOR_KEY = "color"
OUTPUT_STROKE_COLOR_KEY = "stroke-color"
OUTPUT_STROKE_WEIGHT_KEY = "stroke-weight"
BLACK_HEX = "#000000"
WHITE_HEX = "#FFFFFF"
MODE_UPDATE = "update"
MODE_UNMATCHED_TEXT = "unmatched-text"


def _point_in_rect(px: float, py: float, rect: list[float]) -> bool:
    x1, y1, x2, y2 = rect
    return x1 <= px <= x2 and y1 <= py <= y2


def _read_image_size(image_path: Path) -> tuple[int, int]:
    data = image_path.read_bytes()

    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        width = int.from_bytes(data[16:20], "big")
        height = int.from_bytes(data[20:24], "big")
        return width, height

    if data.startswith(b"\xff\xd8"):
        i = 2
        while i < len(data):
            while i < len(data) and data[i] == 0xFF:
                i += 1
            if i >= len(data):
                break

            marker = data[i]
            i += 1
            if marker in {0xD8, 0xD9}:
                continue
            if i + 2 > len(data):
                break

            segment_length = int.from_bytes(data[i : i + 2], "big")
            segment_start = i + 2
            segment_end = i + segment_length
            if marker in {
                0xC0,
                0xC1,
                0xC2,
                0xC3,
                0xC5,
                0xC6,
                0xC7,
                0xC9,
                0xCA,
                0xCB,
                0xCD,
                0xCE,
                0xCF,
            }:
                height = int.from_bytes(data[segment_start + 1 : segment_start + 3], "big")
                width = int.from_bytes(data[segment_start + 3 : segment_start + 5], "big")
                return width, height
            i = segment_end

    raise ValueError(f"不支援或無法讀取圖片尺寸：{image_path}")


def _center_square_xyxy(cx: float, cy: float, size: int) -> list[int]:
    """以 (cx, cy) 為中心，生成 size×size 軸對齊方框 [x1, y1, x2, y2]。"""
    half = size // 2
    icx = int(round(cx))
    icy = int(round(cy))
    x1 = icx - half
    y1 = icy - half
    return [x1, y1, x1 + size, y1 + size]


def _quantize_font_size(
    value: float,
    *,
    step: int = DEFAULT_FONT_SIZE_STEP,
    min_size: int = DEFAULT_FONT_SIZE_MIN,
) -> int:
    """將字級對齊至 min, min+step, min+2*step, …；等距取較大，低於 min 取 min。"""
    if value <= min_size:
        return min_size
    k = math.floor((value - min_size + step / 2) / step)
    return min_size + k * step


def _offset_rect(rect: list[float], tol: int) -> list[float]:
    """左下角固定，僅往右上擴張（寬 +tol、高 +tol，上邊再上移 tol）。"""
    x1, y1, x2, y2 = rect
    return [x1, y1 - tol, x2 + tol, y2 + tol]


def _find_best_match(
    tx: float,
    ty: float,
    ocr_items: list[dict[str, Any]],
    tolerance_px: int,
) -> dict[str, Any] | None:
    """以條件 B 命中者為候選，取原框右上角 (x2, y1) 與 (tx, ty) 最近者（平方歐式距離最小）。"""

    b_hits: list[dict[str, Any]] = []

    for item in ocr_items:
        rect = item.get("xyxy_pixel")
        if not rect or len(rect) != 4:
            continue
        if _point_in_rect(tx, ty, _offset_rect(rect, tolerance_px)):
            b_hits.append(item)

    if not b_hits:
        return None

    def _tr_corner_dist2_to_point(it: dict[str, Any]) -> float:
        _x1, y1, x2, _y2 = it["xyxy_pixel"]
        rx, ry = x2, y1
        return (tx - rx) ** 2 + (ty - ry) ** 2

    return min(b_hits, key=_tr_corner_dist2_to_point)


def _page_diagonal(page_width: int, page_height: int) -> float:
    return math.hypot(page_width, page_height)


def _find_nearest_successful_match(
    tx: float,
    ty: float,
    successful_matches: list[dict[str, Any]],
) -> dict[str, Any] | None:
    if not successful_matches:
        return None

    def _center_dist2(match_info: dict[str, Any]) -> float:
        mx = match_info["center_px"][0]
        my = match_info["center_px"][1]
        return (tx - mx) ** 2 + (ty - my) ** 2

    return min(successful_matches, key=_center_dist2)


def _typography_from_match(
    match: dict[str, Any],
    *,
    font_size_step: int,
    font_size_min: int,
) -> tuple[str, int]:
    orientation = match.get("orientation", DEFAULT_ORIENTATION)
    font_size = _quantize_font_size(
        float(match.get("font_size", DEFAULT_FONT_SIZE)),
        step=font_size_step,
        min_size=font_size_min,
    )
    return orientation, font_size


def _default_style() -> dict[str, Any]:
    return {
        OUTPUT_COLOR_KEY: BLACK_HEX,
        OUTPUT_STROKE_COLOR_KEY: WHITE_HEX,
        OUTPUT_STROKE_WEIGHT_KEY: 0,
    }


def _style_from_match(match: dict[str, Any], font_size: int) -> dict[str, Any]:
    text_color = str(match.get("text_color", "black")).lower()
    color = WHITE_HEX if text_color == "white" else BLACK_HEX
    stroke_color = BLACK_HEX if color == WHITE_HEX else WHITE_HEX
    has_stroke = bool(match.get("text_has_stroke", False))
    need_inpaint = bool(match.get("need_inpaint", False))
    stroke_weight = math.ceil(font_size / 8) if has_stroke or need_inpaint else 0
    return {
        OUTPUT_COLOR_KEY: color,
        OUTPUT_STROKE_COLOR_KEY: stroke_color,
        OUTPUT_STROKE_WEIGHT_KEY: stroke_weight,
    }


def _apply_style(entry: dict[str, Any], style: dict[str, Any]) -> None:
    entry[OUTPUT_COLOR_KEY] = style[OUTPUT_COLOR_KEY]
    entry[OUTPUT_STROKE_COLOR_KEY] = style[OUTPUT_STROKE_COLOR_KEY]
    entry[OUTPUT_STROKE_WEIGHT_KEY] = style[OUTPUT_STROKE_WEIGHT_KEY]


def _build_page_match_results(
    items: list[dict[str, Any]],
    ocr_items: list[dict[str, Any]],
    page_width: int,
    page_height: int,
    tolerance_px: int,
) -> list[dict[str, Any]]:
    page_results: list[dict[str, Any]] = []

    for entry in items:
        tx = entry["x"] * page_width
        ty = entry["y"] * page_height
        match = _find_best_match(tx, ty, ocr_items, tolerance_px)
        page_results.append(
            {
                "entry": entry,
                "tx": tx,
                "ty": ty,
                "match": match,
            }
        )

    return page_results


def _unmatched_entry_info(entry: dict[str, Any]) -> dict[str, Any]:
    return {
        "index": entry.get("index"),
        "groupId": entry.get("groupId"),
        "text": entry.get("text", ""),
    }


def collect_unmatched_translate_texts(
    translate_data: dict[str, Any],
    text_rect_data: dict[str, Any],
    image_dir: Path,
    tolerance_px: int = TOLERANCE_PX,
) -> dict[str, list[dict[str, Any]]]:
    """按頁收集 --translate 中沒有命中 OCR 框的文字條目。"""
    pages = text_rect_data.get("pages", {})
    image_sizes: dict[str, tuple[int, int]] = {}

    unmatched_by_page: dict[str, list[dict[str, Any]]] = {}
    for image_name, items in translate_data.get("transMap", {}).items():
        ocr_items = pages.get(image_name, [])

        if not ocr_items:
            unmatched_items = [
                _unmatched_entry_info(entry) for entry in items
            ]
            if unmatched_items:
                unmatched_by_page[image_name] = unmatched_items
            continue

        image_path = image_dir / image_name
        if not image_path.is_file():
            raise FileNotFoundError(f"找不到對應圖片：{image_path}")
        page_width, page_height = image_sizes.setdefault(
            image_name,
            _read_image_size(image_path),
        )

        page_results = _build_page_match_results(
            items,
            ocr_items,
            page_width,
            page_height,
            tolerance_px,
        )
        unmatched_items = [
            _unmatched_entry_info(result["entry"])
            for result in page_results
            if result["match"] is None
        ]
        if unmatched_items:
            unmatched_by_page[image_name] = unmatched_items

    return unmatched_by_page


def format_unmatched_text_report(
    unmatched_by_page: dict[str, list[dict[str, Any]]],
) -> str:
    page_count = len(unmatched_by_page)
    item_count = sum(len(items) for items in unmatched_by_page.values())
    if item_count == 0:
        return "沒有未匹配文字。\n"

    lines = [f"未匹配文字：{page_count} 頁，{item_count} 條"]
    for image_name, items in unmatched_by_page.items():
        lines.extend(["", f"## {image_name}"])
        for entry in items:
            label_parts = []
            if entry.get("index") is not None:
                label_parts.append(f"index={entry['index']}")
            if entry.get("groupId") is not None:
                label_parts.append(f"groupId={entry['groupId']}")
            label = " ".join(label_parts) or "entry"
            text = str(entry.get("text", "")).strip() or "(空文字)"
            if "\n" in text:
                lines.append(f"- {label}:")
                lines.extend(f"  {line}" for line in text.splitlines())
            else:
                lines.append(f"- {label}: {text}")

    return "\n".join(lines) + "\n"


def build_updated_translate(
    translate_data: dict[str, Any],
    text_rect_data: dict[str, Any],
    image_dir: Path,
    tolerance_px: int = TOLERANCE_PX,
    font_size_step: int = DEFAULT_FONT_SIZE_STEP,
    font_size_min: int = DEFAULT_FONT_SIZE_MIN,
) -> dict[str, Any]:
    pages = text_rect_data.get("pages", {})
    image_sizes: dict[str, tuple[int, int]] = {}
    default_font_size = _quantize_font_size(
        DEFAULT_FONT_SIZE,
        step=font_size_step,
        min_size=font_size_min,
    )

    new_trans_map: dict[str, list[dict[str, Any]]] = {}
    for image_name, items in translate_data.get("transMap", {}).items():
        ocr_items = pages.get(image_name, [])
        image_path = image_dir / image_name
        if not image_path.is_file():
            raise FileNotFoundError(f"找不到對應圖片：{image_path}")
        page_width, page_height = image_sizes.setdefault(
            image_name,
            _read_image_size(image_path),
        )
        neighbor_dist_limit = _page_diagonal(page_width, page_height) / 4.0

        page_results = _build_page_match_results(
            items,
            ocr_items,
            page_width,
            page_height,
            tolerance_px,
        )

        ocr_match_counts = Counter(
            id(result["match"])
            for result in page_results
            if result["match"] is not None
        )

        updated_items: list[dict[str, Any]] = []
        successful_matches: list[dict[str, Any]] = []

        for result in page_results:
            entry = result["entry"]
            tx = result["tx"]
            ty = result["ty"]
            match = result["match"]

            new_entry = dict(entry)
            new_entry.pop("font_size", None)
            new_entry.pop(OUTPUT_FONT_SIZE_KEY, None)
            new_entry.pop(OUTPUT_COLOR_KEY, None)
            new_entry.pop(OUTPUT_STROKE_COLOR_KEY, None)
            new_entry.pop(OUTPUT_STROKE_WEIGHT_KEY, None)
            new_entry.pop("match_status", None)
            new_entry.pop("match_source_block_index", None)

            if match is None:
                new_entry["match_status"] = "unmatched"
                new_entry["xyxy_pixel"] = _center_square_xyxy(
                    tx, ty, FALLBACK_BOX_SIZE_PX
                )
                nearest = _find_nearest_successful_match(
                    tx, ty, successful_matches
                )
                if nearest is not None:
                    dist = math.hypot(
                        tx - nearest["center_px"][0],
                        ty - nearest["center_px"][1],
                    )
                    if dist < neighbor_dist_limit:
                        new_entry["orientation"] = nearest["orientation"]
                        new_entry[OUTPUT_FONT_SIZE_KEY] = nearest[
                            OUTPUT_FONT_SIZE_KEY
                        ]
                        _apply_style(new_entry, nearest)
                    else:
                        new_entry["orientation"] = DEFAULT_ORIENTATION
                        new_entry[OUTPUT_FONT_SIZE_KEY] = default_font_size
                        _apply_style(new_entry, _default_style())
                else:
                    new_entry["orientation"] = DEFAULT_ORIENTATION
                    new_entry[OUTPUT_FONT_SIZE_KEY] = default_font_size
                    _apply_style(new_entry, _default_style())
                updated_items.append(new_entry)
                continue

            orientation, font_size = _typography_from_match(
                match,
                font_size_step=font_size_step,
                font_size_min=font_size_min,
            )
            new_entry["orientation"] = orientation
            new_entry[OUTPUT_FONT_SIZE_KEY] = font_size
            style = _style_from_match(match, font_size)
            _apply_style(new_entry, style)
            if match.get("source_block_index") is not None:
                new_entry["match_source_block_index"] = match.get("source_block_index")

            if ocr_match_counts[id(match)] >= 2:
                new_entry["match_status"] = "duplicate"
                new_entry["xyxy_pixel"] = _center_square_xyxy(
                    tx, ty, FALLBACK_BOX_SIZE_PX
                )
                successful_matches.append(
                    {
                        "center_px": (tx, ty),
                        "orientation": orientation,
                        OUTPUT_FONT_SIZE_KEY: font_size,
                        **style,
                    }
                )
            else:
                new_entry["match_status"] = "auto"
                cx, cy = match["center_normalized"]
                new_entry["x"] = cx
                new_entry["y"] = cy
                xyxy = match.get("xyxy_pixel")
                if xyxy and len(xyxy) == 4:
                    new_entry["xyxy_pixel"] = xyxy
                successful_matches.append(
                    {
                        "center_px": (cx * page_width, cy * page_height),
                        "orientation": orientation,
                        OUTPUT_FONT_SIZE_KEY: font_size,
                        **style,
                    }
                )

            updated_items.append(new_entry)
        new_trans_map[image_name] = updated_items

    result = dict(translate_data)
    result["transMap"] = new_trans_map
    return result


def _default_output_path(translate_path: Path) -> Path:
    """translate 同目錄，檔名為 stem + _bt.json。"""
    return translate_path.with_name(f"{translate_path.stem}_bt.json")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="依翻譯稿與本地 OCR 結果合併為更新後的 JSON。",
    )
    parser.add_argument(
        "--translate",
        type=Path,
        required=True,
        metavar="PATH",
        help="翻譯稿 JSON（translate.json）",
    )
    parser.add_argument(
        "--text-rect",
        type=Path,
        default=None,
        metavar="PATH",
        help="本地 OCR 結果 JSON；省略時使用 --translate 同目錄下 text_rect.json",
    )
    parser.add_argument(
        "--tolerance",
        type=int,
        default=TOLERANCE_PX,
        metavar="PX",
        help=f"擴張容差像素（預設 {TOLERANCE_PX}）",
    )
    parser.add_argument(
        "--font-size-step",
        type=int,
        default=DEFAULT_FONT_SIZE_STEP,
        metavar="N",
        help=f"字級量化步進，最小 1（預設 {DEFAULT_FONT_SIZE_STEP}）",
    )
    parser.add_argument(
        "--font-size-min",
        type=int,
        default=DEFAULT_FONT_SIZE_MIN,
        metavar="N",
        help=f"字級量化下限（預設 {DEFAULT_FONT_SIZE_MIN}）",
    )
    parser.add_argument(
        "--mode",
        choices=[MODE_UPDATE, MODE_UNMATCHED_TEXT],
        default=MODE_UPDATE,
        help=(
            f"{MODE_UPDATE}: 產出更新後 JSON；"
            f"{MODE_UNMATCHED_TEXT}: 只輸出 --translate 中未匹配 OCR 框的文字"
        ),
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        metavar="PATH",
        help=(
            "輸出路徑；update 模式省略時為 --translate 路徑 stem 加上 _bt.json；"
            "unmatched-text 模式省略時印到 stdout"
        ),
    )
    args = parser.parse_args()

    if args.font_size_step < 1:
        parser.error("--font-size-step 必須 >= 1")
    if args.font_size_min < 0:
        parser.error("--font-size-min 必須 >= 0")

    translate_path = args.translate.resolve()
    text_rect_path = (
        args.text_rect.resolve()
        if args.text_rect is not None
        else (translate_path.parent / "text_rect.json").resolve()
    )
    output_path = args.output.resolve() if args.output is not None else None

    translate_data = json.loads(translate_path.read_text(encoding="utf-8"))
    text_rect_data = json.loads(text_rect_path.read_text(encoding="utf-8"))

    if args.mode == MODE_UNMATCHED_TEXT:
        unmatched_by_page = collect_unmatched_translate_texts(
            translate_data,
            text_rect_data,
            text_rect_path.parent,
            args.tolerance,
        )
        report = format_unmatched_text_report(unmatched_by_page)
        if output_path is None:
            print(report, end="")
        else:
            output_path.write_text(report, encoding="utf-8")
            print(f"wrote: {output_path}")
        return

    if output_path is None:
        output_path = _default_output_path(translate_path)

    updated = build_updated_translate(
        translate_data,
        text_rect_data,
        text_rect_path.parent,
        args.tolerance,
        args.font_size_step,
        args.font_size_min,
    )

    output_path.write_text(
        json.dumps(updated, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"wrote: {output_path}")


if __name__ == "__main__":
    main()
