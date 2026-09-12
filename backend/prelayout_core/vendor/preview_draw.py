import cv2
import numpy as np


MASK_COLORS = [
    (255, 179, 179), (179, 255, 179), (179, 179, 255), (255, 224, 179),
    (224, 179, 255), (179, 255, 255), (255, 179, 224), (202, 255, 179),
    (179, 202, 255), (255, 247, 179), (247, 179, 255), (179, 255, 202),
    (255, 202, 179), (202, 179, 255), (179, 247, 255), (230, 255, 179),
    (255, 179, 202), (179, 230, 255), (230, 179, 255), (179, 255, 230),
    (255, 230, 179), (210, 255, 210), (210, 210, 255), (255, 210, 210),
]


def preview_base_image(img):
    preview = img[:, :, :3].copy() if len(img.shape) == 3 else cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    if preview.shape[2] == 4:
        preview = preview[:, :, :3]
    return preview


def overlay_mask(preview, mask, color, alpha):
    if mask is None:
        return
    active = mask > 0
    if not np.any(active):
        return
    color_layer = np.zeros_like(preview, dtype=np.uint8)
    color_layer[active] = color
    blended = (preview.astype(np.float32) * (1.0 - alpha) + color_layer.astype(np.float32) * alpha).astype(np.uint8)
    preview[active] = blended[active]


def draw_dashed_line(img, pt1, pt2, color, thickness=2, dash_length=14, gap_length=8):
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


def draw_dashed_rect(img, x1, y1, x2, y2, color, thickness=2):
    draw_dashed_line(img, (x1, y1), (x2, y1), color, thickness)
    draw_dashed_line(img, (x2, y1), (x2, y2), color, thickness)
    draw_dashed_line(img, (x2, y2), (x1, y2), color, thickness)
    draw_dashed_line(img, (x1, y2), (x1, y1), color, thickness)


def draw_rect_from_dict(img, rect, color, dashed=False):
    if not rect:
        return
    x1 = int(rect["left"])
    y1 = int(rect["top"])
    x2 = int(rect["left"] + rect["width"])
    y2 = int(rect["top"] + rect["height"])
    if dashed:
        draw_dashed_rect(img, x1, y1, x2, y2, color, thickness=2)
    else:
        cv2.rectangle(img, (x1, y1), (x2, y2), color, 2)


def center_color_for_mode(center_mode, fallback_color):
    if center_mode == "outer":
        return (255, 0, 0)
    if center_mode == "inner":
        return (0, 165, 255)
    if center_mode == "average":
        return (0, 255, 0)
    return fallback_color


def draw_rect_xyxy(img, xyxy, color, center_color=None):
    center_color = center_color or color
    x1, y1, x2, y2 = [int(v) for v in xyxy]
    cv2.rectangle(img, (x1, y1), (x2, y2), color, 2)
    cx = int(round((x1 + x2) / 2))
    cy = int(round((y1 + y2) / 2))
    cv2.drawMarker(img, (cx, cy), center_color, markerType=cv2.MARKER_CROSS, markerSize=18, thickness=2)


def draw_item_preview(preview, layout, preview_masks=None, item_index=0):
    debug = layout["layout_debug"]

    if preview_masks:
        mask_color = MASK_COLORS[item_index % len(MASK_COLORS)]
        overlay_mask(preview, preview_masks.get("outer_body_mask"), mask_color, 0.34)

    if debug.get("accepted"):
        draw_rect_from_dict(preview, debug.get("outer_rect"), (255, 0, 0), dashed=True)
        draw_rect_from_dict(preview, debug.get("inner_rect"), (0, 165, 255), dashed=True)
        final_color = (0, 255, 0)
    else:
        final_color = (0, 0, 0)
    center_mode = debug.get("resolved_center_mode", debug.get("center_mode"))
    center_color = center_color_for_mode(center_mode, final_color) if debug.get("accepted") else final_color
    draw_rect_xyxy(preview, layout["final_xyxy_pixel"], final_color, center_color)
