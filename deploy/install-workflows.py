#!/usr/bin/env python3
"""Link bundled UI workflows so an application release updates both entry points."""
import argparse
from pathlib import Path


def install(app: Path, comfy: Path):
    source = app.resolve() / 'workflows'
    target = comfy.resolve() / 'user/default/workflows'
    for path in sorted(source.rglob('*.json')):
        if path.name.endswith('.api.json'):
            continue  # API templates are consumed directly by the application runner.
        relative = path.relative_to(source)
        destination = target / path.name
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists() and destination.is_dir():
            raise ValueError(f'Workflow destination is a directory: {destination}')
        temporary = destination.with_name(destination.name + '.install')
        temporary.unlink(missing_ok=True)
        temporary.symlink_to(path)
        temporary.replace(destination)
        print(f'LINK {relative}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--app-root', type=Path, required=True)
    parser.add_argument('--comfy-root', type=Path, required=True)
    args = parser.parse_args()
    install(args.app_root, args.comfy_root)
