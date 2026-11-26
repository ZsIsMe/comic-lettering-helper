"""Place CTD blocks at the area centroid of their MangaLens balloon body."""
from collections import defaultdict

import cv2
import numpy as np

from .vendor.bubble_neck_split import split_mask


def _body(region):
    # Open with a disk scaled to the lobe's thickness. The padding also handles
    # balloons clipped by a page edge; morphology must see the exterior as zero.
    inside = cv2.copyMakeBorder(region, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=0)
    thickness = cv2.distanceTransform(inside, cv2.DIST_L2, 5).max()
    radius = max(1, round(float(thickness) * .22))
    disk = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * radius + 1,) * 2)
    opened = cv2.morphologyEx(inside, cv2.MORPH_OPEN, disk,
                              borderType=cv2.BORDER_CONSTANT, borderValue=0)
    return cv2.bitwise_and(region, opened[1:-1, 1:-1])


def balloon_centers(polygons, boxes, anchors, shape):
    """Return accepted groups with pixel centers and their cropped body masks.

    Indices refer to source blocks. An omitted index keeps its existing anchor.
    All members of an unsplit balloon receive the same translation.
    """
    h, w = shape
    balloons = []
    for polygon in polygons:
        points = np.rint(polygon).astype(np.int32)
        points = np.clip(points, [0, 0], [w - 1, h - 1]).astype(np.int32)
        x, y, bw, bh = cv2.boundingRect(points)
        mask = np.zeros((bh, bw), np.uint8)
        cv2.fillPoly(mask, [points - (x, y)], 255)
        balloons.append((x, y, mask))

    owners = defaultdict(list)
    for i, (x1, y1, x2, y2) in enumerate(boxes):
        area = (x2 - x1) * (y2 - y1)
        if area <= 0:
            continue
        cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
        scores = []
        for j, (x, y, mask) in enumerate(balloons):
            bh, bw = mask.shape
            if not (x <= cx < x + bw and y <= cy < y + bh and mask[cy-y, cx-x]):
                continue
            crop = mask[max(0, y1-y):min(bh, y2-y), max(0, x1-x):min(bw, x2-x)]
            scores.append((cv2.countNonZero(crop) / area, j))
        scores.sort(reverse=True)
        if scores and scores[0][0] >= .70 and (len(scores) == 1 or scores[0][0] - scores[1][0] >= .15):
            owners[scores[0][1]].append(i)

    groups = []
    for j, indices in owners.items():
        x, y, mask = balloons[j]
        seeds = [((boxes[i][0]+boxes[i][2])//2-x, (boxes[i][1]+boxes[i][3])//2-y) for i in indices]
        regions = None
        if len(indices) > 1:
            regions, _, _ = split_mask(mask, seeds)
        parts = zip(([i] for i in indices), regions) if regions else [(indices, mask)]
        for members, region in parts:
            body = _body(region)
            moments = cv2.moments(body, binaryImage=True)
            if not moments['m00'] or cv2.connectedComponents(body)[0] != 2:
                continue
            centroid = np.array([moments['m10'], moments['m01']]) / moments['m00']
            size = np.array([[boxes[i][2]-boxes[i][0], boxes[i][3]-boxes[i][1]] for i in members])
            positions = np.array([anchors[i] for i in members])
            group_center = ((positions-size/2).min(axis=0) + (positions+size/2).max(axis=0)) / 2
            points = centroid + positions - group_center
            # A centroid can be outside a deeply concave region. Reject the
            # complete group rather than collapsing or moving only one member.
            checks = np.rint(np.vstack([centroid, points])).astype(int)
            if not all(0 <= px < body.shape[1] and 0 <= py < body.shape[0] and body[py, px]
                       for px, py in checks):
                continue
            groups.append({'indices': members, 'centers': (points + [x, y]).tolist(),
                           'origin': (x, y), 'body': body, 'balloon': j,
                           'split': regions is not None})
    return groups
