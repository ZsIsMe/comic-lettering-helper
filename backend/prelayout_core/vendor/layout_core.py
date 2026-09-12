import json

import cv2
import numpy as np


class NumpyEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, np.integer):
            return int(obj)
        if isinstance(obj, np.floating):
            return float(obj)
        if isinstance(obj, np.ndarray):
            return obj.tolist()
        return super().default(obj)


def to_gray(img):
    if len(img.shape) == 2:
        return img
    if img.shape[2] == 4:
        bgr = img[:, :, :3]
        alpha = img[:, :, 3]
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        gray[alpha < 128] = 0
        return gray
    return cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)


def smooth_mask(mask, radius=10):
    if radius <= 0:
        return mask
    ksize = int(radius * 2) | 1
    blurred = cv2.GaussianBlur(mask, (ksize, ksize), 0)
    _, smoothed = cv2.threshold(blurred, 127, 255, cv2.THRESH_BINARY)
    return smoothed


def get_component_mask(gray, seed_point, lo_diff=32, up_diff=32):
    h, w = gray.shape
    x, y = int(round(seed_point[0])), int(round(seed_point[1]))
    if x < 0 or x >= w or y < 0 or y >= h:
        return None

    flood_mask = np.zeros((h + 2, w + 2), np.uint8)
    flood_img = gray.copy()
    flags = 4 | (255 << 8) | cv2.FLOODFILL_FIXED_RANGE | cv2.FLOODFILL_MASK_ONLY
    try:
        cv2.floodFill(flood_img, flood_mask, (x, y), 255, lo_diff, up_diff, flags)
    except Exception:
        return None
    return flood_mask[1:-1, 1:-1]


def largest_rect_in_histogram(heights):
    stack = []
    max_area = 0
    best_rect = (0, 0, 0)
    h = np.append(heights, 0)
    for i, height in enumerate(h):
        start = i
        while stack and stack[-1][0] >= height:
            h_top, idx_top = stack.pop()
            width = i - idx_top
            area = int(h_top) * int(width)
            if area > max_area:
                max_area = area
                best_rect = (int(h_top), int(idx_top), int(i - 1))
            start = idx_top
        stack.append((int(height), int(start)))
    return max_area, best_rect


def find_largest_inner_rectangle(mask, bbox, step=2):
    x0, y0, w, h = bbox
    roi = mask[y0:y0 + h, x0:x0 + w]
    rows, cols = roi.shape
    if rows <= 0 or cols <= 0:
        return None

    is_white = roi == 255
    h_matrix = np.zeros((rows, cols), dtype=np.int32)
    for r in range(rows):
        if r == 0:
            h_matrix[r] = is_white[r].astype(np.int32)
        else:
            h_matrix[r] = np.where(is_white[r], h_matrix[r - 1] + 1, 0)

    best_area = 0
    best_rect_global = None
    for r in range(0, rows, step):
        area, (rect_h, start_col, end_col) = largest_rect_in_histogram(h_matrix[r])
        if area > best_area and rect_h > 0:
            best_area = area
            rect_top = r - rect_h + 1
            rect_left = start_col
            rect_w = end_col - start_col + 1
            best_rect_global = {
                "left": int(rect_left + x0),
                "top": int(rect_top + y0),
                "width": int(rect_w),
                "height": int(rect_h),
                "area": int(area),
            }
    return best_rect_global


def rect_center(xyxy):
    x1, y1, x2, y2 = [float(v) for v in xyxy]
    return ((x1 + x2) / 2.0, (y1 + y2) / 2.0)


def rect_area(xyxy):
    x1, y1, x2, y2 = [float(v) for v in xyxy]
    return max(0.0, x2 - x1) * max(0.0, y2 - y1)


def rects_overlap(a, b):
    ax1, ay1, ax2, ay2 = [float(v) for v in a]
    bx1, by1, bx2, by2 = [float(v) for v in b]
    return min(ax2, bx2) > max(ax1, bx1) and min(ay2, by2) > max(ay1, by1)


def rect_inside_image(xyxy, img_w, img_h):
    x1, y1, x2, y2 = [float(v) for v in xyxy]
    return 0 <= x1 <= img_w and 0 <= x2 <= img_w and 0 <= y1 <= img_h and 0 <= y2 <= img_h


def point_inside_rect(x, y, rect):
    left = float(rect["left"])
    top = float(rect["top"])
    right = left + float(rect["width"])
    bottom = top + float(rect["height"])
    return left <= x <= right and top <= y <= bottom


def point_inside_xyxy(x, y, xyxy):
    x1, y1, x2, y2 = [float(v) for v in xyxy]
    return x1 <= x <= x2 and y1 <= y <= y2


def normalized_center(xyxy, img_w, img_h):
    cx, cy = rect_center(xyxy)
    return [round(cx / img_w, 4), round(cy / img_h, 4)]


def dict_rect_to_xyxy(rect):
    return [
        int(rect["left"]),
        int(rect["top"]),
        int(rect["left"] + rect["width"]),
        int(rect["top"] + rect["height"]),
    ]


def dict_rect_area(rect):
    return max(0, int(rect["width"])) * max(0, int(rect["height"]))


def mask_inside_rect(mask, rect):
    result = np.zeros_like(mask, dtype=np.uint8)
    left = int(rect["left"])
    top = int(rect["top"])
    right = left + int(rect["width"])
    bottom = top + int(rect["height"])
    result[top:bottom, left:right] = mask[top:bottom, left:right]
    return result


def rect_contains_dict_rect(container, inner, min_ratio=0.9):
    container_xyxy = dict_rect_to_xyxy(container)
    inner_xyxy = dict_rect_to_xyxy(inner)
    x1 = max(container_xyxy[0], inner_xyxy[0])
    y1 = max(container_xyxy[1], inner_xyxy[1])
    x2 = min(container_xyxy[2], inner_xyxy[2])
    y2 = min(container_xyxy[3], inner_xyxy[3])
    overlap = max(0, x2 - x1) * max(0, y2 - y1)
    area = dict_rect_area(inner)
    return area > 0 and overlap / area >= min_ratio


def refine_outer_rect_by_projection(mask, raw_outer_rect, inner_rect, old_xyxy, frac=0.2):
    if not inner_rect:
        return raw_outer_rect, {
            "method": "none",
            "applied": False,
            "reason": "missing_inner_rect",
        }

    raw_right = raw_outer_rect["left"] + raw_outer_rect["width"]
    raw_bottom = raw_outer_rect["top"] + raw_outer_rect["height"]
    inner_right = inner_rect["left"] + inner_rect["width"]
    inner_bottom = inner_rect["top"] + inner_rect["height"]
    left_gap = inner_rect["left"] - raw_outer_rect["left"]
    right_gap = raw_right - inner_right
    top_gap = inner_rect["top"] - raw_outer_rect["top"]
    bottom_gap = raw_bottom - inner_bottom

    horizontal_tail = (
        max(left_gap, right_gap) >= max(24, inner_rect["width"] * 0.35)
        and max(left_gap, right_gap) >= min(left_gap, right_gap) * 3 + 10
    )
    vertical_tail = (
        max(top_gap, bottom_gap) >= max(24, inner_rect["height"] * 0.35)
        and max(top_gap, bottom_gap) >= min(top_gap, bottom_gap) * 3 + 10
    )
    if not horizontal_tail and not vertical_tail:
        return raw_outer_rect, {
            "method": "projection",
            "applied": False,
            "reason": "no_tail_asymmetry",
            "gaps": {
                "left": int(left_gap),
                "right": int(right_gap),
                "top": int(top_gap),
                "bottom": int(bottom_gap),
            },
        }

    left = int(raw_outer_rect["left"])
    top = int(raw_outer_rect["top"])
    width = int(raw_outer_rect["width"])
    height = int(raw_outer_rect["height"])
    roi = mask[top:top + height, left:left + width]
    if roi.size == 0:
        return raw_outer_rect, {
            "method": "projection",
            "applied": False,
            "reason": "empty_roi",
        }

    col_counts = np.sum(roi > 0, axis=0)
    row_counts = np.sum(roi > 0, axis=1)
    if col_counts.max() == 0 or row_counts.max() == 0:
        return raw_outer_rect, {
            "method": "projection",
            "applied": False,
            "reason": "empty_projection",
        }

    col_threshold = float(col_counts.max()) * frac
    row_threshold = float(row_counts.max()) * frac
    cols = np.where(col_counts >= col_threshold)[0]
    rows = np.where(row_counts >= row_threshold)[0]
    if len(cols) == 0 or len(rows) == 0:
        return raw_outer_rect, {
            "method": "projection",
            "applied": False,
            "reason": "projection_no_bounds",
        }

    refined = {
        "left": int(left + cols[0]),
        "top": int(top + rows[0]),
        "width": int(cols[-1] - cols[0] + 1),
        "height": int(rows[-1] - rows[0] + 1),
    }
    refined["area"] = dict_rect_area(refined)

    raw_area = dict_rect_area(raw_outer_rect)
    refined_area = dict_rect_area(refined)
    valid = (
        refined_area > 0
        and refined["width"] >= inner_rect["width"]
        and refined["height"] >= inner_rect["height"]
        and rect_contains_dict_rect(refined, inner_rect, min_ratio=0.85)
        and rects_overlap(dict_rect_to_xyxy(refined), old_xyxy)
        and refined_area >= raw_area * 0.25
    )
    if not valid:
        return raw_outer_rect, {
            "method": "projection",
            "applied": False,
            "reason": "refined_rect_failed_validation",
            "candidate": refined,
            "col_threshold": round(col_threshold, 2),
            "row_threshold": round(row_threshold, 2),
        }

    return refined, {
        "method": "projection",
        "applied": refined != raw_outer_rect,
        "reason": None,
        "col_threshold": round(col_threshold, 2),
        "row_threshold": round(row_threshold, 2),
    }


def seed_from_item(item, img_w, img_h):
    if "xyxy_pixel" in item and len(item["xyxy_pixel"]) == 4:
        x1, y1, x2, y2 = item["xyxy_pixel"]
        return (float(x1 + x2) / 2.0, float(y1 + y2) / 2.0)
    if "center_normalized" in item and len(item["center_normalized"]) == 2:
        return (float(item["center_normalized"][0]) * img_w, float(item["center_normalized"][1]) * img_h)
    raise ValueError("Item must contain xyxy_pixel or center_normalized")


def candidate_seed_points(item, img_w, img_h):
    primary = seed_from_item(item, img_w, img_h)
    points = [primary]
    if "xyxy_pixel" in item and len(item["xyxy_pixel"]) == 4:
        x1, y1, x2, y2 = [float(v) for v in item["xyxy_pixel"]]
        for fx in (0.25, 0.5, 0.75):
            for fy in (0.25, 0.5, 0.75):
                points.append((x1 + (x2 - x1) * fx, y1 + (y2 - y1) * fy))

    deduped = []
    seen = set()
    for x, y in points:
        key = (int(round(x)), int(round(y)))
        if key not in seen:
            seen.add(key)
            deduped.append((x, y))
    return deduped


def get_best_component_mask(gray, item):
    img_h, img_w = gray.shape
    best = None
    for seed_x, seed_y in candidate_seed_points(item, img_w, img_h):
        mask = get_component_mask(gray, (seed_x, seed_y))
        if mask is None or cv2.countNonZero(mask) == 0:
            continue

        smoothed = smooth_mask(mask, 10)
        smooth_area = cv2.countNonZero(smoothed)

        # Keep the original algorithm's center seed when it yields a usable mask.
        if best is None:
            best = (mask, smoothed, seed_x, seed_y, smooth_area)
            if smooth_area > 0:
                return best
            continue

        if smooth_area > best[4]:
            best = (mask, smoothed, seed_x, seed_y, smooth_area)

    return best


def contour_angle(prev_point, point, next_point):
    v1 = np.array(prev_point, dtype=np.float32) - np.array(point, dtype=np.float32)
    v2 = np.array(next_point, dtype=np.float32) - np.array(point, dtype=np.float32)
    len1 = float(np.linalg.norm(v1))
    len2 = float(np.linalg.norm(v2))
    if len1 == 0 or len2 == 0:
        return None, len1, len2
    cosine = float(np.dot(v1, v2) / (len1 * len2))
    cosine = max(-1.0, min(1.0, cosine))
    return float(np.degrees(np.arccos(cosine))), len1, len2


def analyze_right_angles(mask, epsilon_ratio=0.02, angle_min=80, angle_max=100):
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return {
            "has_right_angle": False,
            "right_angle_count": 0,
            "approx_points": 0,
            "right_angle_points": [],
            "reason": "no_contours",
        }

    contour = max(contours, key=cv2.contourArea)
    perimeter = cv2.arcLength(contour, True)
    if perimeter <= 0:
        return {
            "has_right_angle": False,
            "right_angle_count": 0,
            "approx_points": 0,
            "right_angle_points": [],
            "reason": "zero_perimeter",
        }

    approx = cv2.approxPolyDP(contour, epsilon_ratio * perimeter, True).reshape(-1, 2)
    min_edge_len = max(12.0, perimeter * 0.015)
    right_angle_points = []
    for idx, point in enumerate(approx):
        prev_point = approx[idx - 1]
        next_point = approx[(idx + 1) % len(approx)]
        angle, len1, len2 = contour_angle(prev_point, point, next_point)
        if angle is None:
            continue
        if angle_min <= angle <= angle_max and min(len1, len2) >= min_edge_len:
            right_angle_points.append({
                "point": [int(point[0]), int(point[1])],
                "angle": round(angle, 2),
                "edge_lengths": [round(len1, 2), round(len2, 2)],
            })

    return {
        "has_right_angle": len(right_angle_points) > 0,
        "right_angle_count": len(right_angle_points),
        "approx_points": int(len(approx)),
        "right_angle_points": right_angle_points,
        "epsilon_ratio": epsilon_ratio,
        "min_edge_len": round(min_edge_len, 2),
    }


def resolve_center_mode(center_mode, shape_analysis):
    if center_mode == "auto":
        return "average" if shape_analysis.get("has_right_angle") else "outer"
    return center_mode


def resolve_candidate_center(outer_rect, inner_rect, resolved_center_mode):
    outer_center_x = outer_rect["left"] + outer_rect["width"] / 2.0
    outer_center_y = outer_rect["top"] + outer_rect["height"] / 2.0
    if not inner_rect:
        return outer_center_x, outer_center_y, f"{resolved_center_mode}_center_inner_failed_fallback_outer"

    inner_center_x = inner_rect["left"] + inner_rect["width"] / 2.0
    inner_center_y = inner_rect["top"] + inner_rect["height"] / 2.0
    if resolved_center_mode == "outer":
        return outer_center_x, outer_center_y, "outer_center"
    if resolved_center_mode == "inner":
        return inner_center_x, inner_center_y, "inner_center"
    if resolved_center_mode == "average":
        return (outer_center_x + inner_center_x) / 2.0, (outer_center_y + inner_center_y) / 2.0, "average_outer_inner"
    raise ValueError(f"Unknown center mode: {resolved_center_mode}")


def calculate_layout(gray, item, center_mode="auto", component_mask=None):
    img_h, img_w = gray.shape
    if component_mask is None:
        best_mask = get_best_component_mask(gray, item)
        if best_mask is None:
            raise ValueError("Magic wand failed")
        _, smoothed_mask, seed_x, seed_y, smooth_area = best_mask
    else:
        if component_mask.shape != gray.shape:
            raise ValueError("Component mask shape differs from image")
        seed_x, seed_y = seed_from_item(item, img_w, img_h)
        sx, sy = int(round(seed_x)), int(round(seed_y))
        if not (0 <= sx < img_w and 0 <= sy < img_h and component_mask[sy, sx]):
            raise ValueError("Seed outside assigned component")
        smoothed_mask = cv2.bitwise_and(smooth_mask(component_mask, 10), component_mask)
        smooth_area = cv2.countNonZero(smoothed_mask)
    if smooth_area == 0:
        raise ValueError("Smoothed selection is empty")

    points = cv2.findNonZero(smoothed_mask)
    if points is None:
        raise ValueError("Smoothed selection is empty")

    x, y, w, h = cv2.boundingRect(points)
    raw_outer_rect = {"left": int(x), "top": int(y), "width": int(w), "height": int(h), "area": int(w * h)}

    inner_rect = find_largest_inner_rectangle(smoothed_mask, (x, y, w, h), step=2)
    outer_rect, outer_refine = refine_outer_rect_by_projection(
        smoothed_mask,
        raw_outer_rect,
        inner_rect,
        [int(round(v)) for v in item["xyxy_pixel"]],
        frac=0.2,
    )
    shape_analysis = analyze_right_angles(smoothed_mask)
    resolved_center_mode = resolve_center_mode(center_mode, shape_analysis)
    new_center_x, new_center_y, method = resolve_candidate_center(outer_rect, inner_rect, resolved_center_mode)

    if inner_rect:
        result_w = (outer_rect["width"] + inner_rect["width"]) / 2.0
        result_h = (outer_rect["height"] + inner_rect["height"]) / 2.0
    else:
        result_w = float(outer_rect["width"])
        result_h = float(outer_rect["height"])

    candidate_xyxy_raw = [
        new_center_x - result_w / 2.0,
        new_center_y - result_h / 2.0,
        new_center_x + result_w / 2.0,
        new_center_y + result_h / 2.0,
    ]
    new_xyxy = [int(round(v)) for v in candidate_xyxy_raw]
    cx, cy = rect_center(new_xyxy)

    return {
        "new_xyxy_pixel": new_xyxy,
        "new_center_normalized": [round(cx / img_w, 4), round(cy / img_h, 4)],
        "_preview_masks": {
            "smoothed_mask": smoothed_mask,
            "outer_body_mask": mask_inside_rect(smoothed_mask, outer_rect),
        },
        "layout_debug": {
            "processed": True,
            "calculation_method": method,
            "center_mode": center_mode,
            "resolved_center_mode": resolved_center_mode,
            "shape_analysis": shape_analysis,
            "seed_point": [round(seed_x, 2), round(seed_y, 2)],
            "new_center_pixel": [round(cx, 2), round(cy, 2)],
            "candidate_xyxy_raw": [round(v, 2) for v in candidate_xyxy_raw],
            "raw_outer_rect": raw_outer_rect,
            "outer_rect": outer_rect,
            "outer_refine": outer_refine,
            "inner_rect": inner_rect,
            "result_rect": {
                "left": new_xyxy[0],
                "top": new_xyxy[1],
                "width": new_xyxy[2] - new_xyxy[0],
                "height": new_xyxy[3] - new_xyxy[1],
            },
        },
    }


def apply_safety_rules(item, layout, img_w, img_h):
    old_xyxy = [int(round(v)) for v in item["xyxy_pixel"]]
    candidate_xyxy = layout["new_xyxy_pixel"]
    old_cx, old_cy = rect_center(old_xyxy)
    new_cx, new_cy = rect_center(candidate_xyxy)
    dx = new_cx - old_cx
    dy = new_cy - old_cy
    move_px = float(np.hypot(dx, dy))
    move_norm = float(np.hypot(dx / img_w, dy / img_h))
    old_area = rect_area(old_xyxy)
    candidate_area = rect_area(candidate_xyxy)
    area_ratio = candidate_area / old_area if old_area > 0 else float("inf")
    outer_area = dict_rect_area(layout["layout_debug"]["outer_rect"])
    inner_rect = layout["layout_debug"].get("inner_rect")
    inner_area = dict_rect_area(inner_rect) if inner_rect else 0
    outer_inner_area_ratio = outer_area / inner_area if inner_area > 0 else float("inf")

    checks = {
        "overlaps_old": rects_overlap(candidate_xyxy, old_xyxy),
        "center_inside_old": point_inside_xyxy(new_cx, new_cy, old_xyxy),
        "center_inside_outer": point_inside_rect(new_cx, new_cy, layout["layout_debug"]["outer_rect"]),
        "large_movement": move_px > 150,
        "inside_image": rect_inside_image(layout["layout_debug"]["candidate_xyxy_raw"], img_w, img_h),
        "outer_inner_area_too_large": outer_inner_area_ratio > 4.0,
    }

    skip_reason = None
    if not checks["overlaps_old"]:
        skip_reason = "candidate_does_not_overlap_old"
    elif not checks["center_inside_old"]:
        skip_reason = "center_outside_old_block"
    elif not checks["center_inside_outer"]:
        skip_reason = "center_outside_outer_rect"
    elif checks["large_movement"]:
        skip_reason = "movement_too_large"
    elif not checks["inside_image"]:
        skip_reason = "candidate_outside_image"
    elif checks["outer_inner_area_too_large"]:
        skip_reason = "outer_inner_area_too_large"

    accepted = skip_reason is None
    final_xyxy = candidate_xyxy if accepted else old_xyxy
    layout["final_xyxy_pixel"] = final_xyxy
    layout["final_center_normalized"] = normalized_center(final_xyxy, img_w, img_h)
    final_cx, final_cy = rect_center(final_xyxy)
    layout["layout_debug"].update({
        "accepted": accepted,
        "skip_reason": skip_reason,
        "old_xyxy_pixel": old_xyxy,
        "old_center_pixel": [round(old_cx, 2), round(old_cy, 2)],
        "final_center_pixel": [round(final_cx, 2), round(final_cy, 2)],
        "move_px": round(move_px, 2),
        "move_norm": round(move_norm, 6),
        "old_area": round(old_area, 2),
        "candidate_area": round(candidate_area, 2),
        "area_ratio": round(area_ratio, 4) if np.isfinite(area_ratio) else "inf",
        "outer_area": round(outer_area, 2),
        "inner_area": round(inner_area, 2),
        "outer_inner_area_ratio": round(outer_inner_area_ratio, 4) if np.isfinite(outer_inner_area_ratio) else "inf",
        "safety_checks": checks,
    })
    return layout
