"""Headless CTD/OCR worker. Each model phase runs in its own process."""
from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image

from app.prelayout.store import atomic_json
from .data import read_json, validate_measure


def load(path):
    return read_json(Path(path).read_bytes())


def progress(folder, stage, completed=0, total=0):
    atomic_json(folder / 'progress.json', {'state': stage, 'progress': {'stage': stage, 'completed': completed, 'total': total}})


def verify_sources(record, images):
    for page in record['pages']:
        path = images / page['name']
        if hashlib.sha256(path.read_bytes()).hexdigest() != page['sha256']:
            raise ValueError(f'原圖已改變：{page["name"]}')
        with Image.open(path) as image:
            image.load()
            if image.size != (page['width'], page['height']):
                raise ValueError('原圖尺寸不一致')


def preflight(method, device='cuda'):
    from .check import check
    root = Path(os.environ['COMIC_PRELAYOUT_MODEL_ROOT'])
    report = check(root, method, device=device)
    if not report['ok']:
        raise RuntimeError('；'.join(report['errors']))
    return root


def run_ctd(folder, record, images, models):
    from .vendor import new_detect_folder as core
    from .vendor import detect_folder
    from .vendor.analyze_text_core import enrich_measure_map
    names = [page['name'] for page in record['pages']]
    def image_list(directory, abs_path=False):
        return [str(Path(directory) / name) if abs_path else name for name in names]
    core.find_all_imgs = image_list
    detect_folder.find_all_imgs = image_list
    paths = core._ensure_dirs(str(images / 'ctd'))
    progress(folder, 'detecting', 0, len(names))
    block, lines = core._detect_pages(str(images), str(models / 'comictextdetector.pt'), record.get('device', 'cuda'), paths, save_line_trans_preview=False,
                                    on_page=lambda done, total: progress(folder, 'detecting', done, total))
    if set(block.get('blockMap', {})) != set(names):
        raise ValueError('CTD 未完整輸出全部原圖')
    core._write_json(str(images / 'ctd' / 'progressing' / core.BLOCK_MAP_JSON), block)
    core._write_json(str(images / 'ctd' / 'progressing' / core.LINE_TRANS_MAP_JSON), lines)
    progress(folder, 'aligning', 0, len(names))
    aligned, _ = core._align_pages(str(images), paths, block, save_center_preview=False, need_neck=True,
                                  on_page=lambda done, total: progress(folder, 'aligning', done, total))
    core._write_json(str(images / 'ctd' / 'progressing' / core.ALIGNED_BOX_MAP_JSON), aligned)
    method = 'char_box' if record['options']['method'] == 'single_char' else 'ocr_aligned'
    progress(folder, 'measuring', 0, len(names))
    measure, debug = core._build_measure_maps(str(images), paths, block, lines, aligned,
                                             font_size_calculation_method=method, default_font_size=record['options']['font_size'], font_size_step=record['options']['step'],
                                             on_page=lambda done, total: progress(folder, 'measuring', done, total))
    _, errors = enrich_measure_map(images, measure)
    if errors: raise ValueError('；'.join(errors))
    for name in names:
        if name not in measure['pages'] and not block['blockMap'][name]: measure['pages'][name] = []
    if set(measure['pages']) != set(names): raise ValueError('量測輸出頁面不完整')
    atomic_json(images / 'ctd' / 'measure.json', measure)
    atomic_json(images / 'ctd' / 'measure.debug.json', debug)
    progress(folder, 'measuring', len(names), len(names))


def run_ocr(folder, record, images, models):
    from .vendor import measure_ocr
    from .vendor.font_size_calibration import calibrate_ocr_output
    progress(folder, 'calibrating', 0, len(record['pages']))
    measure_path = images / 'ctd' / 'measure.json'
    output = measure_ocr.run(str(measure_path), str(images), None,
        model_path=str(models / 'mit48pxctc_ocr.ckpt'), alphabet_path=str(models / 'alphabet-all-v5.txt'),
        implementation_path=str(Path(__file__).parent / 'vendor' / 'mit48px_ctc.py'), device=record.get('device', 'cuda'), pads=[4, 8], minimum_probability=.3,
        page=None, measure_debug_path=None, source_block_index=None, limit_pages=None, limit_items=None,
        batch_size=32, save_crops=None, dry_run=False, on_page=lambda done, total: progress(folder, 'calibrating', done, total))
    calibrated = load(output)
    calibrate_ocr_output(calibrated, default_font_size=record['options']['font_size'], font_size_step=record['options']['step'])
    measure = load(measure_path)
    measure_ocr.apply_calibrated_font_sizes(measure, calibrated)
    # Provenance names describe external assets; archives must not depend on this host's paths.
    def portable(value):
        if isinstance(value, dict):
            return {key.replace('_path', '_asset') if key in ('model_path', 'alphabet_path', 'font_path', 'metrics_path') else key:
                    Path(child).name if key in ('model_path', 'alphabet_path', 'font_path', 'metrics_path') and isinstance(child, str) else portable(child)
                    for key, child in value.items()}
        if isinstance(value, list): return [portable(child) for child in value]
        return value
    atomic_json(measure_path, portable(measure)); atomic_json(output, portable(calibrated))
    progress(folder, 'calibrating', len(record['pages']), len(record['pages']))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--task', type=Path, required=True)
    parser.add_argument('--task-id', required=True)
    parser.add_argument('--images', type=Path, required=True)
    parser.add_argument('--phase', choices=['ctd', 'ocr'])
    args = parser.parse_args()
    record = load(args.task)
    if record['id'] != args.task_id: raise ValueError('任務 ID 不符')
    folder = args.task.parent
    if args.phase:
        device = record.get('device', 'cuda')
        models = preflight(record['options']['method'], device)
        print(f'預排版 {args.phase} 真實模型推理 · 設備：{device}', flush=True)
        if args.phase == 'ctd': run_ctd(folder, record, args.images, models)
        else: run_ocr(folder, record, args.images, models)
        return
    verify_sources(record, args.images)
    images = folder / 'input'; images.mkdir()
    for page in record['pages']:
        shutil.copyfile(args.images / page['name'], images / page['name'])
    phases = ['ctd'] + (['ocr'] if record['options']['method'] == 'ocr_aligned' else [])
    for phase in phases:
        subprocess.run([sys.executable, '-m', 'prelayout_core.worker', '--task', str(args.task), '--task-id', args.task_id,
                        '--images', str(images), '--phase', phase], check=True)
    progress(folder, 'publishing', len(record['pages']), len(record['pages']))
    measure = load(images / 'ctd' / 'measure.json')
    validate_measure(measure, record['pages'])
    for page in record['pages']:
        atomic_json(images / 'ctd' / 'page-measures' / f'{page["id"]}.json', measure['pages'][page['name']])
    (images / 'ctd').rename(folder / 'output')
    atomic_json(folder / 'output' / 'complete.json', {'pages': [page['name'] for page in record['pages']]})


if __name__ == '__main__':
    main()
