"""Compose CTD's transparent inpainted layer into a full-page preview."""
from pathlib import Path

from PIL import Image


def composite_inpainted(original, overlay, destination):
    with Image.open(original) as source, Image.open(overlay) as patch:
        if patch.format != 'PNG' or patch.mode != 'RGBA' or patch.size != source.size:
            raise ValueError('inpainted 必須是與原圖同尺寸的 RGBA PNG')
        with source.convert('RGBA') as background:
            with Image.alpha_composite(background, patch) as combined:
                with combined.convert('RGB') as output:
                    Path(destination).parent.mkdir(parents=True, exist_ok=True)
                    output.save(destination, 'PNG')
