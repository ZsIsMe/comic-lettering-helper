"""Conservative, diagnostic contour completion; never changes layout ownership.

Visible straight sides suggest a rectangle; curved sides use reflected outlines.
These are hypotheses, not recovered ground truth. Added pixels are restricted
to the original shared balloon. The existing disjoint regions stay unchanged.
"""
import cv2
import numpy as np


def reflect_mask(mask, axis):
    """Reflect about a Euclidean line, including tilted symmetry axes."""
    point = np.asarray(axis['point'], dtype=float)
    direction = np.asarray(axis['direction'], dtype=float)
    direction /= np.linalg.norm(direction)
    rotation = 2*np.outer(direction, direction)-np.eye(2)
    transform = np.column_stack((rotation, point-rotation@point))
    return cv2.warpAffine(mask, transform, (mask.shape[1], mask.shape[0]),
                          flags=cv2.INTER_NEAREST, borderValue=0)


def symmetry_error(mask, axis):
    reflected = reflect_mask(mask, axis) > 0
    original = mask > 0
    return float(np.count_nonzero(original ^ reflected)/max(1, np.count_nonzero(original | reflected)))


def mirrored_outline(region, excluded, cuts):
    """Infer an axis from scanlines with BOTH original sides still visible.

    The artificial cut, OCR boxes and text centers supply no axis coordinates.
    A tilted axis needs evidence in both halves; otherwise retain a conservative
    upright/horizontal axis and record the limited support explicitly.
    """
    longest = max(cuts, key=lambda c: np.linalg.norm(np.array(c['b'])-c['a']))
    delta = np.array(longest['b'])-longest['a']
    transpose = abs(delta[0]) > abs(delta[1])
    work = region.T if transpose else region
    ignored = excluded.T if transpose else excluded
    x, y, width, height = cv2.boundingRect(work)
    rows = []
    for row in range(y+2, y+height-2):
        occupied = np.flatnonzero(work[row])
        if not len(occupied):
            continue
        left, right = int(occupied[0]), int(occupied[-1])
        if (right-left < max(12, width*.2) or ignored[row, left] or ignored[row, right]
                or left < 2 or right >= work.shape[1]-2):
            continue
        rows.append((row, (left+right)/2))
    if len(rows) < 8:
        return None, {'status': 'insufficient_symmetry_evidence', 'axis_samples': len(rows)}
    samples = np.asarray(rows)
    mid_y = y+(height-1)/2
    t, centers = samples[:, 0]-mid_y, samples[:, 1]
    span = float(np.ptp(samples[:, 0])/height)
    bilateral = (np.count_nonzero(t < -.2*height) >= 5
                 and np.count_nonzero(t > .2*height) >= 5 and span > .55)
    slope = 0.0
    center = float(np.median(centers))
    if bilateral:
        keep = np.ones(len(t), dtype=bool)
        for _ in range(4):
            slope, center = np.polyfit(t[keep], centers[keep], 1)
            residual = np.abs(centers-(slope*t+center))
            keep = residual <= max(1.5, float(np.quantile(residual, .85)))
        if abs(slope) > .25:
            return None, {'status': 'unstable_symmetry_axis', 'axis_slope': float(slope)}
    residual = float(np.median(np.abs(centers-(slope*t+center))))
    if residual > max(3, width*.04):
        return None, {'status': 'asymmetric_visible_outline', 'axis_residual': residual}
    point = [float(center), float(mid_y)]
    direction = [float(slope), 1.0]
    if transpose:
        point, direction = point[::-1], direction[::-1]
    axis = {'point': point, 'direction': direction}
    reflected = reflect_mask(region, axis)
    # Reflection uses the actual outline, including non-elliptical curvature.
    # Union retains all observed pixels; the caller constrains additions to body.
    model = cv2.bitwise_or(region, reflected)
    return model, {'shape': 'mirrored_outline', 'axis': axis,
                   'axis_samples': len(rows), 'axis_support_span': span,
                   'axis_support': 'both_ends' if bilateral else 'one_end_constant',
                   'axis_residual': residual}


def complete_region(region, body, cuts):
    if not cuts:
        return region.copy(), np.zeros_like(region), {'status': 'unchanged'}
    contours = cv2.findContours(region, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)[0]
    if not contours:
        return region.copy(), np.zeros_like(region), {'status': 'empty_region'}
    contour = max(contours, key=cv2.contourArea)
    points = contour[:, 0].astype(float)
    excluded = np.zeros_like(region)
    for cut in cuts:
        cv2.line(excluded, tuple(cut['a']), tuple(cut['b']), 255, 17)
    valid = excluded[points[:, 1].astype(int), points[:, 0].astype(int)] == 0
    valid &= (points[:, 0] > 2) & (points[:, 0] < region.shape[1]-3)
    valid &= (points[:, 1] > 2) & (points[:, 1] < region.shape[0]-3)
    visible = points[valid]
    if len(visible) < 30:
        return region.copy(), np.zeros_like(region), {'status': 'insufficient_outline'}
    # Measure straight, axis-aligned evidence on both sides of each sample.
    v = np.roll(points, -8, axis=0)-np.roll(points, 8, axis=0)
    straight = np.min(np.abs(v), axis=1) / np.maximum(np.linalg.norm(v, axis=1), 1) < .08
    straight_fraction = float(np.mean(straight[valid]))
    model = np.zeros_like(region)
    x, y, w, h = cv2.boundingRect(contour)
    debug = {'straight_fraction': straight_fraction}
    if straight_fraction > .65:
        # The surviving parallel sides establish extents; no outer-box drawing
        # is used in the preview, only the inferred missing boundary is shown.
        cv2.rectangle(model, (x, y), (x+w-1, y+h-1), 255, -1)
        radius = max(2, min(10, round(min(w, h)*.03)))
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (radius*2+1, radius*2+1))
        model = cv2.morphologyEx(model, cv2.MORPH_OPEN, kernel)
        debug.update(shape='rounded_rectangle', bounds=[x, y, w, h],
                     axis={'point': [x+(w-1)/2, y+(h-1)/2], 'direction': [0., 1.]})
    else:
        model, mirror_debug = mirrored_outline(region, excluded, cuts)
        debug.update(mirror_debug)
        if model is None:
            return region.copy(), np.zeros_like(region), debug
    # Only add inferred pixels. Never replace or shrink the observed lobe.
    addition = (model > 0) & (body > 0) & (region == 0)
    added_fraction = float(addition.sum()/max(1, np.count_nonzero(region)))
    debug['added_fraction'] = added_fraction
    if added_fraction > .50:
        return region.copy(), np.zeros_like(region), {**debug, 'status': 'excessive_completion'}
    completed = region.copy()
    completed[addition] = 255
    if cv2.connectedComponents(completed, connectivity=4)[0] != 2:
        return region.copy(), np.zeros_like(region), {**debug, 'status': 'disconnected_completion'}
    debug['symmetry_error_before'] = symmetry_error(region, debug['axis'])
    debug['symmetry_error_after'] = symmetry_error(completed, debug['axis'])
    if (debug['symmetry_error_after'] > .08
            or debug['symmetry_error_after'] > debug['symmetry_error_before']+.01):
        return region.copy(), np.zeros_like(region), {**debug, 'status': 'completion_not_symmetric'}
    outline = cv2.morphologyEx(completed, cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8))
    old_neighborhood = cv2.dilate(region, np.ones((7, 7), np.uint8))
    outline[old_neighborhood > 0] = 0
    debug['status'] = 'completed' if addition.any() else 'unchanged'
    assert np.all(completed[region > 0] > 0)
    assert not np.any((completed > 0) & (body == 0))
    return completed, outline, debug


def draw_dashed_outline(image, outline, color):
    """Dash a mask boundary without joining separate missing-edge segments."""
    contours = cv2.findContours(outline, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)[0]
    for contour in contours:
        points = contour[:, 0]
        for start in range(0, len(points)-1, 22):
            cv2.polylines(image, [points[start:start+12]], False, color, 2, cv2.LINE_AA)
