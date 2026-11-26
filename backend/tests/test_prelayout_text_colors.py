"""Text-tone regressions exercise masks without OCR or model dependencies."""
import cv2
import numpy as np
import pytest

from prelayout_core.vendor.analyze_text_core import _text_style


@pytest.mark.parametrize('ink,background,color', [(0, 255, 'black'), (255, 0, 'white')])
def test_background_gaps_between_strokes_do_not_become_a_reversed_fill(ink, background, color):
    image = np.full((48, 48, 3), background, dtype=np.uint8)
    mask = np.zeros((48, 48), dtype=np.uint8)
    # A broad CTD component spans a glyph's outer and central strokes as well
    # as the background between them, as in the chapter 164 false outlines.
    mask[8:40, 8:40] = 255
    image[8:40, 8:40] = ink
    image[12:36, 12:36] = background
    image[18:30, 18:30] = ink

    style = _text_style(image, mask)

    assert style['text_color'] == color
    assert style['text_has_stroke'] is False


@pytest.mark.parametrize('ink,background,color', [(0, 255, 'black'), (255, 0, 'white')])
def test_plain_strokes_keep_their_ink_color(ink, background, color):
    image = np.full((48, 48, 3), background, dtype=np.uint8)
    mask = np.zeros((48, 48), dtype=np.uint8)
    cv2.putText(mask, 'Hi', (5, 35), cv2.FONT_HERSHEY_SIMPLEX, 1, 255, 3)
    image[mask > 0] = ink

    style = _text_style(image, mask)

    assert style['text_color'] == color
    assert style['text_has_stroke'] is False


@pytest.mark.parametrize('fill,outline,color', [(255, 0, 'white'), (0, 255, 'black')])
def test_real_outlines_keep_the_inner_ink_color(fill, outline, color):
    image = np.full((48, 48, 3), fill, dtype=np.uint8)
    mask = np.zeros((48, 48), dtype=np.uint8)
    mask[8:40, 8:40] = 255
    image[8:40, 8:40] = outline
    image[12:36, 12:36] = fill

    style = _text_style(image, mask)

    assert style['text_color'] == color
    assert style['text_has_stroke'] is True


@pytest.mark.parametrize('fill,outline,color', [(255, 0, 'white'), (0, 255, 'black')])
@pytest.mark.parametrize('background', [128, 225])
def test_outlined_ring_on_gray_background_keeps_its_fill(fill, outline, color, background):
    image = np.full((48, 48, 3), background, dtype=np.uint8)
    mask = np.zeros((48, 48), dtype=np.uint8)
    mask[8:40, 8:40] = 255
    image[8:40, 8:40] = outline
    image[12:36, 12:36] = fill
    # The deep interior of an outlined ring can be its dark/light counter.
    # It must not veto the fill on a gray or illustrated background.
    image[18:30, 18:30] = outline

    style = _text_style(image, mask)

    assert style['text_color'] == color
    assert style['text_has_stroke'] is True
