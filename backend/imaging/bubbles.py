"""MangaLens geometry and conservative fill; see NOTICE.md and LICENSE."""
from __future__ import annotations
import cv2
import numpy as np

def _tiles(shape):
    """Overlap long-page windows so small bubbles are not lost in a page resize."""
    h, w = shape[:2]
    vertical = h >= w
    long_side, short_side = max(h, w), min(h, w)
    if long_side <= short_side * 2.5:
        yield 0, 0, w, h
        return
    length = min(long_side, short_side * 2)
    step = max(1, length - short_side // 2)
    starts = list(range(0, long_side - length + 1, step))
    if starts[-1] != long_side - length:
        starts.append(long_side - length)
    for start in starts:
        yield (0, start, w, start + length) if vertical else (start, 0, start + length, h)

def _polygon_mask(polygon, shape):
    mask = np.zeros(shape, dtype=np.uint8)
    points = np.rint(polygon).astype(np.int32)
    points[:, 0] = np.clip(points[:, 0], 0, shape[1]-1)
    points[:, 1] = np.clip(points[:, 1], 0, shape[0]-1)
    cv2.fillPoly(mask, [points], 255)
    return mask

def _deduplicate(polygons, shape):
    kept = []
    # Largest complete instance wins when overlapping long-page windows agree.
    for p in sorted(polygons, key=lambda a: abs(cv2.contourArea(a)), reverse=True):
        x, y, w, h = cv2.boundingRect(p)
        duplicate = False
        for q in kept:
            qx, qy, qw, qh = cv2.boundingRect(q)
            if min(x+w, qx+qw) <= max(x, qx) or min(y+h, qy+qh) <= max(y, qy):
                continue
            ox, oy = min(x, qx), min(y, qy)
            roi_shape = (max(y+h, qy+qh)-oy, max(x+w, qx+qw)-ox)
            a = _polygon_mask(p - [ox, oy], roi_shape) > 0
            b = _polygon_mask(q - [ox, oy], roi_shape) > 0
            if np.count_nonzero(a & b) / max(1, np.count_nonzero(a | b)) > 0.7:
                duplicate = True
                break
        if not duplicate:
            kept.append(p)
    return kept

def spatial_spread(image: np.ndarray, sample: np.ndarray) -> tuple[float, int]:
    """Compare 4x4 spatial medians; histogram alone cannot reject gradients."""
    ys, xs = np.where(sample)
    if not len(xs):
        return 255.0, 0
    colors = []
    for yy in np.array_split(np.arange(ys.min(), ys.max()+1), 4):
        for xx in np.array_split(np.arange(xs.min(), xs.max()+1), 4):
            if not len(yy) or not len(xx):
                continue
            crop = sample[yy[0]:yy[-1]+1, xx[0]:xx[-1]+1]
            if np.count_nonzero(crop) >= 8:
                colors.append(np.median(image[yy[0]:yy[-1]+1, xx[0]:xx[-1]+1][crop], axis=0))
    if not colors:
        return 255.0, 0
    return float(np.ptp(np.asarray(colors), axis=0).max()), len(colors)

def _quality(image, safe, text, protected):
    area = int(np.count_nonzero(safe))
    excluded = cv2.dilate(text.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    sample = safe & ~excluded
    pixels = int(np.count_nonzero(sample))
    debug = {'sample_pixels': pixels, 'safe_pixels': area, 'accepted': False}
    def reject(reason):
        debug['reason'] = reason
        return None, sample, debug
    if np.any(safe & protected):
        return reject('manual_other')
    if pixels < 64 or pixels < area * 0.25:
        return reject('insufficient_background')
    color = np.median(image[sample], axis=0)
    delta = np.max(np.abs(image.astype(np.float32) - color), axis=2)
    residual = sample & (delta > 12)
    count = int(np.count_nonzero(residual))
    debug['residual_pixels'] = count
    if count / pixels > 0.015:
        return reject('too_many_residuals')
    # Assess the background separately from the question of whether every mark
    # can be erased. A few unexplained marks must not disable safe text-only
    # repairs on an otherwise verified uniform background.
    sample &= ~residual
    samples = image[sample].astype(np.float32)
    color = np.median(samples, axis=0)
    deltas = np.max(np.abs(samples-color), axis=1)
    spread, cells = spatial_spread(image, sample)
    close = float(np.mean(deltas <= 8))
    debug.update(fill_bgr=np.rint(color).astype(int).tolist(), close_ratio=close,
                 spatial_spread=spread, sampled_cells=cells)
    if cells < 4:
        return reject('insufficient_spatial_coverage')
    if spread > 5:
        return reject('gradient_or_multiple_colors')
    if close < 0.985 or np.percentile(deltas, 95) > 8:
        return reject('background_variation')
    debug['local_fallback'] = True
    if count:
        # Only a small number of short, dark marks near detected text may be
        # treated as missed strokes. Distant artwork/long emphasis lines veto.
        ys, xs = np.where(safe)
        short = min(int(np.ptp(xs))+1, int(np.ptp(ys))+1)
        distance = cv2.distanceTransform((~text).astype(np.uint8), cv2.DIST_L2, 5)
        n, labels, stats, _ = cv2.connectedComponentsWithStats(residual.astype(np.uint8), connectivity=8)
        # Tiny low-contrast compression speckles are not text/artwork. Keep a
        # separate strict budget, rather than treating all black outliers as noise.
        speckles = {idx for idx in range(1, n)
                    if stats[idx, cv2.CC_STAT_AREA] <= 4 and delta[labels == idx].max() <= 32}
        noise_pixels = sum(int(stats[idx, cv2.CC_STAT_AREA]) for idx in speckles)
        debug['compression_speckle_pixels'] = noise_pixels
        # A fixed count (formerly eight) misclassified anti-aliased fragments on
        # high-resolution/many-character pages. Area, shape and proximity below
        # constrain them independently of page resolution and character count.
        if noise_pixels > pixels * 0.005:
            return reject('texture')
        for idx in range(1, n):
            if idx in speckles:
                continue
            _, _, w, h, size = stats[idx]
            active = labels == idx
            near_edge = distance[active].max() <= max(4, short*0.03)
            if (max(w, h) > max(5, short*0.18) or size > max(8, area*0.005)
                    or distance[active].max() > max(12, short*0.15)
                    # The dark core establishes a stroke. Its anti-aliased
                    # light edge is expected and must not veto the whole mark.
                    # When the core is already masked, a nearby grey fringe
                    # can remain without any dark core in the sampled fragment.
                    or (np.min(image[active].mean(axis=1)) > color.mean()-20 and not near_edge)):
                return reject('unexplained_marks')
    debug.update(accepted=True, reason='solid')
    return np.rint(color).astype(np.uint8), sample, debug

def _protect_boundary_fragments(image, safe, text):
    """Trim small model-boundary overshoots without erasing the actual outline.

    Only components touching the safe rim, contained entirely in a narrow edge
    band and separated from detected text qualify. Interior artwork still goes
    through the whole-bubble rejection checks.
    """
    excluded = cv2.dilate(text.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    sample = safe & ~excluded
    if np.count_nonzero(sample) < 64:
        return safe, 0
    color = np.median(image[sample], axis=0)
    marks = sample & (np.abs(image.astype(np.float32)-color).max(axis=2) > 12)
    if np.count_nonzero(marks) > np.count_nonzero(sample)*0.10:
        return safe, 0
    n, labels, stats, _ = cv2.connectedComponentsWithStats(marks.astype(np.uint8), connectivity=8)
    rim_distance = cv2.distanceTransform(np.pad(safe.astype(np.uint8), 1), cv2.DIST_L2, 5)[1:-1, 1:-1]
    text_distance = cv2.distanceTransform((~text).astype(np.uint8), cv2.DIST_L2, 5)
    # A small bubble has a large perimeter relative to its area. A few outline
    # pixels can exceed the old 3% budget; preserve them instead of vetoing all
    # its text. Short boundary-connected rays can also enter a model contour.
    band = max(2, min(safe.shape)*0.20)
    trim = np.zeros(safe.shape, np.uint8)
    for idx in range(1, n):
        active = labels == idx
        if (rim_distance[active].min() <= 2 and rim_distance[active].max() <= band
                and text_distance[active].min() > max(4, min(safe.shape)*0.04)):
            trim[active] = 1
    if np.count_nonzero(trim) > np.count_nonzero(safe)*0.08:
        return safe, 0
    guard = cv2.dilate(trim, np.ones((3, 3), np.uint8)) > 0
    refined = safe & ~guard
    return refined, int(np.count_nonzero(safe & guard))

def _near_text_rim(image, region, safe, text, color, protected):
    """Extend only verified text strokes into the inset, preserving real outlines.

    A whole ink component must sit inside the model contour and intersect both
    detected text and the accepted interior. Components joined to a frame or
    crossing the contour stay untouched. Background-coloured repair margins
    can be covered directly; these do not need an OTHER warning.
    """
    delta = np.abs(image.astype(np.float32)-color).max(axis=2)
    repair = cv2.dilate(text.astype(np.uint8), np.ones((7, 7), np.uint8)) > 0
    interior = cv2.erode(region.astype(np.uint8), np.ones((3, 3), np.uint8),
                         borderType=cv2.BORDER_CONSTANT, borderValue=0) > 0
    extra = (region > 0) & repair & (delta <= 8)
    ink = delta > 8
    n, labels, stats, _ = cv2.connectedComponentsWithStats(ink.astype(np.uint8), connectivity=8)
    strokes = np.zeros(text.shape, np.uint8)
    for idx in range(1, n):
        x, y, w, h, area = stats[idx]
        if area < 2:
            continue
        active = labels[y:y+h, x:x+w] == idx
        if (np.all(interior[y:y+h, x:x+w][active])
                and np.any(text[y:y+h, x:x+w][active])
                and np.count_nonzero(safe[y:y+h, x:x+w] & active) >= area*0.5):
            strokes[y:y+h, x:x+w][active] = 1
    extra |= (cv2.dilate(strokes, np.ones((3, 3), np.uint8)) > 0) & interior
    return extra & ~safe & ~protected

def _split_overlap_at_boundaries(image, text, union, expected_count):
    """Split mixed instances at image edges, without selecting by background colour.

    Text edges are excluded. Enclosed holes are restored before colour analysis,
    so drawings or screen tones cannot disappear from the background test merely
    because their edges formed closed contours.
    """
    x, y, w, h = cv2.boundingRect(union)
    crop = image[y:y+h, x:x+w]
    local_union = union[y:y+h, x:x+w] > 0
    local_text = text[y:y+h, x:x+w]
    edges = cv2.Canny(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY), 60, 120)
    text_guard = cv2.dilate(local_text.astype(np.uint8), np.ones((7, 7), np.uint8)) > 0
    edges[text_guard] = 0
    edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    barrier = cv2.dilate(edges, np.ones((3, 3), np.uint8)) > 0
    available = local_union & ~barrier
    n, labels, stats, _ = cv2.connectedComponentsWithStats(available.astype(np.uint8), connectivity=8)
    parts = []
    min_area = max(64, np.count_nonzero(local_union)*0.05)
    for idx in range(1, n):
        if stats[idx, cv2.CC_STAT_AREA] < min_area:
            continue
        component = labels == idx
        if np.count_nonzero(component & local_text) < 8:
            continue
        contours, _ = cv2.findContours(component.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        filled = np.zeros((h, w), np.uint8)
        cv2.drawContours(filled, contours, -1, 255, cv2.FILLED)
        filled[~local_union] = 0
        parts.append(filled)
    if len(parts) != expected_count:
        return None
    coverage = np.zeros((h, w), np.uint16)
    for part in parts:
        coverage += (part > 0).astype(np.uint16)
    # Reject nested/split artwork and badly fragmented masks. Each text component
    # must remain in one partition, rather than straddling a manufactured cut.
    if np.any(coverage > 1) or np.count_nonzero(coverage) < np.count_nonzero(local_union)*0.7:
        return None
    inside_text = local_text & local_union
    if np.count_nonzero((coverage > 0) & inside_text) < np.count_nonzero(inside_text)*0.95:
        return None
    n_text, text_labels, text_stats, _ = cv2.connectedComponentsWithStats(inside_text.astype(np.uint8), connectivity=8)
    for idx in range(1, n_text):
        size = text_stats[idx, cv2.CC_STAT_AREA]
        if size >= 8 and max(np.count_nonzero((part > 0) & (text_labels == idx)) for part in parts) < size*0.95:
            return None
    output = []
    for part in parts:
        full = np.zeros(union.shape, np.uint8)
        full[y:y+h, x:x+w] = part
        output.append(full)
    return output

def _resolve_overlaps(image, text, regions):
    """Resolve overlap groups, keeping ambiguous seams separate from fill regions."""
    parents = list(range(len(regions)))
    areas = [np.count_nonzero(r) for r in regions]
    pairs = []
    def find(i):
        while parents[i] != i:
            parents[i] = parents[parents[i]]
            i = parents[i]
        return i
    for i in range(len(regions)):
        for j in range(i+1, len(regions)):
            overlap = np.count_nonzero((regions[i] > 0) & (regions[j] > 0))
            if overlap:
                parents[find(j)] = find(i)
                pairs.append((i, j, overlap / min(areas[i], areas[j])))
    groups = {}
    for idx in range(len(regions)):
        groups.setdefault(find(idx), []).append(idx)
    resolved = []
    seam_guard = np.zeros(text.shape, bool)
    for ids in groups.values():
        if len(ids) == 1:
            resolved.append((regions[ids[0]], {'overlap_resolution': 'none'}))
            continue
        coverage = np.zeros(text.shape, np.uint16)
        for idx in ids:
            coverage += (regions[idx] > 0).astype(np.uint16)
        union = (coverage > 0).astype(np.uint8)*255
        overlap = coverage > 1
        meta = {'source_instances': len(ids), 'overlap_pixels': int(np.count_nonzero(overlap))}
        if not np.any(text & (union > 0)):
            continue
        large = any(ratio > 0.02 for i, j, ratio in pairs if i in ids)
        if not large:
            guard = cv2.dilate(overlap.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
            seam_guard |= guard
            for idx in ids:
                region = regions[idx].copy()
                region[guard] = 0
                resolved.append((region, dict(meta, overlap_resolution='edge_trim')))
            continue
        parts = _split_overlap_at_boundaries(image, text, union, len(ids))
        if parts is not None:
            occupied = np.zeros(text.shape, bool)
            for part in parts:
                occupied |= part > 0
                resolved.append((part, dict(meta, overlap_resolution='image_boundary_split')))
            seam_guard |= (union > 0) & ~occupied
        else:
            # A geometry failure alone must not reject reliable text-only fills.
            # This union still has to pass the background checks below, and will
            # never be painted wholesale without a reliable image partition.
            resolved.append((union, dict(meta, overlap_resolution='text_only')))
    return resolved, seam_guard

def fill_bubbles(image, text_mask, polygons, shrink_ratio=0.02, protected=None):
    """Return overlay, geometry veto, samples and diagnostics without mutating inputs.

    Background variation vetoes local-ring fills. Uniform background with a few
    uncertain marks allows existing text-only fills, with those marks protected.
    """
    shape = text_mask.shape
    text = text_mask > 0
    protected = np.zeros(shape, bool) if protected is None else protected > 0
    overlay = np.zeros((*shape, 4), np.uint8)
    veto = np.zeros(shape, np.uint8)
    samples = np.zeros(shape, np.uint8)
    records = []
    fallback = np.zeros(shape, bool)
    hard_veto = np.zeros(shape, bool)
    _, text_labels, text_stats, _ = cv2.connectedComponentsWithStats(
        text.astype(np.uint8), connectivity=8)
    regions = []
    for polygon in polygons:
        p = np.asarray(polygon, np.float32)
        if p.ndim != 2 or p.shape[1] != 2 or len(p) < 3 or not np.isfinite(p).all():
            continue
        region = _polygon_mask(p, shape)
        if np.any(region):
            regions.append(region)
    resolved, seam_guard = _resolve_overlaps(image, text, regions)
    veto[seam_guard] = 255
    hard_veto[seam_guard] = True
    for region, overlap_meta in resolved:
        if np.count_nonzero(text & (region > 0)) < 8:
            continue
        x, y, w, h = cv2.boundingRect(region)
        x1, y1, x2, y2 = max(0, x), max(0, y), min(shape[1], x+w), min(shape[0], y+h)
        if x2 <= x1 or y2 <= y1:
            continue
        r = max(1, round(min(x2-x1, y2-y1)*shrink_ratio)) if shrink_ratio else 0
        local = region[y1:y2, x1:x2]
        safe = cv2.erode(local, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2*r+1,)*2),
                         borderType=cv2.BORDER_CONSTANT, borderValue=0) > 0
        # The legacy 3px text expansion must not paint over the bubble outline
        # just outside the segmentation either.
        halo = cv2.dilate(region, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)))
        veto[halo > 0] = 255
        # Irregular regions can have overlapping bounding rectangles even after
        # their actual masks are disjoint. Neighbouring text is not owned by
        # this bubble just because it lies in that rectangle.
        local_text = text[y1:y2, x1:x2] & (local > 0)
        safe, outline_pixels = _protect_boundary_fragments(
            image[y1:y2, x1:x2], safe, local_text,
        )
        # Require most nearby detected text to be contained, not a stray
        # intersection between an exterior caption and a model bubble.
        labels, inside_counts = np.unique(text_labels[region > 0], return_counts=True)
        crossing = [idx for idx, count in zip(labels, inside_counts)
                    if idx > 0 and count < 0.7 * text_stats[idx, cv2.CC_STAT_AREA]]
        # Tiny detector islands on the outline must not veto an otherwise
        # well-contained paragraph. Keep these islands protected, including
        # their repair margin; they are not evidence for erasing the border.
        text_area = np.count_nonzero(local_text)
        tiny = [idx for idx in crossing
                if text_stats[idx, cv2.CC_STAT_AREA] <= min(64, max(8, text_area*0.005))
                and max(text_stats[idx, cv2.CC_STAT_WIDTH], text_stats[idx, cv2.CC_STAT_HEIGHT]) <= 8]
        if sum(text_stats[idx, cv2.CC_STAT_AREA] for idx in tiny) > max(8, text_area*0.005):
            tiny = []
        ignored = np.isin(text_labels[y1:y2, x1:x2], tiny) if tiny else np.zeros(local.shape, bool)
        ignored_guard = cv2.dilate(ignored.astype(np.uint8), np.ones((7, 7), np.uint8)) > 0
        safe &= ~ignored_guard
        crosses = any(idx not in tiny for idx in crossing)
        if crosses or np.count_nonzero(local_text & safe) < 0.7 * np.count_nonzero(local_text):
            hard_veto[halo > 0] = True
            records.append(dict(overlap_meta, accepted=False, reason='text_crosses_boundary', box=[x1,y1,x2,y2]))
            continue
        color, sample, record = _quality(image[y1:y2, x1:x2], safe, local_text,
                                         protected[y1:y2, x1:x2])
        record['box'] = [x1, y1, x2, y2]
        record['inset_px'] = r
        record['protected_outline_pixels'] = outline_pixels
        record['ignored_boundary_text_pixels'] = int(sum(text_stats[idx, cv2.CC_STAT_AREA] for idx in tiny))
        record['ignored_boundary_components'] = [text_stats[idx, :4].astype(int).tolist() for idx in tiny]
        record.update(overlap_meta)
        if color is not None and overlap_meta['overlap_resolution'] == 'text_only':
            color = None
            record.update(accepted=False, reason='overlap_text_only', local_fallback=True)
        records.append(record)
        samples[y1:y2, x1:x2][sample] = 255
        if color is not None:
            blocked = protected[y1:y2, x1:x2] | ignored_guard | seam_guard[y1:y2, x1:x2]
            rim = _near_text_rim(image[y1:y2, x1:x2], local, safe, local_text, color, blocked)
            record['recovered_rim_pixels'] = int(np.count_nonzero(rim))
            view = overlay[y1:y2, x1:x2]
            view[safe | rim, :3] = color
            view[safe | rim, 3] = 255
        elif record.get('local_fallback'):
            excluded = cv2.dilate(local_text.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
            delta = np.abs(image[y1:y2, x1:x2].astype(np.float32) - record['fill_bgr']).max(axis=2)
            uncertain = safe & ~excluded & (delta > 12)
            guard = cv2.dilate(uncertain.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
            fallback[y1:y2, x1:x2] |= safe & ~guard
        else:
            hard_veto[halo > 0] = True
    veto[fallback & ~hard_veto] = 0
    overlay[seam_guard] = 0
    return overlay, veto, samples, records
