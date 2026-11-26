"""Explicit OCR selection for new tasks and immutable legacy task records."""
from __future__ import annotations

import os


OCR_ENGINES = ('charspot', 'mit48')
MIT48_DISABLED_MESSAGE = 'mit48 推理已停用，原碼與既有測量保留；請使用 CharSpot 建立新偵測任務'
CHARSPOT_DIRECTORY = 'manga-ocr-charspot-small'
CHARSPOT_REVISION = '72ca29202673880ca9c67b1c02c107535be4472b'
CHARSPOT_ASSETS = {
    'config.json': 'fbab49bfbfee9e9fee22e74288202a7928e268e9b03de185aa9e206614b0a65c',
    'vocab.json': '9f72fc7852b1432bcb61b3b94b2e4cd8abef52b01e9051550a6a3070e2b314d5',
    'manga_ocr_charspot_small/__init__.py': '8693db4d83b64d8e2fdd994901c3c7ae2af6135041e0ecbcdcf98460ab48e1c7',
    'manga_ocr_charspot_small/core.py': 'a907e94f21b40641027d014dfea36df6489997809dd053dca3987d4965650a65',
    'manga_ocr_charspot_small/backends/__init__.py': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
}
CHARSPOT_BACKEND_ASSETS = {
    'cpu': {
        'model.onnx': '05fb79760f8e3dbc989b61f23a34c46b511818a2166573ce7e41d994f4403843',
        'manga_ocr_charspot_small/backends/onnx.py': '2da0c938e3f4c623969cdfb39f1279a20e8e09fecfb088850d67e4e5e7f70ca9',
    },
    'cuda': {
        'model.safetensors': '3dec28460e10353b8a12d0e6d252bff9b892ec2d12ffb7a3d81ae02532963286',
        'manga_ocr_charspot_small/backends/cuda.py': '60cbe33a615265ccdd6f85aa580d14f6526d26e60499f2fe68cf537f0a708235',
        'manga_ocr_charspot_small/model.py': '4ec554862b56171bbd85a42b7e27d88621b24617a5ddbbffd2091dfe421e7895',
        'manga_ocr_charspot_small/gpu_preprocess.py': '391647938bce2d5cc425097ff4fd14fa270c6b68ac9026cf0cc60dcd6af8a598',
    },
}


def charspot_assets(device):
    if device not in CHARSPOT_BACKEND_ASSETS:
        raise ValueError('CharSpot 設備只接受 cpu 或 cuda')
    return {f'{CHARSPOT_DIRECTORY}/{name}': digest for name, digest in
            {**CHARSPOT_ASSETS, **CHARSPOT_BACKEND_ASSETS[device]}.items()}


def configured_engine():
    engine = os.getenv('COMIC_PRELAYOUT_OCR_ENGINE', 'charspot').strip().lower()
    if engine not in OCR_ENGINES:
        raise ValueError('COMIC_PRELAYOUT_OCR_ENGINE 只接受 charspot 或 mit48')
    require_active_engine(engine)
    return engine


def require_active_engine(engine):
    if engine == 'mit48':
        raise ValueError(MIT48_DISABLED_MESSAGE)


def task_engine(record):
    # Tasks saved before engine selection always used mit48. A server setting
    # change must not relabel or change the runtime of those existing tasks.
    engine = record.get('options', {}).get('ocr_engine', 'mit48')
    if engine not in OCR_ENGINES:
        raise ValueError('無效的 OCR 引擎')
    return engine


def configured_ocr_device(engine, detection_device):
    require_active_engine(engine)
    default = 'cuda' if detection_device == 'cuda' else 'cpu'
    device = os.getenv('COMIC_PRELAYOUT_CHARSPOT_DEVICE', default).strip().lower()
    if device not in ('cpu', 'cuda'):
        raise ValueError('COMIC_PRELAYOUT_CHARSPOT_DEVICE 只接受 cpu 或 cuda')
    return device
