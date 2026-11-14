"""Single-array NPZ overlays and in-memory image composition."""
import os
from pathlib import Path
import tempfile
import zipfile

import numpy as np
from PIL import Image

MAX_OVERLAY_PIXELS = 120_000_000


def _validate_array(array, expected_size=None):
    if array.dtype != np.uint8 or array.ndim != 3 or array.shape[2] != 4:
        raise ValueError('overlay NPZ 必須是 uint8 RGBA 陣列')
    height, width, _ = array.shape
    if min(width, height) < 1 or width * height > MAX_OVERLAY_PIXELS:
        raise ValueError('overlay NPZ 尺寸超過限制')
    if expected_size is not None and (width, height) != tuple(expected_size):
        raise ValueError('overlay NPZ 必須與原圖同尺寸')


def save_overlay(overlay, destination):
    """Atomically save one RGBA array; transparent pixels carry no RGB data."""
    if isinstance(overlay, Image.Image) and overlay.mode != 'RGBA':
        raise ValueError('overlay NPZ 必須是 uint8 RGBA 陣列')
    array = np.asarray(overlay)
    _validate_array(array)
    array = np.array(array, dtype=np.uint8, order='C', copy=True)
    array[array[:, :, 3] == 0, :3] = 0
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.overlay-', dir=destination.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            np.savez_compressed(stream, overlay=array)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
    finally:
        Path(temporary).unlink(missing_ok=True)


def load_overlay(path, expected_size=None):
    """Read an owned RGBA image after validating the NPZ header and allocation."""
    try:
        with zipfile.ZipFile(path) as archive:
            entries = archive.infolist()
            if len(entries) != 1 or entries[0].filename != 'overlay.npy':
                raise ValueError('overlay NPZ 只能包含 overlay')
            entry = entries[0]
            if entry.file_size > MAX_OVERLAY_PIXELS * 4 + 10_000:
                raise ValueError('overlay NPZ 尺寸超過限制')
            with archive.open(entry) as stream:
                version = np.lib.format.read_magic(stream)
                if version == (1, 0):
                    shape, fortran, dtype = np.lib.format.read_array_header_1_0(stream)
                elif version == (2, 0):
                    shape, fortran, dtype = np.lib.format.read_array_header_2_0(stream)
                else:
                    raise ValueError('overlay NPZ 陣列格式無效')
                if dtype != np.dtype('uint8') or len(shape) != 3 or shape[2] != 4 or fortran:
                    raise ValueError('overlay NPZ 必須是 uint8 RGBA 陣列')
                height, width, _ = shape
                if min(width, height) < 1 or width * height > MAX_OVERLAY_PIXELS:
                    raise ValueError('overlay NPZ 尺寸超過限制')
                if expected_size is not None and (width, height) != tuple(expected_size):
                    raise ValueError('overlay NPZ 必須與原圖同尺寸')
                if entry.file_size != stream.tell() + width * height * 4:
                    raise ValueError('overlay NPZ 陣列長度無效')
            with archive.open(entry) as stream:
                array = np.load(stream, allow_pickle=False)
            _validate_array(array, expected_size)
            return Image.fromarray(array).copy()
    except (OSError, zipfile.BadZipFile, EOFError, KeyError, RuntimeError, NotImplementedError) as exc:
        raise ValueError('overlay NPZ 檔案無效') from exc


def compose_inpainted(original, overlay, region=None):
    """Return an RGB preview without persisting a full-page composite.

    A region is cropped from both full-resolution inputs before blending. Alpha
    compositing is pixel-local, so this is identical to cropping the full-page
    result and avoids allocating a full-page composite for each detail tile.
    """
    with Image.open(original) as source, load_overlay(overlay, source.size) as patch:
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
