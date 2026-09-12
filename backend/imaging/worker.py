"""Run one detection stage in a dedicated process; stage processes never overlap."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import time


def atomic_json(path, value):
    path = Path(path)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
    temporary.replace(path)


def save_image(path, value):
    from PIL import Image
    path = Path(path)
    temporary = path.with_suffix('.tmp')
    Image.fromarray(value).save(temporary, format='PNG')
    temporary.replace(path)


def read_image(path, mode):
    import numpy as np
    from PIL import Image
    with Image.open(path) as image:
        if image.mode != mode:
            raise ValueError(f'輸入格式必須是 {mode}：{Path(path).name}')
        return np.asarray(image).copy()


def validate_manifest(manifest):
    seen = set()
    if not manifest.get('pages'):
        raise ValueError('偵測任務沒有頁面')
    for page in manifest['pages']:
        if page['id'] in seen:
            raise ValueError('重複頁面')
        seen.add(page['id'])
        rgb = read_image(page['source'], 'RGB')
        shape = rgb.shape[:2]
        overlay = read_image(page['overlay'], 'RGBA')
        other = read_image(page['other'], 'L')
        edited = read_image(page['edited'], 'L')
        if overlay.shape != (*shape, 4) or other.shape != shape or edited.shape != shape:
            raise ValueError('輸入編輯資料尺寸不一致')
        if ((overlay[:, :, 3] > 0) & (other > 0)).any():
            raise ValueError('輸入兩類選區重疊')
        Path(page['output']).mkdir(parents=True, exist_ok=True)


def run_stage(stage, manifest, config, progress):
    import numpy as np
    from .models import validate_weights, require_device, device_metrics, RFDetector, MangaLensDetector
    validate_manifest(manifest)
    if stage == 'check':
        validate_weights(config)
        # All optional imports are confined to this process/environment.
        import cv2  # noqa: F401
        import rfdetr  # noqa: F401
        import safetensors  # noqa: F401
        import ultralytics  # noqa: F401
        torch = require_device(config)
        value = {'stage': stage, **device_metrics(config, torch)}
        atomic_json(progress, value)
        print(json.dumps(value), flush=True)
        return
    started = time.monotonic()
    detector = RFDetector(config) if stage == 'rf' else MangaLensDetector(config) if stage == 'mangalens' else None
    load_seconds = time.monotonic() - started
    total = len(manifest['pages'])
    for index, page in enumerate(manifest['pages']):
        stamp = time.monotonic()
        rgb = read_image(page['source'], 'RGB')
        output = Path(page['output'])
        if stage == 'rf':
            save_image(output / 'text_mask.png', detector.predict(rgb))
        elif stage == 'mangalens':
            text_mask = read_image(output / 'text_mask.png', 'L')
            polygons = detector.predict(rgb) if np.any(text_mask) else []
            atomic_json(output / 'bubbles.json', [p.tolist() for p in polygons])
        elif stage == 'classify':
            from .core import classify_page
            polygons = [np.asarray(p, np.float32) for p in json.loads((output / 'bubbles.json').read_text())]
            overlay, other, edited, diagnostics = classify_page(rgb,
                read_image(output / 'text_mask.png', 'L'), polygons,
                overlay=read_image(page['overlay'], 'RGBA'), other=read_image(page['other'], 'L'),
                edited=read_image(page['edited'], 'L'), shrink_ratio=config['mangalens']['shrink_ratio'])
            for name, value in (('overlay', overlay), ('other', other), ('edited', edited)):
                save_image(output / f'{name}.png', value)
            atomic_json(output / 'diagnostics.json', diagnostics)
        else:
            raise ValueError(f'未知階段：{stage}')
        value = {'stage': stage, 'completed': index + 1, 'total': total, 'page_id': page['id'],
                 'page_seconds': round(time.monotonic()-stamp, 3), 'stage_seconds': round(time.monotonic()-started, 3),
                 'model_load_seconds': round(load_seconds, 3)}
        if detector is not None:
            import torch
            value.update(device_metrics(config, torch, inference=True))
        atomic_json(progress, value)
        print(json.dumps(value), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--stage', choices=['check', 'rf', 'mangalens', 'classify'], required=True)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--progress', type=Path, required=True)
    args = parser.parse_args()
    from .models import load_config
    manifest = json.loads(args.manifest.read_text(encoding='utf-8'))
    config = load_config(args.config)
    if config['device'] == 'mps':
        # Set before importing torch; unsupported MPS operators must fail visibly.
        os.environ['PYTORCH_ENABLE_MPS_FALLBACK'] = '0'
    try:
        run_stage(args.stage, manifest, config, args.progress)
    except Exception as exc:
        atomic_json(args.progress, {'stage': args.stage, 'error': str(exc)})
        raise


if __name__ == '__main__':
    main()
