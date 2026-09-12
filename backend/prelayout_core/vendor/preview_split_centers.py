#!/usr/bin/env python3
"""Shared center geometry and preview drawing; CLI uses original-pixel concavities.

No detector model is loaded. Rectangle geometry is retained in the JSON report,
but images contain only applied split lines and newly calculated center points.
"""
from pathlib import Path

import cv2
import numpy as np


def load_image(path: Path, unchanged: bool = True):
    flag = cv2.IMREAD_UNCHANGED if unchanged else cv2.IMREAD_COLOR
    image = cv2.imdecode(np.fromfile(str(path), dtype=np.uint8), flag)
    if image is None:
        raise ValueError(f"Could not read image: {path}")
    return image


def save_png(path: Path, image):
    path.parent.mkdir(parents=True, exist_ok=True)
    ok, encoded = cv2.imencode(".png", image)
    if not ok:
        raise ValueError(f"Could not encode image: {path}")
    encoded.tofile(str(path))


def mask_iou(mask_a, mask_b):
    intersection = cv2.countNonZero(cv2.bitwise_and(mask_a, mask_b))
    union = cv2.countNonZero(cv2.bitwise_or(mask_a, mask_b))
    return intersection / union if union else 0.0


def group_shared_components(component_masks, threshold=0.9):
    parent = list(range(len(component_masks)))

    def find(index):
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def union(left, right):
        left_root, right_root = find(left), find(right)
        if left_root != right_root:
            parent[right_root] = left_root

    for left in range(len(component_masks)):
        if component_masks[left] is None:
            continue
        for right in range(left + 1, len(component_masks)):
            if component_masks[right] is None:
                continue
            if mask_iou(component_masks[left], component_masks[right]) >= threshold:
                union(left, right)

    groups = {}
    for index in range(len(component_masks)):
        groups.setdefault(find(index), []).append(index)
    return list(groups.values())


def calculate_from_mask(core, gray, item, component_mask, center_mode, smooth_radius=4):
    """Run the existing rectangle-center calculation on a pre-split mask."""
    image_height, image_width = gray.shape
    smoothed_mask = cv2.bitwise_and(core.smooth_mask(component_mask, smooth_radius), component_mask)
    points = cv2.findNonZero(smoothed_mask)
    if points is None:
        raise ValueError("Split selection is empty")

    x, y, width, height = cv2.boundingRect(points)
    raw_outer_rect = {
        "left": int(x),
        "top": int(y),
        "width": int(width),
        "height": int(height),
        "area": int(width * height),
    }
    inner_rect = core.find_largest_inner_rectangle(
        smoothed_mask, (x, y, width, height), step=2
    )
    outer_rect, _ = core.refine_outer_rect_by_projection(
        smoothed_mask,
        raw_outer_rect,
        inner_rect,
        [int(round(value)) for value in item["xyxy_pixel"]],
        frac=0.2,
    )
    shape_analysis = core.analyze_right_angles(smoothed_mask)
    resolved_mode = core.resolve_center_mode(center_mode, shape_analysis)
    center_x, center_y, method = core.resolve_candidate_center(
        outer_rect, inner_rect, resolved_mode
    )

    if inner_rect:
        result_width = (outer_rect["width"] + inner_rect["width"]) / 2.0
        result_height = (outer_rect["height"] + inner_rect["height"]) / 2.0
    else:
        result_width = float(outer_rect["width"])
        result_height = float(outer_rect["height"])

    candidate = [
        center_x - result_width / 2.0,
        center_y - result_height / 2.0,
        center_x + result_width / 2.0,
        center_y + result_height / 2.0,
    ]
    rounded = [int(round(value)) for value in candidate]
    rounded_center = core.rect_center(rounded)
    return {
        "center": [round(rounded_center[0], 2), round(rounded_center[1], 2)],
        "center_normalized": [
            round(rounded_center[0] / image_width, 4),
            round(rounded_center[1] / image_height, 4),
        ],
        "candidate_xyxy_pixel": rounded,
        "outer_rect": outer_rect,
        "inner_rect": inner_rect,
        "center_mode": resolved_mode,
        "method": method,
        "split_mask_area": int(cv2.countNonZero(smoothed_mask)),
    }


def draw_center(preview, center, item_index):
    x, y = int(round(center[0])), int(round(center[1]))
    cv2.circle(preview, (x, y), 11, (0, 255, 0), 3, cv2.LINE_AA)
    cv2.drawMarker(
        preview,
        (x, y),
        (0, 255, 0),
        markerType=cv2.MARKER_CROSS,
        markerSize=25,
        thickness=3,
        line_type=cv2.LINE_AA,
    )
    cv2.putText(
        preview,
        str(item_index + 1),
        (x + 14, y - 10),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.75,
        (0, 120, 0),
        2,
        cv2.LINE_AA,
    )
