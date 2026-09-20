#!/usr/bin/env python3
"""Run whole-line mit48px CTC OCR and derive independent character regions."""

from __future__ import annotations

import argparse
import json
import os.path as osp
import time
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from prelayout_core.vendor.font_size_calibration import (
    DEFAULT_FONT_SIZE_BASE,
    DEFAULT_FONT_SIZE_STEP,
    calibrate_ocr_output,
)
from prelayout_core.vendor.mit48px_ocr import (
    DEFAULT_ALPHABET_PATH,
    DEFAULT_IMPLEMENTATION_PATH,
    DEFAULT_MODEL_PATH,
    Mit48pxCtcOcr,
)


def _load_json(path: str | Path) -> dict:
    with open(path, 'r', encoding='utf8') as file:
        return json.load(file)


def _write_json(path: str | Path, data: dict) -> None:
    with open(path, 'w', encoding='utf8') as file:
        json.dump(data, file, ensure_ascii=False, indent=2)


def _resolve_input_paths(path1: str, path2: str | None, measure_json: str | None) -> tuple[str, str]:
    if measure_json is not None:
        return measure_json, path1
    if path2 is None:
        return osp.join(path1, 'ctd', 'measure.json'), path1
    return path1, path2


def _image_path_for_page(image_dir: str | Path, page_name: str) -> Path:
    image_dir = Path(image_dir)
    path = image_dir / page_name
    if path.is_file():
        return path
    stem = Path(page_name).stem
    for extension in ('.png', '.jpg', '.jpeg', '.bmp', '.webp'):
        candidate = image_dir / f'{stem}{extension}'
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(f'找不到原圖：{page_name}')


def _source_index(item: dict[str, Any], fallback: int) -> int:
    try:
        return int(item.get('source_block_index', fallback))
    except (TypeError, ValueError):
        return fallback


def _debug_items_by_source(measure_debug: dict, page_name: str) -> dict[int, dict]:
    result = {}
    for fallback, item in enumerate((measure_debug.get('font_size') or {}).get(page_name, []) or []):
        if isinstance(item, dict):
            result[_source_index(item, fallback)] = item
    return result


def _line_box(line: dict[str, Any]) -> tuple[int, int, int, int] | None:
    polygon = line.get('polygon')
    if isinstance(polygon, list) and len(polygon) >= 4:
        points = np.asarray(polygon, dtype=np.float64).reshape(-1, 2)
        x1, y1 = points.min(axis=0)
        x2, y2 = points.max(axis=0)
        return int(np.floor(x1)), int(np.floor(y1)), int(np.ceil(x2)), int(np.ceil(y2))
    if all(key in line for key in ('x', 'y', 'w', 'h')):
        x = int(round(float(line.get('x') or 0)))
        y = int(round(float(line.get('y') or 0)))
        w = int(round(float(line.get('w') or 0)))
        h = int(round(float(line.get('h') or 0)))
        return x, y, x + w, y + h
    return None


def _line_center(line: dict[str, Any]) -> tuple[float, float] | None:
    box = _line_box(line)
    if box is None:
        return None
    x1, y1, x2, y2 = box
    return (x1 + x2) / 2.0, (y1 + y2) / 2.0


def _overlap_area(first: tuple[int, int, int, int], second: tuple[int, int, int, int]) -> int:
    x1 = max(first[0], second[0])
    y1 = max(first[1], second[1])
    x2 = min(first[2], second[2])
    y2 = min(first[3], second[3])
    return max(0, x2 - x1) * max(0, y2 - y1)


def _fallback_line_groups(measure_debug: dict, page_name: str) -> dict[int, list[dict]]:
    block_items = ((measure_debug.get('block') or {}).get('blockMap') or {}).get(page_name, []) or []
    line_items = ((measure_debug.get('line') or {}).get('transMap') or {}).get(page_name, []) or []
    block_boxes: list[tuple[int, tuple[int, int, int, int]]] = []
    for fallback, block in enumerate(block_items):
        if not isinstance(block, dict):
            continue
        bbox = block.get('xyxy_pixel')
        if not isinstance(bbox, list) or len(bbox) != 4:
            continue
        block_boxes.append((_source_index(block, fallback), tuple(int(round(float(value))) for value in bbox)))

    result: dict[int, list[dict]] = {}
    for line in line_items:
        if not isinstance(line, dict):
            continue
        line_box = _line_box(line)
        center = _line_center(line)
        selected = None
        if center is not None:
            for source_index, bbox in block_boxes:
                if bbox[0] <= center[0] <= bbox[2] and bbox[1] <= center[1] <= bbox[3]:
                    selected = source_index
                    break
        if selected is None and line_box is not None:
            best_overlap = 0
            for source_index, bbox in block_boxes:
                overlap = _overlap_area(line_box, bbox)
                if overlap > best_overlap:
                    best_overlap = overlap
                    selected = source_index
        if selected is not None:
            result.setdefault(selected, []).append(line)
    return result


def _line_tasks_for_page(
    items: list[dict],
    measure_debug: dict,
    page_name: str,
    source_block_filter: int | None,
) -> tuple[list[dict], list[dict]]:
    debug_by_source = _debug_items_by_source(measure_debug, page_name)
    fallback_groups = _fallback_line_groups(measure_debug, page_name)
    output_items = []
    tasks = []
    for item_index, item in enumerate(items):
        if not isinstance(item, dict):
            continue
        source_index = _source_index(item, item_index)
        if source_block_filter is not None and source_index != source_block_filter:
            continue
        output_item = dict(item)
        output_item['measure_item_index'] = item_index
        output_item['ocr_characters'] = []
        output_item['ocr_lines'] = []
        output_index = len(output_items)
        output_items.append(output_item)

        debug_lines = debug_by_source.get(source_index, {}).get('lines')
        lines = debug_lines if isinstance(debug_lines, list) else fallback_groups.get(source_index, [])
        for line_index, line in enumerate(lines):
            if not isinstance(line, dict) or _line_box(line) is None:
                continue
            tasks.append({
                'output_index': output_index,
                'source_block_index': source_index,
                'line_index': line_index,
                'orientation': str(item.get('orientation') or 'vertical'),
                'line': line,
            })
    return output_items, tasks


def _line_orientation(line: dict[str, Any], fallback: str) -> str:
    box = _line_box(line)
    if box is None:
        return fallback
    x1, y1, x2, y2 = box
    return 'horizontal' if (x2 - x1) >= (y2 - y1) else 'vertical'


def _mask_path_for_page(measure_path: str | Path, page_name: str) -> Path:
    return Path(measure_path).parent / 'progressing' / 'mask' / f'{Path(page_name).stem}.png'


def _prepare_line_crop(
    image_rgb: np.ndarray,
    text_mask: np.ndarray,
    line: dict[str, Any],
    orientation: str,
    pad: int,
) -> dict[str, Any] | None:
    box = _line_box(line)
    if box is None:
        return None
    image_height, image_width = image_rgb.shape[:2]
    x1 = max(0, box[0] - pad)
    y1 = max(0, box[1] - pad)
    x2 = min(image_width, box[2] + pad + 1)
    y2 = min(image_height, box[3] + pad + 1)
    if x2 <= x1 or y2 <= y1:
        return None
    crop = image_rgb[y1:y2, x1:x2]
    mask_crop = text_mask[y1:y2, x1:x2]
    if orientation == 'vertical':
        crop = cv2.rotate(crop, cv2.ROTATE_90_COUNTERCLOCKWISE)
        mask_crop = cv2.rotate(mask_crop, cv2.ROTATE_90_COUNTERCLOCKWISE)
    canonical_height, canonical_width = crop.shape[:2]
    if canonical_height <= 0 or canonical_width <= 0:
        return None
    target_width = max(4, int(round(48 * canonical_width / canonical_height)))
    interpolation = cv2.INTER_CUBIC if canonical_height < 48 else cv2.INTER_AREA
    normalized = cv2.resize(crop, (target_width, 48), interpolation=interpolation)
    if orientation == 'horizontal':
        content_y1 = max(0, box[1] - y1)
        content_y2 = min(canonical_height, box[3] + 1 - y1)
    else:
        source_width = x2 - x1
        content_y1 = max(0, source_width - (box[2] + 1 - x1))
        content_y2 = min(canonical_height, source_width - (box[0] - x1))
    return {
        'crop': normalized,
        'mask': mask_crop,
        'origin': (x1, y1),
        'source_size': (x2 - x1, y2 - y1),
        'canonical_size': (canonical_width, canonical_height),
        'content_y_range': (content_y1, content_y2),
        'orientation': orientation,
        'pad': pad,
    }


def _canonical_bbox_to_image(
    bbox: tuple[int, int, int, int],
    prepared: dict[str, Any],
) -> list[int]:
    x1, y1, x2, y2 = bbox
    origin_x, origin_y = prepared['origin']
    source_width, _ = prepared['source_size']
    if prepared['orientation'] == 'horizontal':
        return [origin_x + x1, origin_y + y1, origin_x + x2, origin_y + y2]
    return [
        origin_x + source_width - y2,
        origin_y + x1,
        origin_x + source_width - y1,
        origin_y + x2,
    ]


def _projection_ink_runs(projection: np.ndarray, coarse_size: float) -> list[tuple[int, int]]:
    del coarse_size
    runs: list[tuple[int, int]] = []
    start = None
    for index, value in enumerate(projection):
        if value > 0 and start is None:
            start = index
        elif value <= 0 and start is not None:
            runs.append((start, index))
            start = None
    if start is not None:
        runs.append((start, len(projection)))
    return runs


def _select_ink_run(
    runs: list[tuple[int, int]],
    anchor_x: float,
    coarse_size: float,
) -> tuple[int, int] | None:
    containing_indices = [index for index, run in enumerate(runs) if run[0] <= anchor_x < run[1]]
    if containing_indices:
        selected_index = containing_indices[0]
        selected_from_gap = False
    else:
        def distance(run: tuple[int, int]) -> float:
            if anchor_x < run[0]:
                return run[0] - anchor_x
            return anchor_x - run[1]

        if not runs:
            return None
        previous_indices = [index for index, run in enumerate(runs) if run[1] <= anchor_x]
        following_indices = [index for index, run in enumerate(runs) if run[0] > anchor_x]
        previous_index = previous_indices[-1] if previous_indices else None
        following_index = following_indices[0] if following_indices else None
        tolerance = max(2.0, coarse_size * 0.3)
        previous_distance = distance(runs[previous_index]) if previous_index is not None else float('inf')
        following_distance = distance(runs[following_index]) if following_index is not None else float('inf')
        # CTC peaks tend to sit near the leading side of a glyph. When an
        # anchor falls in a tiny blank gap, prefer the following ink run if it
        # is almost as close as the preceding one.
        if following_distance <= tolerance and following_distance <= previous_distance + coarse_size * 0.12:
            selected_index = following_index
        elif previous_distance <= tolerance:
            selected_index = previous_index
        else:
            return None
        selected_from_gap = True

    selected = runs[selected_index]
    maximum_gap = max(1, int(round(coarse_size * 0.16)))
    maximum_span = max(4.0, coarse_size * 1.35)
    # Only a clearly undersized run may absorb an adjacent detached stroke.
    # Full-sized runs remain independent, so neighboring characters cannot be
    # merged merely because their gap is narrow.
    merge_below_width = coarse_size * (0.9 if selected_from_gap else 0.5)
    left_index = right_index = selected_index
    while selected[1] - selected[0] < merge_below_width:
        candidates: list[tuple[int, int, int, int]] = []
        if left_index > 0:
            previous = runs[left_index - 1]
            gap = selected[0] - previous[1]
            if gap <= maximum_gap and selected[1] - previous[0] <= maximum_span:
                candidates.append((gap, -1, previous[0], selected[1]))
        if right_index + 1 < len(runs):
            following = runs[right_index + 1]
            gap = following[0] - selected[1]
            if gap <= maximum_gap and following[1] - selected[0] <= maximum_span:
                candidates.append((gap, 1, selected[0], following[1]))
        if not candidates:
            break
        _, direction, start, end = min(candidates, key=lambda item: item[0])
        if direction < 0:
            left_index -= 1
        else:
            right_index += 1
        selected = (start, end)
    if selected[1] - selected[0] > coarse_size * 1.45:
        return None
    return selected


def _character_region_from_token(
    token: dict[str, Any],
    prepared: dict[str, Any],
    task: dict[str, Any],
    character_index: int,
    minimum_probability: float,
) -> dict[str, Any] | None:
    character = str(token.get('text') or '')
    probability = float(token.get('probability') or 0)
    if not character or character.isspace() or probability < minimum_probability:
        return None

    mask = np.asarray(prepared['mask'])
    canonical_width, canonical_height = prepared['canonical_size']
    position_ratio = max(0.0, min(1.0, float(token.get('position_ratio') or 0)))
    center_x = position_ratio * canonical_width
    line = task['line']
    line_box = _line_box(line)
    if line_box is None:
        return None
    line_short_axis = min(max(1, line_box[2] - line_box[0]), max(1, line_box[3] - line_box[1]))
    metric_width = float(line.get('font_width_px') or line.get('font_size_proxy_px') or 0)
    # The window must depend only on line geometry. Reusing a previously
    # calibrated paragraph font size would create a feedback loop and could
    # make one oversized result absorb ink from its neighbors on the next run.
    coarse_size = max(4.0, metric_width, float(line_short_axis))
    content_y1, content_y2 = prepared.get('content_y_range', (0, canonical_height))
    content_y1 = max(0, min(canonical_height, int(content_y1)))
    content_y2 = max(content_y1, min(canonical_height, int(content_y2)))
    projection = np.count_nonzero(mask[content_y1:content_y2, :] > 0, axis=0)
    runs = _projection_ink_runs(projection, coarse_size)
    selected_run = _select_ink_run(runs, center_x, coarse_size)
    if selected_run is None:
        return None
    sample_x1, sample_x2 = selected_run
    local = mask[content_y1:content_y2, sample_x1:sample_x2]
    ys, xs = np.nonzero(local > 0)
    if xs.size < 2:
        return None
    ink_x1 = sample_x1 + int(xs.min())
    ink_x2 = sample_x1 + int(xs.max()) + 1
    ink_y1 = content_y1 + int(ys.min())
    ink_y2 = content_y1 + int(ys.max()) + 1
    if ink_x2 <= ink_x1 or ink_y2 <= ink_y1:
        return None

    canonical_bbox = (ink_x1, ink_y1, ink_x2, ink_y2)
    image_bbox = _canonical_bbox_to_image(canonical_bbox, prepared)
    sample_bbox = _canonical_bbox_to_image((sample_x1, 0, sample_x2, canonical_height), prepared)
    width = max(0, image_bbox[2] - image_bbox[0])
    height = max(0, image_bbox[3] - image_bbox[1])
    if width <= 0 or height <= 0:
        return None
    return {
        'line_index': task['line_index'],
        'character_index': character_index,
        'orientation': prepared['orientation'],
        'ocr_text': character,
        'ocr_probability': round(probability, 6),
        'ctc_timestep': int(token.get('timestep') or 0),
        'position_ratio': round(position_ratio, 6),
        'sample_bbox': sample_bbox,
        'bbox': image_bbox,
        'width': width,
        'height': height,
        'status': 'accepted',
    }


def _iter_pages(measure: dict, page_filter: str | None) -> list[tuple[str, list[dict]]]:
    pages = measure.get('pages') or {}
    if page_filter is not None:
        return [(page_filter, pages.get(page_filter, []))]
    return list(pages.items())


def apply_calibrated_font_sizes(
    measure: dict,
    output: dict,
) -> int:
    changed = 0
    measure_pages = measure.get('pages') or {}
    for page_name, output_items in (output.get('pages') or {}).items():
        measure_items = measure_pages.get(page_name)
        if not isinstance(output_items, list) or not isinstance(measure_items, list):
            continue
        for output_item in output_items:
            if not isinstance(output_item, dict):
                continue
            fit = output_item.get('font_fit') or {}
            suggested = fit.get('suggested_font_size')
            suggested_float = fit.get('suggested_font_size_float', suggested)
            item_index = output_item.get('measure_item_index')
            fit_status = str(fit.get('status') or '')
            if (
                fit_status not in {'ready', 'ready_overlap_inherited'}
                or not isinstance(suggested, (int, float))
                or isinstance(suggested, bool)
                or not isinstance(item_index, int)
            ):
                continue
            try:
                suggested_float = float(suggested_float)
            except (TypeError, ValueError):
                suggested_float = float(suggested)
            if not np.isfinite(suggested_float) or suggested_float <= 0:
                suggested_float = float(suggested)
            if not (0 <= item_index < len(measure_items)) or not isinstance(measure_items[item_index], dict):
                continue
            font_size = round(max(0.1, min(999.0, suggested_float)), 1)
            measure_item = measure_items[item_index]
            old_size = measure_item.get('font_size')
            measure_item.setdefault('font_size_detected', old_size)
            measure_item['font_size_ocr'] = font_size
            measure_item['font_size_method'] = (
                'mit48_cached_font_ink_overlap_inherited'
                if fit_status == 'ready_overlap_inherited'
                else 'mit48_cached_font_ink_candidate_grid'
            )
            measure_item['font_size_ocr_method'] = measure_item['font_size_method']
            char_box_size = measure_item.get('font_size_char_box')
            if (isinstance(char_box_size, (int, float)) and not isinstance(char_box_size, bool)
                    and np.isfinite(char_box_size) and char_box_size > 0):
                font_size = round(max(font_size, min(999.0, char_box_size)), 1)
                measure_item['font_size_method'] = 'max_char_box_ocr_aligned'
                fit['char_box_font_size'] = char_box_size
            measure_item['font_size'] = font_size
            fit['applied_font_size'] = font_size
            fit['applied_font_size_source_float'] = round(suggested_float, 3)
            try:
                unchanged = abs(float(old_size) - font_size) < 0.05
            except (TypeError, ValueError):
                unchanged = False
            if not unchanged:
                changed += 1
    calibration = output.get('font_calibration') or {}
    measure['font_size_calculation_method'] = 'ocr_aligned'
    measure['font_size_calculation_settings'] = {
        'default_font_size': round(float(calibration.get('default_font_size', DEFAULT_FONT_SIZE_BASE)), 1),
        'font_size_step': round(float(calibration.get('font_size_step', DEFAULT_FONT_SIZE_STEP)), 1),
    }
    return changed


def run(
    measure_path: str,
    image_dir: str,
    output_path: str | None,
    model_path: str,
    alphabet_path: str,
    implementation_path: str,
    device: str,
    pads: list[int],
    minimum_probability: float,
    page: str | None,
    measure_debug_path: str | None,
    source_block_index: int | None,
    limit_pages: int | None,
    limit_items: int | None,
    batch_size: int,
    save_crops: str | None,
    dry_run: bool,
    on_page=None,
) -> str:
    measure = _load_json(measure_path)
    measure_debug_path = measure_debug_path or osp.join(osp.dirname(measure_path), 'measure.debug.json')
    measure_debug = _load_json(measure_debug_path) if osp.isfile(measure_debug_path) else {}
    output_path = output_path or osp.join(osp.dirname(measure_path), 'measure_ocr.json')
    pages = _iter_pages(measure, page)
    if limit_pages is not None:
        pages = pages[:limit_pages]

    save_crops_path = Path(save_crops) if save_crops else None
    if save_crops_path is not None:
        save_crops_path.mkdir(parents=True, exist_ok=True)
    if dry_run:
        ocr = None
    else:
        print(f'正在載入 mit48px CTC 模型（請求設備：{device}）...', flush=True)
        ocr = Mit48pxCtcOcr(
            device,
            model_path=model_path,
            alphabet_path=alphabet_path,
            implementation_path=implementation_path,
        )
        print(f'mit48px CTC 模型載入完成（實際設備：{ocr.device}）。', flush=True)
    output = {
        'ocr_engine': 'mit48px_ctc_line_aligned',
        'model_path': str(model_path),
        'alphabet_path': str(alphabet_path),
        'device': ocr.device if ocr is not None else device,
        'pads': pads,
        'line_pad': max(pads) if pads else 4,
        'minimum_probability': minimum_probability,
        'pages': {},
    }

    start_time = time.perf_counter()
    total_pages = len(pages)
    print(f'準備處理 {total_pages} 頁。', flush=True)
    for page_index, (page_name, items) in enumerate(pages, start=1):
        page_start = time.perf_counter()
        image_bgr = cv2.imread(str(_image_path_for_page(image_dir, page_name)), cv2.IMREAD_COLOR)
        if image_bgr is None:
            raise RuntimeError(f'無法讀取原圖：{page_name}')
        image_rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
        mask_path = _mask_path_for_page(measure_path, page_name)
        text_mask = cv2.imread(str(mask_path), cv2.IMREAD_GRAYSCALE)
        if text_mask is None:
            raise FileNotFoundError(f'找不到文字遮罩：{mask_path}')
        output_items, tasks = _line_tasks_for_page(
            items, measure_debug, page_name, source_block_index,
        )
        if limit_items is not None:
            output_items = output_items[:limit_items]
            allowed = set(range(len(output_items)))
            tasks = [task for task in tasks if task['output_index'] in allowed]
        print(
            f'[{page_index}/{total_pages}] OCR {page_name}: '
            f'{len(output_items)} boxes, {len(tasks)} lines',
            flush=True,
        )

        crops = []
        prepared_lines = []
        line_pad = max(pads) if pads else 4
        for task_index, task in enumerate(tasks):
            orientation = _line_orientation(task['line'], task['orientation'])
            prepared = _prepare_line_crop(
                image_rgb,
                text_mask,
                task['line'],
                orientation,
                line_pad,
            )
            if prepared is None:
                continue
            crops.append(prepared['crop'])
            prepared_lines.append((task_index, prepared))
            if save_crops_path is not None:
                name = (
                    f'{Path(page_name).stem}-b{task["source_block_index"]:03d}'
                    f'-l{task["line_index"]:02d}-p{line_pad}.png'
                )
                cv2.imwrite(str(save_crops_path / name), cv2.cvtColor(prepared['crop'], cv2.COLOR_RGB2BGR))

        if dry_run:
            recognized = [
                {'text': '', 'probability': 0.0, 'character_probabilities': [], 'tokens': []}
                for _ in crops
            ]
        else:
            def report_line_progress(completed: int, total: int) -> None:
                print(
                    f'[{page_index}/{total_pages}] OCR {page_name}: '
                    f'{completed}/{total} lines',
                    flush=True,
                )

            recognized = (
                ocr.recognize_batch_aligned(
                    crops,
                    batch_size=batch_size,
                    progress_callback=report_line_progress,
                )
                if ocr is not None
                else []
            )

        print(
            f'[{page_index}/{total_pages}] OCR {page_name}: '
            f'模型推理完成，正在整理 {sum(len(result.get("tokens") or []) for result in recognized)} 個 token 的墨跡框...',
            flush=True,
        )

        for (task_index, prepared), line_result in zip(prepared_lines, recognized):
            task = tasks[task_index]
            output_item = output_items[task['output_index']]
            output_item['ocr_lines'].append({
                'line_index': task['line_index'],
                'orientation': prepared['orientation'],
                'ocr_text': line_result.get('text') or '',
                'ocr_probability': float(line_result.get('probability') or 0),
                'token_count': len(line_result.get('tokens') or []),
                'pad': prepared['pad'],
            })
            for character_index, token in enumerate(line_result.get('tokens') or []):
                character = _character_region_from_token(
                    token,
                    prepared,
                    task,
                    character_index,
                    minimum_probability,
                )
                if character is not None:
                    output_item['ocr_characters'].append(character)

        for output_item in output_items:
            characters = output_item['ocr_characters']
            characters.sort(key=lambda item: (int(item['line_index']), int(item['character_index'])))
            output_item['ocr_lines'].sort(key=lambda item: int(item['line_index']))
            output_item['ocr_text'] = '\n'.join(
                str(line.get('ocr_text') or '')
                for line in output_item['ocr_lines']
            )
        output['pages'][page_name] = output_items
        if on_page: on_page(page_index, total_pages)
        print(
            f'[{page_index}/{total_pages}] 完成 {page_name} '
            f'({time.perf_counter() - page_start:.1f}s，已寫入記憶體)',
            flush=True,
        )

    _write_json(output_path, output)
    print(f'總耗時：{time.perf_counter() - start_time:.1f}s', flush=True)
    return output_path


def main() -> None:
    parser = argparse.ArgumentParser(description='Run whole-line mit48px CTC OCR with aligned character regions.')
    parser.add_argument('path1', help='Image folder, or measure.json in the old two-argument form')
    parser.add_argument('path2', nargs='?', default=None, help='Image folder for old two-argument form')
    parser.add_argument('--measure-json', default=None)
    parser.add_argument('--output', default=None)
    parser.add_argument('--model', default=str(DEFAULT_MODEL_PATH))
    parser.add_argument('--alphabet', default=str(DEFAULT_ALPHABET_PATH))
    parser.add_argument('--implementation', default=str(DEFAULT_IMPLEMENTATION_PATH))
    parser.add_argument('--device', default='cpu', choices=['cpu', 'mps', 'cuda'])
    parser.add_argument('--pads', default='4,8', help='Comma-separated line padding values; the largest is used')
    parser.add_argument('--minimum-probability', type=float, default=0.3)
    parser.add_argument('--page', default=None)
    parser.add_argument('--measure-debug', default=None)
    parser.add_argument('--source-block-index', type=int, default=None)
    parser.add_argument('--limit-pages', type=int, default=None)
    parser.add_argument('--limit-items', type=int, default=None)
    parser.add_argument('--batch-size', type=int, default=32)
    parser.add_argument('--save-crops', default=None)
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--calibrate-font-sizes', action='store_true')
    parser.add_argument('--apply-font-sizes', action='store_true')
    parser.add_argument('--default-font-size', type=float, default=DEFAULT_FONT_SIZE_BASE)
    parser.add_argument('--font-size-step', type=float, default=DEFAULT_FONT_SIZE_STEP)
    args = parser.parse_args()
    measure_path, image_dir = _resolve_input_paths(args.path1, args.path2, args.measure_json)
    pads = sorted({max(0, int(value.strip())) for value in args.pads.split(',') if value.strip()})
    if not pads:
        pads = [4]
    output = run(
        measure_path=measure_path,
        image_dir=image_dir,
        output_path=args.output,
        model_path=args.model,
        alphabet_path=args.alphabet,
        implementation_path=args.implementation,
        device=args.device,
        pads=pads,
        minimum_probability=max(0.0, min(1.0, args.minimum_probability)),
        page=args.page,
        measure_debug_path=args.measure_debug,
        source_block_index=args.source_block_index,
        limit_pages=args.limit_pages,
        limit_items=args.limit_items,
        batch_size=max(1, args.batch_size),
        save_crops=args.save_crops,
        dry_run=args.dry_run,
    )
    if args.calibrate_font_sizes or args.apply_font_sizes:
        calibrated = _load_json(output)
        default_font_size = max(0.1, round(float(args.default_font_size), 1))
        font_size_step = max(0.1, round(float(args.font_size_step), 1))
        ready_count = calibrate_ocr_output(
            calibrated,
            default_font_size=default_font_size,
            font_size_step=font_size_step,
        )
        changed_count = 0
        if args.apply_font_sizes:
            measure = _load_json(measure_path)
            changed_count = apply_calibrated_font_sizes(measure, calibrated)
            _write_json(measure_path, measure)
        _write_json(output, calibrated)
        print(f'字級校準：{ready_count} 個可靠區塊，更新 measure.json {changed_count} 個區塊。', flush=True)
    print(f'輸出：{output}', flush=True)
