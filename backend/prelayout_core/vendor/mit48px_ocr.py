"""Small adapter for the vendored mit48px CTC OCR model."""

from __future__ import annotations

import importlib.util
import math
from pathlib import Path
from typing import Any, Callable

import cv2
import einops
import numpy as np
import torch


import os
PROJECT_ROOT = Path(os.environ['COMIC_PRELAYOUT_MODEL_ROOT'])
DEFAULT_MODEL_PATH = PROJECT_ROOT / 'mit48pxctc_ocr.ckpt'
DEFAULT_ALPHABET_PATH = PROJECT_ROOT / 'alphabet-all-v5.txt'
DEFAULT_IMPLEMENTATION_PATH = Path(__file__).resolve().parent / 'mit48px_ctc.py'


def resolved_device(requested: str) -> str:
    requested = str(requested or 'cpu').lower()
    if requested == 'mps':
        if not hasattr(torch.backends, 'mps') or not torch.backends.mps.is_available():
            raise RuntimeError('MPS 不可用，未切換 CPU')
        return 'mps'
    if requested == 'cuda':

        if not torch.cuda.is_available():
            raise RuntimeError('CUDA 不可用，未切換 CPU')
        return 'cuda'
    return 'cpu'


def _load_ocr_class(implementation_path: Path):
    if not implementation_path.is_file():
        raise FileNotFoundError(f'找不到 mit48px CTC 實作：{implementation_path}')

    spec = importlib.util.spec_from_file_location('_ctd_mit48px_ctc', implementation_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f'無法載入 mit48px CTC 實作：{implementation_path}')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.OCR


def prepare_character_crop(image_rgb: np.ndarray, bbox: list[Any], pad: int = 2) -> np.ndarray:
    height, width = image_rgb.shape[:2]
    x1, y1, x2, y2 = [int(round(float(value))) for value in bbox]
    x1 = max(0, x1 - pad)
    y1 = max(0, y1 - pad)
    x2 = min(width, x2 + pad)
    y2 = min(height, y2 + pad)
    if x2 <= x1 or y2 <= y1:
        raise ValueError(f'無效單字框：{bbox}')
    crop = image_rgb[y1:y2, x1:x2]
    crop_h, crop_w = crop.shape[:2]
    target_h = 48
    target_w = max(4, int(round(target_h * crop_w / max(1, crop_h))))
    interpolation = cv2.INTER_CUBIC if target_h > crop_h else cv2.INTER_AREA
    return cv2.resize(crop, (target_w, target_h), interpolation=interpolation)


def collapse_ctc_runs(
    log_probabilities: torch.Tensor,
    dictionary: list[str],
    *,
    blank: int = 0,
    valid_timesteps: int | None = None,
) -> list[dict[str, Any]]:
    """Collapse CTC runs while retaining the best timestep of each token."""
    if log_probabilities.ndim != 2:
        raise ValueError('CTC log probabilities must have shape [T, C]')
    timestep_count = int(log_probabilities.shape[0])
    valid_count = timestep_count if valid_timesteps is None else max(0, min(timestep_count, int(valid_timesteps)))
    if valid_count == 0:
        return []

    best_ids = log_probabilities[:valid_count].argmax(dim=1).detach().cpu().tolist()
    tokens: list[dict[str, Any]] = []
    run_start = 0
    while run_start < valid_count:
        character_id = int(best_ids[run_start])
        run_end = run_start + 1
        while run_end < valid_count and int(best_ids[run_end]) == character_id:
            run_end += 1
        if character_id != blank:
            run_scores = log_probabilities[run_start:run_end, character_id]
            best_offset = int(run_scores.argmax().item())
            timestep = run_start + best_offset
            character = dictionary[character_id]
            if character == '<SP>':
                character = ' '
            tokens.append({
                'text': character,
                'probability': round(math.exp(float(log_probabilities[timestep, character_id].item())), 6),
                'timestep': timestep,
                'run_start': run_start,
                'run_end': run_end,
                'position_ratio': round((timestep + 0.5) / valid_count, 6),
            })
        run_start = run_end
    return tokens


class Mit48pxCtcOcr:
    def __init__(
        self,
        device: str = 'cpu',
        *,
        model_path: str | Path = DEFAULT_MODEL_PATH,
        alphabet_path: str | Path = DEFAULT_ALPHABET_PATH,
        implementation_path: str | Path = DEFAULT_IMPLEMENTATION_PATH,
    ) -> None:
        self.model_path = Path(model_path)
        self.alphabet_path = Path(alphabet_path)
        self.implementation_path = Path(implementation_path)
        for path in (self.model_path, self.alphabet_path):
            if not path.is_file():
                raise FileNotFoundError(f'找不到 mit48px CTC 檔案：{path}')

        self.device = resolved_device(device)
        dictionary = self.alphabet_path.read_text(encoding='utf-8').splitlines()
        ocr_class = _load_ocr_class(self.implementation_path)
        self.net = ocr_class(dictionary, 768)
        state = torch.load(self.model_path, map_location='cpu', weights_only=True)
        weights = state['model'] if isinstance(state, dict) and 'model' in state else state
        for key in (
            'encoders.layers.0.pe.pe',
            'encoders.layers.1.pe.pe',
            'encoders.layers.2.pe.pe',
        ):
            weights.pop(key, None)
        self.net.load_state_dict(weights, strict=False)
        self.net.eval()
        if self.device != 'cpu':
            self.net = self.net.to(self.device)

    @torch.inference_mode()
    def recognize_batch(self, crops: list[np.ndarray], batch_size: int = 32) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        for start in range(0, len(crops), max(1, batch_size)):
            batch = crops[start:start + max(1, batch_size)]
            widths = [int(crop.shape[1]) for crop in batch]
            max_width = (4 * (max(widths) + 7) // 4) + 128
            region = np.zeros((len(batch), 48, max_width, 3), dtype=np.uint8)
            for index, crop in enumerate(batch):
                region[index, :, :crop.shape[1], :] = crop
            images = (torch.from_numpy(region).float() - 127.5) / 127.5
            images = einops.rearrange(images, 'N H W C -> N C H W')
            if self.device != 'cpu':
                images = images.to(self.device)
            decoded = self.net.decode(images, widths, 0)
            for sequence in decoded:
                chars = []
                probabilities = []
                for character_id, log_probability, *_ in sequence:
                    character = self.net.dictionary[character_id]
                    if character == '<SP>':
                        character = ' '
                    chars.append(character)
                    probabilities.append(math.exp(float(log_probability)))
                probability = (
                    float(math.exp(sum(math.log(max(value, 1e-12)) for value in probabilities) / len(probabilities)))
                    if probabilities
                    else 0.0
                )
                results.append({
                    'text': ''.join(chars),
                    'probability': round(probability, 6),
                    'character_probabilities': [round(value, 6) for value in probabilities],
                })
        return results

    @torch.inference_mode()
    def recognize_batch_aligned(
        self,
        crops: list[np.ndarray],
        batch_size: int = 32,
        progress_callback: Callable[[int, int], None] | None = None,
    ) -> list[dict[str, Any]]:
        """Recognize whole lines and retain an independent CTC position per token."""
        if not crops:
            return []
        results: list[dict[str, Any] | None] = [None] * len(crops)
        ordered_indices = sorted(range(len(crops)), key=lambda index: int(crops[index].shape[1]))
        completed = 0
        for start in range(0, len(ordered_indices), max(1, batch_size)):
            batch_indices = ordered_indices[start:start + max(1, batch_size)]
            batch = [crops[index] for index in batch_indices]
            widths = [int(crop.shape[1]) for crop in batch]
            max_width = (4 * (max(widths) + 7) // 4) + 128
            region = np.zeros((len(batch), 48, max_width, 3), dtype=np.uint8)
            for index, crop in enumerate(batch):
                region[index, :, :crop.shape[1], :] = crop
            images = (torch.from_numpy(region).float() - 127.5) / 127.5
            images = einops.rearrange(images, 'N H W C -> N C H W')
            if self.device != 'cpu':
                images = images.to(self.device)

            pred_char_logits, _ = self.net(images)
            log_probabilities = pred_char_logits.log_softmax(2)
            total_timesteps = int(log_probabilities.shape[1])
            for batch_index, crop_width in enumerate(widths):
                valid_timesteps = max(
                    1,
                    min(
                        total_timesteps,
                        int(math.ceil(total_timesteps * crop_width / max_width)),
                    ),
                )
                tokens = collapse_ctc_runs(
                    log_probabilities[batch_index],
                    self.net.dictionary,
                    blank=0,
                    valid_timesteps=valid_timesteps,
                )
                probabilities = [float(token['probability']) for token in tokens]
                probability = (
                    float(math.exp(sum(math.log(max(value, 1e-12)) for value in probabilities) / len(probabilities)))
                    if probabilities
                    else 0.0
                )
                results[batch_indices[batch_index]] = {
                    'text': ''.join(str(token['text']) for token in tokens),
                    'probability': round(probability, 6),
                    'character_probabilities': [round(value, 6) for value in probabilities],
                    'tokens': tokens,
                    'valid_timesteps': valid_timesteps,
                    'total_timesteps': total_timesteps,
                }
            completed += len(batch)
            if progress_callback is not None:
                progress_callback(completed, len(crops))
        return [result for result in results if result is not None]
