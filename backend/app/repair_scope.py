"""Manual, pixel-based repair bounds; geometry never changes workflow parameters."""
import json

from PIL import Image

from .storage import basename


MAX_SCOPE_BYTES = 2 * 1024 * 1024


def validate_external_scope(value: dict) -> dict:
    """Normalize portable filename keys; image bounds are checked during creation."""
    if (not isinstance(value, dict) or set(value) - {'enabled', 'revision', 'pages'}
            or type(value.get('enabled')) is not bool or not isinstance(value.get('pages'), dict)):
        raise ValueError('裁切 JSON 必須包含 enabled 開關及 pages 圖片檔名對照')
    if 'revision' in value and (type(value['revision']) is not int or value['revision'] < 0):
        raise ValueError('裁切 JSON 的 revision 必須為非負整數')
    pages = {}
    for filename, rect in value['pages'].items():
        if (not isinstance(filename, str) or not filename or '/' in filename
                or '\\' in filename or '\x00' in filename or filename.startswith('.')):
            raise ValueError('裁切 JSON 的 key 必須為完整圖片檔名，不可包含路徑或隱藏檔')
        name = basename(filename)
        if name in pages:
            raise ValueError(f'裁切 JSON 包含重複圖片檔名：{name}')
        pages[name] = rect
    return {'enabled': value['enabled'], 'revision': 0, 'pages': pages}


def parse_external_scope(data: bytes) -> dict:
    if len(data) > MAX_SCOPE_BYTES:
        raise ValueError('裁切 JSON 超過 2 MiB 大小限制')

    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f'裁切 JSON 包含重複 key：{key}')
            result[key] = value
        return result

    try:
        value = json.loads(data.decode('utf-8-sig'), object_pairs_hook=unique_object)
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError('裁切檔案必須為有效 UTF-8 JSON') from exc
    return validate_external_scope(value)


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


def is_grid(value: dict) -> bool:
    return isinstance(value, dict) and 'selectedCells' in value


def validate_scope(value: dict, width: int, height: int) -> dict:
    """Accept historical rectangles and integer-pixel, selected grid cells."""
    if not is_grid(value):
        return validate_rect(value, width, height)
    if set(value) != {'verticalGuides', 'horizontalGuides', 'selectedCells'}:
        raise ValueError('分割範圍必須包含 verticalGuides、horizontalGuides、selectedCells')
    guides = {}
    for key, bound in [('verticalGuides', width), ('horizontalGuides', height)]:
        items = value[key]
        if (not isinstance(items, list) or len(items) > 128 or any(type(item) is not int or not 0 < item < bound for item in items)
                or items != sorted(set(items))):
            raise ValueError('分割線必須使用圖片內遞增、不重複的整數像素')
        guides[key] = list(items)
    cells = value['selectedCells']
    if not isinstance(cells, list):
        raise ValueError('點亮區塊必須為陣列')
    selected = set()
    for cell in cells:
        if (not isinstance(cell, dict) or set(cell) != {'column', 'row'}
                or any(type(item) is not int for item in cell.values())
                or not 0 <= cell['column'] <= len(guides['verticalGuides'])
                or not 0 <= cell['row'] <= len(guides['horizontalGuides'])):
            raise ValueError('點亮區塊索引超出分割範圍')
        pair = (cell['row'], cell['column'])
        if pair in selected:
            raise ValueError('點亮區塊不可重複')
        selected.add(pair)
    return {**guides, 'selectedCells': [dict(column=column, row=row) for row, column in sorted(selected)]}


def scope_rects(value: dict, width: int, height: int) -> list[dict]:
    value = validate_scope(value, width, height)
    if not is_grid(value):
        return [value]
    xs = [0, *value['verticalGuides'], width]
    ys = [0, *value['horizontalGuides'], height]
    return [dict(x=xs[cell['column']], y=ys[cell['row']],
                 width=xs[cell['column'] + 1] - xs[cell['column']],
                 height=ys[cell['row'] + 1] - ys[cell['row']])
            for cell in value['selectedCells']]


def fit_scope(value: dict, width: int, height: int) -> dict:
    if not is_grid(value):
        return fit_rect(value, width, height)
    # Keep pixel positions, like legacy apply-all. Guides beyond a smaller page
    # collapse to its last internal pixel; transfer lit cells by their old interval.
    fitted = {}
    maps = {}
    for key, bound in [('verticalGuides', width), ('horizontalGuides', height)]:
        fitted[key] = sorted({min(item, bound - 1) for item in value[key] if bound > 1})
        maps[key] = [sum(guide <= start for guide in fitted[key])
                     for start in [0, *value[key]]]
    cells = {(maps['verticalGuides'][cell['column']], maps['horizontalGuides'][cell['row']])
             for cell in value['selectedCells']}
    fitted['selectedCells'] = [dict(column=column, row=row) for column, row in sorted(cells, key=lambda cell: (cell[1], cell[0]))]
    return validate_scope(fitted, width, height)


def fit_rect(rect: dict, width: int, height: int) -> dict:
    x, y = min(rect['x'], width - 1), min(rect['y'], height - 1)
    return dict(x=x, y=y, width=min(rect['width'], width - x), height=min(rect['height'], height - y))


def box(rect: dict) -> tuple[int, int, int, int]:
    return rect['x'], rect['y'], rect['x'] + rect['width'], rect['y'] + rect['height']


def scoped_mask(mask: Image.Image, rect: dict) -> Image.Image:
    result = Image.new('L', mask.size)
    for region in scope_rects(rect, *mask.size):
        result.paste(mask.crop(box(region)), (region['x'], region['y']))
    return result


def paste_result(base: Image.Image, result: Image.Image, rect: dict, *, in_place: bool = False) -> Image.Image:
    validate_rect(rect, *base.size)
    if result.size != (rect['width'], rect['height']):
        raise ValueError('修復輸出尺寸與作用範圍不一致')
    output = base if in_place and base.mode == 'RGB' else base.convert('RGB')
    output.paste(result.convert('RGB'), (rect['x'], rect['y']))
    return output
