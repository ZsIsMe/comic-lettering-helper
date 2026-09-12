"""Original-pixel grid whitening; no model or desktop dependencies.

Guide geometry follows EdgeWhite bdfbe8b8 (Models.swift / ImageExporter.swift).
Rectangles use [left, right) × [top, bottom) throughout.
"""
from __future__ import annotations

import io
from pathlib import Path

from PIL import Image, ImageCms
from pydantic import BaseModel, ConfigDict, Field, StrictInt

MAX_PIXELS = 40_000_000
MAX_GUIDES = 128


class Cell(BaseModel):
    model_config = ConfigDict(extra='forbid')
    column: StrictInt = Field(ge=0)
    row: StrictInt = Field(ge=0)


class Edit(BaseModel):
    model_config = ConfigDict(extra='forbid')
    verticalGuides: list[StrictInt] = Field(default_factory=list, max_length=MAX_GUIDES)
    horizontalGuides: list[StrictInt] = Field(default_factory=list, max_length=MAX_GUIDES)
    selectedCells: list[Cell] = Field(default_factory=list, max_length=(MAX_GUIDES + 1) ** 2)


def validate_edit(edit: Edit, width: int, height: int) -> dict:
    for positions, dimension in [(edit.verticalGuides, width), (edit.horizontalGuides, height)]:
        if positions != sorted(set(positions)) or any(p <= 0 or p >= dimension for p in positions):
            raise ValueError('參考線必須排序、不重複且位於圖片內部')
    seen = set()
    for cell in edit.selectedCells:
        key = (cell.column, cell.row)
        if (key in seen or cell.column > len(edit.verticalGuides) or cell.row > len(edit.horizontalGuides)
                or not (edit.verticalGuides or edit.horizontalGuides)):
            raise ValueError('網格選區重複或超出參考線範圍')
        seen.add(key)
    result = edit.model_dump()
    result['selectedCells'].sort(key=lambda c: (c['row'], c['column']))
    return result


def normalize(source: Path, target: Path) -> tuple[int, int]:
    with Image.open(source) as im:
        if im.format not in {'PNG', 'JPEG'}:
            raise ValueError('圖片只接受 PNG／JPG／JPEG')
        if im.width < 1 or im.height < 1 or im.width * im.height > MAX_PIXELS:
            raise ValueError('單張圖片須在 4000 萬像素以內')
        if getattr(im, 'n_frames', 1) != 1:
            raise ValueError('請將動畫整理成單張圖片')
        if im.getexif().get(274, 1) != 1:
            raise ValueError('圖片含旋轉方向資訊，請先整理像素方向後再匯入')
        alpha = im.convert('RGBA').getchannel('A')
        profile = im.info.get('icc_profile')
        if profile:
            try:
                color = ImageCms.profileToProfile(im, ImageCms.ImageCmsProfile(io.BytesIO(profile)),
                    ImageCms.createProfile('sRGB'), outputMode='RGB')
            except (ImageCms.PyCMSError, OSError, ValueError) as exc:
                raise ValueError('無法轉換圖片色彩描述檔，請先轉成 sRGB PNG') from exc
        else:
            color = im.convert('RGB')
        rgb = Image.new('RGB', im.size, 'white')
        rgb.paste(color, mask=alpha)
        # Drop source EXIF/ICC metadata; pixels are normalized sRGB with orientation unchanged.
        rgb.info.clear()
        rgb.save(target, format='PNG')
        return rgb.size


def render(source: Path, target: Path, edit: dict) -> None:
    with Image.open(source) as original:
        image = original.convert('RGB')
    edit = validate_edit(Edit.model_validate(edit), image.width, image.height)
    xs = [0, *edit['verticalGuides'], image.width]
    ys = [0, *edit['horizontalGuides'], image.height]
    for cell in edit['selectedCells']:
        x, y = cell['column'], cell['row']
        image.paste((255, 255, 255), (xs[x], ys[y], xs[x + 1], ys[y + 1]))
    image.save(target, format='PNG')
