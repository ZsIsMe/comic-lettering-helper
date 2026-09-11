"""RGB/RGBA public boundary for the migrated BGR classification algorithms."""
from __future__ import annotations

import numpy as np

from .solid import _solid_overlay_from_mask


def classify_page(rgb, text_mask, polygons, *, overlay=None, other=None, edited=None, shrink_ratio=0.02):
    rgb = np.asarray(rgb)
    if rgb.dtype != np.uint8 or rgb.ndim != 3 or rgb.shape[2] != 3:
        raise ValueError('來源必須是 uint8 RGB 圖片')
    shape = rgb.shape[:2]
    text = np.asarray(text_mask)
    if text.shape != shape:
        raise ValueError('偵測 Mask 尺寸與原圖不一致')
    old_overlay = np.zeros((*shape, 4), np.uint8) if overlay is None else np.asarray(overlay)
    old_other = np.zeros(shape, np.uint8) if other is None else np.asarray(other)
    old_edited = np.zeros(shape, np.uint8) if edited is None else np.asarray(edited)
    if old_overlay.shape != (*shape, 4) or old_other.shape != shape or old_edited.shape != shape:
        raise ValueError('保存的編輯資料尺寸不一致')
    if any(value.dtype != np.uint8 for value in (old_overlay, old_other, old_edited)):
        raise ValueError('保存的編輯資料必須是 uint8')
    if np.any((old_overlay[:, :, 3] > 0) & (old_other > 0)):
        raise ValueError('純色填充和圖像修補不能重疊')
    if not 0 <= shrink_ratio <= 0.1:
        raise ValueError('氣泡內縮比例必須介於 0–10%')
    locked = old_edited > 0
    protected = np.where(locked & (old_other > 0), 255, 0).astype(np.uint8)
    result, remaining, _, diagnostics = _solid_overlay_from_mask(
        np.ascontiguousarray(rgb[:, :, ::-1]),
        np.where(text > 0, 255, 0).astype(np.uint8),
        polygons, shrink_ratio, protected,
    )
    # The migrated core returns BGRA; project assets always use RGBA.
    result = result[:, :, [2, 1, 0, 3]].copy()
    result[locked] = old_overlay[locked]
    remaining[locked] = old_other[locked]
    result[result[:, :, 3] == 0] = 0
    if np.any((result[:, :, 3] > 0) & (remaining > 0)):
        raise ValueError('分類結果的兩類選區重疊')
    return result, remaining, old_edited.copy(), diagnostics
