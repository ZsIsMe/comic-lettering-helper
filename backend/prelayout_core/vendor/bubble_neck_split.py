"""Split closed balloon masks by pairing concave contour points.

Only contour evidence proposes cuts. Text centers validate ownership; they do
not define the cut angle. Every displayed cut is applied to the returned masks.
"""
from __future__ import annotations

import itertools
import cv2
import numpy as np


def isolate_balloon(gray, mask, seeds):
    """Close thin escape routes using erosion, seed selection and dilation.

    Reconstruction is limited to one dilation; geodesic reconstruction would
    follow the same escape route back into the page. Long horizontal panel
    borders close balloons clipped by a panel edge.
    """
    seeds = np.rint(seeds).astype(int)
    raw_x,raw_y,raw_w,raw_h = cv2.boundingRect(cv2.findNonZero(mask))
    page_leak = sum((raw_x==0,raw_y==0,raw_x+raw_w==mask.shape[1],raw_y+raw_h==mask.shape[0])) >= 3
    selected = mask.copy()
    trials = []
    previous_area = None
    for radius in (2, 4, 6, 8, 10, 12, 15, 18, 22, 28):
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2*radius+1, 2*radius+1))
        eroded = cv2.erode(mask, kernel)
        _, labels = cv2.connectedComponents(eroded, connectivity=4)
        owners = [int(labels[y,x]) for x,y in seeds]
        if 0 in owners:
            break
        body = np.isin(labels, owners).astype(np.uint8)*255
        restored = cv2.bitwise_and(cv2.dilate(body, kernel), mask)
        area = int(cv2.countNonZero(restored))
        x,y,w,h = cv2.boundingRect(cv2.findNonZero(restored))
        edges = sum((x==0,y==0,x+w==mask.shape[1],y+h==mask.shape[0]))
        trials.append({'radius':radius,'area':area,'page_edges':edges})
        selected = restored
        if radius >= 6 and edges < 3 and previous_area is not None and abs(area-previous_area)/max(area,1) < .02:
            break
        previous_area = area
    # A speech balloon touching a panel's top/bottom can share the white gutter.
    # Restrict only at an observed long, dark horizontal border outside all seeds.
    dark = (gray < 80).astype(np.uint8)
    lines = cv2.morphologyEx(dark, cv2.MORPH_OPEN, np.ones((1,80),np.uint8))
    rows = np.where(lines.sum(axis=1) > gray.shape[1]*.4)[0]
    x,y,w,h = cv2.boundingRect(cv2.findNonZero(selected))
    # Require evidence on both sides of the group's horizontal center.
    cx = int(np.mean(seeds[:,0]))
    rows = [int(row) for row in rows if np.any(lines[row,max(0,x-100):cx])
            and np.any(lines[row,cx:min(gray.shape[1],x+w+100)])]
    above = [row for row in rows if row < seeds[:,1].min()]
    below = [row for row in rows if row > seeds[:,1].max()]
    top = max(above)+1 if above and page_leak else 0
    bottom = min(below) if below and page_leak else gray.shape[0]
    selected[:top] = 0
    selected[bottom:] = 0
    _, labels = cv2.connectedComponents(selected, connectivity=4)
    owners = [int(labels[sy,sx]) for sx,sy in seeds]
    if 0 in owners:
        return None, {'reason':'seed_removed_by_boundary', 'trials':trials}
    selected = np.isin(labels,owners).astype(np.uint8)*255
    return selected, {'reason':None, 'trials':trials, 'panel_y':[top,bottom],
                      'raw_area':int(cv2.countNonZero(mask)), 'body_area':int(cv2.countNonZero(selected))}


def concavities(mask):
    contours = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)[0]
    if not contours:
        return []
    contour = max(contours, key=cv2.contourArea)
    points = contour[:, 0, :].astype(np.float64)
    if cv2.contourArea(contour, oriented=True) > 0:
        points = points[::-1]
    window = max(8, min(24, int(len(points) * .02)))
    before, after = np.roll(points, window, axis=0), np.roll(points, -window, axis=0)
    chord = after - before
    offset = points - before
    depth = -(chord[:, 0] * offset[:, 1] - chord[:, 1] * offset[:, 0]) / np.maximum(np.linalg.norm(chord, axis=1), 1)
    selected = []
    for index in np.argsort(-depth):
        if depth[index] < max(2.5, window * .14):
            break
        if any(np.linalg.norm(points[index] - point['point']) < window for point in selected):
            continue
        selected.append({'point': points[index].astype(int).tolist(), 'depth': float(depth[index])})
    return selected


def refine_notches(notches, raw_mask, original_gray):
    """Snap proposals to unsmoothed contour concavity, then adjacent source ink."""
    point_sets, score_sets = [], []
    for contour in cv2.findContours(raw_mask,cv2.RETR_LIST,cv2.CHAIN_APPROX_NONE)[0]:
        if len(contour)<50:
            continue
        points=contour[:,0,:].astype(float)
        scales=[]
        for window in (8,12,20):
            a,b=np.roll(points,window,axis=0),np.roll(points,-window,axis=0)
            v,o=b-a,points-a
            scales.append(-(v[:,0]*o[:,1]-v[:,1]*o[:,0])/np.maximum(np.linalg.norm(v,axis=1),1)/window)
        point_sets.append(points)
        score_sets.append(np.mean(scales,axis=0))
    if not point_sets:
        return notches
    points,scores=np.concatenate(point_sets),np.concatenate(score_sets)
    refined=[]
    for notch in notches:
        proposed=np.array(notch['point'])
        distances=np.linalg.norm(points-proposed,axis=1)
        nearby=np.where((distances<=16)&(scores>.15))[0]
        point=proposed
        if len(nearby):
            best=nearby[np.argmax(scores[nearby]-.01*distances[nearby])]
            point=points[best].astype(int)
        x,y=point
        x1,y1=max(0,x-4),max(0,y-4)
        x2,y2=min(original_gray.shape[1],x+5),min(original_gray.shape[0],y+5)
        yy,xx=np.where(original_gray[y1:y2,x1:x2]<128)
        if len(xx):
            ink=np.column_stack([xx+x1,yy+y1])
            point=ink[np.argmin(np.linalg.norm(ink-point,axis=1))]
        refined.append({**notch,'proposal':notch['point'],'point':point.tolist(),
                        'snap_distance':float(np.linalg.norm(point-proposed))})
    return refined


def split_mask(mask, seeds, raw_mask=None, original_gray=None):
    """Return disjoint seed regions and the exact cuts, or an explicit failure."""
    seeds = np.rint(seeds).astype(int)
    if any(not (0 <= x < mask.shape[1] and 0 <= y < mask.shape[0]) or mask[y, x] == 0 for x, y in seeds):
        return None, [], {'reason': 'seed_outside_mask'}
    if len(seeds) == 1:
        _, labels = cv2.connectedComponents(mask, connectivity=4)
        x, y = seeds[0]
        region = (labels == labels[y,x]).astype(np.uint8) * 255
        return [region], [], {'reason': None, 'candidates': []}
    notches = concavities(mask)
    if raw_mask is not None and original_gray is not None:
        notches = refine_notches(notches,raw_mask,original_gray)
    candidates = []
    for first, second in itertools.combinations(notches, 2):
        a, b = np.array(first['point']), np.array(second['point'])
        length = float(np.linalg.norm(b-a))
        if length < 12:
            continue
        line = np.zeros_like(mask)
        cv2.line(line, tuple(a), tuple(b), 255, 3)
        if np.count_nonzero((line > 0) & (mask > 0)) / max(1, np.count_nonzero(line)) < .85:
            continue
        # Reject cuts through the immediate seed neighborhood.
        direction = (b-a) / length
        projected = np.clip((seeds-a) @ direction, 0, length)
        if np.min(np.linalg.norm(seeds-(a+projected[:, None]*direction), axis=1)) < 8:
            continue
        separated = mask.copy()
        separated[line > 0] = 0
        _, labels = cv2.connectedComponents(separated, connectivity=4)
        owners = [int(labels[y, x]) for x, y in seeds]
        if 0 in owners or len(set(owners)) < 2:
            continue
        strength = min(first['depth'], second['depth'])
        candidates.append({'a': a.tolist(), 'b': b.tolist(), 'length': length,
                           'score': length / max(strength, 1) ** .25, 'owners': owners})
    candidates.sort(key=lambda cut: cut['score'])
    working = mask.copy()
    selected = []
    _, labels = cv2.connectedComponents(working, connectivity=4)
    for cut in candidates:
        current = [int(labels[y, x]) for x, y in seeds]
        if len(set(current)) == len(seeds):
            break
        # Each extra cut must resolve a group that still shares a component.
        if not any(current[i] == current[j] and cut['owners'][i] != cut['owners'][j]
                   for i, j in itertools.combinations(range(len(seeds)), 2)):
            continue
        trial = working.copy()
        cv2.line(trial, tuple(cut['a']), tuple(cut['b']), 0, 3)
        _, trial_labels = cv2.connectedComponents(trial, connectivity=4)
        owners = [int(trial_labels[y, x]) for x, y in seeds]
        if 0 in owners or len(set(owners)) <= len(set(current)):
            continue
        working, labels = trial, trial_labels
        selected.append(cut)
    owners = [int(labels[y, x]) for x, y in seeds]
    debug = {'reason': None, 'notches': notches, 'candidates': candidates}
    if len(set(owners)) != len(seeds):
        debug['reason'] = 'insufficient_valid_concavity_pairs'
        return None, [], debug
    regions = [(labels == owner).astype(np.uint8) * 255 for owner in owners]
    return regions, selected, debug
