import io
import zipfile

import numpy as np
import pytest
from PIL import Image

from prelayout_core.preview import compose_inpainted, load_overlay, save_overlay
from prelayout_core.worker import finalize_output


def test_single_array_rgba_npz_roundtrip_and_composition(tmp_path):
    source = tmp_path / 'source.png'
    Image.new('RGB', (30, 40), 'white').save(source)
    patch = np.zeros((40, 30, 4), dtype=np.uint8)
    patch[5, 5] = [20, 40, 60, 255]
    patch[5, 6] = [0, 0, 0, 128]
    patch[0, 0] = [200, 20, 40, 0]
    path = tmp_path / 'patch.npz'
    save_overlay(patch, path)
    assert not list(tmp_path.glob('*.tmp'))
    with np.load(path, allow_pickle=False) as result:
        assert result.files == ['overlay']
        assert result['overlay'].dtype == np.uint8
        assert result['overlay'][0, 0].tolist() == [0, 0, 0, 0]
        assert result['overlay'][5, 5].tolist() == [20, 40, 60, 255]
    with load_overlay(path, (30, 40)) as loaded, compose_inpainted(source, path) as composed:
        assert loaded.mode == 'RGBA'
        assert composed.getpixel((0, 0)) == (255, 255, 255)
        assert composed.getpixel((5, 5)) == (20, 40, 60)
        assert composed.getpixel((6, 5)) == (127, 127, 127)
        expected = composed.crop((4, 4, 8, 8)).tobytes()
    with compose_inpainted(source, path, (4, 4, 4, 4)) as region:
        assert region.tobytes() == expected
    assert patch[0, 0].tolist() == [200, 20, 40, 0]


@pytest.mark.parametrize('array', [np.zeros((4, 5, 3), np.uint8), np.zeros((4, 5, 4), np.float32),
                                  np.zeros((0, 5, 4), np.uint8), np.zeros((4, 5), np.uint8)])
def test_saving_rejects_wrong_shape_dtype_and_empty_images(tmp_path, array):
    with pytest.raises(ValueError, match='NPZ'):
        save_overlay(array, tmp_path / 'invalid.npz')
    assert not (tmp_path / 'invalid.npz').exists()


@pytest.mark.parametrize('bad', ['extra_key', 'object', 'rgb', 'size', 'fortran', 'corrupt', 'oversized', 'truncated'])
def test_loading_rejects_invalid_npz_before_unsafe_allocation(tmp_path, bad):
    path = tmp_path / 'invalid.npz'
    array = np.zeros((4, 5, 4), np.uint8)
    if bad == 'extra_key': np.savez_compressed(path, overlay=array, other=array)
    elif bad == 'object': np.savez_compressed(path, overlay=np.zeros((4, 5, 4), object))
    elif bad == 'rgb': np.savez_compressed(path, overlay=np.zeros((4, 5, 3), np.uint8))
    elif bad == 'fortran': np.savez_compressed(path, overlay=np.asfortranarray(array))
    elif bad == 'corrupt': path.write_bytes(b'not a zip')
    elif bad in ('oversized', 'truncated'):
        content = io.BytesIO()
        shape = (120_000_001, 1, 4) if bad == 'oversized' else (4, 5, 4)
        np.lib.format.write_array_header_1_0(content, {'descr': '|u1', 'fortran_order': False, 'shape': shape})
        with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('overlay.npy', content.getvalue())
    else: np.savez_compressed(path, overlay=array)
    with pytest.raises(ValueError, match='NPZ'):
        with load_overlay(path, (6, 4) if bad == 'size' else None):
            pass


def test_finalize_preserves_raw_data_when_compact_inputs_incomplete(tmp_path):
    (tmp_path / 'measure.json').write_text('{"pages":{"1.png":[]}}')
    (tmp_path / 'measure.debug.json').write_text('{"font_size":{"1.png":[]}}')
    (tmp_path / 'measure_ocr.json').write_text('{"pages":{}}')
    progressing = tmp_path / 'progressing'; progressing.mkdir()
    sentinel = progressing / 'mask'; sentinel.write_text('keep')
    record = {'pages': [{'id': 'p1', 'name': '1.png', 'width': 5, 'height': 4}],
              'options': {'method': 'ocr_aligned'}}
    with pytest.raises(ValueError, match='OCR'):
        finalize_output(tmp_path, record)
    assert sentinel.read_text() == 'keep'
    assert (tmp_path / 'measure.debug.json').is_file()
    assert (tmp_path / 'measure_ocr.json').is_file()
