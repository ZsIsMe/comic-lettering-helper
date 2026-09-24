#!/usr/bin/env python3
"""Copy local project images into an isolated, reduced-resolution UI fixture.

Reads existing results only. Never modifies the project or calls ComfyUI.
Output belongs under ignored var/ and must not be included in a release.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from app.composition import difference_mask  # noqa: E402


def prepare(project_file: Path, jobs_root: Path, output: Path) -> None:
    project = json.loads(project_file.read_text())
    project_root = project_file.parent
    output.mkdir(parents=True, exist_ok=True)
    manifest = {'version': 1, 'projectName': project['name'], 'pages': [], 'rounds': []}
    workflows = ['flux2klein_lanpaint', 'firered', 'qwen2511_lanpaint']
    for page in project['pages']:
        target = output / page['id']
        target.mkdir(exist_ok=True)
        with Image.open(project_root / page['source']) as image:
            original = image.convert('RGB')
        with Image.open(project_root / page['overlay']) as overlay:
            base = Image.alpha_composite(original.convert('RGBA'), overlay.convert('RGBA')).convert('RGB')
        with Image.open(project_root / page['other']) as image:
            mask = image.convert('L')
        original.thumbnail((850, 1100), Image.Resampling.LANCZOS)
        base = base.resize(original.size, Image.Resampling.LANCZOS)
        mask = mask.resize(original.size, Image.Resampling.NEAREST)
        original.save(target / 'original.png')
        base.save(target / 'base.png')
        mask.save(target / 'mask.png')
        pink = Image.new('RGB', original.size, '#ff6ea5')
        overlay = Image.composite(pink, original, mask.point(lambda v: round(v * .4)))
        overlay.thumbnail((400, 540), Image.Resampling.LANCZOS)
        overlay.save(target / 'mask-preview.jpg', quality=88)
        results = {}
        for run in project['runs']:
            for workflow in workflows:
                source = jobs_root / run['id'] / 'inpaint_workflows' / workflow / f"{page['stem']}.png"
                if not source.is_file():
                    continue
                name = f"{run['id']}-{workflow}"
                try:
                    with Image.open(source) as image:
                        # Resizing applies only to the isolated browser preview.
                        result = image.convert('RGB').resize(base.size, Image.Resampling.LANCZOS)
                except OSError as exc:
                    print(f'Skipping unreadable saved preview: {workflow}/{page["stem"]}.png ({exc})')
                    continue
                result.save(target / f'{name}.png')
                diff = difference_mask(np.asarray(base), np.asarray(result), 12, 16, 5)
                Image.fromarray(diff).save(target / f'{name}-diff.png')
                results[name] = {'image': f"{page['id']}/{name}.png", 'diff': f"{page['id']}/{name}-diff.png"}
        manifest['pages'].append({
            'id': page['id'], 'filename': page['filename'], 'width': base.width, 'height': base.height,
            'base': f"{page['id']}/base.png", 'maskPreview': f"{page['id']}/mask-preview.jpg",
            'maskReady': bool(page.get('mask_ready')), 'results': results,
        })
    for run in project['runs']:
        for workflow in workflows:
            key = f"{run['id']}-{workflow}"
            pages = [page['id'] for page in manifest['pages'] if key in page['results']]
            if pages:
                manifest['rounds'].append({'id': key, 'workflow': workflow, 'createdAt': run['created_at'], 'pageIds': pages, 'assetKey': key})
    (output / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False), encoding='utf-8')
    print(f"Prepared {len(manifest['pages'])} pages and {len(manifest['rounds'])} saved workflow results in {output}")


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, required=True, help='Existing project.json (read only)')
    parser.add_argument('--jobs', type=Path, required=True, help='Existing jobs directory (read only)')
    args = parser.parse_args()
    prepare(args.project.resolve(), args.jobs.resolve(), ROOT / 'var/rounds-preview/assets')
