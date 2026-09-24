"""Manual, pixel-based repair bounds; geometry never changes workflow parameters."""
from PIL import Image


def full_rect(width: int, height: int) -> dict:
    return dict(x=0, y=0, width=width, height=height)


def default_rect(width: int, height: int) -> dict:
    x, y = min(10, (width - 1) // 2), min(10, (height - 1) // 2)
    return dict(x=x, y=y, width=width - 2 * x, height=height - 2 * y)


def validate_rect(value: dict, width: int, height: int) -> dict:
    if not isinstance(value, dict) or set(value) != {'x', 'y', 'width', 'height'}:
        raise ValueError('作用範圍必須包含 x、y、width、height')
    if any(type(v) is not int for v in value.values()):
        raise ValueError('作用範圍必須使用整數像素')
    x, y, w, h = (value[k] for k in ('x', 'y', 'width', 'height'))
    if x < 0 or y < 0 or w < 1 or h < 1 or x + w > width or y + h > height:
        raise ValueError('作用範圍必須位於圖片內，且寬高至少為 1 像素')
    return dict(value)


def fit_rect(rect: dict, width: int, height: int) -> dict:
    x, y = min(rect['x'], width - 1), min(rect['y'], height - 1)
    return dict(x=x, y=y, width=min(rect['width'], width - x), height=min(rect['height'], height - y))


def box(rect: dict) -> tuple[int, int, int, int]:
    return rect['x'], rect['y'], rect['x'] + rect['width'], rect['y'] + rect['height']


def scoped_mask(mask: Image.Image, rect: dict) -> Image.Image:
    result = Image.new('L', mask.size)
    result.paste(mask.crop(box(rect)), (rect['x'], rect['y']))
    return result


def paste_result(base: Image.Image, result: Image.Image, rect: dict) -> Image.Image:
    validate_rect(rect, *base.size)
    if result.size != (rect['width'], rect['height']):
        raise ValueError('修復輸出尺寸與作用範圍不一致')
    output = base.convert('RGB')
    output.paste(result.convert('RGB'), (rect['x'], rect['y']))
    return output
