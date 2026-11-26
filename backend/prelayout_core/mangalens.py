"""Optional placement phase, run once per task in the detection Python environment."""
import argparse
import hashlib
import json
import os
from pathlib import Path

import numpy as np
from PIL import Image

from imaging.models import MangaLensDetector, load_config
from .bubble_centers import balloon_centers


def run(images, device):
    output = images / 'ctd'
    blocks = json.loads((output / 'progressing/block_map.json').read_bytes())['blockMap']
    path = output / 'measure.json'
    measure = json.loads(path.read_bytes())
    default_config = Path(__file__).resolve().parents[2] / 'config/detection-models.json'
    config = load_config(os.environ.get('COMIC_DETECTION_CONFIG') or default_config)
    config['device'] = 'cuda:0' if device == 'cuda' else device
    entry = config['mangalens']
    if hashlib.sha256(Path(entry['path']).read_bytes()).hexdigest() != entry['sha256']:
        raise ValueError('MangaLens 權重校驗失敗')
    detector = MangaLensDetector(config)
    for name, items in measure['pages'].items():
        if not items:
            continue
        with Image.open(images / name) as image:
            rgb = np.array(image.convert('RGB'))
        h, w = rgb.shape[:2]
        rows = {item['source_block_index']: item for item in items}
        boxes = [block['xyxy_pixel'] for block in blocks[name]]
        anchors = [np.array(rows[i]['center_normalized']) * [w, h] for i in range(len(boxes))]
        groups = balloon_centers(detector.predict(rgb), boxes, anchors, (h, w))
        for group in groups:
            for i, (cx, cy) in zip(group['indices'], group['centers']):
                rows[i]['center_normalized'] = [round(cx/w, 6), round(cy/h, 6)]
                rows[i]['center_method'] = 'mangalens_centroid'
    # Private task directory. Only the completed worker can publish this file.
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(measure, ensure_ascii=False, allow_nan=False), encoding='utf-8')
    temp.replace(path)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--images', type=Path, required=True)
    parser.add_argument('--device', choices=['mps', 'cuda'], required=True)
    args = parser.parse_args()
    run(args.images, args.device)
