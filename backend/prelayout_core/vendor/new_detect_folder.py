#!/usr/bin/env python3
"""精簡版資料夾偵測腳本，輸出偵測、對齊、mask npz 和量測預覽結果。"""

import argparse
import json
import os
import os.path as osp
from pathlib import Path

import cv2
import numpy as np
import torch
from tqdm import tqdm

from prelayout_core.vendor.detect_folder import (
    CENTER_DIR,
    DEAL_OVERLAP_DIR,
    LINE_TRANS_BOX_DIR,
    NumpyEncoder,
    REFINEMASK_ANNOTATION,
    TextDetector,
    _align_block_box,
    _align_block_boxes,
    _char_boxes_from_line_mask,
    _clean_aligned_items,
    _draw_aligned_boxes,
    _draw_line_width_measurements,
    _ensure_deal_overlap_image,
    _final_boxes_overlap,
    _find_component_boxes,
    _outer_overlap_indices,
    _prepare_align_gray,
    _shrink_line_polygons,
    find_all_imgs,
    imread,
    imwrite,
)
from prelayout_core.vendor.detect_folder import (
    SHRINK_PERCENTILE_HIGH,
    SHRINK_PERCENTILE_LOW,
    SHRINK_PERCENTILE_PADDING,
)
from prelayout_core.vendor.bubble_pipeline import split_candidates as _split_bubble_candidates


CTD_DIR = 'ctd'
PROGRESSING_DIR = 'progressing'
MASK_DIR = 'mask'
BLOCK_MASK_DIR = 'block_mask'
OTHER_MASK_DIR = 'other_mask'
ALIGN_DIR = 'align'
NECK_DIR = 'neck'
ALIGN_MASK_DIR = 'masks'
MEASURE_PREVIEW_DIR = 'measure_preview'
MEASURE_WH_PREVIEW_DIR = 'measure_wh_preview'
ONLY_TEXT_DIR = 'only_text'
INPAINTED_DIR = 'inpainted'
BLOCK_MAP_JSON = 'block_map.json'
LINE_TRANS_MAP_JSON = 'line_trans_map.json'
ALIGNED_BOX_MAP_JSON = 'aligned_box_map.json'
MEASURE_JSON = 'measure.json'
MEASURE_DEBUG_JSON = 'measure.debug.json'
NECK_IOU_THRESHOLD = 0.92
NECK_SEED_DILATE = 15
NECK_LINE_COLOR = (0, 0, 0)
NECK_MANUAL_DIFF_THRESHOLD = 24
ONLY_TEXT_COLOR = (255, 0, 255)
ONLY_TEXT_OPACITY = 0.4
INPAINT_RADIUS = 3
INPAINT_MASK_EXPANSION = 5


def _parse_bool(value: str | bool) -> bool:
    if isinstance(value, bool):
        return value
    normalized = value.strip().lower()
    if normalized in {'1', 'true', 'yes', 'y', 'on'}:
        return True
    if normalized in {'0', 'false', 'no', 'n', 'off'}:
        return False
    raise argparse.ArgumentTypeError(f'布林值格式錯誤：{value}，請使用 true 或 false')


def _ensure_dirs(ctd_dir: str) -> dict[str, str]:
    progressing_dir = osp.join(ctd_dir, PROGRESSING_DIR)
    paths = {
        'ctd': ctd_dir,
        'progressing': progressing_dir,
        'mask': osp.join(progressing_dir, MASK_DIR),
        'block_mask': osp.join(progressing_dir, BLOCK_MASK_DIR),
        'other_mask': osp.join(progressing_dir, OTHER_MASK_DIR),
        'line_trans_box': osp.join(progressing_dir, LINE_TRANS_BOX_DIR),
        'align': osp.join(progressing_dir, ALIGN_DIR),
        'center': osp.join(progressing_dir, ALIGN_DIR, CENTER_DIR),
        'deal_overlap': osp.join(progressing_dir, ALIGN_DIR, DEAL_OVERLAP_DIR),
        'neck': osp.join(progressing_dir, ALIGN_DIR, NECK_DIR),
        'align_masks': osp.join(progressing_dir, ALIGN_DIR, ALIGN_MASK_DIR),
        'measure_preview': osp.join(ctd_dir, MEASURE_PREVIEW_DIR),
        'measure_wh_preview': osp.join(ctd_dir, MEASURE_WH_PREVIEW_DIR),
        'only_text': osp.join(ctd_dir, ONLY_TEXT_DIR),
        'inpainted': osp.join(ctd_dir, INPAINTED_DIR),
    }
    for path in paths.values():
        os.makedirs(path, exist_ok=True)
    return paths


def _block_item_from_xyxy(box: list[int], img_w: int, img_h: int, index: int) -> dict:
    x1, y1, x2, y2 = [int(v) for v in box]
    return {
        'xyxy_pixel': [x1, y1, x2, y2],
        'center_normalized': [
            round(((x1 + x2) / 2) / img_w, 4),
            round(((y1 + y2) / 2) / img_h, 4),
        ],
        'source_block_index': index,
    }


def _block_boxes_from_items(items: list[dict]) -> list[list[int]]:
    boxes = []
    for item in items:
        xyxy = item.get('xyxy_pixel')
        if isinstance(xyxy, list) and len(xyxy) == 4:
            boxes.append([int(round(v)) for v in xyxy])
    return boxes


def _load_json(path: str) -> dict:
    with open(path, 'r', encoding='utf8') as f:
        return json.load(f)


def _write_json(path: str, data: dict) -> None:
    with open(path, 'w', encoding='utf8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2, cls=NumpyEncoder)


def _image_path_for_page(img_dir: str, page_name: str) -> str:
    path = osp.join(img_dir, page_name)
    if osp.isfile(path):
        return path
    stem = Path(page_name).stem
    for ext in ('.png', '.jpg', '.jpeg', '.bmp'):
        candidate = osp.join(img_dir, f'{stem}{ext}')
        if osp.isfile(candidate):
            return candidate
    raise FileNotFoundError(f'找不到原圖：{page_name}')


def _mask_path_for_page(paths: dict[str, str], page_name: str) -> str:
    return osp.join(paths['mask'], f'{Path(page_name).stem}.png')


def _block_mask_path_for_page(paths: dict[str, str], page_name: str) -> str:
    return osp.join(paths['block_mask'], f'{Path(page_name).stem}.png')


def _other_mask_path_for_page(paths: dict[str, str], page_name: str) -> str:
    return osp.join(paths['other_mask'], f'{Path(page_name).stem}.png')


def _only_text_path_for_page(paths: dict[str, str], page_name: str) -> str:
    return osp.join(paths['only_text'], f'{Path(page_name).stem}.png')


def _inpainted_path_for_page(paths: dict[str, str], page_name: str) -> str:
    return osp.join(paths['inpainted'], f'{Path(page_name).stem}.png')


def _deal_overlap_path_for_page(paths: dict[str, str], page_name: str) -> str:
    return osp.join(paths['deal_overlap'], f'{Path(page_name).stem}.png')


def _neck_path_for_page(paths: dict[str, str], page_name: str) -> str:
    return osp.join(paths['neck'], f'{Path(page_name).stem}.png')


def _neck_summary_path_for_page(paths: dict[str, str], page_name: str) -> str:
    return osp.join(paths['neck'], f'{Path(page_name).stem}.json')


def _align_mask_path_for_page(paths: dict[str, str], page_name: str) -> str:
    return osp.join(paths['align_masks'], f'{Path(page_name).stem}.npz')


def _image_modified(base_img: np.ndarray, candidate_img: np.ndarray | None) -> bool:
    if candidate_img is None or base_img.shape[:2] != candidate_img.shape[:2]:
        return False
    base = base_img[:, :, :3] if len(base_img.shape) == 3 else cv2.cvtColor(base_img, cv2.COLOR_GRAY2BGR)
    candidate = candidate_img[:, :, :3] if len(candidate_img.shape) == 3 else cv2.cvtColor(candidate_img, cv2.COLOR_GRAY2BGR)
    diff = cv2.absdiff(base, candidate)
    diff_gray = cv2.cvtColor(diff, cv2.COLOR_BGR2GRAY)
    changed = diff_gray > NECK_MANUAL_DIFF_THRESHOLD
    return int(np.count_nonzero(changed)) >= 16


def _draw_neck_guides(
    base_img: np.ndarray,
    groups: list[dict],
    line_color: tuple[int, int, int] = NECK_LINE_COLOR,
) -> np.ndarray:
    canvas = base_img.copy()
    line_width = max(3, min(canvas.shape[:2]) // 280)
    for group in groups:
        for guide in group.get('guides', []):
            start = tuple(int(v) for v in guide['start'])
            end = tuple(int(v) for v in guide['end'])
            cv2.line(canvas, start, end, line_color, line_width, cv2.LINE_AA)
    return canvas


def _rect_from_points(points: list[list[int]], padding: int, img_w: int, img_h: int) -> list[int] | None:
    points = [point for point in points if isinstance(point, list) and len(point) >= 2]
    if not points:
        return None
    xs = [int(point[0]) for point in points]
    ys = [int(point[1]) for point in points]
    return [
        max(0, min(xs) - padding),
        max(0, min(ys) - padding),
        min(img_w, max(xs) + padding),
        min(img_h, max(ys) + padding),
    ]


def _dict_rect_to_xyxy(rect: dict | None) -> list[int] | None:
    if not rect:
        return None
    return [
        int(round(rect.get('left', 0))),
        int(round(rect.get('top', 0))),
        int(round(rect.get('left', 0) + rect.get('width', 0))),
        int(round(rect.get('top', 0) + rect.get('height', 0))),
    ]


def _expand_xyxy(box: list[int], padding: int, img_w: int, img_h: int) -> list[int]:
    return [
        max(0, int(box[0]) - padding),
        max(0, int(box[1]) - padding),
        min(img_w, int(box[2]) + padding),
        min(img_h, int(box[3]) + padding),
    ]


def _xyxy_overlap(a: list[int], b: list[int]) -> bool:
    return min(a[2], b[2]) > max(a[0], b[0]) and min(a[3], b[3]) > max(a[1], b[1])


def _final_xyxy_for_overlap(item: dict) -> list[int] | None:
    xyxy = item.get('final_xyxy_pixel') or item.get('new_xyxy_pixel')
    if isinstance(xyxy, list) and len(xyxy) == 4:
        return [int(round(value)) for value in xyxy]
    if all(key in item for key in ('x', 'y', 'w', 'h')):
        x = int(round(item['x']))
        y = int(round(item['y']))
        w = int(round(item['w']))
        h = int(round(item['h']))
        return [x, y, x + w, y + h]
    return None


def _xyxy_area(box: list[int]) -> int:
    return max(0, int(box[2]) - int(box[0])) * max(0, int(box[3]) - int(box[1]))


def _final_overlap_indices(aligned_items: list[dict], min_ratio: float = 0.05) -> set[int]:
    boxes = []
    for index, item in enumerate(aligned_items):
        box = _final_xyxy_for_overlap(item)
        if box is not None:
            boxes.append((index, box))

    overlap_indices = set()
    for list_index, (index_a, box_a) in enumerate(boxes):
        for index_b, box_b in boxes[list_index + 1:]:
            if not _xyxy_overlap(box_a, box_b):
                continue
            overlap_area = _overlap_area(box_a, box_b)
            smaller_area = min(_xyxy_area(box_a), _xyxy_area(box_b))
            if smaller_area > 0 and overlap_area / smaller_area >= min_ratio:
                overlap_indices.add(index_a)
                overlap_indices.add(index_b)
    return overlap_indices


def _mark_overlap_error_route(
    aligned_items: list[dict],
    overlap_indices: set[int],
    img_shape: tuple[int, int],
) -> list[dict]:
    if not overlap_indices:
        return aligned_items

    img_h, img_w = img_shape
    result = []
    for index, item in enumerate(aligned_items):
        if index not in overlap_indices:
            result.append(item)
            continue

        marked = dict(item)
        debug = dict(marked.get('layout_debug', {}))
        old_xyxy = debug.get('old_xyxy_pixel')
        if not isinstance(old_xyxy, list) or len(old_xyxy) != 4:
            old_xyxy = _final_xyxy_for_overlap(marked)
        if not isinstance(old_xyxy, list) or len(old_xyxy) != 4:
            result.append(marked)
            continue

        old_xyxy = [int(round(value)) for value in old_xyxy]
        old_center = _center_normalized_from_xyxy(old_xyxy, img_w, img_h)
        debug['accepted'] = False
        debug['skip_reason'] = 'final_boxes_overlap'
        debug['error_route'] = True
        debug['final_center_pixel'] = [
            round((old_xyxy[0] + old_xyxy[2]) / 2, 2),
            round((old_xyxy[1] + old_xyxy[3]) / 2, 2),
        ]
        debug['final_xyxy_pixel'] = old_xyxy
        marked['layout_debug'] = debug
        marked['x'] = old_xyxy[0]
        marked['y'] = old_xyxy[1]
        marked['w'] = max(0, old_xyxy[2] - old_xyxy[0])
        marked['h'] = max(0, old_xyxy[3] - old_xyxy[1])
        marked['area'] = _xyxy_area(old_xyxy)
        marked['final_xyxy_pixel'] = old_xyxy
        marked['final_center_normalized'] = old_center
        marked['accepted'] = False
        marked['method'] = 'block_fallback_final_overlap'
        marked['error_route'] = True
        marked['error_reason'] = 'final_boxes_overlap'
        result.append(marked)
    return result


def _neck_affected_indices(
    neck_summary: dict,
    aligned_items: list[dict],
    img_shape: tuple[int, int],
) -> set[int]:
    img_h, img_w = img_shape
    affected: set[int] = set()
    guide_rects = []

    for group in neck_summary.get('groups', []):
        guides = group.get('guides') or []
        if not guides:
            continue
        affected.update(
            int(index)
            for index in group.get('source_block_indices', [])
            if index is not None
        )
        for guide in guides:
            affected.update(
                int(index)
                for index in guide.get('source_block_indices', [])
                if index is not None
            )
            rect = _rect_from_points(
                [guide.get('start'), guide.get('end'), guide.get('center')],
                padding=max(16, NECK_SEED_DILATE * 2),
                img_w=img_w,
                img_h=img_h,
            )
            if rect is not None:
                guide_rects.append(rect)

    if not guide_rects:
        return affected

    for index, item in enumerate(aligned_items):
        debug = item.get('layout_debug', {})
        boxes = [
            _dict_rect_to_xyxy(debug.get('outer_rect')),
            _dict_rect_to_xyxy(debug.get('raw_outer_rect')),
            debug.get('old_xyxy_pixel'),
            item.get('final_xyxy_pixel'),
        ]
        for box in boxes:
            if not isinstance(box, list) or len(box) != 4:
                continue
            expanded = _expand_xyxy([int(round(v)) for v in box], 12, img_w, img_h)
            if any(_xyxy_overlap(expanded, guide_rect) for guide_rect in guide_rects):
                affected.add(index)
                break

    return affected


def _item_outer_xyxy(item: dict) -> list[int] | None:
    debug = item.get('layout_debug', {})
    return _dict_rect_to_xyxy(debug.get('outer_rect')) or _dict_rect_to_xyxy(debug.get('raw_outer_rect'))


def _overlap_indices_near_affected(aligned_items: list[dict], affected: set[int]) -> set[int]:
    if not affected:
        return set()

    outer_boxes = []
    for index, item in enumerate(aligned_items):
        box = _item_outer_xyxy(item)
        if box is not None:
            outer_boxes.append((index, box))

    related = set(affected)
    changed = True
    while changed:
        changed = False
        for index_a, box_a in outer_boxes:
            for index_b, box_b in outer_boxes:
                if index_a == index_b:
                    continue
                if index_a not in related and index_b not in related:
                    continue
                if not _xyxy_overlap(box_a, box_b):
                    continue
                if index_a not in related:
                    related.add(index_a)
                    changed = True
                if index_b not in related:
                    related.add(index_b)
                    changed = True

    return related & _outer_overlap_indices(aligned_items)


def _realign_affected_blocks(
    neck_img: np.ndarray,
    mask: np.ndarray,
    block_boxes: list[list[int]],
    aligned_items: list[dict],
    neck_summary: dict,
    base_img: np.ndarray,
) -> list[dict]:
    affected = _neck_affected_indices(neck_summary, aligned_items, neck_img.shape[:2])
    if not affected:
        return aligned_items

    neck_gray, _ = _prepare_align_gray(neck_img, mask, base_img=base_img)
    merged_items = list(aligned_items)
    for index in sorted(affected):
        if index < 0 or index >= len(block_boxes):
            continue
        merged_items[index] = _align_block_box(
            neck_img,
            mask,
            block_boxes[index],
            index,
            center_mode='auto',
            base_img=base_img,
            prepared_gray=neck_gray,
        )

    for index in sorted(_overlap_indices_near_affected(merged_items, affected)):
        if index < 0 or index >= len(block_boxes):
            continue
        merged_items[index] = _align_block_box(
            neck_img,
            mask,
            block_boxes[index],
            index,
            center_mode='outer',
            base_img=base_img,
            prepared_gray=neck_gray,
        )
        merged_items[index]['outer_overlap_center_mode_override'] = True

    return merged_items


def _remove_generated_neck_image(path: str) -> None:
    if osp.exists(path):
        os.remove(path)


def _align_concavity_blocks(img, mask, boxes, aligned_items, gray, neck_path,
                            summary_path, page_name):
    candidates, groups = _split_bubble_candidates(gray, cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), boxes)
    merged = list(aligned_items)

    def calculate(index, use_completion):
        candidate = candidates[index]
        partition = candidate['partition']
        geometry = candidate['geometry'] if use_completion else partition
        item = _align_block_box(img, mask, boxes[index], index, base_img=img,
                                prepared_gray=gray, component_mask=geometry, layout_mask=partition)
        debug = item['layout_debug']
        debug.update(split_applied=True, split_method='concavity_symmetry_v1',
                     completion=candidate['completion'],
                     geometry_used='completion' if use_completion else 'partition')
        proposed = item.get('new_xyxy_pixel', [0, 0, 0, 0])
        x1, y1, x2, y2 = proposed
        inside = (0 <= x1 < x2 <= partition.shape[1] and
                  0 <= y1 < y2 <= partition.shape[0] and
                  bool(np.all(partition[y1:y2, x1:x2] > 0)))
        debug.setdefault('safety_checks', {})['inside_partition'] = inside
        if item.get('accepted') and not inside:
            old = debug['old_xyxy_pixel']
            item.update(x=old[0], y=old[1], w=old[2]-old[0], h=old[3]-old[1],
                        area=(old[2]-old[0])*(old[3]-old[1]), accepted=False,
                        final_xyxy_pixel=old, method='block_fallback_outside_partition',
                        final_center_normalized=_center_normalized_from_xyxy(old, img.shape[1], img.shape[0]))
            debug.update(accepted=False, skip_reason='candidate_outside_partition',
                         final_center_pixel=[(old[0]+old[2])/2, (old[1]+old[3])/2])
        return item

    for index, candidate in candidates.items():
        use_completion = candidate['completion']['status'] == 'completed'
        item = calculate(index, use_completion)
        if use_completion and not item.get('accepted'):
            reason = item['layout_debug'].get('skip_reason') or 'completion_rejected'
            item = calculate(index, False)
            item['layout_debug']['completion_fallback_reason'] = reason
        merged[index] = item
    # Conflicts with untouched/fallback text boxes still use the existing safety route.
    for index in sorted(_final_overlap_indices(merged)):
        if index in candidates and merged[index]['layout_debug'].get('geometry_used') == 'completion':
            merged[index] = calculate(index, False)
            merged[index]['layout_debug']['completion_fallback_reason'] = 'completed_boxes_overlap'
    summary = {'page': page_name, 'method': 'concavity_symmetry_v1',
               'generated': bool(candidates), 'groups': groups}
    if candidates:
        imwrite(neck_path, _draw_neck_guides(img, groups))
    else:
        _remove_generated_neck_image(neck_path)
    _write_json(summary_path, summary)
    return merged, summary


def _xyxy_from_align_item(item: dict) -> list[int]:
    if item.get('accepted') is False:
        xyxy = item.get('final_xyxy_pixel') or item.get('new_xyxy_pixel')
    else:
        xyxy = item.get('new_xyxy_pixel') or item.get('final_xyxy_pixel')
    if isinstance(xyxy, list) and len(xyxy) == 4:
        return [int(round(v)) for v in xyxy]

    x = int(round(item.get('x', 0)))
    y = int(round(item.get('y', 0)))
    w = int(round(item.get('w', 0)))
    h = int(round(item.get('h', 0)))
    return [x, y, x + w, y + h]


def _center_from_align_item(
    item: dict,
    xyxy: list[int],
    img_w: int,
    img_h: int,
) -> list[float]:
    if item.get('accepted') is False:
        center = item.get('final_center_normalized')
    else:
        center = item.get('new_center_normalized') or item.get('final_center_normalized')
    if isinstance(center, list) and len(center) == 2:
        return [round(float(center[0]), 4), round(float(center[1]), 4)]
    return _center_normalized_from_xyxy(xyxy, img_w, img_h)


def _center_normalized_from_xyxy(
    xyxy: list[int],
    img_w: int,
    img_h: int,
) -> list[float]:
    x1, y1, x2, y2 = xyxy
    return [
        round(((x1 + x2) / 2) / img_w, 4),
        round(((y1 + y2) / 2) / img_h, 4),
    ]


def _line_box_from_item(item: dict) -> list[int] | None:
    poly = item.get('polygon')
    if isinstance(poly, list) and len(poly) >= 4:
        arr = np.asarray(poly, dtype=np.float64).reshape(-1, 2)
        x1, y1 = arr.min(axis=0)
        x2, y2 = arr.max(axis=0)
        return [int(x1), int(y1), int(x2), int(y2)]
    if all(key in item for key in ('x', 'y', 'w', 'h')):
        x = int(round(item['x']))
        y = int(round(item['y']))
        w = int(round(item['w']))
        h = int(round(item['h']))
        return [x, y, x + w, y + h]
    return None


def _line_center(item: dict) -> tuple[float, float] | None:
    poly = item.get('polygon')
    if isinstance(poly, list) and len(poly) >= 4:
        arr = np.asarray(poly, dtype=np.float64).reshape(-1, 2)
        center = arr.mean(axis=0)
        return float(center[0]), float(center[1])
    box = _line_box_from_item(item)
    if box is None:
        return None
    x1, y1, x2, y2 = box
    return (x1 + x2) / 2, (y1 + y2) / 2


def _line_width(item: dict) -> float:
    value = item.get('font_width_px')
    if isinstance(value, (int, float)):
        return float(value)

    poly = item.get('polygon')
    if isinstance(poly, list) and len(poly) >= 4:
        pts = np.asarray(poly, dtype=np.float64).reshape(4, 2)
        lengths = [
            float(np.linalg.norm(pts[(i + 1) % 4] - pts[i]))
            for i in range(4)
        ]
        return min((lengths[0] + lengths[2]) / 2.0, (lengths[1] + lengths[3]) / 2.0)

    box = _line_box_from_item(item)
    if box is None:
        return 0.0
    x1, y1, x2, y2 = box
    return float(min(max(0, x2 - x1), max(0, y2 - y1)))


def _line_orientation(item: dict) -> str:
    poly = item.get('polygon')
    if isinstance(poly, list) and len(poly) >= 4:
        pts = np.asarray(poly, dtype=np.float64).reshape(4, 2)
        lengths = [
            float(np.linalg.norm(pts[(i + 1) % 4] - pts[i]))
            for i in range(4)
        ]
        pair_a = (lengths[0] + lengths[2]) / 2.0
        pair_b = (lengths[1] + lengths[3]) / 2.0
        long_indices = (0, 2) if pair_a >= pair_b else (1, 3)
        vec = pts[(long_indices[0] + 1) % 4] - pts[long_indices[0]]
        return 'horizontal' if abs(vec[0]) >= abs(vec[1]) else 'vertical'

    box = _line_box_from_item(item)
    if box is None:
        return 'vertical'
    x1, y1, x2, y2 = box
    return 'horizontal' if (x2 - x1) >= (y2 - y1) else 'vertical'


def _overlap_area(a: list[int], b: list[int]) -> int:
    x1 = max(a[0], b[0])
    y1 = max(a[1], b[1])
    x2 = min(a[2], b[2])
    y2 = min(a[3], b[3])
    return max(0, x2 - x1) * max(0, y2 - y1)


def _line_groups_by_block(
    block_items: list[dict],
    line_items: list[dict],
) -> dict[int, list[dict]]:
    groups: dict[int, list[dict]] = {}
    block_boxes = []
    for item in block_items:
        xyxy = item.get('xyxy_pixel')
        if not isinstance(xyxy, list) or len(xyxy) != 4:
            continue
        source_index = int(item.get('source_block_index', len(block_boxes)))
        block_boxes.append((source_index, [int(round(v)) for v in xyxy]))

    for line in line_items:
        center = _line_center(line)
        line_box = _line_box_from_item(line)
        best_index = None
        if center is not None:
            cx, cy = center
            for source_index, box in block_boxes:
                if box[0] <= cx <= box[2] and box[1] <= cy <= box[3]:
                    best_index = source_index
                    break

        if best_index is None and line_box is not None:
            best_area = 0
            for source_index, box in block_boxes:
                area = _overlap_area(line_box, box)
                if area > best_area:
                    best_area = area
                    best_index = source_index

        if best_index is not None:
            groups.setdefault(best_index, []).append(line)
    return groups


def _upper_median(values: list[float]) -> float:
    sorted_values = sorted(values)
    return sorted_values[len(sorted_values) // 2]


def _percentile(values: list[float], percentile: float) -> float:
    sorted_values = sorted(float(value) for value in values if float(value) > 0)
    if not sorted_values:
        return 0.0
    if len(sorted_values) == 1:
        return sorted_values[0]
    pos = (len(sorted_values) - 1) * percentile / 100.0
    lower = int(np.floor(pos))
    upper = int(np.ceil(pos))
    if lower == upper:
        return sorted_values[lower]
    weight = pos - lower
    return sorted_values[lower] * (1.0 - weight) + sorted_values[upper] * weight


def _dominant_dimension_values(values: list[float]) -> list[float]:
    valid = [float(value) for value in values if float(value) > 0]
    if not valid:
        return []
    upper = _percentile(valid, 75)
    threshold = max(1.0, upper * 0.55)
    selected = [value for value in valid if value >= threshold]
    return selected or valid


RELIABLE_SQUARE_MIN_DIFF_PX = 5.0
RELIABLE_SQUARE_DIFF_RATIO = 0.16
RELIABLE_SQUARE_MIN_COUNT = 4
RELIABLE_SQUARE_SMALL_SAMPLE_MAX_COUNT = 4
RELIABLE_SQUARE_SMALL_SAMPLE_MIN_COUNT = 1
RELIABLE_SQUARE_MIN_PRIMARY_RATIO = 0.55
SECONDARY_OUTLIER_GAP_PX = 5.0


def _reliable_square_diff_limit(width: float, height: float) -> float:
    return max(RELIABLE_SQUARE_MIN_DIFF_PX, max(width, height) * RELIABLE_SQUARE_DIFF_RATIO)


def _paragraph_font_size_from_char_boxes(
    char_boxes: list[dict],
    orientation: str,
) -> tuple[float | None, dict]:
    widths = [float(box.get('width') or 0) for box in char_boxes if float(box.get('width') or 0) > 0]
    heights = [float(box.get('height') or 0) for box in char_boxes if float(box.get('height') or 0) > 0]
    if not widths or not heights:
        return None, {
            'method': 'char_box_dual_signal',
            'accepted': False,
            'reason': 'no_char_boxes',
            'char_count': len(char_boxes),
        }

    primary_key = 'height' if orientation == 'horizontal' else 'width'
    secondary_key = 'width' if orientation == 'horizontal' else 'height'
    primary_values = _dominant_dimension_values(heights if orientation == 'horizontal' else widths)
    secondary_values = _dominant_dimension_values(widths if orientation == 'horizontal' else heights)
    if not primary_values or not secondary_values:
        return None, {
            'method': 'char_box_dual_signal',
            'accepted': False,
            'reason': 'no_dominant_values',
            'char_count': len(char_boxes),
            'widths': widths,
            'heights': heights,
        }

    primary_percentile = 100 if orientation == 'horizontal' else 60
    secondary_percentile = 75 if orientation == 'horizontal' else 100
    primary_size = _percentile(primary_values, primary_percentile)
    secondary_limit = max(primary_size * 1.6, primary_size + 8.0)
    secondary_min = min(secondary_values)
    secondary_filtered = []
    secondary_outliers = []
    apply_secondary_outlier_filter = len(char_boxes) <= RELIABLE_SQUARE_SMALL_SAMPLE_MAX_COUNT
    for index, box in enumerate(char_boxes):
        width = float(box.get('width') or 0)
        height = float(box.get('height') or 0)
        primary_value = height if primary_key == 'height' else width
        secondary_value = height if secondary_key == 'height' else width
        if primary_value <= 0 or secondary_value <= 0 or secondary_value < secondary_min:
            continue
        reason = None
        if secondary_value > secondary_limit:
            reason = 'above_secondary_limit'
        elif (
            apply_secondary_outlier_filter
            and secondary_value > primary_size + SECONDARY_OUTLIER_GAP_PX
            and abs(height - width) > _reliable_square_diff_limit(width, height)
        ):
            reason = 'extreme_secondary_not_square'
        if reason is not None:
            secondary_outliers.append({
                'index': index,
                'width': width,
                'height': height,
                'primary_value': primary_value,
                'secondary_value': secondary_value,
                'bbox': box.get('bbox'),
                'line_index': box.get('line_index'),
                'reason': reason,
            })
            continue
        secondary_filtered.append(secondary_value)
    if not secondary_filtered:
        secondary_filtered = secondary_values
    secondary_size = _percentile(secondary_filtered, secondary_percentile)
    font_size = max(primary_size, secondary_size)
    reliable_square_boxes = []
    reliable_min_size = max(1.0, primary_size * RELIABLE_SQUARE_MIN_PRIMARY_RATIO)
    required_square_count = (
        RELIABLE_SQUARE_SMALL_SAMPLE_MIN_COUNT
        if len(char_boxes) <= RELIABLE_SQUARE_SMALL_SAMPLE_MAX_COUNT
        else RELIABLE_SQUARE_MIN_COUNT
    )
    for index, box in enumerate(char_boxes):
        width = float(box.get('width') or 0)
        height = float(box.get('height') or 0)
        if width <= 0 or height <= 0:
            continue
        candidate_size = max(width, height)
        if abs(height - width) <= _reliable_square_diff_limit(width, height) and candidate_size >= reliable_min_size:
            reliable_square_boxes.append({
                'index': index,
                'width': width,
                'height': height,
                'size': candidate_size,
                'bbox': box.get('bbox'),
                'line_index': box.get('line_index'),
            })
    reliable_square_size = None
    if len(reliable_square_boxes) >= required_square_count:
        reliable_square_size = max(float(box['size']) for box in reliable_square_boxes)
        font_size = reliable_square_size
        method = 'char_box_reliable_square'
    else:
        method = 'char_box_dual_signal'
    return font_size, {
        'method': method,
        'accepted': True,
        'orientation': orientation,
        'char_count': len(char_boxes),
        'widths': widths,
        'heights': heights,
        'primary_dimension': 'H' if orientation == 'horizontal' else 'W',
        'secondary_dimension': 'W' if orientation == 'horizontal' else 'H',
        'primary_values': primary_values,
        'secondary_values': secondary_values,
        'secondary_filtered': secondary_filtered,
        'secondary_outlier_gap_px': SECONDARY_OUTLIER_GAP_PX,
        'secondary_outlier_filter_applied': apply_secondary_outlier_filter,
        'secondary_outliers': secondary_outliers,
        'primary_percentile': primary_percentile,
        'secondary_percentile': secondary_percentile,
        'primary_size': primary_size,
        'secondary_size': secondary_size,
        'dual_signal_font_size': max(primary_size, secondary_size),
        'reliable_square_min_diff_px': RELIABLE_SQUARE_MIN_DIFF_PX,
        'reliable_square_diff_ratio': RELIABLE_SQUARE_DIFF_RATIO,
        'reliable_square_min_count': RELIABLE_SQUARE_MIN_COUNT,
        'reliable_square_small_sample_max_count': RELIABLE_SQUARE_SMALL_SAMPLE_MAX_COUNT,
        'reliable_square_small_sample_min_count': RELIABLE_SQUARE_SMALL_SAMPLE_MIN_COUNT,
        'reliable_square_required_count': required_square_count,
        'reliable_square_min_size': reliable_min_size,
        'reliable_square_boxes': reliable_square_boxes,
        'reliable_square_size': reliable_square_size,
        'font_size': font_size,
    }


def _char_boxes_for_lines(mask: np.ndarray | None, lines: list[dict]) -> list[dict]:
    if mask is None:
        return []
    char_boxes = []
    for line_index, line in enumerate(lines):
        poly = line.get('polygon')
        if poly is None:
            continue
        _, boxes = _char_boxes_from_line_mask(mask, poly)
        for box in boxes:
            item = dict(box)
            item['line_index'] = line_index
            char_boxes.append(item)
    return char_boxes


def _snap_font_size_to_grid(font_size: float, default_font_size: float, font_size_step: float) -> float:
    value = max(0.1, float(font_size))
    base = max(0.1, float(default_font_size))
    step = max(0.1, float(font_size_step))
    lower_index = int(np.floor((value - base) / step))
    candidates = [base + lower_index * step, base + (lower_index + 1) * step]
    positive = [candidate for candidate in candidates if candidate > 0]
    selected = min(positive or [base], key=lambda candidate: (abs(candidate - value), -candidate))
    return round(selected, 1)


def _orientation_from_lines(lines: list[dict]) -> str:
    if not lines:
        return 'vertical'
    counts = {'horizontal': 0, 'vertical': 0}
    areas = {'horizontal': 0.0, 'vertical': 0.0}
    for line in lines:
        orientation = _line_orientation(line)
        counts[orientation] += 1
        areas[orientation] += float(line.get('area') or 0)
    if counts['horizontal'] == counts['vertical']:
        return 'horizontal' if areas['horizontal'] > areas['vertical'] else 'vertical'
    return 'horizontal' if counts['horizontal'] > counts['vertical'] else 'vertical'


def _build_measure_maps(
    img_dir: str,
    paths: dict[str, str],
    block_map: dict,
    line_trans_map: dict,
    aligned_box_map: dict,
    font_size_calculation_method: str = 'ocr_aligned',
    default_font_size: float = 24.0,
    font_size_step: float = 2.0,
    on_page=None,
) -> tuple[dict, dict]:
    pages = {}
    debug_pages = {}
    block_pages = block_map.get('blockMap', {})
    line_pages = line_trans_map.get('transMap', {})
    align_pages = aligned_box_map.get('transMap', {})

    for page_name, align_items in align_pages.items():
        img = imread(_image_path_for_page(img_dir, page_name))
        img_h, img_w = img.shape[:2]
        mask_path = _mask_path_for_page(paths, page_name)
        mask = (
            imread(mask_path, cv2.IMREAD_GRAYSCALE)
            if font_size_calculation_method in {'char_box', 'ocr_aligned'} and osp.isfile(mask_path)
            else None
        )
        block_items = block_pages.get(page_name, [])
        line_items = line_pages.get(page_name, [])
        line_groups = _line_groups_by_block(block_items, line_items)

        page_items = []
        page_debug_items = []
        for item in align_items:
            source_index = int(item.get('source_block_index', len(page_items)))
            xyxy = _xyxy_from_align_item(item)
            center = _center_from_align_item(item, xyxy, img_w, img_h)

            matched_lines = line_groups.get(source_index, [])
            orientation = _orientation_from_lines(matched_lines)
            if font_size_calculation_method in {'char_box', 'ocr_aligned'}:
                char_boxes = _char_boxes_for_lines(mask, matched_lines)
                detected_font_size, font_debug = _paragraph_font_size_from_char_boxes(char_boxes, orientation)
                if detected_font_size is not None:
                    font_method = str(font_debug.get('method') or 'char_box_dual_signal')
                else:
                    widths = [_line_width(line) for line in matched_lines]
                    widths = [value for value in widths if value > 0]
                    if widths:
                        detected_font_size = _upper_median(widths)
                        font_method = 'line_width_upper_median_fallback'
                    else:
                        x1, y1, x2, y2 = xyxy
                        detected_font_size = float(min(max(0, x2 - x1), max(0, y2 - y1)))
                        font_method = 'block_short_side_fallback'
                    font_debug = {
                        **font_debug,
                        'fallback_method': font_method,
                        'line_widths': widths,
                    }
                font_size = _snap_font_size_to_grid(
                    detected_font_size,
                    default_font_size,
                    font_size_step,
                )
                font_debug.update({
                    'detected_font_size': round(float(detected_font_size), 3),
                    'default_font_size': round(float(default_font_size), 1),
                    'font_size_step': round(float(font_size_step), 1),
                    'applied_font_size': font_size,
                    'rounding': 'candidate_grid_one_decimal',
                })
            else:
                char_boxes = []
                widths = [_line_width(line) for line in matched_lines]
                widths = [value for value in widths if value > 0]
                if widths:
                    font_size = _upper_median(widths)
                    font_method = 'line_width_upper_median'
                    font_debug = {
                        'method': font_method,
                        'accepted': True,
                        'orientation': orientation,
                        'line_widths': widths,
                        'font_size': font_size,
                    }
                else:
                    x1, y1, x2, y2 = xyxy
                    font_size = float(min(max(0, x2 - x1), max(0, y2 - y1)))
                    font_method = 'block_short_side_fallback'
                    font_debug = {
                        'method': font_method,
                        'accepted': True,
                        'orientation': orientation,
                        'line_widths': widths,
                        'font_size': font_size,
                    }

            page_items.append({
                'source_block_index': source_index,
                'xyxy_pixel': xyxy,
                'center_normalized': center,
                'orientation': orientation,
                'font_size': round(float(font_size), 1),
                'font_size_method': font_method,
                **(
                    {'font_size_detected': round(float(detected_font_size), 1)}
                    if font_size_calculation_method in {'char_box', 'ocr_aligned'}
                    else {}
                ),
                **(
                    {'font_size_char_box': font_size, 'font_size_char_box_method': font_method}
                    if font_size_calculation_method == 'ocr_aligned' and font_debug.get('accepted')
                    else {}
                ),
            })
            page_debug_items.append({
                'source_block_index': source_index,
                'font_size_debug': font_debug,
                'lines': matched_lines,
                'char_boxes': char_boxes,
            })
        pages[page_name] = page_items
        debug_pages[page_name] = page_debug_items
        if on_page: on_page(len(pages), len(align_pages))

    measure = {'pages': pages}
    if font_size_calculation_method == 'char_box':
        measure['font_size_calculation_method'] = 'char_box'
        measure['font_size_calculation_settings'] = {
            'default_font_size': round(float(default_font_size), 1),
            'font_size_step': round(float(font_size_step), 1),
        }
    measure_debug = {
        'pages': pages,
        'font_size': debug_pages,
        'block': block_map,
        'line': line_trans_map,
        'align': aligned_box_map,
    }
    if font_size_calculation_method == 'char_box':
        measure_debug['font_size_calculation_method'] = 'char_box'
    return measure, measure_debug


def _align_item_by_source_index(items: list[dict]) -> dict[int, dict]:
    result = {}
    for fallback_index, item in enumerate(items):
        source_index = int(item.get('source_block_index', fallback_index))
        result[source_index] = item
    return result


def _label_box_for_measure_item(measure_item: dict) -> list[int]:
    xyxy = measure_item.get('xyxy_pixel')
    if isinstance(xyxy, list) and len(xyxy) == 4:
        return [int(round(v)) for v in xyxy]
    return [0, 0, 0, 0]


def _single_text_size(text: str, font_scale: float) -> tuple[int, int, int]:
    font = cv2.FONT_HERSHEY_SIMPLEX
    (text_w, text_h), baseline = cv2.getTextSize(text, font, font_scale, 1)
    return text_w, text_h + baseline, baseline


def _fit_label_origin(
    box: list[int],
    canvas_shape: tuple[int, int] | tuple[int, int, int],
    text_w: int,
    text_h: int,
) -> tuple[int, int]:
    img_h, img_w = canvas_shape[:2]
    x1, y1, x2, y2 = box
    pad = 5
    # Prefer outside bottom-right; if clipped, try other outside corners.
    candidates = [
        (x2 + pad, y2 + pad),
        (x2 + pad, y1 - text_h - pad),
        (x1 - text_w - pad, y2 + pad),
        (x1 - text_w - pad, y1 - text_h - pad),
    ]
    for x, y in candidates:
        if 1 <= x and x + text_w <= img_w - 1 and 1 <= y and y + text_h <= img_h - 1:
            return int(round(x)), int(round(y))

    x = max(1, min(int(round(x2 + pad)), img_w - text_w - 1))
    y = max(1, min(int(round(y2 + pad)), img_h - text_h - 1))
    return x, y


def _draw_black_text(
    canvas: np.ndarray,
    text: str,
    origin: tuple[int, int],
    font_scale: float,
) -> None:
    font = cv2.FONT_HERSHEY_SIMPLEX
    cv2.putText(canvas, text, origin, font, font_scale, (0, 0, 0), 1, cv2.LINE_AA)


def _draw_measure_block_labels(
    canvas: np.ndarray,
    measure_items: list[dict],
    align_items: list[dict],
) -> np.ndarray:
    if not measure_items:
        return canvas

    font_scale = max(0.36, min(0.52, canvas.shape[1] / 1700))
    for item in measure_items:
        orientation = str(item.get('orientation', 'vertical'))
        font_size = item.get('font_size', 0)
        suffix = 'H' if orientation == 'horizontal' else 'V'
        text = f'{int(round(float(font_size)))}{suffix}'
        text_w, text_h, baseline = _single_text_size(text, font_scale)
        box = _label_box_for_measure_item(item)
        x, y = _fit_label_origin(box, canvas.shape, text_w, text_h)
        pad = 3
        cv2.rectangle(
            canvas,
            (x - pad, y - pad),
            (x + text_w + pad, y + text_h + pad),
            (255, 255, 255),
            -1,
        )
        _draw_black_text(canvas, text, (x, y + text_h - baseline), font_scale)
    return canvas


def _draw_paragraph_font_size_markers(
    canvas: np.ndarray,
    measure_items: list[dict],
    render_scale: float = 1.0,
    draw_label: bool = True,
) -> np.ndarray:
    if not measure_items:
        return canvas

    height, width = canvas.shape[:2]
    font_scale = max(0.42, min(0.62, canvas.shape[1] / 1900))
    font_face = cv2.FONT_HERSHEY_SIMPLEX
    marker_color = (0, 210, 255)
    fill_color = (210, 250, 255)
    text_color = (0, 0, 0)
    thickness = max(1, int(round(render_scale)))
    for item in measure_items:
        box = _label_box_for_measure_item(item)
        x1, y1, x2, y2 = [int(round(value * render_scale)) for value in box]
        x1 = max(0, min(x1, width - 1))
        y1 = max(0, min(y1, height - 1))
        x2 = max(x1 + 1, min(x2, width))
        y2 = max(y1 + 1, min(y2, height))
        font_size = int(round(float(item.get('font_size') or 0)))
        if font_size <= 0:
            continue

        side = max(12, int(round(font_size * render_scale)))
        marker_x2 = min(width, x2)
        marker_x1 = max(0, marker_x2 - side)
        marker_y1 = max(0, y1)
        marker_y2 = min(height, marker_y1 + side)
        if marker_y2 - marker_y1 < side and marker_y2 == height:
            marker_y1 = max(0, marker_y2 - side)
        if marker_x2 <= marker_x1 or marker_y2 <= marker_y1:
            continue

        roi = canvas[marker_y1:marker_y2, marker_x1:marker_x2]
        if roi.size:
            fill = np.full_like(roi, fill_color, dtype=np.uint8)
            cv2.addWeighted(fill, 0.55, roi, 0.45, 0, roi)
        cv2.rectangle(canvas, (marker_x1, marker_y1), (marker_x2 - 1, marker_y2 - 1), marker_color, thickness, cv2.LINE_AA)

        if not draw_label:
            continue
        text = f'FS{font_size}'
        (text_w, text_h), baseline = cv2.getTextSize(text, font_face, font_scale, 1)
        label_x = marker_x1 + max(0, (side - text_w) // 2)
        label_y = marker_y1 - 4
        if label_y - text_h - baseline < 1:
            label_y = marker_y2 + text_h + 2
        if label_y + baseline >= height:
            label_y = marker_y1 + text_h + 2
        label_x = max(1, min(label_x, width - text_w - 1))
        cv2.rectangle(
            canvas,
            (label_x - 2, label_y - text_h - 2),
            (label_x + text_w + 2, label_y + baseline + 2),
            (255, 255, 255),
            -1,
        )
        cv2.putText(canvas, text, (label_x, label_y), font_face, font_scale, text_color, 1, cv2.LINE_AA)
    return canvas


def _center_marker_color(item: dict) -> tuple[int, int, int]:
    debug = item.get('layout_debug', {})
    if not debug.get('accepted'):
        return (0, 0, 0)
    center_mode = debug.get('resolved_center_mode', debug.get('center_mode'))
    if center_mode == 'outer':
        return (255, 0, 0)
    if center_mode == 'inner':
        return (0, 165, 255)
    if center_mode == 'average':
        return (0, 255, 0)
    return (0, 255, 0)


def _center_xy_for_align_item(item: dict) -> tuple[int, int]:
    xyxy = item.get('final_xyxy_pixel') or item.get('new_xyxy_pixel')
    if isinstance(xyxy, list) and len(xyxy) == 4:
        x1, y1, x2, y2 = [float(v) for v in xyxy]
        return int(round((x1 + x2) / 2)), int(round((y1 + y2) / 2))

    x = float(item.get('x', 0))
    y = float(item.get('y', 0))
    w = float(item.get('w', 0))
    h = float(item.get('h', 0))
    return int(round(x + w / 2)), int(round(y + h / 2))


def _draw_measure_center_blocks(
    canvas: np.ndarray,
    measure_items: list[dict],
    align_items: list[dict],
) -> np.ndarray:
    align_by_source = _align_item_by_source_index(align_items)
    height, width = canvas.shape[:2]
    for measure_item in measure_items:
        source_index = int(measure_item.get('source_block_index', -1))
        align_item = align_by_source.get(source_index)
        if align_item is None:
            continue
        cx, cy = _center_xy_for_align_item(align_item)
        side = max(4, int(round(float(measure_item.get('font_size') or 0))))
        half = side / 2
        x1 = max(0, int(round(cx - half)))
        y1 = max(0, int(round(cy - half)))
        x2 = min(width - 1, int(round(cx + half)))
        y2 = min(height - 1, int(round(cy + half)))
        cv2.rectangle(canvas, (x1, y1), (x2, y2), _center_marker_color(align_item), -1)
    return canvas


def _empty_preview_masks(shape: tuple[int, int]) -> dict[str, np.ndarray]:
    return {
        'smoothed_mask': np.zeros(shape, dtype=np.uint8),
        'outer_body_mask': np.zeros(shape, dtype=np.uint8),
    }


def _preview_masks_from_items(
    aligned_items: list[dict],
    image_shape: tuple[int, int],
) -> tuple[list[np.ndarray], list[np.ndarray], list[bool]]:
    smoothed_masks = []
    outer_body_masks = []
    accepted = []
    for item in aligned_items:
        preview_masks = item.get('_preview_masks') or _empty_preview_masks(image_shape)
        smoothed_masks.append(preview_masks.get('smoothed_mask', np.zeros(image_shape, dtype=np.uint8)))
        outer_body_masks.append(preview_masks.get('outer_body_mask', np.zeros(image_shape, dtype=np.uint8)))
        accepted.append(bool(item.get('layout_debug', {}).get('accepted')))
    return smoothed_masks, outer_body_masks, accepted


def _write_align_masks(
    path: str,
    aligned_items: list[dict],
    image_shape: tuple[int, int],
) -> None:
    smoothed_masks, outer_body_masks, accepted = _preview_masks_from_items(
        aligned_items,
        image_shape,
    )
    if smoothed_masks:
        smoothed_array = np.stack(smoothed_masks).astype(np.uint8)
        outer_array = np.stack(outer_body_masks).astype(np.uint8)
    else:
        height, width = image_shape
        smoothed_array = np.zeros((0, height, width), dtype=np.uint8)
        outer_array = np.zeros((0, height, width), dtype=np.uint8)

    os.makedirs(osp.dirname(path), exist_ok=True)
    np.savez_compressed(
        path,
        smoothed_masks=smoothed_array,
        outer_body_masks=outer_array,
        accepted=np.asarray(accepted, dtype=np.bool_),
    )


def _load_preview_masks(
    path: str,
    count: int,
    image_shape: tuple[int, int],
) -> list[dict[str, np.ndarray]]:
    if not osp.isfile(path):
        return [_empty_preview_masks(image_shape) for _ in range(count)]

    with np.load(path) as data:
        outer_body_masks = data.get('outer_body_masks')
        smoothed_masks = data.get('smoothed_masks')
        result = []
        for index in range(count):
            result.append({
                'smoothed_mask': (
                    smoothed_masks[index]
                    if smoothed_masks is not None and index < len(smoothed_masks)
                    else np.zeros(image_shape, dtype=np.uint8)
                ),
                'outer_body_mask': (
                    outer_body_masks[index]
                    if outer_body_masks is not None and index < len(outer_body_masks)
                    else np.zeros(image_shape, dtype=np.uint8)
                ),
            })
        return result


def _draw_aligned_boxes_from_masks(
    img: np.ndarray,
    align_items: list[dict],
    preview_masks: list[dict[str, np.ndarray]],
) -> np.ndarray:
    items = []
    for index, item in enumerate(align_items):
        draw_item = dict(item)
        draw_item['_preview_masks'] = (
            preview_masks[index]
            if index < len(preview_masks)
            else _empty_preview_masks(img.shape[:2])
        )
        items.append(draw_item)
    return _draw_aligned_boxes(img, items)


def _write_measure_previews(
    img_dir: str,
    paths: dict[str, str],
    line_trans_map: dict,
    aligned_box_map: dict,
    measure_map: dict,
) -> None:
    align_pages = aligned_box_map.get('transMap', {})
    measure_pages = measure_map.get('pages', {})

    for page_name, measure_items in tqdm(measure_pages.items(), desc='measure preview'):
        img = imread(_image_path_for_page(img_dir, page_name))
        align_items = align_pages.get(page_name, [])
        preview_masks = _load_preview_masks(
            _align_mask_path_for_page(paths, page_name),
            len(align_items),
            img.shape[:2],
        )
        center_img = _draw_aligned_boxes_from_masks(img, align_items, preview_masks)
        canvas = center_img.copy()
        canvas = _draw_measure_center_blocks(
            canvas,
            measure_items,
            align_items,
        )
        canvas = _draw_measure_block_labels(
            canvas,
            measure_items,
            align_items,
        )
        imwrite(osp.join(paths['measure_preview'], f'{Path(page_name).stem}.png'), canvas)


def _write_measure_wh_previews(
    img_dir: str,
    paths: dict[str, str],
    line_trans_map: dict,
    measure_map: dict,
) -> None:
    line_pages = line_trans_map.get('transMap', {})
    measure_pages = measure_map.get('pages', {})

    for page_name in tqdm(measure_pages.keys(), desc='measure W/H preview'):
        img = imread(_image_path_for_page(img_dir, page_name))
        mask = imread(_mask_path_for_page(paths, page_name), cv2.IMREAD_GRAYSCALE)
        canvas = _draw_line_width_measurements(
            img,
            line_pages.get(page_name, []),
            mask,
            thin_text=True,
            draw_text_background=False,
            render_scale=2.0,
            text_color=(0, 150, 0),
            stroke_scale=1.0,
            char_box_measurements=True,
            char_box_text_thickness=1,
            char_box_text_line_type=cv2.LINE_AA,
            char_box_text_background=True,
            char_box_text_scale_ratio=0.62,
        )
        canvas = _draw_paragraph_font_size_markers(
            canvas,
            measure_pages.get(page_name, []),
            render_scale=2.0,
            draw_label=True,
        )
        imwrite(osp.join(paths['measure_wh_preview'], f'{Path(page_name).stem}.png'), canvas)


def _write_line_trans_previews(
    img_dir: str,
    paths: dict[str, str],
    line_trans_map: dict,
) -> None:
    line_pages = line_trans_map.get('transMap', {})
    for page_name, line_items in tqdm(line_pages.items(), desc='line trans preview'):
        img = imread(_image_path_for_page(img_dir, page_name))
        mask = imread(_mask_path_for_page(paths, page_name), cv2.IMREAD_GRAYSCALE)
        canvas = _draw_line_width_measurements(img, line_items, mask)
        imwrite(osp.join(paths['line_trans_box'], f'{Path(page_name).stem}.png'), canvas)


def _parse_color_string(color_str: str) -> tuple[int, int, int]:
    value = color_str.strip()
    if value.startswith('#'):
        value = value[1:]

    if len(value) == 6 and ',' not in value:
        try:
            return tuple(int(value[index:index + 2], 16) for index in (0, 2, 4))
        except ValueError:
            pass

    parts = value.split(',')
    if len(parts) == 3:
        try:
            rgb = tuple(int(part.strip()) for part in parts)
            if all(0 <= channel <= 255 for channel in rgb):
                return rgb
        except ValueError:
            pass

    raise ValueError(f'顏色格式錯誤：{color_str}，請使用 "#ff00ff" 或 "255,0,255"')


def _alpha_from_mask(mask: np.ndarray, opacity: float) -> np.ndarray:
    if len(mask.shape) == 3:
        mask_gray = cv2.cvtColor(mask[:, :, :3], cv2.COLOR_BGR2GRAY)
    else:
        mask_gray = mask
    return np.clip(mask_gray.astype(np.float32) * opacity, 0, 255).astype(np.uint8)


def _dilate_mask(mask: np.ndarray, size: int) -> np.ndarray:
    if size <= 1:
        return mask
    if size % 2 == 0:
        size += 1
    kernel = np.ones((size, size), dtype=np.uint8)
    return cv2.dilate(mask, kernel, iterations=1)


def _block_zone_from_items(
    block_items: list[dict],
    image_shape: tuple[int, int],
    padding: int = 0,
) -> np.ndarray:
    height, width = image_shape[:2]
    zone = np.zeros((height, width), dtype=np.uint8)
    pad = max(0, int(padding))
    for box in _block_boxes_from_items(block_items):
        x1, y1, x2, y2 = box
        x1 = max(0, x1 - pad)
        y1 = max(0, y1 - pad)
        x2 = min(width, x2 + pad)
        y2 = min(height, y2 + pad)
        if x2 > x1 and y2 > y1:
            zone[y1:y2, x1:x2] = 255
    return zone


def _split_text_mask_by_blocks(
    mask: np.ndarray,
    block_items: list[dict],
) -> tuple[np.ndarray, np.ndarray]:
    text_mask = np.where(mask > 0, 255, 0).astype(np.uint8)
    block_zone = _block_zone_from_items(block_items, mask.shape[:2])
    block_mask = cv2.bitwise_and(text_mask, block_zone)
    other_mask = cv2.bitwise_and(text_mask, cv2.bitwise_not(block_zone))
    return block_mask, other_mask


def _write_split_mask_images(
    paths: dict[str, str],
    page_names: list[str],
    block_map: dict,
) -> None:
    block_pages = block_map.get('blockMap', {})
    for page_name in tqdm(page_names, desc='split masks'):
        mask_path = _mask_path_for_page(paths, page_name)
        if not osp.isfile(mask_path):
            raise FileNotFoundError(f'找不到文字 mask：{mask_path}')
        mask = imread(mask_path, cv2.IMREAD_GRAYSCALE)
        if mask is None:
            raise FileNotFoundError(f'無法讀取文字 mask：{mask_path}')

        block_mask, other_mask = _split_text_mask_by_blocks(
            mask,
            block_pages.get(page_name, []),
        )
        imwrite(_block_mask_path_for_page(paths, page_name), block_mask)
        imwrite(_other_mask_path_for_page(paths, page_name), other_mask)


def _write_only_text_images(
    img_dir: str,
    paths: dict[str, str],
    page_names: list[str],
    color_rgb: tuple[int, int, int],
    opacity: float,
) -> None:
    for page_name in tqdm(page_names, desc='only text'):
        mask_path = _mask_path_for_page(paths, page_name)
        if not osp.isfile(mask_path):
            raise FileNotFoundError(f'找不到文字 mask：{mask_path}')
        mask = imread(mask_path, cv2.IMREAD_GRAYSCALE)
        if mask is None:
            raise FileNotFoundError(f'無法讀取文字 mask：{mask_path}')

        alpha = _alpha_from_mask(mask, opacity)
        output = np.zeros((mask.shape[0], mask.shape[1], 4), dtype=np.uint8)
        text_zone = alpha > 0
        output[text_zone, 0] = color_rgb[2]
        output[text_zone, 1] = color_rgb[1]
        output[text_zone, 2] = color_rgb[0]
        output[:, :, 3] = alpha
        imwrite(_only_text_path_for_page(paths, page_name), output)


def _write_inpainted_images(
    img_dir: str,
    paths: dict[str, str],
    page_names: list[str],
    block_map: dict,
    radius: int = INPAINT_RADIUS,
    mask_expansion: int = INPAINT_MASK_EXPANSION,
) -> None:
    radius = max(1, int(radius))
    mask_expansion = max(1, int(mask_expansion))
    block_pages = block_map.get('blockMap', {})
    for page_name in tqdm(page_names, desc='inpainted'):
        img = imread(_image_path_for_page(img_dir, page_name), cv2.IMREAD_UNCHANGED)
        if img is None:
            raise FileNotFoundError(f'找不到原圖：{page_name}')

        mask_path = _mask_path_for_page(paths, page_name)
        if not osp.isfile(mask_path):
            raise FileNotFoundError(f'找不到文字 mask：{mask_path}')
        mask = imread(mask_path, cv2.IMREAD_GRAYSCALE)
        if mask is None:
            raise FileNotFoundError(f'無法讀取文字 mask：{mask_path}')

        text_mask = np.where(mask > 0, 255, 0).astype(np.uint8)
        block_zone = _block_zone_from_items(
            block_pages.get(page_name, []),
            mask.shape[:2],
            padding=mask_expansion,
        )
        inpaint_mask = cv2.bitwise_and(text_mask, block_zone)
        inpaint_mask = _dilate_mask(inpaint_mask, mask_expansion)
        if len(img.shape) == 2:
            color_img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
        else:
            color_img = img[:, :, :3]

        inpainted_bgr = cv2.inpaint(color_img, inpaint_mask, radius, cv2.INPAINT_TELEA)
        inpainted = cv2.cvtColor(inpainted_bgr, cv2.COLOR_BGR2BGRA)
        inpainted[:, :, 3] = inpaint_mask
        inpainted[inpaint_mask == 0, :3] = 0
        imwrite(_inpainted_path_for_page(paths, page_name), inpainted)


def _align_pages(
    img_dir: str,
    paths: dict[str, str],
    block_map: dict,
    save_center_preview: bool = False,
    need_neck: bool = True,
    on_page=None,
) -> tuple[dict, dict]:
    aligned_map = {}
    summary = {
        'pages': 0,
        'boxes': 0,
        'accepted': 0,
        'using_deal_overlap': 0,
        'ignored_unmodified_deal_overlap': 0,
        'neck_pages': 0,
        'neck_guides': 0,
        'neck_shared_pages': 0,
        'neck_no_guide_groups': 0,
        'overlap_pages': 0,
        'final_overlap_pages': 0,
        'shared_without_guide_pages': 0,
        'deal_overlap_final_overlap_pages': 0,
        'copied': 0,
    }

    pages = block_map.get('blockMap', {})
    for page_name, block_items in tqdm(pages.items(), desc='重定位'):
        img_path = _image_path_for_page(img_dir, page_name)
        mask_path = _mask_path_for_page(paths, page_name)
        if not osp.isfile(mask_path):
            raise FileNotFoundError(f'找不到 mask：{mask_path}')

        img = imread(img_path)
        mask = imread(mask_path)
        overlap_path = _deal_overlap_path_for_page(paths, page_name)
        overlap_img = imread(overlap_path) if need_neck and osp.exists(overlap_path) else None
        overlap_modified = need_neck and _image_modified(img, overlap_img)
        if overlap_modified:
            calc_img = overlap_img
            summary['using_deal_overlap'] += 1
        else:
            calc_img = img
            if need_neck and overlap_img is not None:
                summary['ignored_unmodified_deal_overlap'] += 1

        block_boxes = _block_boxes_from_items(block_items)
        calc_gray, _ = _prepare_align_gray(calc_img, mask, base_img=img)
        aligned_items = _align_block_boxes(
            calc_img,
            mask,
            block_boxes,
            base_img=img,
            prepared_gray=calc_gray,
        )
        neck_summary = {
            'page': page_name,
            'generated': False,
            'groups': [],
        }
        if not need_neck:
            neck_summary_path = _neck_summary_path_for_page(paths, page_name)
            _remove_generated_neck_image(_neck_path_for_page(paths, page_name))
            _write_json(neck_summary_path, {
                'page': page_name,
                'generated': False,
                'skipped_reason': 'need_neck_false',
                'groups': [],
            })
        elif not overlap_modified:
            neck_path = _neck_path_for_page(paths, page_name)
            neck_summary_path = _neck_summary_path_for_page(paths, page_name)
            aligned_items, neck_summary = _align_concavity_blocks(
                img, mask, block_boxes, aligned_items, calc_gray,
                neck_path, neck_summary_path, page_name,
            )
            if neck_summary.get('groups'):
                summary['neck_shared_pages'] += 1
                summary['neck_no_guide_groups'] += sum(
                    not group.get('guides') for group in neck_summary['groups'])
            if neck_summary['generated']:
                summary['neck_pages'] += 1
                summary['neck_guides'] += sum(
                    len(group.get('guides', [])) for group in neck_summary['groups'])
        else:
            neck_summary_path = _neck_summary_path_for_page(paths, page_name)
            _remove_generated_neck_image(_neck_path_for_page(paths, page_name))
            _write_json(neck_summary_path, {
                'page': page_name,
                'generated': False,
                'skipped_reason': 'modified_deal_overlap',
                'groups': [],
            })

        overlap_indices = _final_overlap_indices(aligned_items)
        aligned_items = _mark_overlap_error_route(aligned_items, overlap_indices, img.shape[:2])
        clean_items = _clean_aligned_items(aligned_items)
        aligned_map[page_name] = clean_items
        _write_align_masks(
            _align_mask_path_for_page(paths, page_name),
            aligned_items,
            img.shape[:2],
        )

        final_boxes_overlap = bool(overlap_indices)
        unresolved_shared_without_guide = any(
            not group.get('guides')
            for group in neck_summary.get('groups', [])
        )
        if final_boxes_overlap or unresolved_shared_without_guide:
            summary['overlap_pages'] += 1
        if final_boxes_overlap:
            summary['final_overlap_pages'] += 1
        if unresolved_shared_without_guide:
            summary['shared_without_guide_pages'] += 1

        if need_neck and final_boxes_overlap:
            summary['deal_overlap_final_overlap_pages'] += 1
            helper_status = _ensure_deal_overlap_image(img_path, overlap_path)
            if helper_status == 'copied':
                summary['copied'] += 1

        if save_center_preview:
            center_img = _draw_aligned_boxes(img, aligned_items)
            imwrite(osp.join(paths['center'], f'{Path(page_name).stem}.png'), center_img)

        summary['pages'] += 1
        summary['boxes'] += len(clean_items)
        summary['accepted'] += sum(1 for item in clean_items if item.get('accepted'))
        if on_page: on_page(summary['pages'], len(pages))

    return {'transMap': aligned_map}, summary


def _detect_pages(
    img_dir: str,
    model_path: str,
    device: str | None,
    paths: dict[str, str],
    save_line_trans_preview: bool = False,
    on_page=None,
) -> tuple[dict, dict]:
    if device is None:
        device = 'cuda' if torch.cuda.is_available() else 'cpu'

    imglist = find_all_imgs(img_dir, abs_path=True)
    if not imglist:
        print(f'資料夾內沒有可處理的圖片：{img_dir}')
        return {'blockMap': {}}, {'transMap': {}}

    print(f'資料夾：{img_dir}')
    print(f'輸出：{paths["ctd"]}')
    print(f'模型：{model_path}')
    print(f'裝置：{device}')
    print(f'圖片數量：{len(imglist)}')

    detector = TextDetector(model_path=model_path, input_size=1024, device=device, act='leaky')
    block_map = {}
    line_trans_map = {}

    for img_path in tqdm(imglist, desc='偵測中'):
        imgname = osp.basename(img_path)
        page_key = imgname
        imname = Path(imgname).stem
        img = imread(img_path)
        im_h, im_w = img.shape[:2]

        _, mask_refined, blk_list = detector(
            img,
            refine_mode=REFINEMASK_ANNOTATION,
            keep_undetected_mask=True,
        )

        polys = []
        block_boxes = []
        for blk in blk_list:
            polys += blk.lines
            block_boxes.append([int(x) for x in blk.xyxy])

        block_map[page_key] = [
            _block_item_from_xyxy(box, im_w, im_h, index)
            for index, box in enumerate(block_boxes)
        ]

        component_boxes = _find_component_boxes(mask_refined, polys)
        percentile_items = _shrink_line_polygons(
            mask_refined,
            polys,
            percentile_low=SHRINK_PERCENTILE_LOW,
            percentile_high=SHRINK_PERCENTILE_HIGH,
            padding=SHRINK_PERCENTILE_PADDING,
            method='percentile',
        )
        line_trans_items = _shrink_line_polygons(
            mask_refined,
            polys,
            padding=SHRINK_PERCENTILE_PADDING,
            component_boxes=component_boxes,
            method='line_trans_component',
            fallback_items=percentile_items,
        )
        line_trans_map[page_key] = line_trans_items

        imwrite(osp.join(paths['mask'], f'{imname}.png'), mask_refined)
        if save_line_trans_preview:
            line_trans_img = _draw_line_width_measurements(img, line_trans_items, mask_refined)
            imwrite(osp.join(paths['line_trans_box'], f'{imname}.png'), line_trans_img)
        if on_page: on_page(len(block_map), len(imglist))

    return {'blockMap': block_map}, {'transMap': line_trans_map}


def run(
    img_dir: str,
    model_path: str,
    device: str | None = None,
    only_align: bool = False,
    only_measure_wh_preview: bool = False,
    need_neck: bool = True,
    save_line_trans_preview: bool = False,
    save_center_preview: bool = False,
    only_text_color: tuple[int, int, int] = ONLY_TEXT_COLOR,
    only_text_opacity: float = ONLY_TEXT_OPACITY,
    inpaint_radius: int = INPAINT_RADIUS,
    inpaint_mask_expansion: int = INPAINT_MASK_EXPANSION,
) -> int:
    img_dir = osp.abspath(img_dir)
    if not osp.isdir(img_dir):
        raise FileNotFoundError(f'找不到資料夾：{img_dir}')

    ctd_dir = osp.join(img_dir, CTD_DIR)
    paths = _ensure_dirs(ctd_dir)
    block_map_path = osp.join(paths['progressing'], BLOCK_MAP_JSON)
    line_trans_map_path = osp.join(paths['progressing'], LINE_TRANS_MAP_JSON)
    aligned_box_map_path = osp.join(paths['progressing'], ALIGNED_BOX_MAP_JSON)
    measure_path = osp.join(ctd_dir, MEASURE_JSON)
    measure_debug_path = osp.join(ctd_dir, MEASURE_DEBUG_JSON)

    if only_measure_wh_preview:
        if not osp.isfile(block_map_path):
            raise FileNotFoundError(f'--only-measure-wh-preview 需要既有 block map：{block_map_path}')
        if not osp.isfile(line_trans_map_path):
            raise FileNotFoundError(f'--only-measure-wh-preview 需要既有 line trans map：{line_trans_map_path}')
        if not osp.isfile(aligned_box_map_path):
            raise FileNotFoundError(f'--only-measure-wh-preview 需要既有 aligned box map：{aligned_box_map_path}')
        block_map = _load_json(block_map_path)
        line_trans_map = _load_json(line_trans_map_path)
        aligned_box_map = _load_json(aligned_box_map_path)
        measure_map, measure_debug_map = _build_measure_maps(
            img_dir,
            paths,
            block_map,
            line_trans_map,
            aligned_box_map,
        )
        _write_json(measure_path, measure_map)
        _write_json(measure_debug_path, measure_debug_map)
        print(f'重新計算 measure 並輸出 measure preview：{img_dir}')
        _write_measure_previews(img_dir, paths, line_trans_map, aligned_box_map, measure_map)
        _write_measure_wh_previews(img_dir, paths, line_trans_map, measure_map)
        print('完成。輸出：')
        print(f'  - {measure_path}')
        print(f'  - {measure_debug_path}')
        print(f'  - {paths["measure_preview"]}/<檔名>.png')
        print(f'  - {paths["measure_wh_preview"]}/<檔名>.png')
        return len(measure_map.get('pages', {}))

    if only_align:
        if not osp.isfile(block_map_path):
            raise FileNotFoundError(f'--only-align 需要既有 block map：{block_map_path}')
        if not osp.isfile(line_trans_map_path):
            raise FileNotFoundError(f'--only-align 需要既有 line trans map：{line_trans_map_path}')
        block_map = _load_json(block_map_path)
        line_trans_map = _load_json(line_trans_map_path)
        print(f'只重定位：{img_dir}')
        if save_line_trans_preview:
            _write_line_trans_previews(img_dir, paths, line_trans_map)
    else:
        model_path = osp.abspath(model_path)
        if not osp.isfile(model_path):
            raise FileNotFoundError(f'找不到模型檔：{model_path}')
        block_map, line_trans_map = _detect_pages(
            img_dir,
            model_path,
            device,
            paths,
            save_line_trans_preview=save_line_trans_preview,
        )
        _write_json(block_map_path, block_map)
        _write_json(line_trans_map_path, line_trans_map)

    aligned_box_map, align_summary = _align_pages(
        img_dir,
        paths,
        block_map,
        save_center_preview=save_center_preview,
        need_neck=need_neck,
    )
    _write_json(aligned_box_map_path, aligned_box_map)
    measure_map, measure_debug_map = _build_measure_maps(
        img_dir,
        paths,
        block_map,
        line_trans_map,
        aligned_box_map,
    )
    _write_json(measure_path, measure_map)
    _write_json(measure_debug_path, measure_debug_map)
    _write_measure_previews(img_dir, paths, line_trans_map, aligned_box_map, measure_map)
    _write_measure_wh_previews(img_dir, paths, line_trans_map, measure_map)
    _write_split_mask_images(
        paths,
        list(measure_map.get('pages', {}).keys()),
        block_map,
    )
    _write_only_text_images(
        img_dir,
        paths,
        list(measure_map.get('pages', {}).keys()),
        only_text_color,
        only_text_opacity,
    )
    _write_inpainted_images(
        img_dir,
        paths,
        list(measure_map.get('pages', {}).keys()),
        block_map,
        inpaint_radius,
        inpaint_mask_expansion,
    )

    print('完成。輸出：')
    print(f'  - {block_map_path}')
    if not only_align:
        print(f'  - {line_trans_map_path}')
        print(f'  - {paths["mask"]}/<檔名>.png')
        print(f'  - {paths["block_mask"]}/<檔名>.png')
        print(f'  - {paths["other_mask"]}/<檔名>.png')
        if save_line_trans_preview:
            print(f'  - {paths["line_trans_box"]}/<檔名>.png')
    print(f'  - {aligned_box_map_path}')
    print(f'  - {paths["align_masks"]}/<檔名>.npz')
    print(f'  - {measure_path}')
    print(f'  - {measure_debug_path}')
    if save_center_preview:
        print(f'  - {paths["center"]}/<檔名>.png')
    if need_neck:
        print(f'  - {paths["neck"]}/<檔名>.png')
    print(f'  - {paths["measure_preview"]}/<檔名>.png')
    print(f'  - {paths["measure_wh_preview"]}/<檔名>.png')
    print(f'  - {paths["only_text"]}/<檔名>.png')
    print(f'  - {paths["inpainted"]}/<檔名>.png')
    if need_neck:
        print(f'  - {paths["deal_overlap"]}/<檔名>.png')
    print(f"重定位頁數：{align_summary['pages']}")
    print(f"重定位 block 數：{align_summary['boxes']}")
    print(f"accepted：{align_summary['accepted']}")
    print(f"need_neck：{need_neck}")
    print(f"使用 deal_overlap 計算頁數：{align_summary['using_deal_overlap']}")
    print(f"忽略未修改 deal_overlap 頁數：{align_summary['ignored_unmodified_deal_overlap']}")
    print(f"neck shared 頁數：{align_summary['neck_shared_pages']}")
    print(f"neck 自動切割頁數：{align_summary['neck_pages']}")
    print(f"neck guide 數：{align_summary['neck_guides']}")
    print(f"neck 無 guide group 數：{align_summary['neck_no_guide_groups']}")
    print(f"偵測到重疊頁數：{align_summary['overlap_pages']}")
    print(f"final box 重疊頁數：{align_summary['final_overlap_pages']}")
    print(f"shared 無 guide 頁數：{align_summary['shared_without_guide_pages']}")
    print(f"deal_overlap final 重疊頁數：{align_summary['deal_overlap_final_overlap_pages']}")
    print(f"新複製到 deal_overlap：{align_summary['copied']}")
    return align_summary['pages']


def main() -> None:
    default_model = osp.join(osp.dirname(__file__), 'data', 'comictextdetector.pt')
    parser = argparse.ArgumentParser(
        description='精簡版漫畫文字偵測與 center 重定位輸出。',
    )
    parser.add_argument('img_dir', help='輸入圖片資料夾路徑')
    parser.add_argument(
        '--model',
        default=default_model,
        help=f'模型路徑（預設：{default_model}）',
    )
    parser.add_argument(
        '--device',
        choices=['cpu', 'cuda'],
        default=None,
        help='推理裝置（預設：有 GPU 則用 cuda，否則 cpu）',
    )
    parser.add_argument(
        '--only-align',
        action='store_true',
        help='不跑模型，只讀 ctd/block_map.json 和 ctd/mask/ 重新生成對齊結果。',
    )
    parser.add_argument(
        '--only-measure-wh-preview',
        action='store_true',
        help='只讀既有 maps 和 mask，重新計算 measure.json 並輸出 measure_preview/measure_wh_preview。',
    )
    parser.add_argument(
        '--need-neck',
        dest='need_neck',
        type=_parse_bool,
        default=True,
        help='是否啟用新凹口分割、鏡像補全與 deal_overlap helper（預設：true）。',
    )
    parser.add_argument(
        '--save-line-trans-preview',
        action='store_true',
        help='額外輸出 ctd/progressing/line-trans-box/<檔名>.png。',
    )
    parser.add_argument(
        '--save-center-preview',
        action='store_true',
        help='額外輸出 ctd/progressing/align/center/<檔名>.png。',
    )
    parser.add_argument(
        '--only-text-color',
        default=','.join(str(value) for value in ONLY_TEXT_COLOR),
        help='純字圖顏色，支援 "#ff00ff" 或 "255,0,255"。',
    )
    parser.add_argument(
        '--only-text-opacity',
        type=float,
        default=ONLY_TEXT_OPACITY,
        help='純字圖透明度，0.0 到 1.0。',
    )
    parser.add_argument(
        '--inpaint-radius',
        type=int,
        default=INPAINT_RADIUS,
        help='inpainted 預覽的周圍顏色填補半徑。',
    )
    parser.add_argument(
        '--inpaint-mask-expansion',
        type=int,
        default=INPAINT_MASK_EXPANSION,
        help='inpainted 預覽先把 mask 向外擴張的像素核大小。',
    )
    args = parser.parse_args()
    only_text_color = _parse_color_string(args.only_text_color)

    run(
        img_dir=args.img_dir,
        model_path=args.model,
        device=args.device,
        only_align=args.only_align,
        only_measure_wh_preview=args.only_measure_wh_preview,
        need_neck=args.need_neck,
        save_line_trans_preview=args.save_line_trans_preview,
        save_center_preview=args.save_center_preview,
        only_text_color=only_text_color,
        only_text_opacity=args.only_text_opacity,
        inpaint_radius=args.inpaint_radius,
        inpaint_mask_expansion=args.inpaint_mask_expansion,
    )
