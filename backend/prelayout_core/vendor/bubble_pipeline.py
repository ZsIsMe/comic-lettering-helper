"""Shared-mask splitting for the production measurement workflow (no models)."""
import cv2
import numpy as np
from prelayout_core.vendor import layout_core as core
from prelayout_core.vendor.bubble_neck_split import isolate_balloon, split_mask
from prelayout_core.vendor.bubble_completion import complete_region
from prelayout_core.vendor.preview_split_centers import group_shared_components


def constrain_layout_to_partition(layout, partition):
    """Keep the computed center, but fit the placement box inside its own lobe."""
    debug = layout['layout_debug']
    raw = debug['candidate_xyxy_raw']
    cx, cy = (raw[0]+raw[2])/2, (raw[1]+raw[3])/2
    width, height = raw[2]-raw[0], raw[3]-raw[1]

    def fits(box):
        x1, y1, x2, y2 = box
        return (0 <= x1 < x2 <= partition.shape[1] and
                0 <= y1 < y2 <= partition.shape[0] and
                bool(np.all(partition[y1:y2, x1:x2] > 0)))

    if fits(layout['new_xyxy_pixel']):
        debug['partition_constraint'] = {'applied': False, 'reason': 'already_inside'}
        return layout
    best, low, high = None, 0., 1.
    for _ in range(18):
        scale = (low+high)/2
        box = np.rint([cx-width*scale/2, cy-height*scale/2,
                       cx+width*scale/2, cy+height*scale/2]).astype(int).tolist()
        if fits(box):
            best, low = box, scale
        else:
            high = scale
    if best is None:
        debug['partition_constraint'] = {'applied': False, 'reason': 'cannot_fit'}
        return layout
    debug['unconstrained_candidate_xyxy_raw'] = raw
    debug['partition_constraint'] = {'applied': True, 'scale': low}
    debug['candidate_xyxy_raw'] = list(best)
    layout['new_xyxy_pixel'] = best
    center = core.rect_center(best)
    layout['new_center_normalized'] = core.normalized_center(best, partition.shape[1], partition.shape[0])
    debug['new_center_pixel'] = list(center)
    debug['result_rect'] = {'left': best[0], 'top': best[1],
                            'width': best[2]-best[0], 'height': best[3]-best[1]}
    return layout


def split_candidates(gray, original_gray, boxes):
    items = [{'xyxy_pixel': box} for box in boxes]
    seeds = [core.seed_from_item(item, gray.shape[1], gray.shape[0]) for item in items]
    selections = [core.get_best_component_mask(gray, item) for item in items]
    masks = [value[0] if value is not None else None for value in selections]
    candidates, groups = {}, []
    for indices in group_shared_components(masks):
        if len(indices) < 2 or masks[indices[0]] is None:
            continue
        group = {'source_block_indices': indices, 'status': 'no-neck',
                 'method': 'concavity_symmetry_v1', 'guides': []}
        groups.append(group)
        body, cleanup = isolate_balloon(gray, masks[indices[0]], [seeds[i] for i in indices])
        group['cleanup'] = cleanup
        if body is None:
            group['reason'] = cleanup['reason']
            continue
        regions, cuts, debug = split_mask(body, [seeds[i] for i in indices],
                                         masks[indices[0]], original_gray)
        group['reason'] = debug['reason']
        if regions is None:
            continue
        group['status'] = 'neck'
        group['guides'] = [{'start': c['a'], 'end': c['b'],
                            'center': ((np.array(c['a'])+c['b'])/2).tolist(),
                            'source_block_indices': indices, 'method': 'concavity'}
                           for c in cuts]
        assert np.all(np.sum(np.stack(regions)>0, axis=0) <= 1)
        for index, region in zip(indices, regions):
            relevant = []
            nearby = cv2.dilate(region, np.ones((9, 9), np.uint8))
            for cut in cuts:
                line = np.zeros_like(region)
                cv2.line(line, tuple(cut['a']), tuple(cut['b']), 255, 1)
                if np.count_nonzero((line>0)&(nearby>0)) > .6*np.count_nonzero(line):
                    relevant.append(cut)
            completed, _, completion = complete_region(region, body, relevant)
            candidates[index] = {'partition': region, 'geometry': completed,
                                 'completion': completion}
    return candidates, groups
