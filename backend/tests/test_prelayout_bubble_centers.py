import cv2
import numpy as np

from prelayout_core.bubble_centers import balloon_centers


def contour(mask):
    return max(cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0],
               key=cv2.contourArea).reshape(-1, 2)


def test_offset_text_and_thin_tail():
    mask = np.zeros((160, 260), np.uint8)
    cv2.circle(mask, (70, 80), 45, 255, -1)
    cv2.rectangle(mask, (70, 79), (210, 81), 255, -1)
    groups = balloon_centers([contour(mask)], [[76, 60, 94, 94]], [[85, 77]], mask.shape)
    assert np.allclose(groups[0]['centers'][0], [70, 80], atol=1)


def test_shared_oval_moves_as_group_and_ambiguous_or_external_boxes_stay_put():
    mask = np.zeros((180, 220), np.uint8)
    cv2.ellipse(mask, (100, 80), (70, 50), 0, 0, 360, 255, -1)
    polygon = contour(mask)
    boxes = [[62, 62, 78, 86], [102, 62, 118, 86], [1, 1, 15, 10]]
    anchors = [[70, 74], [110, 74], [8, 5]]
    group, = balloon_centers([polygon], boxes, anchors, mask.shape)
    assert group['indices'] == [0, 1]
    assert np.allclose(np.diff(group['centers'], axis=0), [[40, 0]])
    assert not balloon_centers([polygon, polygon], boxes, anchors, mask.shape)


def test_joined_balloons_have_separate_centers():
    mask = np.zeros((160, 220), np.uint8)
    for x in [63, 143]:
        cv2.circle(mask, (x, 80), 47, 255, -1)
    groups = balloon_centers([contour(mask)], [[49, 70, 75, 92], [132, 67, 150, 91]],
                             [[65, 82], [139, 78]], mask.shape)
    assert len(groups) == 2 and all(g['split'] for g in groups)
    assert groups[0]['centers'][0][0] < 75 < 130 < groups[1]['centers'][0][0]
