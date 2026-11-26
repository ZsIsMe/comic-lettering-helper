"""Bounded font-advance estimates, in em cells, for suggestion ranking only.

Use the same bundled/default display face as the editor, including code-only
deployments which contain dist assets but no frontend source. This does not
resolve a browser's local per-item faces or reproduce full browser shaping.
"""
from __future__ import annotations

import os
import unicodedata
from functools import lru_cache
from pathlib import Path

from PIL import ImageFont

_EM = 64
_BUNDLED_FONT = 'toolbox-demibold-v2.7'


@lru_cache(maxsize=4)
def _display_font(app_root: str, custom: str, model_root: str):
    root = Path(app_root)

    def candidates():
        if custom:
            yield Path(custom).expanduser()
        yield root / 'frontend' / 'src' / 'assets' / 'fonts' / f'{_BUNDLED_FONT}.ttf'
        # One narrow, nonrecursive lookup per configuration, never a system scan.
        yield from sorted((root / 'frontend' / 'dist' / 'assets').glob(f'{_BUNDLED_FONT}-*.ttf'))
        yield Path(model_root).expanduser() / 'NotoSansCJKjp-Medium.otf'

    for path in candidates():
        try:
            return ImageFont.truetype(str(path), _EM, layout_engine=ImageFont.Layout.BASIC), False
        except (OSError, ValueError):
            continue
    # Pillow's wheel embeds this face; no font source directory is required.
    return ImageFont.load_default(size=_EM), True


def _font():
    return _display_font(
        os.getenv('COMIC_APP_ROOT', str(Path(__file__).resolve().parents[3])),
        os.getenv('COMIC_PRELAYOUT_DISPLAY_FONT', '').strip(),
        os.getenv('COMIC_PRELAYOUT_MODEL_ROOT', '/root/models/comic-prelayout'),
    )


@lru_cache(maxsize=8192)
def _advance(font, char: str) -> float:
    return max(0.0, float(font.getlength(char)) / _EM)


@lru_cache(maxsize=8192)
def _pair_advance(font, previous: str, char: str) -> float:
    # A two-glyph probe captures pair kerning without quadratic prefix shaping.
    return max(0.0, float(font.getlength(previous + char)) / _EM - _advance(font, previous))


def cumulative_widths(text: str, orientation: str = 'vertical') -> list[float]:
    """Return O(n) prefix advances; a full CJK glyph is one cell in either axis.

    Vertical text retains grid cells. Horizontal text uses actual glyph advances
    and pair kerning, normalized by the fixed em so neither font size nor canvas
    needs to change. Combining marks/joiners do not add an independent cell.
    """
    horizontal = orientation == 'horizontal'
    font, fallback = _font() if horizontal else (None, False)
    widths, width, previous = [0.0], 0.0, ''
    for char in text:
        category = unicodedata.category(char)
        if category.startswith('M') or category == 'Cf':
            widths.append(width)
            continue
        if not horizontal:
            delta = 0.0 if char.isspace() else 1.0
        elif fallback and unicodedata.east_asian_width(char) in ('W', 'F'):
            # The wheel fallback has no CJK face; its missing-glyph box is not
            # a reliable CJK width. Preserve the full-width grid in that case.
            delta = 1.0
            previous = ''
        elif char == '\t':
            delta = 8 * _advance(font, ' ')
            previous = ''
        else:
            delta = _pair_advance(font, previous, char) if previous else _advance(font, char)
            previous = char
        width += delta
        widths.append(width)
    return widths
