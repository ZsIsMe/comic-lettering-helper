#!/usr/bin/env python3
"""對指定資料夾內的漫畫圖片執行文字偵測，並在該資料夾下的 ctd 子資料夾輸出結果。"""

import argparse
import json
import os
import os.path as osp
import shutil
import sys
from pathlib import Path

import cv2
import numpy as np
import torch
from tqdm import tqdm

from prelayout_core.vendor.inference import TextDetector
from prelayout_core.vendor.utils.imgproc_utils import get_yololabel_strings, xyxy2yolo
from prelayout_core.vendor.utils.io_utils import NumpyEncoder, find_all_imgs, imread, imwrite
from prelayout_core.vendor.utils.textmask import REFINEMASK_ANNOTATION

from prelayout_core.vendor.layout_core import apply_safety_rules as _core_apply_safety_rules
from prelayout_core.vendor.layout_core import calculate_layout as _core_calculate_layout
from prelayout_core.vendor.preview_draw import draw_item_preview as _core_draw_item_preview

BLOCK_BOX_DIR = 'block-box'
LINE_BOX_DIR = 'line-box'
LINE_TRANS_BOX_DIR = 'line-trans-box'
ALIGNED_BOX_DIR = 'aligned-box'
CENTER_DIR = 'center'
DEAL_OVERLAP_DIR = 'deal_overlap'
BLOCK_BOX_COLOR = (0, 255, 0)      # 綠色：文字區塊
LINE_BOX_COLOR = (0, 128, 255)     # 橘色：文字行
LINE_TRANS_BOX_COLOR = (255, 0, 255)  # 洋紅色：line + trans 混合結果
LINE_WIDTH_MEASURE_COLOR = (255, 235, 0)  # 青色：接近水平尺寸測量卡尺
LINE_HEIGHT_MEASURE_COLOR = (0, 165, 255)  # 橘色：接近垂直尺寸測量卡尺
LINE_WIDTH_TEXT_COLOR = (0, 255, 255)  # 黃色：尺寸像素數字
LINE_HEIGHT_TEXT_SCALE_RATIO = 0.5
LINE_HEIGHT_CALIPER_GAP = 4.0
LINE_HEIGHT_LABEL_GAP = 8.0
LINE_MEASURE_THIN_TEXT_SCALE_RATIO = 2.0
CHAR_MEASURE_BOX_COLOR = (150, 235, 150)
CHAR_MEASURE_BOX_OUTLINE_COLOR = (60, 220, 60)
CHAR_MEASURE_BOX_ALPHA = 0.36
CHAR_MEASURE_BOX_TEXT_SCALE_RATIO = 0.38
ALIGNED_BOX_COLOR = (255, 255, 0)  # 青色：氣泡對齊後的文字區塊
ALIGN_MASK_COLOR = (179, 255, 255)  # 淡黃色：候選氣泡區域

COMPONENT_MASK_THRESHOLD = 10
COMPONENT_KERNEL_RATIO = 0.4
COMPONENT_KERNEL_MIN = 3
COMPONENT_KERNEL_MAX = 15
COMPONENT_MIN_LONG_SIDE = 50
COMPONENT_MIN_BOX_AREA = 120
COMPONENT_SPLIT_VALLEY_RATIO = 0.12
COMPONENT_SPLIT_MIN_GAP = 3
SHRINK_LINE_MASK_THRESHOLD = 10
SHRINK_LINE_MIN_PIXELS = 8
SHRINK_LINE_PADDING = 1.0
SHRINK_LINE_AXIS_SNAP_DEGREES = 10
SHRINK_PERCENTILE_LOW = 2
SHRINK_PERCENTILE_HIGH = 98
SHRINK_PERCENTILE_PADDING = 0.0
SHRINK_TRANS_MAX_COMPONENT_WIDTH_RATIO = 1.35
SHRINK_TRANS_MAX_COMPONENT_HEIGHT_RATIO = 1.35
SHRINK_TRANS_MAX_COMPONENT_AREA_RATIO = 1.8
SHRINK_TRANS_MIN_COMPONENT_COVERAGE = 0.5
SHRINK_TRANS_MIN_LINE_COVERAGE = 0.08
CHAR_MEASURE_TARGET_RATIO = 1.12
CHAR_MEASURE_SPLIT_RATIO = 1.6
CHAR_MEASURE_INK_RATIO = 0.025
CHAR_MEASURE_INTERNAL_GAP_RATIO = 0.18
CHAR_MEASURE_COMPLETE_RATIO = 0.72
CHAR_MEASURE_MIN_SEGMENT_RATIO = 0.30
CHAR_MEASURE_VALLEY_SEARCH_RATIO = 0.36
CHAR_MEASURE_VALLEY_RATIO = 0.12
CHAR_MEASURE_INK_TARGET_MIN_RATIO = 0.45
CHAR_MEASURE_INK_TARGET_MAX_RATIO = 1.15
CHAR_MEASURE_LANE_INK_RATIO = 0.08
CHAR_MEASURE_RUBY_LANE_WIDTH_RATIO = 0.55
CHAR_MEASURE_RUBY_LANE_PIXEL_RATIO = 0.35
CHAR_MEASURE_MAIN_LANE_PADDING = 1.0
ALIGN_MASK_DILATE_SIZE = 9
ALIGN_FLOOD_DIFF = 28
ALIGN_MASK_SMOOTH_RADIUS = 7
ALIGN_MAX_MOVE_PX = 150
ALIGN_MAX_IMAGE_AREA_RATIO = 0.35
ALIGN_MAX_OLD_AREA_RATIO = 40.0
ALIGN_MAX_OUTER_INNER_AREA_RATIO = 4.0
ALIGN_BLOCK_BG_COLOR = (0, 0, 0)
ALIGN_BLOCK_BG_ALPHA = 0.18
ALIGN_MANUAL_DIFF_THRESHOLD = 24
ALIGN_MANUAL_PROTECT_DILATE_SIZE = 5


def _box_line_width(height: int, width: int) -> int:
    return max(2, min(height, width) // 400)


def _mask_to_bgr(mask: np.ndarray) -> np.ndarray:
    if len(mask.shape) == 2:
        return cv2.cvtColor(mask, cv2.COLOR_GRAY2BGR)
    return mask.copy()


def _preview_base_image(img: np.ndarray) -> np.ndarray:
    preview = img[:, :, :3].copy() if len(img.shape) == 3 else cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    if preview.shape[2] == 4:
        preview = preview[:, :, :3]
    return preview


def _overlay_mask(
    preview: np.ndarray,
    mask: np.ndarray | None,
    color: tuple[int, int, int],
    alpha: float,
) -> None:
    if mask is None:
        return
    active = mask > 0
    if not np.any(active):
        return
    color_layer = np.zeros_like(preview, dtype=np.uint8)
    color_layer[active] = color
    blended = (
        preview.astype(np.float32) * (1.0 - alpha)
        + color_layer.astype(np.float32) * alpha
    ).astype(np.uint8)
    preview[active] = blended[active]


def _overlay_rect(
    preview: np.ndarray,
    box: list[int] | tuple[int, int, int, int],
    color: tuple[int, int, int],
    alpha: float,
) -> None:
    height, width = preview.shape[:2]
    x1, y1, x2, y2 = _clip_xyxy(box, width, height)
    if x2 <= x1 or y2 <= y1:
        return
    region = preview[y1:y2, x1:x2]
    color_layer = np.full_like(region, color, dtype=np.uint8)
    preview[y1:y2, x1:x2] = (
        region.astype(np.float32) * (1.0 - alpha)
        + color_layer.astype(np.float32) * alpha
    ).astype(np.uint8)


def _draw_rect_boxes(
    mask: np.ndarray,
    boxes: list[list[int]],
    color: tuple[int, int, int],
) -> np.ndarray:
    canvas = _mask_to_bgr(mask)
    if not boxes:
        return canvas

    line_width = _box_line_width(canvas.shape[0], canvas.shape[1])
    for x1, y1, x2, y2 in boxes:
        cv2.rectangle(canvas, (x1, y1), (x2, y2), color, line_width)
    return canvas


def _draw_dashed_line(
    img: np.ndarray,
    pt1: tuple[int, int],
    pt2: tuple[int, int],
    color: tuple[int, int, int],
    thickness: int = 2,
    dash_length: int = 14,
    gap_length: int = 8,
) -> None:
    x1, y1 = pt1
    x2, y2 = pt2
    length = float(np.hypot(x2 - x1, y2 - y1))
    if length == 0:
        return
    dx = (x2 - x1) / length
    dy = (y2 - y1) / length
    distance = 0.0
    while distance < length:
        start = distance
        end = min(distance + dash_length, length)
        p1 = (int(round(x1 + dx * start)), int(round(y1 + dy * start)))
        p2 = (int(round(x1 + dx * end)), int(round(y1 + dy * end)))
        cv2.line(img, p1, p2, color, thickness, cv2.LINE_AA)
        distance += dash_length + gap_length


def _draw_dashed_rect(
    img: np.ndarray,
    x1: int,
    y1: int,
    x2: int,
    y2: int,
    color: tuple[int, int, int],
    thickness: int = 2,
) -> None:
    _draw_dashed_line(img, (x1, y1), (x2, y1), color, thickness)
    _draw_dashed_line(img, (x2, y1), (x2, y2), color, thickness)
    _draw_dashed_line(img, (x2, y2), (x1, y2), color, thickness)
    _draw_dashed_line(img, (x1, y2), (x1, y1), color, thickness)


def _draw_rect_from_dict(
    img: np.ndarray,
    rect: dict | None,
    color: tuple[int, int, int],
    dashed: bool = False,
) -> None:
    if not rect:
        return
    x1 = int(rect['left'])
    y1 = int(rect['top'])
    x2 = int(rect['left'] + rect['width'])
    y2 = int(rect['top'] + rect['height'])
    if dashed:
        _draw_dashed_rect(img, x1, y1, x2, y2, color, thickness=2)
    else:
        cv2.rectangle(img, (x1, y1), (x2, y2), color, 2)


def _draw_rect_xyxy_with_center(
    img: np.ndarray,
    xyxy: list[int] | tuple[int, int, int, int],
    color: tuple[int, int, int],
    center_color: tuple[int, int, int] | None = None,
) -> None:
    center_color = center_color or color
    x1, y1, x2, y2 = [int(v) for v in xyxy]
    cv2.rectangle(img, (x1, y1), (x2, y2), color, 2)
    cx = int(round((x1 + x2) / 2))
    cy = int(round((y1 + y2) / 2))
    cv2.drawMarker(img, (cx, cy), center_color, markerType=cv2.MARKER_CROSS, markerSize=18, thickness=2)


def _draw_line_polygons(
    mask: np.ndarray,
    polys: list | np.ndarray,
    color: tuple[int, int, int],
) -> np.ndarray:
    canvas = _mask_to_bgr(mask)
    if len(polys) == 0:
        return canvas

    line_width = _box_line_width(canvas.shape[0], canvas.shape[1])
    polys_arr = np.array(polys, dtype=np.int32).reshape(-1, 4, 2)
    cv2.polylines(canvas, polys_arr, isClosed=True, color=color, thickness=line_width)
    return canvas


def _polygon_to_xywh(poly: np.ndarray) -> dict:
    x_min, y_min = poly.min(axis=0)
    x_max, y_max = poly.max(axis=0)
    return {
        'x': int(x_min),
        'y': int(y_min),
        'w': int(x_max - x_min + 1),
        'h': int(y_max - y_min + 1),
    }


def _polygon_short_edge_width(poly: np.ndarray) -> float:
    pts = np.asarray(poly, dtype=np.float64).reshape(4, 2)
    lengths = [
        float(np.linalg.norm(pts[(i + 1) % 4] - pts[i]))
        for i in range(4)
    ]
    return min((lengths[0] + lengths[2]) / 2.0, (lengths[1] + lengths[3]) / 2.0)


def _box_to_rect(box: dict) -> tuple[int, int, int, int]:
    return box['x'], box['y'], box['x'] + box['w'], box['y'] + box['h']


def _rect_intersection_area(
    rect_a: tuple[int, int, int, int],
    rect_b: tuple[int, int, int, int],
) -> int:
    x1 = max(rect_a[0], rect_b[0])
    y1 = max(rect_a[1], rect_b[1])
    x2 = min(rect_a[2], rect_b[2])
    y2 = min(rect_a[3], rect_b[3])
    return max(0, x2 - x1) * max(0, y2 - y1)


def _rect_area_xyxy(box: list[int] | tuple[int, int, int, int]) -> int:
    return max(0, int(box[2]) - int(box[0])) * max(0, int(box[3]) - int(box[1]))


def _rects_overlap_xyxy(
    box_a: list[int] | tuple[int, int, int, int],
    box_b: list[int] | tuple[int, int, int, int],
) -> bool:
    return _rect_intersection_area(tuple(box_a), tuple(box_b)) > 0


def _dict_rect_to_xyxy(rect: dict) -> list[int]:
    return [
        int(rect['left']),
        int(rect['top']),
        int(rect['left'] + rect['width']),
        int(rect['top'] + rect['height']),
    ]


def _final_boxes_overlap(aligned_items: list[dict], min_ratio: float = 0.05) -> bool:
    boxes = []
    for item in aligned_items:
        final_box = item.get('final_xyxy_pixel')
        if final_box is None:
            x1, y1 = int(item['x']), int(item['y'])
            final_box = [x1, y1, x1 + int(item['w']), y1 + int(item['h'])]
        boxes.append([int(v) for v in final_box])

    for index, box_a in enumerate(boxes):
        for box_b in boxes[index + 1:]:
            if not _rects_overlap_xyxy(box_a, box_b):
                continue
            overlap_area = _rect_intersection_area(tuple(box_a), tuple(box_b))
            smaller_area = min(_rect_area_xyxy(box_a), _rect_area_xyxy(box_b))
            if smaller_area > 0 and overlap_area / smaller_area >= min_ratio:
                return True
    return False


def _outer_overlap_indices(aligned_items: list[dict]) -> set[int]:
    outer_boxes = []
    for index, item in enumerate(aligned_items):
        outer_rect = item.get('layout_debug', {}).get('outer_rect')
        if outer_rect is None:
            continue
        outer_boxes.append((index, _dict_rect_to_xyxy(outer_rect)))

    overlap_indices = set()
    for pos, (index_a, box_a) in enumerate(outer_boxes):
        for index_b, box_b in outer_boxes[pos + 1:]:
            if _rects_overlap_xyxy(box_a, box_b):
                overlap_indices.add(index_a)
                overlap_indices.add(index_b)
    return overlap_indices


def _ensure_deal_overlap_image(original_path: str, overlap_path: str) -> str:
    if osp.exists(overlap_path):
        return 'exists'
    os.makedirs(osp.dirname(overlap_path), exist_ok=True)
    shutil.copy2(original_path, overlap_path)
    return 'copied'


def _clip_xyxy(
    box: list[int] | tuple[int, int, int, int],
    width: int,
    height: int,
) -> list[int]:
    x1, y1, x2, y2 = [int(round(v)) for v in box]
    return [
        max(0, min(width - 1, x1)),
        max(0, min(height - 1, y1)),
        max(0, min(width, x2)),
        max(0, min(height, y2)),
    ]


def _xyxy_to_item(box: list[int], method: str, accepted: bool, index: int) -> dict:
    x1, y1, x2, y2 = box
    return {
        'x': int(x1),
        'y': int(y1),
        'w': int(max(0, x2 - x1)),
        'h': int(max(0, y2 - y1)),
        'area': int(_rect_area_xyxy(box)),
        'method': method,
        'accepted': accepted,
        'source_block_index': index,
    }


def _matched_component_mask(
    image_shape: tuple[int, int],
    poly: np.ndarray,
    component_boxes: dict[str, list[dict]] | list[dict],
) -> tuple[np.ndarray | None, int]:
    candidates = _component_candidates_for_polygon(poly, component_boxes)
    if not candidates:
        return None, 0

    line_box = _polygon_to_xywh(poly.astype(np.int32))
    line_rect = _box_to_rect(line_box)
    line_area = max(1, line_box['w'] * line_box['h'])
    matched_mask = np.zeros(image_shape[:2], dtype=np.uint8)
    matched_count = 0

    for component in candidates:
        component_rect = _box_to_rect(component)
        component_area = max(1, component['w'] * component['h'])
        intersection_area = _rect_intersection_area(line_rect, component_rect)
        if intersection_area <= 0:
            continue

        if component['w'] > line_box['w'] * SHRINK_TRANS_MAX_COMPONENT_WIDTH_RATIO:
            continue
        if component['h'] > line_box['h'] * SHRINK_TRANS_MAX_COMPONENT_HEIGHT_RATIO:
            continue
        if component_area > line_area * SHRINK_TRANS_MAX_COMPONENT_AREA_RATIO:
            continue

        component_coverage = intersection_area / component_area
        line_coverage = intersection_area / line_area
        if (
            component_coverage < SHRINK_TRANS_MIN_COMPONENT_COVERAGE
            and line_coverage < SHRINK_TRANS_MIN_LINE_COVERAGE
        ):
            continue

        x1, y1, x2, y2 = component_rect
        matched_mask[y1:y2, x1:x2] = 1
        matched_count += 1

    if matched_count == 0:
        return None, 0
    return matched_mask, matched_count


def _polygon_orientation(poly: np.ndarray) -> str:
    points = np.asarray(poly, dtype=np.float64).reshape(4, 2)
    edges = [points[(index + 1) % 4] - points[index] for index in range(4)]
    lengths = [float(np.linalg.norm(edge)) for edge in edges]
    long_index = int(np.argmax(lengths))
    long_edge = edges[long_index]
    return 'horizontal' if abs(long_edge[0]) >= abs(long_edge[1]) else 'vertical'


def _component_candidates_for_polygon(
    poly: np.ndarray,
    component_boxes: dict[str, list[dict]] | list[dict],
) -> list[dict]:
    if isinstance(component_boxes, dict):
        return component_boxes.get(_polygon_orientation(poly), [])
    return component_boxes


def _polygon_axes(poly: np.ndarray) -> tuple[np.ndarray, np.ndarray, bool] | None:
    p0, p1, p2, p3 = poly.astype(np.float64)
    u_vec = ((p1 - p0) + (p2 - p3)) / 2
    v_vec = ((p3 - p0) + (p2 - p1)) / 2
    u_norm = np.linalg.norm(u_vec)
    v_norm = np.linalg.norm(v_vec)
    if u_norm < 1e-6 or v_norm < 1e-6:
        return None

    u_axis = u_vec / u_norm
    v_axis = v_vec / v_norm
    snap_limit = np.sin(np.deg2rad(SHRINK_LINE_AXIS_SNAP_DEGREES))
    is_near_u_horizontal = abs(u_axis[1]) <= snap_limit
    is_near_v_vertical = abs(v_axis[0]) <= snap_limit
    if is_near_u_horizontal and is_near_v_vertical:
        u_axis = np.array([1.0 if u_axis[0] >= 0 else -1.0, 0.0])
        v_axis = np.array([0.0, 1.0 if v_axis[1] >= 0 else -1.0])
        return u_axis, v_axis, True

    return u_axis, v_axis, False


def _shrink_line_polygon(
    mask: np.ndarray,
    poly: np.ndarray,
    *,
    percentile_low: float = 0,
    percentile_high: float = 100,
    padding: float = SHRINK_LINE_PADDING,
    component_boxes: list[dict] | None = None,
    method: str = 'minmax',
) -> dict | None:
    axes = _polygon_axes(poly)
    if axes is None:
        return None
    u_axis, v_axis, axis_snapped = axes

    if len(mask.shape) == 3:
        mask = cv2.cvtColor(mask, cv2.COLOR_BGR2GRAY)
    poly = poly.astype(np.int32)

    poly_mask = np.zeros(mask.shape[:2], dtype=np.uint8)
    cv2.fillPoly(poly_mask, [poly], 1)
    text_mask = (mask > SHRINK_LINE_MASK_THRESHOLD) & (poly_mask > 0)
    matched_component_count = 0
    if component_boxes is not None:
        component_mask, matched_component_count = _matched_component_mask(
            mask.shape[:2],
            poly,
            component_boxes,
        )
        if component_mask is None:
            return None
        text_mask &= component_mask > 0

    ys, xs = np.where(text_mask)
    if len(xs) < SHRINK_LINE_MIN_PIXELS:
        return None

    origin = poly.astype(np.float64)[0]
    pixels = np.stack([xs, ys], axis=1).astype(np.float64)
    rel_pixels = pixels - origin
    rel_poly = poly.astype(np.float64) - origin

    pixel_u = rel_pixels @ u_axis
    pixel_v = rel_pixels @ v_axis
    poly_u = rel_poly @ u_axis
    poly_v = rel_poly @ v_axis

    u_low = np.percentile(pixel_u, percentile_low)
    u_high = np.percentile(pixel_u, percentile_high)
    v_low = np.percentile(pixel_v, percentile_low)
    v_high = np.percentile(pixel_v, percentile_high)
    u_min = max(u_low - padding, poly_u.min())
    u_max = min(u_high + padding, poly_u.max())
    v_min = max(v_low - padding, poly_v.min())
    v_max = min(v_high + padding, poly_v.max())
    if u_max <= u_min or v_max <= v_min:
        return None

    shrunk_poly = np.array(
        [
            origin + u_axis * u_min + v_axis * v_min,
            origin + u_axis * u_max + v_axis * v_min,
            origin + u_axis * u_max + v_axis * v_max,
            origin + u_axis * u_min + v_axis * v_max,
        ],
        dtype=np.float64,
    )
    height, width = mask.shape[:2]
    shrunk_poly[:, 0] = np.clip(np.round(shrunk_poly[:, 0]), 0, width - 1)
    shrunk_poly[:, 1] = np.clip(np.round(shrunk_poly[:, 1]), 0, height - 1)
    shrunk_poly = shrunk_poly.astype(np.int32)

    xywh = _polygon_to_xywh(shrunk_poly)
    font_width = _polygon_short_edge_width(shrunk_poly)
    return {
        **xywh,
        'area': int(len(xs)),
        'font_size_proxy_px': int(min(xywh['w'], xywh['h'])),
        'font_width_px': round(font_width, 2),
        'axis_snapped': axis_snapped,
        'method': method,
        'matched_component_count': matched_component_count,
        'polygon': shrunk_poly.tolist(),
    }


def _shrink_line_polygons(
    mask: np.ndarray,
    polys: list | np.ndarray,
    *,
    percentile_low: float = 0,
    percentile_high: float = 100,
    padding: float = SHRINK_LINE_PADDING,
    component_boxes: dict[str, list[dict]] | list[dict] | None = None,
    method: str = 'minmax',
    fallback_items: list[dict] | None = None,
) -> list[dict]:
    if len(polys) == 0:
        return []

    line_polys = np.array(polys, dtype=np.int32).reshape(-1, 4, 2)
    shrunk_items = []
    fallback_by_index = {}
    if fallback_items is not None:
        fallback_by_index = {
            item['source_line_index']: item
            for item in fallback_items
            if 'source_line_index' in item
        }
    for idx, poly in enumerate(line_polys):
        items = []
        if component_boxes is None:
            item = _shrink_line_polygon(
                mask,
                poly,
                percentile_low=percentile_low,
                percentile_high=percentile_high,
                padding=padding,
                method=method,
            )
            if item is not None:
                items.append(item)
        else:
            # A detector polygon may cover a whole paragraph. Process every
            # orientation-aware row/column component independently so adjacent
            # horizontal rows or vertical columns cannot be fused back together.
            for component in _component_candidates_for_polygon(poly, component_boxes):
                item = _shrink_line_polygon(
                    mask,
                    poly,
                    percentile_low=percentile_low,
                    percentile_high=percentile_high,
                    padding=padding,
                    component_boxes=[component],
                    method=method,
                )
                if item is not None:
                    items.append(item)

        if not items and idx in fallback_by_index:
            item = dict(fallback_by_index[idx])
            item['method'] = f'{method}_fallback'
            item['matched_component_count'] = 0
            items.append(item)

        for item in items:
            item['source_line_index'] = idx
            shrunk_items.append(item)

    unique_items = []
    seen_polygons = set()
    for item in shrunk_items:
        polygon_key = tuple(value for point in item.get('polygon', []) for value in point)
        if polygon_key and polygon_key in seen_polygons:
            continue
        if polygon_key:
            seen_polygons.add(polygon_key)
        unique_items.append(item)
    unique_items.sort(key=lambda item: (item['x'], item['y']))
    return unique_items


def _draw_shrink_line_polygons(
    mask: np.ndarray,
    shrunk_items: list[dict],
    color: tuple[int, int, int] = LINE_TRANS_BOX_COLOR,
) -> np.ndarray:
    canvas = _mask_to_bgr(mask)
    if not shrunk_items:
        return canvas

    line_width = _box_line_width(canvas.shape[0], canvas.shape[1])
    polys = np.array([item['polygon'] for item in shrunk_items], dtype=np.int32)
    cv2.polylines(canvas, polys, isClosed=True, color=color, thickness=line_width)
    return canvas


def _top_short_edge_measure(poly: list | np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, float] | None:
    pts = np.asarray(poly, dtype=np.float64).reshape(4, 2)
    edges = []
    for idx in range(4):
        start = pts[idx]
        end = pts[(idx + 1) % 4]
        length = float(np.linalg.norm(end - start))
        edges.append((idx, start, end, length))

    pair_a = (edges[0][3] + edges[2][3]) / 2.0
    pair_b = (edges[1][3] + edges[3][3]) / 2.0
    short_indices = (0, 2) if pair_a <= pair_b else (1, 3)
    _, start, end, _ = min(
        (edges[idx] for idx in short_indices),
        key=lambda edge: ((edge[1][1] + edge[2][1]) / 2.0, (edge[1][0] + edge[2][0]) / 2.0),
    )

    direction = end - start
    norm = np.linalg.norm(direction)
    if norm < 1:
        return None

    short_axis = direction / norm
    normal = np.array([-short_axis[1], short_axis[0]], dtype=np.float64)
    if normal[1] > 0:
        normal = -normal
    width = (edges[short_indices[0]][3] + edges[short_indices[1]][3]) / 2.0
    return start, end, normal, width


def _edge_pair_dimension_measurements(
    poly: list | np.ndarray,
) -> list[tuple[str, np.ndarray, np.ndarray, np.ndarray, float]]:
    pts = np.asarray(poly, dtype=np.float64).reshape(4, 2)
    edges = []
    for idx in range(4):
        start = pts[idx]
        end = pts[(idx + 1) % 4]
        direction = end - start
        length = float(np.linalg.norm(direction))
        if length < 1:
            return []
        edges.append((idx, start, end, direction, length))

    measurements = []
    for pair in ((0, 2), (1, 3)):
        pair_edges = [edges[pair[0]], edges[pair[1]]]
        _, start, end, direction, _ = min(
            pair_edges,
            key=lambda edge: ((edge[1][1] + edge[2][1]) / 2.0, (edge[1][0] + edge[2][0]) / 2.0),
        )
        axis = direction / np.linalg.norm(direction)
        normal = np.array([-axis[1], axis[0]], dtype=np.float64)
        if normal[1] > 0:
            normal = -normal
        label = 'W' if abs(direction[0]) >= abs(direction[1]) else 'H'
        width = (pair_edges[0][4] + pair_edges[1][4]) / 2.0
        measurements.append((label, start, end, normal, width))
    return measurements


def _line_measure_axes(poly: list | np.ndarray) -> dict | None:
    pts = np.asarray(poly, dtype=np.float64).reshape(4, 2)
    edges = []
    for idx in range(4):
        start = pts[idx]
        end = pts[(idx + 1) % 4]
        direction = end - start
        length = float(np.linalg.norm(direction))
        if length < 1:
            return None
        edges.append((idx, start, end, direction, length))

    pair_a = (edges[0][4] + edges[2][4]) / 2.0
    pair_b = (edges[1][4] + edges[3][4]) / 2.0
    long_pair = (0, 2) if pair_a >= pair_b else (1, 3)
    short_pair = (1, 3) if long_pair == (0, 2) else (0, 2)

    long_edges = [edges[long_pair[0]], edges[long_pair[1]]]
    short_edges = [edges[short_pair[0]], edges[short_pair[1]]]
    _, long_start, long_end, long_direction, _ = min(
        long_edges,
        key=lambda edge: ((edge[1][1] + edge[2][1]) / 2.0, (edge[1][0] + edge[2][0]) / 2.0),
    )
    _, short_start, short_end, short_direction, _ = min(
        short_edges,
        key=lambda edge: ((edge[1][1] + edge[2][1]) / 2.0, (edge[1][0] + edge[2][0]) / 2.0),
    )

    long_axis = long_direction / np.linalg.norm(long_direction)
    short_axis = short_direction / np.linalg.norm(short_direction)
    long_normal = np.array([-long_axis[1], long_axis[0]], dtype=np.float64)
    short_normal = np.array([-short_axis[1], short_axis[0]], dtype=np.float64)
    if long_normal[1] > 0:
        long_normal = -long_normal
    if short_normal[1] > 0:
        short_normal = -short_normal

    long_length = (long_edges[0][4] + long_edges[1][4]) / 2.0
    short_length = (short_edges[0][4] + short_edges[1][4]) / 2.0
    orientation = 'horizontal' if abs(long_direction[0]) >= abs(long_direction[1]) else 'vertical'
    return {
        'origin': pts[0],
        'long_axis': long_axis,
        'short_axis': short_axis,
        'long_start': long_start,
        'long_end': long_end,
        'long_normal': long_normal,
        'long_length': long_length,
        'short_start': short_start,
        'short_end': short_end,
        'short_normal': short_normal,
        'short_length': short_length,
        'orientation': orientation,
    }


def _projection_segments(
    projection: np.ndarray,
    threshold: int,
) -> list[tuple[int, int]]:
    active = projection > threshold
    segments = []
    start = None
    for idx, is_active in enumerate(active):
        if is_active and start is None:
            start = idx
        elif not is_active and start is not None:
            segments.append((start, idx))
            start = None
    if start is not None:
        segments.append((start, len(active)))
    return [(seg_start, seg_end) for seg_start, seg_end in segments if seg_end > seg_start]


def _split_projection_segment_by_valleys(
    projection: np.ndarray,
    start: int,
    end: int,
    target_size: float,
) -> list[tuple[int, int]]:
    length = end - start
    if target_size <= 1 or length <= target_size * CHAR_MEASURE_COMPLETE_RATIO:
        return [(start, end)]

    count = max(1, int(round(length / target_size)))
    if count <= 1:
        return [(start, end)]

    local_projection = projection[start:end]
    peak = int(local_projection.max()) if local_projection.size else 0
    if peak <= 0:
        return [(start, end)]

    min_piece = max(3, int(round(target_size * CHAR_MEASURE_MIN_SEGMENT_RATIO)))
    if length < min_piece * count:
        return [(start, end)]

    window = max(2, int(round(target_size * CHAR_MEASURE_VALLEY_SEARCH_RATIO)))
    step = length / count
    cuts = []
    found_deep_valley = False
    previous_cut = start
    for idx in range(1, count):
        expected = int(round(start + step * idx))
        remaining = count - idx
        lo = max(start + min_piece, previous_cut + min_piece, expected - window)
        hi = min(end - min_piece * remaining, expected + window + 1)
        if hi <= lo:
            cut = max(previous_cut + min_piece, min(expected, end - min_piece * remaining))
        else:
            search = projection[lo:hi]
            valley_offset = int(np.argmin(search))
            cut = lo + valley_offset
            if int(search[valley_offset]) <= max(1, int(round(peak * CHAR_MEASURE_VALLEY_RATIO))):
                found_deep_valley = True
        cuts.append(cut)
        previous_cut = cut

    if not found_deep_valley and length <= target_size * CHAR_MEASURE_SPLIT_RATIO:
        return [(start, end)]

    bounds = [start] + cuts + [end]
    return [
        (seg_start, seg_end)
        for seg_start, seg_end in zip(bounds, bounds[1:])
        if seg_end - seg_start >= 2
    ]


def _target_size_from_ink_segments(
    raw_segments: list[tuple[int, int]],
    fallback_size: float,
) -> float:
    lengths = [float(seg_end - seg_start) for seg_start, seg_end in raw_segments if seg_end > seg_start]
    if not lengths or fallback_size <= 1:
        return fallback_size

    lower_bound = fallback_size * CHAR_MEASURE_INK_TARGET_MIN_RATIO
    upper_bound = fallback_size * CHAR_MEASURE_INK_TARGET_MAX_RATIO
    major_lengths = [length for length in lengths if lower_bound <= length <= upper_bound]
    if not major_lengths:
        return fallback_size

    major_lengths.sort()
    return float(major_lengths[len(major_lengths) // 2])


def _short_axis_lanes(
    short_values: np.ndarray,
    fallback_target_size: float,
) -> list[dict[str, float]]:
    if short_values.size == 0:
        return []

    short_min = float(short_values.min())
    short_max = float(short_values.max()) + 1.0
    bins = max(1, int(np.ceil(short_max - short_min)))
    bin_indices = np.clip(np.floor(short_values - short_min).astype(np.int32), 0, bins - 1)
    projection = np.bincount(bin_indices, minlength=bins).astype(np.int32)
    peak = int(projection.max()) if projection.size else 0
    if peak <= 0:
        return []

    threshold = max(1, int(round(peak * CHAR_MEASURE_LANE_INK_RATIO)))
    segments = _projection_segments(projection, threshold)
    if not segments:
        return []

    merge_gap = max(1, int(round(fallback_target_size * 0.06)))
    merged_segments = []
    for seg_start, seg_end in segments:
        if not merged_segments:
            merged_segments.append([seg_start, seg_end])
            continue
        gap = seg_start - merged_segments[-1][1]
        if gap <= merge_gap:
            merged_segments[-1][1] = seg_end
        else:
            merged_segments.append([seg_start, seg_end])

    lanes = []
    for seg_start, seg_end in merged_segments:
        pixels = int(projection[seg_start:seg_end].sum())
        width = float(seg_end - seg_start)
        lanes.append({
            'start': short_min + float(seg_start),
            'end': short_min + float(seg_end),
            'width': width,
            'pixels': float(pixels),
        })
    return lanes


def _main_text_lane_mask(
    short_values: np.ndarray,
    lanes: list[dict[str, float]],
) -> np.ndarray:
    keep_all = np.ones(short_values.shape, dtype=np.bool_)
    if short_values.size == 0 or len(lanes) < 2:
        return keep_all

    main_lane = max(lanes, key=lambda lane: (lane['width'], lane['pixels']))
    other_lanes = [lane for lane in lanes if lane is not main_lane]
    if not other_lanes:
        return keep_all

    ruby_lanes = [
        lane
        for lane in other_lanes
        if (
            lane['width'] <= main_lane['width'] * CHAR_MEASURE_RUBY_LANE_WIDTH_RATIO
            or lane['pixels'] <= main_lane['pixels'] * CHAR_MEASURE_RUBY_LANE_PIXEL_RATIO
        )
    ]
    if len(ruby_lanes) != len(other_lanes):
        return keep_all

    lane_start = main_lane['start'] - CHAR_MEASURE_MAIN_LANE_PADDING
    lane_end = main_lane['end'] + CHAR_MEASURE_MAIN_LANE_PADDING
    lane_mask = (short_values >= lane_start) & (short_values < lane_end)
    if int(np.count_nonzero(lane_mask)) < SHRINK_LINE_MIN_PIXELS:
        return keep_all

    return lane_mask


def _char_measurements_from_line_mask(
    mask: np.ndarray,
    poly: list | np.ndarray,
) -> tuple[dict | None, list[dict]]:
    axes = _line_measure_axes(poly)
    if axes is None:
        return None, []

    if len(mask.shape) == 3:
        mask = cv2.cvtColor(mask, cv2.COLOR_BGR2GRAY)
    poly_arr = np.asarray(poly, dtype=np.int32).reshape(4, 2)
    poly_mask = np.zeros(mask.shape[:2], dtype=np.uint8)
    cv2.fillPoly(poly_mask, [poly_arr], 1)
    text_mask = (mask > SHRINK_LINE_MASK_THRESHOLD) & (poly_mask > 0)
    ys, xs = np.where(text_mask)
    if len(xs) == 0:
        return axes, []

    points = np.stack([xs, ys], axis=1).astype(np.float64)
    rel_points = points - axes['origin']
    long_values = rel_points @ axes['long_axis']
    short_values = rel_points @ axes['short_axis']
    fallback_target_size = max(1.0, float(axes['short_length']) * CHAR_MEASURE_TARGET_RATIO)

    lanes = _short_axis_lanes(short_values, fallback_target_size)
    lane_mask = _main_text_lane_mask(short_values, lanes)
    if not np.all(lane_mask):
        points = points[lane_mask]
        long_values = long_values[lane_mask]
        short_values = short_values[lane_mask]
        if points.size == 0:
            return axes, []

    long_min = float(long_values.min())
    long_max = float(long_values.max()) + 1.0
    short_min = float(short_values.min())
    short_max = float(short_values.max()) + 1.0

    bins = max(1, int(np.ceil(long_max - long_min)))
    bin_indices = np.clip(np.floor(long_values - long_min).astype(np.int32), 0, bins - 1)
    projection = np.bincount(bin_indices, minlength=bins).astype(np.int32)
    peak = int(projection.max()) if projection.size else 0
    if peak <= 0:
        return axes, []

    threshold = max(1, int(round(peak * CHAR_MEASURE_INK_RATIO)))
    raw_segments = _projection_segments(projection, threshold)
    if not raw_segments:
        return axes, []

    target_size = _target_size_from_ink_segments(raw_segments, fallback_target_size)
    max_internal_gap = max(2, int(round(target_size * CHAR_MEASURE_INTERNAL_GAP_RATIO)))
    active_segments = []
    current_start, current_end = raw_segments[0]
    for seg_start, seg_end in raw_segments[1:]:
        gap = seg_start - current_end
        current_span = current_end - current_start
        current_complete = current_span >= target_size * CHAR_MEASURE_COMPLETE_RATIO
        if current_complete and gap > max_internal_gap:
            active_segments.append((current_start, current_end))
            current_start, current_end = seg_start, seg_end
        else:
            current_end = seg_end
    active_segments.append((current_start, current_end))

    split_segments = []
    for seg_start, seg_end in active_segments:
        split_segments.extend(
            _split_projection_segment_by_valleys(
                projection,
                seg_start,
                seg_end,
                target_size,
            ),
        )
    if not split_segments:
        split_segments = active_segments

    value_segments = [
        (long_min + seg_start, long_min + seg_end)
        for seg_start, seg_end in split_segments
    ]

    measurements = []
    for seg_start, seg_end in value_segments:
        in_segment = (long_values >= seg_start) & (long_values < seg_end)
        if not np.any(in_segment):
            continue
        seg_points = points[in_segment]
        seg_long = long_values[in_segment]
        seg_short = short_values[in_segment]
        x1, y1 = seg_points.min(axis=0)
        x2, y2 = seg_points.max(axis=0)
        axis_width = float(seg_long.max() - seg_long.min() + 1.0)
        axis_height = float(seg_short.max() - seg_short.min() + 1.0)
        image_width = float(x2 - x1 + 1.0)
        image_height = float(y2 - y1 + 1.0)
        bbox = [int(x1), int(y1), int(x2) + 1, int(y2) + 1]
        measurements.extend([
            {
                'label': 'W',
                'value': image_width,
                'line_start': np.array([float(x1), float(y1) - LINE_HEIGHT_CALIPER_GAP], dtype=np.float64),
                'line_end': np.array([float(x2), float(y1) - LINE_HEIGHT_CALIPER_GAP], dtype=np.float64),
                'normal': np.array([0.0, -1.0], dtype=np.float64),
                'label_center': np.array(
                    [(float(x1) + float(x2)) / 2.0, float(y1) - LINE_HEIGHT_LABEL_GAP],
                    dtype=np.float64,
                ),
                'bbox': bbox,
                'axis_width': axis_width,
                'axis_height': axis_height,
            },
            {
                'label': 'H',
                'value': image_height,
                'line_start': np.array([float(x1) - LINE_HEIGHT_CALIPER_GAP, float(y1)], dtype=np.float64),
                'line_end': np.array([float(x1) - LINE_HEIGHT_CALIPER_GAP, float(y2)], dtype=np.float64),
                'normal': np.array([-1.0, 0.0], dtype=np.float64),
                'label_center': np.array(
                    [float(x1) - LINE_HEIGHT_LABEL_GAP, (float(y1) + float(y2)) / 2.0],
                    dtype=np.float64,
                ),
                'bbox': bbox,
                'axis_width': axis_width,
                'axis_height': axis_height,
            },
        ])
    return axes, measurements


def _char_boxes_from_line_mask(
    mask: np.ndarray,
    poly: list | np.ndarray,
) -> tuple[dict | None, list[dict]]:
    axes, measurements = _char_measurements_from_line_mask(mask, poly)
    if axes is None or not measurements:
        return axes, []

    grouped: dict[tuple[int, int, int, int], dict] = {}
    for measure in measurements:
        bbox = measure.get('bbox')
        label = measure.get('label')
        if bbox is None or label not in ('W', 'H'):
            continue
        key = tuple(int(value) for value in bbox)
        item = grouped.setdefault(
            key,
            {
                'bbox': [int(value) for value in bbox],
                'axis_width': float(measure.get('axis_width') or 0),
                'axis_height': float(measure.get('axis_height') or 0),
            },
        )
        if label == 'W':
            item['width'] = float(measure['value'])
        elif label == 'H':
            item['height'] = float(measure['value'])

    boxes = [
        item
        for item in grouped.values()
        if float(item.get('width') or 0) > 0 and float(item.get('height') or 0) > 0
    ]
    return axes, boxes


def _fit_measurement_annotation(
    start: np.ndarray,
    end: np.ndarray,
    normal: np.ndarray,
    image_shape: tuple[int, int] | tuple[int, int, int],
    text: str,
    font_scale: float,
    font_face: int = cv2.FONT_HERSHEY_SIMPLEX,
    stroke_scale: float = 1.0,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    height, width = image_shape[:2]
    (text_w, text_h), baseline = cv2.getTextSize(text, font_face, font_scale, 1)

    # Prefer the outside/top side; flip below the line if the label would be clipped.
    for candidate_normal in (normal, -normal):
        line_start = start + candidate_normal * 4.0 * stroke_scale
        line_end = end + candidate_normal * 4.0 * stroke_scale
        label_center = (line_start + line_end) / 2.0 + candidate_normal * 10.0 * stroke_scale
        x = label_center[0] - text_w / 2
        y_top = label_center[1] - text_h / 2
        y_bottom = label_center[1] + text_h / 2 + baseline
        if 1 <= x and x + text_w <= width - 1 and 1 <= y_top and y_bottom <= height - 1:
            return line_start, line_end, candidate_normal, label_center

    line_start = start + normal * 4.0 * stroke_scale
    line_end = end + normal * 4.0 * stroke_scale
    label_center = (line_start + line_end) / 2.0 + normal * 10.0 * stroke_scale
    return line_start, line_end, normal, label_center


def _draw_plain_measurement_text(
    canvas: np.ndarray,
    text: str,
    center: np.ndarray,
    font_scale: float,
    color: tuple[int, int, int] = (0, 0, 0),
    draw_background: bool = True,
    font_face: int = cv2.FONT_HERSHEY_SIMPLEX,
    thickness: int = 1,
    line_type: int = cv2.LINE_AA,
) -> None:
    (text_w, text_h), baseline = cv2.getTextSize(text, font_face, font_scale, thickness)
    x = int(round(center[0] - text_w / 2))
    y = int(round(center[1] + text_h / 2))
    height, width = canvas.shape[:2]
    x = max(1, min(x, width - text_w - 2))
    y = max(text_h + 1, min(y, height - baseline - 2))
    if draw_background:
        pad = 2
        cv2.rectangle(
            canvas,
            (x - pad, y - text_h - pad),
            (x + text_w + pad, y + baseline + pad),
            (255, 255, 255),
            -1,
        )
    cv2.putText(canvas, text, (x, y), font_face, font_scale, color, thickness, line_type)


def _draw_measurement_caliper(
    canvas: np.ndarray,
    line_start: np.ndarray,
    line_end: np.ndarray,
    normal: np.ndarray,
    text: str,
    font_scale: float,
    measure_color: tuple[int, int, int],
    label_center: np.ndarray | None = None,
    draw_text_background: bool = True,
    font_face: int = cv2.FONT_HERSHEY_SIMPLEX,
    text_color: tuple[int, int, int] = (0, 0, 0),
    stroke_scale: float = 1.0,
) -> None:
    if label_center is None:
        line_start, line_end, normal, label_center = _fit_measurement_annotation(
            line_start,
            line_end,
            normal,
            canvas.shape,
            text,
            font_scale,
            font_face,
            stroke_scale,
        )

    tick = 5.5 * stroke_scale
    shadow_color = (0, 0, 0)
    shadow_thickness = max(1, int(round(2 * stroke_scale)))
    measure_thickness = max(1, int(round(stroke_scale)))
    for color, thickness in ((shadow_color, shadow_thickness), (measure_color, measure_thickness)):
        cv2.line(
            canvas,
            tuple(np.round(line_start).astype(int)),
            tuple(np.round(line_end).astype(int)),
            color,
            thickness,
            cv2.LINE_AA,
        )
        for point in (line_start, line_end):
            tick_start = point - normal * tick / 2
            tick_end = point + normal * tick / 2
            cv2.line(
                canvas,
                tuple(np.round(tick_start).astype(int)),
                tuple(np.round(tick_end).astype(int)),
                color,
                thickness,
                cv2.LINE_AA,
            )
    _draw_plain_measurement_text(
        canvas,
        text,
        label_center,
        font_scale,
        color=text_color,
        draw_background=draw_text_background,
        font_face=font_face,
    )


def _draw_char_measurement_boxes(
    canvas: np.ndarray,
    measurements: list[dict],
    render_scale: float,
    font_scale: float,
    font_face: int,
    text_color: tuple[int, int, int],
    stroke_scale: float,
    text_thickness: int = 1,
    text_line_type: int = cv2.LINE_AA,
    draw_text_background: bool = False,
    text_scale_ratio: float = CHAR_MEASURE_BOX_TEXT_SCALE_RATIO,
) -> None:
    grouped: dict[tuple[int, int, int, int], dict[str, float]] = {}
    for measure in measurements:
        bbox = measure.get('bbox')
        label = measure.get('label')
        if bbox is None or label not in ('W', 'H'):
            continue
        key = tuple(int(value) for value in bbox)
        grouped.setdefault(key, {})[label] = float(measure['value'])

    height, width = canvas.shape[:2]
    label_font_scale = font_scale * text_scale_ratio
    outline_color = CHAR_MEASURE_BOX_OUTLINE_COLOR
    outline_thickness = max(1, int(round(stroke_scale)))
    for bbox, values in grouped.items():
        if 'W' not in values and 'H' not in values:
            continue

        x1, y1, x2, y2 = [int(round(value * render_scale)) for value in bbox]
        x1 = max(0, min(x1, width - 1))
        y1 = max(0, min(y1, height - 1))
        x2 = max(x1 + 1, min(x2, width))
        y2 = max(y1 + 1, min(y2, height))

        roi = canvas[y1:y2, x1:x2]
        if roi.size:
            tint = np.full_like(roi, CHAR_MEASURE_BOX_COLOR, dtype=np.uint8)
            cv2.addWeighted(tint, CHAR_MEASURE_BOX_ALPHA, roi, 1.0 - CHAR_MEASURE_BOX_ALPHA, 0, roi)
        cv2.rectangle(canvas, (x1, y1), (x2 - 1, y2 - 1), outline_color, outline_thickness, cv2.LINE_AA)

        label_parts = []
        if 'W' in values:
            label_parts.append(f'W{int(round(values["W"]))}')
        if 'H' in values:
            label_parts.append(f'H{int(round(values["H"]))}')
        text = ''.join(label_parts)
        (text_w, text_h), baseline = cv2.getTextSize(text, font_face, label_font_scale, 1)
        label_y = y1 + text_h + 1
        if y1 - baseline - 2 >= text_h:
            label_y = y1 - baseline - 2
        center = np.array(
            [
                max(text_w / 2 + 1, min((x1 + x2) / 2.0, width - text_w / 2 - 2)),
                label_y - text_h / 2.0,
            ],
            dtype=np.float64,
        )
        _draw_plain_measurement_text(
            canvas,
            text,
            center,
            label_font_scale,
            color=text_color,
            draw_background=draw_text_background,
            font_face=font_face,
            thickness=text_thickness,
            line_type=text_line_type,
        )


def _draw_line_width_measurements(
    img: np.ndarray,
    shrunk_items: list[dict],
    mask: np.ndarray | None = None,
    thin_text: bool = False,
    draw_text_background: bool | None = None,
    render_scale: float = 1.0,
    text_color: tuple[int, int, int] = (0, 0, 0),
    stroke_scale: float | None = None,
    char_box_measurements: bool = False,
    char_box_text_thickness: int = 1,
    char_box_text_line_type: int = cv2.LINE_AA,
    char_box_text_background: bool = False,
    char_box_text_scale_ratio: float = CHAR_MEASURE_BOX_TEXT_SCALE_RATIO,
) -> np.ndarray:
    if render_scale == 1.0:
        canvas = img.copy()
    else:
        canvas = cv2.resize(
            img,
            None,
            fx=render_scale,
            fy=render_scale,
            interpolation=cv2.INTER_CUBIC,
        )
    if not shrunk_items:
        return canvas

    font_scale = max(0.26, min(0.34, img.shape[1] / 2500)) * render_scale
    font_face = cv2.FONT_HERSHEY_PLAIN if thin_text else cv2.FONT_HERSHEY_SIMPLEX
    if thin_text:
        font_scale *= LINE_MEASURE_THIN_TEXT_SCALE_RATIO
    if draw_text_background is None:
        draw_text_background = not thin_text
    if stroke_scale is None:
        stroke_scale = render_scale
    for item in shrunk_items:
        poly = item.get('polygon')
        if poly is None:
            continue

        if mask is not None:
            axes, char_measurements = _char_measurements_from_line_mask(mask, poly)
            if char_box_measurements:
                if axes is not None and char_measurements:
                    _draw_char_measurement_boxes(
                        canvas,
                        char_measurements,
                        render_scale,
                        font_scale,
                        font_face,
                        text_color,
                        stroke_scale,
                        text_thickness=char_box_text_thickness,
                        text_line_type=char_box_text_line_type,
                        draw_text_background=char_box_text_background,
                        text_scale_ratio=char_box_text_scale_ratio,
                    )
                continue
            if axes is not None and char_measurements:
                for measure in char_measurements:
                    label = measure['label']
                    measure_color = LINE_WIDTH_MEASURE_COLOR if label == 'W' else LINE_HEIGHT_MEASURE_COLOR
                    _draw_measurement_caliper(
                        canvas,
                        measure['line_start'] * render_scale,
                        measure['line_end'] * render_scale,
                        measure['normal'],
                        f'{label}{int(round(measure["value"]))}',
                        font_scale * LINE_HEIGHT_TEXT_SCALE_RATIO if label == 'H' else font_scale,
                        measure_color,
                        measure['label_center'] * render_scale,
                        draw_text_background=draw_text_background and label != 'H',
                        font_face=font_face,
                        text_color=text_color,
                        stroke_scale=stroke_scale,
                    )
                continue

        for label, start, end, normal, width in _edge_pair_dimension_measurements(poly):
            if width < 3:
                continue
            text = f'{label}{int(round(width))}'
            measure_color = LINE_WIDTH_MEASURE_COLOR if label == 'W' else LINE_HEIGHT_MEASURE_COLOR
            _draw_measurement_caliper(
                canvas,
                start * render_scale,
                end * render_scale,
                normal,
                text,
                font_scale * LINE_HEIGHT_TEXT_SCALE_RATIO if label == 'H' else font_scale,
                measure_color,
                draw_text_background=draw_text_background and label != 'H',
                font_face=font_face,
                text_color=text_color,
                stroke_scale=stroke_scale,
            )

    return canvas


def _mask_to_binary(mask: np.ndarray, threshold: int = COMPONENT_MASK_THRESHOLD) -> np.ndarray:
    if len(mask.shape) == 3:
        mask = cv2.cvtColor(mask, cv2.COLOR_BGR2GRAY)
    return mask > threshold


def _compute_box_from_mask(
    component_mask: np.ndarray,
    offset_x: int = 0,
    offset_y: int = 0,
) -> dict | None:
    ys, xs = np.where(component_mask)
    if len(xs) == 0:
        return None

    x_min, x_max = int(xs.min()), int(xs.max())
    y_min, y_max = int(ys.min()), int(ys.max())
    width = x_max - x_min + 1
    height = y_max - y_min + 1
    return {
        'x': offset_x + x_min,
        'y': offset_y + y_min,
        'w': width,
        'h': height,
        'area': int(len(xs)),
        'font_size_proxy_px': width,
    }


def _component_box_is_large_enough(box: dict, orientation: str) -> bool:
    long_side = box['w'] if orientation == 'horizontal' else box['h']
    return long_side >= COMPONENT_MIN_LONG_SIDE and box['area'] >= COMPONENT_MIN_BOX_AREA


def _split_component_box_by_projection(
    box: dict,
    binary_mask: np.ndarray,
    orientation: str,
) -> list[dict]:
    x, y, w, h = box['x'], box['y'], box['w'], box['h']
    crop = binary_mask[y:y + h, x:x + w]
    if crop.size == 0:
        return [box]

    # Horizontal text is separated into rows on the Y axis; vertical text is
    # separated into columns on the X axis.
    projection_axis = 1 if orientation == 'horizontal' else 0
    projection = crop.sum(axis=projection_axis).astype(np.int32)
    peak = int(projection.max()) if projection.size > 0 else 0
    if peak <= 0:
        return [box]

    valley_threshold = max(1, int(peak * COMPONENT_SPLIT_VALLEY_RATIO))
    active = projection > valley_threshold

    segments = []
    start = None
    for idx, is_active in enumerate(active):
        if is_active and start is None:
            start = idx
        elif not is_active and start is not None:
            segments.append((start, idx))
            start = None
    if start is not None:
        segments.append((start, len(active)))

    merged_segments = []
    for seg_start, seg_end in segments:
        if not merged_segments:
            merged_segments.append([seg_start, seg_end])
            continue

        prev_start, prev_end = merged_segments[-1]
        gap = seg_start - prev_end
        if gap < COMPONENT_SPLIT_MIN_GAP:
            merged_segments[-1][1] = seg_end
        else:
            merged_segments.append([seg_start, seg_end])

    split_boxes = []
    for seg_start, seg_end in merged_segments:
        if orientation == 'horizontal':
            sub_mask = crop[seg_start:seg_end, :]
            sub_box = _compute_box_from_mask(sub_mask, offset_x=x, offset_y=y + seg_start)
        else:
            sub_mask = crop[:, seg_start:seg_end]
            sub_box = _compute_box_from_mask(sub_mask, offset_x=x + seg_start, offset_y=y)
        if sub_box is None:
            continue
        if not _component_box_is_large_enough(sub_box, orientation):
            continue
        split_boxes.append(sub_box)

    if split_boxes:
        return split_boxes

    tight_box = _compute_box_from_mask(crop, offset_x=x, offset_y=y)
    if tight_box is not None and _component_box_is_large_enough(tight_box, orientation):
        return [tight_box]
    return []


def _component_kernel_length(polys: list | np.ndarray, orientation: str) -> int:
    short_sides = []
    if len(polys) > 0:
        for poly in np.asarray(polys, dtype=np.float64).reshape(-1, 4, 2):
            if _polygon_orientation(poly) != orientation:
                continue
            edges = [
                float(np.linalg.norm(poly[(index + 1) % 4] - poly[index]))
                for index in range(4)
            ]
            short_sides.append(min((edges[0] + edges[2]) / 2.0, (edges[1] + edges[3]) / 2.0))

    reference = float(np.median(short_sides)) if short_sides else 25.0
    return int(np.clip(round(reference * COMPONENT_KERNEL_RATIO), COMPONENT_KERNEL_MIN, COMPONENT_KERNEL_MAX))


def _find_oriented_component_boxes(
    binary_mask: np.ndarray,
    orientation: str,
    kernel_length: int,
) -> list[dict]:
    kernel_shape = (1, kernel_length) if orientation == 'horizontal' else (kernel_length, 1)
    kernel = np.ones(kernel_shape, dtype=np.uint8)
    merged_mask = cv2.dilate(binary_mask.astype(np.uint8), kernel, iterations=1).astype(bool)

    num_labels, labels = cv2.connectedComponents(merged_mask.astype(np.uint8), connectivity=8)
    boxes = []
    for label_idx in range(1, num_labels):
        component_mask = labels == label_idx
        box = _compute_box_from_mask(component_mask)
        if box is None:
            continue
        boxes.extend(_split_component_box_by_projection(box, binary_mask, orientation))

    boxes.sort(key=lambda item: (item['x'], item['y']))
    return boxes


def _find_component_boxes(
    mask: np.ndarray,
    polys: list | np.ndarray = (),
) -> dict[str, list[dict]]:
    binary_mask = _mask_to_binary(mask)
    return {
        orientation: _find_oriented_component_boxes(
            binary_mask,
            orientation,
            _component_kernel_length(polys, orientation),
        )
        for orientation in ('horizontal', 'vertical')
    }


def _largest_rect_in_histogram(heights: np.ndarray) -> tuple[int, tuple[int, int, int]]:
    stack = []
    max_area = 0
    best_rect = (0, 0, 0)
    histogram = np.append(heights, 0)
    for idx, height in enumerate(histogram):
        start = idx
        while stack and stack[-1][0] >= height:
            prev_height, prev_start = stack.pop()
            width = idx - prev_start
            area = int(prev_height) * int(width)
            if area > max_area:
                max_area = area
                best_rect = (int(prev_height), int(prev_start), int(idx - 1))
            start = prev_start
        stack.append((int(height), int(start)))
    return max_area, best_rect


def _largest_inner_rect(mask: np.ndarray, bbox: tuple[int, int, int, int], step: int = 2) -> dict | None:
    x, y, w, h = bbox
    roi = mask[y:y + h, x:x + w]
    rows, cols = roi.shape
    if rows <= 0 or cols <= 0:
        return None

    is_white = roi > 0
    height_matrix = np.zeros((rows, cols), dtype=np.int32)
    for row in range(rows):
        if row == 0:
            height_matrix[row] = is_white[row].astype(np.int32)
        else:
            height_matrix[row] = np.where(is_white[row], height_matrix[row - 1] + 1, 0)

    best_area = 0
    best = None
    for row in range(0, rows, step):
        area, (rect_h, start_col, end_col) = _largest_rect_in_histogram(height_matrix[row])
        if area > best_area and rect_h > 0:
            best_area = area
            rect_top = row - rect_h + 1
            best = {
                'left': int(x + start_col),
                'top': int(y + rect_top),
                'width': int(end_col - start_col + 1),
                'height': int(rect_h),
                'area': int(area),
            }
    return best


def _smooth_binary_mask(mask: np.ndarray, radius: int = ALIGN_MASK_SMOOTH_RADIUS) -> np.ndarray:
    if radius <= 0:
        return mask
    kernel_size = int(radius * 2) | 1
    blurred = cv2.GaussianBlur(mask, (kernel_size, kernel_size), 0)
    _, smoothed = cv2.threshold(blurred, 127, 255, cv2.THRESH_BINARY)
    return smoothed


def _manual_edit_mask(base_img: np.ndarray | None, calc_img: np.ndarray) -> np.ndarray | None:
    if base_img is None or base_img.shape[:2] != calc_img.shape[:2]:
        return None
    base = base_img[:, :, :3] if len(base_img.shape) == 3 else cv2.cvtColor(base_img, cv2.COLOR_GRAY2BGR)
    calc = calc_img[:, :, :3] if len(calc_img.shape) == 3 else cv2.cvtColor(calc_img, cv2.COLOR_GRAY2BGR)
    diff = cv2.absdiff(base, calc)
    diff_gray = cv2.cvtColor(diff, cv2.COLOR_BGR2GRAY)
    manual = (diff_gray > ALIGN_MANUAL_DIFF_THRESHOLD).astype(np.uint8) * 255
    if cv2.countNonZero(manual) == 0:
        return manual
    kernel = np.ones((ALIGN_MANUAL_PROTECT_DILATE_SIZE, ALIGN_MANUAL_PROTECT_DILATE_SIZE), dtype=np.uint8)
    return cv2.dilate(manual, kernel, iterations=1)


def _prepare_align_gray(
    img: np.ndarray,
    mask: np.ndarray,
    base_img: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if len(img.shape) == 3 else img.copy()
    text_mask = _mask_to_binary(mask).astype(np.uint8) * 255
    kernel = np.ones((ALIGN_MASK_DILATE_SIZE, ALIGN_MASK_DILATE_SIZE), dtype=np.uint8)
    text_mask = cv2.dilate(text_mask, kernel, iterations=1)
    manual_mask = _manual_edit_mask(base_img, img)
    if manual_mask is not None:
        text_mask[manual_mask > 0] = 0
    inpainted = cv2.inpaint(gray, text_mask, 5, cv2.INPAINT_TELEA)
    if manual_mask is not None:
        inpainted[manual_mask > 0] = gray[manual_mask > 0]
    return inpainted, text_mask


def _seed_near_box_center(text_mask: np.ndarray, box: list[int]) -> tuple[int, int]:
    height, width = text_mask.shape[:2]
    x1, y1, x2, y2 = box
    cx = int(round((x1 + x2) / 2))
    cy = int(round((y1 + y2) / 2))
    cx = max(0, min(width - 1, cx))
    cy = max(0, min(height - 1, cy))
    if text_mask[cy, cx] == 0:
        return cx, cy

    pad_x = max(8, int((x2 - x1) * 0.35))
    pad_y = max(8, int((y2 - y1) * 0.35))
    rx1 = max(0, x1 - pad_x)
    ry1 = max(0, y1 - pad_y)
    rx2 = min(width, x2 + pad_x)
    ry2 = min(height, y2 + pad_y)
    crop = text_mask[ry1:ry2, rx1:rx2] == 0
    ys, xs = np.where(crop)
    if len(xs) == 0:
        return cx, cy

    abs_xs = xs + rx1
    abs_ys = ys + ry1
    distances = (abs_xs - cx) ** 2 + (abs_ys - cy) ** 2
    nearest = int(np.argmin(distances))
    return int(abs_xs[nearest]), int(abs_ys[nearest])


def _flood_region(gray: np.ndarray, seed: tuple[int, int]) -> np.ndarray | None:
    height, width = gray.shape[:2]
    x, y = seed
    if x < 0 or x >= width or y < 0 or y >= height:
        return None
    flood_mask = np.zeros((height + 2, width + 2), dtype=np.uint8)
    flood_img = gray.copy()
    flags = 4 | (255 << 8) | cv2.FLOODFILL_FIXED_RANGE | cv2.FLOODFILL_MASK_ONLY
    try:
        cv2.floodFill(
            flood_img,
            flood_mask,
            (x, y),
            255,
            ALIGN_FLOOD_DIFF,
            ALIGN_FLOOD_DIFF,
            flags,
        )
    except cv2.error:
        return None
    region = flood_mask[1:-1, 1:-1]
    return region if cv2.countNonZero(region) > 0 else None


def _candidate_from_region(region: np.ndarray, old_box: list[int]) -> tuple[list[int], dict] | None:
    smoothed = _smooth_binary_mask(region)
    points = cv2.findNonZero(smoothed)
    if points is None:
        return None

    x, y, w, h = cv2.boundingRect(points)
    outer_area = w * h
    inner = _largest_inner_rect(smoothed, (x, y, w, h), step=2)
    if inner is None:
        cx = x + w / 2
        cy = y + h / 2
        result_w = float(w)
        result_h = float(h)
        inner_area = 0
    else:
        outer_cx = x + w / 2
        outer_cy = y + h / 2
        inner_cx = inner['left'] + inner['width'] / 2
        inner_cy = inner['top'] + inner['height'] / 2
        cx = (outer_cx + inner_cx) / 2
        cy = (outer_cy + inner_cy) / 2
        result_w = (w + inner['width']) / 2
        result_h = (h + inner['height']) / 2
        inner_area = inner['area']

    candidate = [
        int(round(cx - result_w / 2)),
        int(round(cy - result_h / 2)),
        int(round(cx + result_w / 2)),
        int(round(cy + result_h / 2)),
    ]
    old_cx = (old_box[0] + old_box[2]) / 2
    old_cy = (old_box[1] + old_box[3]) / 2
    move_px = float(np.hypot(cx - old_cx, cy - old_cy))
    outer_body_mask = np.zeros_like(smoothed, dtype=np.uint8)
    outer_body_mask[y:y + h, x:x + w] = smoothed[y:y + h, x:x + w]
    return candidate, {
        'outer_rect': {'left': int(x), 'top': int(y), 'width': int(w), 'height': int(h), 'area': int(outer_area)},
        'inner_rect': inner,
        'move_px': round(move_px, 2),
        'outer_inner_area_ratio': float(outer_area / inner_area) if inner_area > 0 else float('inf'),
        '_preview_mask': outer_body_mask,
    }


def _fallback_aligned_item(
    old_box: list[int],
    method: str,
    index: int,
    error: Exception | None = None,
) -> dict:
    item = _xyxy_to_item(old_box, method, False, index)
    item['final_xyxy_pixel'] = old_box
    item['layout_debug'] = {
        'processed': False,
        'accepted': False,
        'skip_reason': method,
        'old_xyxy_pixel': old_box,
    }
    if error is not None:
        item['layout_debug']['error'] = str(error)
    return item


def _align_block_box(
    img: np.ndarray,
    mask: np.ndarray,
    block_box: list[int],
    index: int,
    center_mode: str = 'auto',
    base_img: np.ndarray | None = None,
    prepared_gray: np.ndarray | None = None,
    component_mask: np.ndarray | None = None,
    layout_mask: np.ndarray | None = None,
) -> dict:
    height, width = img.shape[:2]
    old_box = _clip_xyxy(block_box, width, height)
    if _rect_area_xyxy(old_box) <= 0:
        return _fallback_aligned_item(old_box, 'block_fallback_invalid_box', index)

    gray = prepared_gray
    if gray is None:
        gray, _ = _prepare_align_gray(img, mask, base_img=base_img)
    core_item = {
        'xyxy_pixel': old_box,
        'center_normalized': [
            round(((old_box[0] + old_box[2]) / 2) / width, 4),
            round(((old_box[1] + old_box[3]) / 2) / height, 4),
        ],
    }
    try:
        layout = _core_calculate_layout(gray, core_item, center_mode=center_mode, component_mask=component_mask)
        if layout_mask is not None:
            from prelayout_core.vendor.bubble_pipeline import constrain_layout_to_partition
            layout = constrain_layout_to_partition(layout, layout_mask)
        layout = _core_apply_safety_rules(core_item, layout, width, height)
    except Exception as exc:
        return _fallback_aligned_item(old_box, 'block_fallback_layout_failed', index, exc)

    final_box = [int(round(v)) for v in layout['final_xyxy_pixel']]
    debug = layout.get('layout_debug', {})
    accepted = bool(debug.get('accepted'))
    method = debug.get('calculation_method', 'bubble_flood_align')
    if not accepted:
        method = f"block_fallback_{debug.get('skip_reason') or 'safety'}"

    item = _xyxy_to_item(final_box, method, accepted, index)
    item.update(layout)
    item['source_block_index'] = index
    item['method'] = method
    item['accepted'] = accepted
    return item


def _align_block_boxes(
    img: np.ndarray,
    mask: np.ndarray,
    block_boxes: list[list[int]],
    center_mode: str = 'auto',
    base_img: np.ndarray | None = None,
    prepared_gray: np.ndarray | None = None,
) -> list[dict]:
    gray = prepared_gray
    if gray is None and block_boxes:
        gray, _ = _prepare_align_gray(img, mask, base_img=base_img)

    aligned_items = [
        _align_block_box(
            img,
            mask,
            block_box,
            index,
            center_mode=center_mode,
            base_img=base_img,
            prepared_gray=gray,
        )
        for index, block_box in enumerate(block_boxes)
    ]
    if center_mode != 'auto':
        return aligned_items

    for index in _outer_overlap_indices(aligned_items):
        aligned_items[index] = _align_block_box(
            img,
            mask,
            block_boxes[index],
            index,
            center_mode='outer',
            base_img=base_img,
            prepared_gray=gray,
        )
        aligned_items[index]['outer_overlap_center_mode_override'] = True
    return aligned_items


def _clean_aligned_items(aligned_items: list[dict]) -> list[dict]:
    clean_items = []
    for item in aligned_items:
        clean_items.append({
            key: value
            for key, value in item.items()
            if not key.startswith('_')
        })
    return clean_items


def _draw_aligned_boxes(
    img: np.ndarray,
    aligned_items: list[dict],
) -> np.ndarray:
    canvas = _preview_base_image(img)
    for item_index, item in enumerate(aligned_items):
        old_box = item.get('layout_debug', {}).get('old_xyxy_pixel')
        if old_box is not None:
            _overlay_rect(canvas, old_box, ALIGN_BLOCK_BG_COLOR, ALIGN_BLOCK_BG_ALPHA)
        _core_draw_item_preview(canvas, item, item.get('_preview_masks'), item_index)
    return canvas


def _save_box_visualizations(
    save_dir: str,
    imname: str,
    img: np.ndarray,
    mask: np.ndarray,
    block_boxes: list[list[int]],
    line_polys: list,
    line_trans_items: list[dict],
    aligned_items: list[dict],
) -> None:
    block_dir = osp.join(save_dir, BLOCK_BOX_DIR)
    line_dir = osp.join(save_dir, LINE_BOX_DIR)
    line_trans_dir = osp.join(save_dir, LINE_TRANS_BOX_DIR)
    center_dir = osp.join(osp.dirname(save_dir), CENTER_DIR)
    os.makedirs(block_dir, exist_ok=True)
    os.makedirs(line_dir, exist_ok=True)
    os.makedirs(line_trans_dir, exist_ok=True)
    os.makedirs(center_dir, exist_ok=True)

    block_img = _draw_rect_boxes(mask, block_boxes, BLOCK_BOX_COLOR)
    line_img = _draw_line_polygons(mask, line_polys, LINE_BOX_COLOR)
    line_trans_img = _draw_line_width_measurements(img, line_trans_items, mask)
    center_img = _draw_aligned_boxes(img, aligned_items)

    imwrite(osp.join(block_dir, f'{imname}.png'), block_img)
    imwrite(osp.join(line_dir, f'{imname}.png'), line_img)
    imwrite(osp.join(line_trans_dir, f'{imname}.png'), line_trans_img)
    imwrite(osp.join(center_dir, f'{imname}.png'), center_img)


def detect_folder(
    img_dir: str,
    model_path: str,
    device: str | None = None,
    save_json: bool = False,
) -> int:
    img_dir = osp.abspath(img_dir)
    if not osp.isdir(img_dir):
        raise FileNotFoundError(f'找不到資料夾：{img_dir}')

    model_path = osp.abspath(model_path)
    if not osp.isfile(model_path):
        raise FileNotFoundError(f'找不到模型檔：{model_path}')

    if device is None:
        device = 'cuda' if torch.cuda.is_available() else 'cpu'

    save_dir = osp.join(img_dir, 'ctd')
    os.makedirs(save_dir, exist_ok=True)

    imglist = [
        p for p in find_all_imgs(img_dir, abs_path=True)
        if not osp.basename(p).startswith('mask-')
    ]
    if not imglist:
        print(f'資料夾內沒有可處理的圖片：{img_dir}')
        return 0

    print(f'資料夾：{img_dir}')
    print(f'輸出：{save_dir}')
    print(f'模型：{model_path}')
    print(f'裝置：{device}')
    print(f'圖片數量：{len(imglist)}')

    detector = TextDetector(model_path=model_path, input_size=1024, device=device, act='leaky')
    line_trans_map = {}
    aligned_box_map = {}
    deal_overlap_dir = osp.join(img_dir, DEAL_OVERLAP_DIR)
    pages_using_deal_overlap = 0
    pages_with_aligned_overlap = 0
    deal_overlap_copied = 0

    for img_path in tqdm(imglist, desc='偵測中'):
        imgname = osp.basename(img_path)
        img = imread(img_path)
        im_h, im_w = img.shape[:2]
        imname = Path(imgname).stem
        overlap_path = osp.join(deal_overlap_dir, imgname)
        calc_img = imread(overlap_path) if osp.exists(overlap_path) else img
        if osp.exists(overlap_path):
            pages_using_deal_overlap += 1

        mask, mask_refined, blk_list = detector(
            img,
            refine_mode=REFINEMASK_ANNOTATION,
            keep_undetected_mask=True,
        )

        polys = []
        blk_xyxy = []
        blk_dict_list = []
        for blk in blk_list:
            polys += blk.lines
            blk_xyxy.append(blk.xyxy)
            blk_dict_list.append(blk.to_dict())

        block_boxes = [[int(x) for x in box] for box in blk_xyxy]

        blk_xyxy_yolo = xyxy2yolo(blk_xyxy, im_w, im_h)
        if blk_xyxy_yolo is not None:
            cls_list = [1] * len(blk_xyxy_yolo)
            yolo_label = get_yololabel_strings(cls_list, blk_xyxy_yolo)
        else:
            yolo_label = ''

        with open(osp.join(save_dir, f'{imname}.txt'), 'w', encoding='utf8') as f:
            f.write(yolo_label)

        poly_save_path = osp.join(save_dir, f'line-{imname}.txt')
        if len(polys) != 0:
            polys_arr = np.array(polys).reshape(-1, 8)
            np.savetxt(poly_save_path, polys_arr, fmt='%d')
        elif osp.exists(poly_save_path):
            os.remove(poly_save_path)

        if save_json:
            with open(osp.join(save_dir, f'{imname}.json'), 'w', encoding='utf8') as f:
                f.write(json.dumps(blk_dict_list, ensure_ascii=False, cls=NumpyEncoder))

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
        line_trans_map[f'{imname}.png'] = line_trans_items
        aligned_items = _align_block_boxes(calc_img, mask_refined, block_boxes, base_img=img)
        aligned_box_map[f'{imname}.png'] = _clean_aligned_items(aligned_items)
        if _final_boxes_overlap(aligned_items):
            pages_with_aligned_overlap += 1
            helper_status = _ensure_deal_overlap_image(img_path, overlap_path)
            if helper_status == 'copied':
                deal_overlap_copied += 1

        imwrite(osp.join(save_dir, f'mask-{imname}.png'), mask_refined)
        _save_box_visualizations(
            save_dir,
            imname,
            img,
            mask_refined,
            block_boxes,
            polys,
            line_trans_items,
            aligned_items,
        )

    with open(osp.join(save_dir, 'line_trans_map.json'), 'w', encoding='utf8') as f:
        json.dump({'transMap': line_trans_map}, f, ensure_ascii=False, indent=2)
    with open(osp.join(save_dir, 'aligned_box_map.json'), 'w', encoding='utf8') as f:
        json.dump({'transMap': aligned_box_map}, f, ensure_ascii=False, indent=2, cls=NumpyEncoder)

    print(f'完成。結果已寫入：{save_dir}')
    print('每張圖片會產生：')
    print('  - <檔名>.txt              YOLO 文字區塊標註')
    print('  - line-<檔名>.txt         文字行多邊形')
    print('  - mask-<檔名>.png         文字分割遮罩')
    print(f'  - {BLOCK_BOX_DIR}/<檔名>.png   區塊窄框矩形（綠色）')
    print(f'  - {LINE_BOX_DIR}/<檔名>.png    文字行四邊形輪廓（橘色）')
    print(f'  - {LINE_TRANS_BOX_DIR}/<檔名>.png 原圖底的文字短邊卡尺測量')
    print(f'  - ../{CENTER_DIR}/<檔名>.png   原圖底的氣泡對齊預覽')
    print('  - line_trans_map.json     line + trans 混合框尺寸')
    print('  - aligned_box_map.json    氣泡對齊區塊框尺寸')
    print(f'  - ../{DEAL_OVERLAP_DIR}/<檔名>.png 重疊時複製的人工拆分輔助圖')
    print(f'使用 deal_overlap 計算的頁數：{pages_using_deal_overlap}')
    print(f'偵測到對齊框重疊的頁數：{pages_with_aligned_overlap}')
    print(f'新複製到 deal_overlap 的頁數：{deal_overlap_copied}')
    if save_json:
        print('  - <檔名>.json        文字區塊 JSON')
    return len(imglist)


def main() -> None:
    default_model = osp.join(osp.dirname(__file__), 'data', 'comictextdetector.pt')

    parser = argparse.ArgumentParser(
        description='對資料夾內的漫畫圖片執行文字偵測，並在該資料夾下的 ctd 子資料夾輸出結果。',
    )
    parser.add_argument(
        'img_dir',
        help='輸入圖片資料夾路徑',
    )
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
        '--json',
        action='store_true',
        help='額外輸出 JSON 格式的文字區塊資訊',
    )
    args = parser.parse_args()

    detect_folder(
        img_dir=args.img_dir,
        model_path=args.model,
        device=args.device,
        save_json=args.json,
    )
