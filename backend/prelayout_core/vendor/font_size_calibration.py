"""Estimate paragraph font size from OCR boxes and cached font ink metrics."""

from __future__ import annotations

import hashlib
import json
import math
import statistics
import unicodedata
from functools import lru_cache
from pathlib import Path
from typing import Any


import os
PROJECT_ROOT = Path(os.environ['COMIC_PRELAYOUT_MODEL_ROOT'])
DEFAULT_FONT_PATH = PROJECT_ROOT / 'NotoSansCJKjp-Medium.otf'
DEFAULT_METRICS_PATH = PROJECT_ROOT / 'NotoSansCJKjp-Medium.ink-metrics.json'
METRICS_SCHEMA_VERSION = 1
DEFAULT_FONT_SIZE_BASE = 24.0
DEFAULT_FONT_SIZE_STEP = 2.0


def ocr_characters(text: object) -> list[str]:
    normalized = unicodedata.normalize('NFC', str(text or ''))
    return [char for char in normalized if not char.isspace()]


def _box_size(box: dict[str, Any]) -> tuple[float, float]:
    width = float(box.get('width') or 0)
    height = float(box.get('height') or 0)
    if width > 0 and height > 0:
        return width, height
    bbox = box.get('bbox')
    if isinstance(bbox, list) and len(bbox) == 4:
        return max(0.0, float(bbox[2]) - float(bbox[0])), max(0.0, float(bbox[3]) - float(bbox[1]))
    return 0.0, 0.0


@lru_cache(maxsize=4)
def load_font_ink_metrics(metrics_path: str | Path = DEFAULT_METRICS_PATH) -> dict[str, Any]:
    path = Path(metrics_path)
    if not path.is_file():
        raise FileNotFoundError(f'找不到字型墨跡緩存：{path}')
    data = json.loads(path.read_text(encoding='utf-8'))
    if data.get('schema_version') != METRICS_SCHEMA_VERSION:
        raise RuntimeError(f'不支援的字型墨跡緩存版本：{data.get("schema_version")}')
    metrics = data.get('metrics') or {}
    if metrics.get('units') != 'reference_pixel_ratio':
        raise RuntimeError(f'不支援的字型墨跡緩存單位：{metrics.get("units")}')
    if not isinstance(data.get('glyphs'), dict):
        raise RuntimeError(f'字型墨跡緩存缺少 glyphs：{path}')
    return data


@lru_cache(maxsize=4)
def _sha256_file(path_text: str) -> str:
    digest = hashlib.sha256()
    with Path(path_text).open('rb') as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def validate_font_ink_metrics(
    font_path: str | Path = DEFAULT_FONT_PATH,
    metrics_path: str | Path = DEFAULT_METRICS_PATH,
) -> dict[str, Any]:
    font = Path(font_path)
    if not font.is_file():
        raise FileNotFoundError(f'找不到字體：{font}')
    metrics = load_font_ink_metrics(metrics_path)
    expected_hash = str((metrics.get('font') or {}).get('sha256') or '')
    if expected_hash and _sha256_file(str(font)) != expected_hash:
        raise RuntimeError(f'字型墨跡緩存與字體不匹配，請重新生成：{metrics_path}')
    return metrics


def character_ink_ratio(
    character: str,
    metrics_path: str | Path = DEFAULT_METRICS_PATH,
) -> tuple[float, float] | None:
    values = (load_font_ink_metrics(metrics_path).get('glyphs') or {}).get(character)
    if not isinstance(values, list) or len(values) != 2:
        return None
    width_ratio = float(values[0])
    height_ratio = float(values[1])
    return (width_ratio, height_ratio) if width_ratio > 0 and height_ratio > 0 else None


def character_ink_size(
    character: str,
    pixel_size: float,
    metrics_path: str | Path = DEFAULT_METRICS_PATH,
) -> tuple[float, float] | None:
    """Scale one cached glyph ink ratio to a requested font size."""
    ratios = character_ink_ratio(character, metrics_path)
    if ratios is None or pixel_size <= 0:
        return None
    return ratios[0] * float(pixel_size), ratios[1] * float(pixel_size)


def _relative_error(predicted: float, target: float) -> float:
    if predicted <= 0 or target <= 0:
        return math.inf
    return abs(predicted - target) / target


def _round_positive(value: float) -> int:
    return max(1, int(math.floor(float(value) + 0.5)))


def _font_size_candidates(
    lower: float,
    upper: float,
    base: float,
    step: float,
) -> list[float]:
    """Return lattice candidates spanning a reliable size range plus both neighbors."""
    lower, upper = sorted((max(0.1, float(lower)), max(0.1, float(upper))))
    base = max(0.1, float(base))
    step = max(0.1, float(step))
    first_index = math.floor((lower - base) / step)
    last_index = math.ceil((upper - base) / step)
    if last_index - first_index > 512:
        median = (lower + upper) / 2.0
        center_index = round((median - base) / step)
        first_index = center_index - 256
        last_index = center_index + 256
    candidates = {
        round(base + index * step, 6)
        for index in range(first_index, last_index + 1)
        if base + index * step > 0
    }
    if not candidates:
        candidates.add(max(0.1, base))
    return sorted(candidates)


def _candidate_fit_error(candidate: float, fits: list[dict[str, Any]]) -> float:
    errors = []
    for fit in fits:
        target_width = float(fit.get('target_width') or 0)
        target_height = float(fit.get('target_height') or 0)
        width_ratio = float(fit.get('font_width_ratio') or 0)
        height_ratio = float(fit.get('font_height_ratio') or 0)
        width_error = _relative_error(width_ratio * candidate, target_width)
        height_error = _relative_error(height_ratio * candidate, target_height)
        if math.isfinite(width_error) and math.isfinite(height_error):
            errors.append((width_error + height_error) / 2.0)
    return float(statistics.mean(errors)) if errors else math.inf


def fit_character_pixel_size(
    character: str,
    box: dict[str, Any],
    orientation: str,
    metrics_path: str | Path = DEFAULT_METRICS_PATH,
) -> dict[str, Any] | None:
    """Infer one character's font size directly from cached glyph ratios."""
    target_width, target_height = _box_size(box)
    ratios = character_ink_ratio(character, metrics_path)
    if target_width <= 0 or target_height <= 0 or ratios is None:
        return None
    width_ratio, height_ratio = ratios
    width_size = target_width / width_ratio
    height_size = target_height / height_ratio
    estimated_size = (width_size + height_size) / 2.0
    width_weight, height_weight = 0.5, 0.5
    size_dimension = 'width_height'
    axis_size_disagreement = abs(width_size - height_size) / max(width_size, height_size)
    pixel_size = _round_positive(estimated_size)
    rendered_width = width_ratio * pixel_size
    rendered_height = height_ratio * pixel_size
    width_error = _relative_error(rendered_width, target_width)
    height_error = _relative_error(rendered_height, target_height)
    error = width_error * width_weight + height_error * height_weight
    return {
        'character': character,
        'estimated_pixel_size': round(float(estimated_size), 3),
        'pixel_size': pixel_size,
        'error': round(float(error), 4),
        'target_width': round(target_width, 2),
        'target_height': round(target_height, 2),
        'rendered_width': round(float(rendered_width), 2),
        'rendered_height': round(float(rendered_height), 2),
        'font_width_ratio': width_ratio,
        'font_height_ratio': height_ratio,
        'width_estimated_pixel_size': round(float(width_size), 3),
        'height_estimated_pixel_size': round(float(height_size), 3),
        'axis_size_disagreement': round(float(axis_size_disagreement), 4),
        'size_dimension': size_dimension,
        'bbox': box.get('bbox'),
    }


def _median_absolute_deviation(values: list[float]) -> tuple[float, float]:
    median = float(statistics.median(values))
    mad = float(statistics.median(abs(value - median) for value in values))
    return median, mad


def _deduplicate_character_fits(fits: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Count the same glyph covered by overlapping OCR lines only once.

    Prefer the fuller accepted ink box. Adjacent repeated glyphs and samples
    without a usable position remain independent.
    """
    def area(fit):
        box = fit.get('bbox')
        if not isinstance(box, list) or len(box) != 4:
            return 0.0
        return max(0.0, box[2] - box[0]) * max(0.0, box[3] - box[1])

    kept = []
    for fit in sorted(fits, key=area, reverse=True):
        size = area(fit)
        duplicate = None
        if size > 0:
            a = fit['bbox']
            for other in kept:
                if (other.get('character') != fit.get('character')
                        or other.get('line_index') == fit.get('line_index') or area(other) <= 0):
                    continue
                b = other['bbox']
                overlap = max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))
                if overlap / (size + area(other) - overlap) >= 0.8:
                    duplicate = other
                    break
        if duplicate is None:
            kept.append(fit)
        else:
            fit['accepted'] = False
            fit['reason'] = 'duplicate_overlapping_character'
            fit['duplicate_of'] = {key: duplicate.get(key) for key in ('line_index', 'character_index')}
    return [fit for fit in fits if fit.get('accepted')]


def fit_ocr_item(
    item: dict[str, Any],
    *,
    font_path: str | Path = DEFAULT_FONT_PATH,
    metrics_path: str | Path = DEFAULT_METRICS_PATH,
    maximum_fit_error: float = 0.45,
    maximum_axis_size_disagreement: float = 0.35,
    minimum_reliable_characters: int = 1,
    default_font_size: float = DEFAULT_FONT_SIZE_BASE,
    font_size_step: float = DEFAULT_FONT_SIZE_STEP,
) -> dict[str, Any]:
    validate_font_ink_metrics(font_path, metrics_path)
    orientation = str(item.get('orientation') or 'vertical')
    character_results = []
    accepted_fits = []
    accepted_boxes = []
    for character_item in item.get('ocr_characters', []) or []:
        if not isinstance(character_item, dict):
            continue
        characters = ocr_characters(character_item.get('ocr_text'))
        result = {
            'line_index': character_item.get('line_index'),
            'character_index': character_item.get('character_index'),
            'ocr_text': character_item.get('ocr_text') or '',
            'ocr_probability': float(character_item.get('ocr_probability') or 0),
            'bbox': character_item.get('bbox'),
            'accepted': False,
        }
        if character_item.get('status') != 'accepted':
            result['reason'] = str(character_item.get('status') or 'ocr_rejected')
        elif len(characters) != 1:
            result['reason'] = 'not_single_character'
        else:
            fit = fit_character_pixel_size(
                characters[0],
                character_item,
                orientation,
                metrics_path,
            )
            if fit is None:
                result['reason'] = 'font_metric_unavailable'
            else:
                result.update(fit)
                axis_disagreement = float(fit['axis_size_disagreement'])
                result['accepted'] = (
                    float(fit['error']) <= maximum_fit_error
                    and axis_disagreement <= maximum_axis_size_disagreement
                )
                if result['accepted']:
                    accepted_fits.append(result)
                    accepted_boxes.append(character_item)
                elif axis_disagreement > maximum_axis_size_disagreement:
                    result['reason'] = 'width_height_size_disagree'
                else:
                    result['reason'] = 'fit_error_too_large'
        character_results.append(result)

    accepted_fits = _deduplicate_character_fits(accepted_fits)
    sizes = [float(fit['estimated_pixel_size']) for fit in accepted_fits]
    if not sizes:
        status = 'no_reliable_characters'
        robust_fits: list[dict[str, Any]] = []
        median = None
        mad = None
    else:
        median, mad = _median_absolute_deviation(sizes)
        tolerance = max(2.0, mad * 3.0)
        robust_fits = [
            fit
            for fit in accepted_fits
            if abs(float(fit['estimated_pixel_size']) - median) <= tolerance
        ]
        robust_ids = {id(fit) for fit in robust_fits}
        for fit in accepted_fits:
            if id(fit) not in robust_ids:
                fit['accepted'] = False
                fit['reason'] = 'font_size_outlier'
        status = 'ready' if len(robust_fits) >= minimum_reliable_characters else 'too_few_reliable_characters'

    robust_sizes = [float(fit['estimated_pixel_size']) for fit in robust_fits]
    continuous_median = float(statistics.median(robust_sizes)) if status == 'ready' else None
    reliable_range = (
        [round(min(robust_sizes), 3), round(max(robust_sizes), 3)]
        if robust_sizes
        else None
    )
    if status == 'ready' and reliable_range is not None and continuous_median is not None:
        candidates = _font_size_candidates(
            reliable_range[0],
            reliable_range[1],
            default_font_size,
            font_size_step,
        )
        candidate_scores = [
            {
                'font_size': round(float(candidate), 1),
                'error': round(_candidate_fit_error(candidate, robust_fits), 6),
            }
            for candidate in candidates
        ]
        selected_candidate = min(
            candidate_scores,
            key=lambda candidate: (
                float(candidate['error']),
                abs(float(candidate['font_size']) - continuous_median),
                float(candidate['font_size']),
            ),
        )
        suggested_float = round(float(selected_candidate['font_size']), 1)
    else:
        candidate_scores = []
        suggested_float = None
    suggested = suggested_float
    robust_positions = {
        (fit.get('line_index'), fit.get('character_index'))
        for fit in robust_fits
    }
    filtered_boxes = [
        dict(box)
        for box in accepted_boxes
        if (box.get('line_index'), box.get('character_index')) in robust_positions
    ]
    return {
        'status': status,
        'font_path': str(Path(font_path)),
        'metrics_path': str(Path(metrics_path)),
        'original_font_size': float(item.get('font_size') or 0),
        'suggested_font_size': suggested,
        'suggested_font_size_float': suggested_float,
        'continuous_font_size_median': round(continuous_median, 3) if continuous_median is not None else None,
        'reliable_font_size_range': reliable_range,
        'default_font_size': round(float(default_font_size), 1),
        'font_size_step': round(float(font_size_step), 1),
        'candidate_scores': candidate_scores,
        'accepted_character_count': len(robust_fits),
        'rejected_character_count': max(0, len(character_results) - len(robust_fits)),
        'total_fitted_character_count': len(accepted_fits),
        'minimum_reliable_characters': minimum_reliable_characters,
        'maximum_axis_size_disagreement': maximum_axis_size_disagreement,
        'median_before_outlier_filter': round(float(median), 2) if median is not None else None,
        'mad': round(float(mad), 2) if mad is not None else None,
        'character_results': character_results,
        'filtered_char_boxes': filtered_boxes,
    }


def _item_xyxy(item: dict[str, Any]) -> tuple[float, float, float, float] | None:
    value = item.get('xyxy_pixel')
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        return None
    try:
        x1, y1, x2, y2 = [float(part) for part in value]
    except (TypeError, ValueError):
        return None
    if x2 <= x1 or y2 <= y1:
        return None
    return x1, y1, x2, y2


def _box_iou(
    left: tuple[float, float, float, float],
    right: tuple[float, float, float, float],
) -> float:
    ix1 = max(left[0], right[0])
    iy1 = max(left[1], right[1])
    ix2 = min(left[2], right[2])
    iy2 = min(left[3], right[3])
    intersection = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    if intersection <= 0:
        return 0.0
    left_area = (left[2] - left[0]) * (left[3] - left[1])
    right_area = (right[2] - right[0]) * (right[3] - right[1])
    union = left_area + right_area - intersection
    return intersection / union if union > 0 else 0.0


def _inherit_overlapping_ready_fits(
    output: dict[str, Any],
    minimum_iou: float = 0.85,
) -> int:
    inherited = 0
    for items in (output.get('pages') or {}).values():
        if not isinstance(items, list):
            continue
        donors = [
            item
            for item in items
            if isinstance(item, dict)
            and (item.get('font_fit') or {}).get('status') == 'ready'
            and _item_xyxy(item) is not None
        ]
        for target in items:
            if not isinstance(target, dict):
                continue
            target_fit = target.get('font_fit') or {}
            if (
                target_fit.get('status') != 'no_reliable_characters'
                or target.get('ocr_lines')
                or target.get('ocr_characters')
            ):
                continue
            target_box = _item_xyxy(target)
            if target_box is None:
                continue
            target_orientation = str(target.get('orientation') or 'vertical')
            candidates = []
            for donor in donors:
                if donor is target or str(donor.get('orientation') or 'vertical') != target_orientation:
                    continue
                donor_box = _item_xyxy(donor)
                if donor_box is None:
                    continue
                overlap = _box_iou(target_box, donor_box)
                if overlap >= minimum_iou:
                    candidates.append((overlap, donor))
            if not candidates:
                continue
            overlap, donor = max(
                candidates,
                key=lambda entry: (
                    entry[0],
                    int((entry[1].get('font_fit') or {}).get('accepted_character_count') or 0),
                ),
            )
            donor_fit = donor.get('font_fit') or {}
            for key in (
                'suggested_font_size',
                'suggested_font_size_float',
                'continuous_font_size_median',
                'reliable_font_size_range',
                'default_font_size',
                'font_size_step',
                'candidate_scores',
            ):
                target_fit[key] = donor_fit.get(key)
            target_fit.update({
                'status': 'ready_overlap_inherited',
                'inherited_overlap_iou': round(float(overlap), 4),
                'inherited_from_source_block_index': donor.get('source_block_index'),
                'inherited_from_measure_item_index': donor.get('measure_item_index'),
            })
            target['font_fit'] = target_fit
            inherited += 1
    return inherited


def calibrate_ocr_output(
    output: dict[str, Any],
    font_path: str | Path = DEFAULT_FONT_PATH,
    metrics_path: str | Path = DEFAULT_METRICS_PATH,
    default_font_size: float = DEFAULT_FONT_SIZE_BASE,
    font_size_step: float = DEFAULT_FONT_SIZE_STEP,
) -> int:
    metrics = validate_font_ink_metrics(font_path, metrics_path)
    for items in (output.get('pages') or {}).values():
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            fit = fit_ocr_item(
                item,
                font_path=font_path,
                metrics_path=metrics_path,
                default_font_size=default_font_size,
                font_size_step=font_size_step,
            )
            item['font_fit'] = fit
    inherited = _inherit_overlapping_ready_fits(output)
    ready = sum(
        1
        for items in (output.get('pages') or {}).values()
        if isinstance(items, list)
        for item in items
        if isinstance(item, dict)
        and (item.get('font_fit') or {}).get('status') in {'ready', 'ready_overlap_inherited'}
    )
    output['font_calibration'] = {
        'method': 'mit48_cached_font_ink_candidate_grid',
        'font_path': str(Path(font_path)),
        'metrics_path': str(Path(metrics_path)),
        'font_sha256': (metrics.get('font') or {}).get('sha256'),
        'glyph_count': (metrics.get('counts') or {}).get('glyph_count'),
        'rounding': 'candidate_grid_one_decimal',
        'default_font_size': round(float(default_font_size), 1),
        'font_size_step': round(float(font_size_step), 1),
        'minimum_reliable_characters': 1,
        'overlap_inherited_count': inherited,
        'overlap_inheritance_minimum_iou': 0.85,
    }
    return ready
