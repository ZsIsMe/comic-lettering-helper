"""Read-only installation preflight; never downloads weights or modifies model paths."""
from __future__ import annotations
import argparse
import hashlib
import importlib
import importlib.metadata
import json
import os
import sys
from pathlib import Path

ASSETS = {
    'comictextdetector.pt': '1f90fa60aeeb1eb82e2ac1167a66bf139a8a61b8780acd351ead55268540cccb',
    'mit48pxctc_ocr.ckpt': '8b0837a24da5fde96c23ca47bb7abd590cd5b185c307e348c6e0b7238178ed89',
    'alphabet-all-v5.txt': 'c1295ae1962e69e35b5b225a0405d1f3432e368c9941d23bfd3acda12654da33',
    'NotoSansCJKjp-Medium.otf': 'dd523e580e3413c480b2d701bf64e534c20f8419e3cfb6a44c2bdcd8d2a6c052',
    'NotoSansCJKjp-Medium.ink-metrics.json': '29a0af82d3501eab9bf8bb0f8de8294b972927eb7d6e863b7cfd2d165ce28a56',
}


def check(root, method='ocr_aligned', require_cuda=False, device=None):
    root = Path(root).resolve()
    report = {'python': sys.version.split()[0], 'method': method, 'assets': {}, 'packages': {}, 'errors': []}
    if require_cuda and device not in (None, 'cuda'):
        report['errors'].append('--require-cuda 不可與其他設備合用')
    requested = 'cuda' if require_cuda else device
    report['device'] = requested
    if requested not in (None, 'cuda', 'mps'):
        report['errors'].append('設備只接受 cuda 或 mps')
    names = list(ASSETS) if method == 'ocr_aligned' else ['comictextdetector.pt']
    for name in names:
        try:
            with (root / name).open('rb') as stream:
                digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            report['assets'][name] = digest
            if digest != ASSETS[name]: report['errors'].append(f'資產雜湊不符：{name}')
        except OSError:
            report['errors'].append(f'缺少資產：{name}')
    modules = ['PIL', 'numpy', 'cv2', 'torch', 'torchvision', 'tqdm', 'pyclipper', 'shapely', 'einops', 'packaging', 'yaml', 'requests']
    for module in modules:
        try:
            loaded = importlib.import_module(module)
            report['packages'][module] = str(getattr(loaded, '__version__', 'imported'))
        except Exception as exc:
            report['errors'].append(f'推理依賴 {module}：{exc}')
    try:
        import torch
        report['cuda_available'] = torch.cuda.is_available()
        report['torch_cuda'] = torch.version.cuda
        report['mps_available'] = hasattr(torch.backends, 'mps') and torch.backends.mps.is_available()
        if requested == 'cuda' and not report['cuda_available']: report['errors'].append('CUDA 不可用；未切換 CPU')
        if requested == 'mps' and not report['mps_available']: report['errors'].append('MPS 不可用；未切換 CPU')
    except ImportError:
        report['cuda_available'] = False
    if not report['errors']:
        try:
            os.environ['COMIC_PRELAYOUT_MODEL_ROOT'] = str(root)
            from .vendor import new_detect_folder
            assert callable(new_detect_folder._detect_pages)
            if method == 'ocr_aligned':
                from .vendor import measure_ocr
                from .vendor.font_size_calibration import validate_font_ink_metrics
                from .vendor.mit48px_ocr import _load_ocr_class, DEFAULT_IMPLEMENTATION_PATH
                assert callable(measure_ocr.run)
                _load_ocr_class(DEFAULT_IMPLEMENTATION_PATH)
                validate_font_ink_metrics()
        except Exception as exc:
            report['errors'].append(f'核心載入失敗：{exc}')
    report['ok'] = not report['errors']
    report['inference_verified'] = False
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-root', type=Path, default=Path(os.getenv('COMIC_PRELAYOUT_MODEL_ROOT', '/root/models/comic-prelayout')))
    parser.add_argument('--method', choices=['single_char', 'ocr_aligned'], default='ocr_aligned')
    parser.add_argument('--require-cuda', action='store_true')
    parser.add_argument('--device', choices=['cuda', 'mps'], help='Explicit GPU backend; no CPU fallback')
    args = parser.parse_args()
    report = check(args.model_root, args.method, args.require_cuda, args.device)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
