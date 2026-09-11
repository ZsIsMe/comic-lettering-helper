"""Lazy CUDA adapters. No auto-download and no CPU fallback."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path


class DetectionUnavailable(RuntimeError):
    pass


def load_config(path):
    config = json.loads(Path(path).read_text(encoding='utf-8'))
    if config.get('version') != 1:
        raise DetectionUnavailable('不支援的偵測模型配置版本')
    if config.get('device') != 'cuda:0':
        raise DetectionUnavailable('偵測目前要求明確指定 cuda:0')
    for name in ('rf', 'mangalens'):
        item = config[name]
        item['path'] = os.environ.get(item.get('path_env', ''), item['path'])
    return config


def validate_weights(config, verify_hash=True):
    for name in ('rf', 'mangalens'):
        entry = config[name]
        path = Path(entry['path'])
        if not path.is_file():
            raise DetectionUnavailable(f'缺少 {name} 模型，請上傳至配置路徑：{path}')
        if verify_hash:
            digest = hashlib.sha256()
            with path.open('rb') as handle:
                for block in iter(lambda: handle.read(1024 * 1024), b''):
                    digest.update(block)
            if digest.hexdigest() != entry['sha256']:
                raise DetectionUnavailable(f'{name} 模型 SHA-256 不符')


def require_cuda(config):
    try:
        import torch
    except ImportError as exc:
        raise DetectionUnavailable('偵測環境缺少 PyTorch；請設定 COMIC_DETECTION_PYTHON') from exc
    if not torch.cuda.is_available():
        raise DetectionUnavailable('偵測需要 CUDA GPU，目前不可用；不會退回 CPU')
    free, _ = torch.cuda.mem_get_info(0)
    minimum = int(config.get('minimum_free_vram_mb', 4096)) * 1024 * 1024
    if free < minimum:
        raise DetectionUnavailable('GPU 可用顯存不足，請確認其他工作已結束且閒置模型已卸載')
    return torch


class RFDetector:
    def __init__(self, config):
        import cv2
        import numpy as np
        from rfdetr import RFDETRSeg2XLarge
        from safetensors.torch import load_file
        self.cv2, self.np = cv2, np
        self.config = config['rf']
        torch = require_cuda(config)
        self.model = RFDETRSeg2XLarge(pretrain_weights=None, device=config['device'],
            resolution=self.config['resolution'], num_select=self.config['num_select'], num_classes=4)
        self.model.model.model.load_state_dict(load_file(self.config['path'], device='cpu'), strict=True)
        self.model.model.device = torch.device(config['device'])

    def predict(self, rgb):
        np, cv2 = self.np, self.cv2
        thresholds = self.config['class_thresholds']
        names = ('text', 'onomatopoeia', 'bubble', 'panel')
        size = self.config['resolution']
        detections = self.model.predict(rgb, threshold=min(thresholds.values()),
            shape=(size, size), include_source_image=False)
        result = np.zeros(rgb.shape[:2], np.uint8)
        if detections.mask is not None:
            for class_id, confidence, instance in zip(detections.class_id, detections.confidence, detections.mask):
                if not 0 <= int(class_id) < len(names):
                    continue
                name = names[int(class_id)]
                if name in ('text', 'onomatopoeia') and float(confidence) >= thresholds[name]:
                    active = np.asarray(instance, dtype=bool)
                    if active.shape != result.shape:
                        raise ValueError('RF 輸出 Mask 尺寸不一致')
                    result[active] = 255
        dilation = int(self.config['mask_dilate'])
        if dilation > 0 and np.any(result):
            result = cv2.dilate(result, np.ones((dilation, dilation), np.uint8))
        return result


class MangaLensDetector:
    def __init__(self, config):
        from ultralytics import YOLO
        require_cuda(config)
        self.config = config['mangalens']
        self.device = config['device']
        self.model = YOLO(self.config['path'], task='segment')

    def predict(self, rgb):
        import numpy as np
        from .bubbles import _tiles, _deduplicate
        image = np.ascontiguousarray(rgb[:, :, ::-1])  # YOLO numpy inputs are BGR.
        polygons = []
        for x1, y1, x2, y2 in _tiles(image.shape):
            result = self.model.predict(np.ascontiguousarray(image[y1:y2, x1:x2]),
                imgsz=self.config['image_size'], conf=self.config['confidence'], iou=self.config['iou'],
                device=self.device, retina_masks=True, verbose=False)[0]
            if result.masks is None:
                continue
            for polygon, class_id in zip(result.masks.xy, result.boxes.cls.cpu().numpy()):
                if result.names[int(class_id)] != 'balloon':
                    continue
                pts = np.asarray(polygon, dtype=np.float32)
                if len(pts) < 3 or not np.isfinite(pts).all():
                    continue
                if ((x1 > 0 and pts[:, 0].min() <= 2) or (y1 > 0 and pts[:, 1].min() <= 2)
                    or (x2 < image.shape[1] and pts[:, 0].max() >= x2-x1-3)
                    or (y2 < image.shape[0] and pts[:, 1].max() >= y2-y1-3)):
                    continue
                polygons.append(pts + np.array([x1, y1], np.float32))
        return _deduplicate(polygons, image.shape)
