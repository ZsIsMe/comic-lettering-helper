"""Compose CTD's transparent inpainted layer into a full-page preview."""
from pathlib import Path

from PIL import Image


def compose_inpainted(original, overlay, region=None):
    """Return an RGB preview without persisting a full-page composite.

    A region is cropped from both full-resolution inputs before blending. Alpha
    compositing is pixel-local, so this is identical to cropping the full-page
    result and avoids allocating a full-page composite for each detail tile.
    """
    with Image.open(original) as source, Image.open(overlay) as patch:
        if patch.format != 'PNG' or patch.mode != 'RGBA' or patch.size != source.size:
            raise ValueError('inpainted 必須是與原圖同尺寸的 RGBA PNG')
        if region is not None:
            x, y, w, h = region
            box = (x, y, x + w, y + h)
            with source.crop(box) as source_region, patch.crop(box) as patch_region:
                with source_region.convert('RGBA') as background:
                    with Image.alpha_composite(background, patch_region) as combined:
                        return combined.convert('RGB')
        with source.convert('RGBA') as background:
            with Image.alpha_composite(background, patch) as combined:
                return combined.convert('RGB')


def composite_inpainted(original, overlay, destination):
    with compose_inpainted(original, overlay) as output:
        Path(destination).parent.mkdir(parents=True, exist_ok=True)
        output.save(destination, 'PNG')
