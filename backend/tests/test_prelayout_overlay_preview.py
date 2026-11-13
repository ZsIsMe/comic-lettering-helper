import io
import json
import zipfile
from pathlib import Path

import pytest
from PIL import Image

from app.prelayout.store import PrelayoutStore, atomic_json
from prelayout_core.data import identifier
from prelayout_core.preview import compose_inpainted, save_overlay
import numpy as np


def image_bytes(image, format='PNG'):
    output = io.BytesIO()
    image.save(output, format)
    return output.getvalue()


@pytest.fixture
def overlay_project(tmp_path):
    size = (600, 900)
    pixels = bytes(channel for y in range(size[1]) for x in range(size[0])
                   for channel in ((x * 7 + y) % 256, (y * 3 + x) % 256, (x + y * 5) % 256))
    source = Image.frombytes('RGB', size, pixels)
    store = PrelayoutStore(tmp_path / 'prelayout')
    project = store.create('透明層預覽', [('page.png', image_bytes(source))])
    patch = Image.new('RGBA', size, (240, 10, 20, 0))
    patch.paste((20, 50, 90, 255), (120, 130, 230, 250))
    patch.paste((130, 20, 190, 128), (230, 130, 380, 310))
    did = install_overlay(store, project, patch)
    return store, store.read(project['id']), source, patch, did


def install_overlay(store, project, patch):
    did = identifier('d')
    record = store.read(project['id'])
    record['detection_id'] = did
    root = store.directory(project['id'])
    measure = {'pages': {page['name']: [{'xyxy_pixel': [10, 10, 50, 90], 'font_size': 24}]
                         for page in record['pages']}}
    folder = root / 'detections' / did
    for page in record['pages']:
        relative = f'detections/{did}/output/inpainted/{Path(page["name"]).stem}.npz'
        (root / relative).parent.mkdir(parents=True, exist_ok=True)
        save_overlay(patch, root / relative)
        page.update(clean=relative, clean_kind='inpainted')
    atomic_json(folder / 'output' / 'measure.json', measure)
    for page in record['pages']:
        atomic_json(folder / 'output' / 'page-measures' / f'{page["id"]}.json', measure['pages'][page['name']])
        atomic_json(folder / 'output' / 'page-characters' / f'{page["id"]}.json', [])
    atomic_json(folder / 'output' / 'complete.json', {'pages': [p['name'] for p in record['pages']], 'inpainted': True})
    atomic_json(folder / 'task.json', {'id': did, 'project_id': project['id'], 'state': 'completed',
                                     'created_at': '2026-11-13T00:00:00Z', 'pid': None})
    store.write(record)
    return did


@pytest.mark.parametrize(('edge', 'region'), [(384, None), (768, None), (1536, None),
                                            (384, (90, 100, 370, 500)), (768, (222, 124, 170, 210))])
def test_overlay_preview_matches_full_composite_before_crop_and_thumbnail(overlay_project, edge, region):
    store, project, source, patch, _ = overlay_project
    page = project['pages'][0]
    root = store.directory(project['id'])
    source_bytes = (root / 'originals' / page['name']).read_bytes()
    patch_bytes = (root / page['clean']).read_bytes()
    expected = Image.alpha_composite(source.convert('RGBA'), patch).convert('RGB')
    if region is not None:
        x, y, w, h = region
        expected = expected.crop((x, y, x + w, y + h))
    expected.thumbnail((edge, edge))
    output = io.BytesIO()
    expected.save(output, 'JPEG', quality=88)

    actual, key = store.preview(project['id'], page['id'], edge, True, region)

    assert actual == output.getvalue()
    assert store.preview(project['id'], page['id'], edge, True, region) == (actual, key)
    assert (root / 'originals' / page['name']).read_bytes() == source_bytes
    assert (root / page['clean']).read_bytes() == patch_bytes
    assert not (root / 'clean').exists()
    assert not (root / 'detections' / project['detection_id'] / 'output' / 'backgrounds').exists()


def test_composition_preserves_unmasked_pixels_and_partial_alpha(overlay_project):
    store, project, source, patch, _ = overlay_project
    page = project['pages'][0]
    root = store.directory(project['id'])
    with compose_inpainted(root / 'originals' / page['name'], root / page['clean']) as actual:
        expected = Image.alpha_composite(source.convert('RGBA'), patch).convert('RGB')
        assert actual.tobytes() == expected.tobytes()
        assert actual.getpixel((0, 0)) == source.getpixel((0, 0))
        assert actual.getpixel((130, 140)) == (20, 50, 90)
        assert actual.getpixel((240, 140)) != patch.getpixel((240, 140))[:3]


@pytest.mark.parametrize(('mode', 'size', 'format'), [('RGB', (600, 900), 'PNG'),
                                                    ('RGBA', (601, 900), 'PNG'),
                                                    ('RGB', (600, 900), 'JPEG')])
def test_overlay_preview_rejects_invalid_patch(overlay_project, mode, size, format):
    store, project, _, _, _ = overlay_project
    page = project['pages'][0]
    path = store.directory(project['id']) / page['clean']
    if format == 'JPEG': path.write_bytes(image_bytes(Image.new(mode, size), format))
    else: np.savez_compressed(path, overlay=np.zeros((size[1],size[0],4 if mode=='RGBA' else 3), dtype=np.uint8))
    with pytest.raises(ValueError):
        store.preview(project['id'], page['id'], 384, True)


def test_new_detection_reference_invalidates_preview_cache(overlay_project):
    store, project, _, patch, _ = overlay_project
    page = project['pages'][0]
    before, old_key = store.preview(project['id'], page['id'], 384, True)
    new_patch = patch.copy()
    new_patch.paste((0, 0, 0, 255), (0, 0, 600, 900))
    install_overlay(store, project, new_patch)

    after, new_key = store.preview(project['id'], page['id'], 384, True)

    assert new_key != old_key
    assert after != before
    assert not (store.directory(project['id']) / 'previews').exists()


def test_archive_stores_patch_once_and_rebinds_detection_reference(overlay_project):
    store, project, _, _, did = overlay_project
    page = project['pages'][0]
    before, _ = store.preview(project['id'], page['id'], 384, True)
    archive = store.export_archive(project['id'])
    try:
        with zipfile.ZipFile(archive) as bundle:
            names = bundle.namelist()
            assert len(names) == len(set(names))
            assert names.count(f'prelayout/{page["clean"]}') == 1
            assert not any('/backgrounds/' in name or '/clean/' in name or '/previews/' in name for name in names)
        imported = store.import_archive(archive.read_bytes(), 10_000_000)
    finally:
        archive.unlink()
    new_page = imported['pages'][0]
    assert imported['detection_id'] != did
    assert new_page['clean'] == f'detections/{imported["detection_id"]}/output/inpainted/page.npz'
    assert (store.directory(imported['id']) / new_page['clean']).is_file()
    assert store.preview(imported['id'], new_page['id'], 384, True)[0] == before


@pytest.mark.parametrize('alteration', ['other_detection', 'other_stem', 'rgb_patch'])
def test_archive_rejects_foreign_or_invalid_inpainted_asset(overlay_project, alteration):
    store, project, _, _, _ = overlay_project
    archive = store.export_archive(project['id'])
    try:
        with zipfile.ZipFile(archive) as bundle:
            entries = {name: bundle.read(name) for name in bundle.namelist()}
    finally:
        archive.unlink()
    record = json.loads(entries['prelayout/project.json'])
    page = record['pages'][0]
    original = page['clean']
    if alteration == 'other_detection':
        page['clean'] = f'detections/{identifier("d")}/output/inpainted/page.npz'
        entries[f'prelayout/{page["clean"]}'] = entries[f'prelayout/{original}']
    elif alteration == 'other_stem':
        page['clean'] = original.replace('/page.npz', '/different.npz')
        entries[f'prelayout/{page["clean"]}'] = entries[f'prelayout/{original}']
    else:
        entries[f'prelayout/{original}'] = image_bytes(Image.new('RGB', (600, 900)))
    entries['prelayout/project.json'] = json.dumps(record).encode()
    raw = io.BytesIO()
    with zipfile.ZipFile(raw, 'w') as bundle:
        for name, data in entries.items():
            bundle.writestr(name, data)
    with pytest.raises(ValueError, match='修補層|NPZ'):
        store.import_archive(raw.getvalue(), 10_000_000)
