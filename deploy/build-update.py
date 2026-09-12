#!/usr/bin/env python3
"""Build a code-only application update after the production frontend build."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('output', type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
version = re.search(r'APP_VERSION = "([^"]+)"', (root/'backend/app/updates.py').read_text())[1]
commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
files = []
for prefix in ['backend/app', 'backend/imaging', 'backend/prelayout_core', 'frontend/dist']:
    files.extend(p for p in (root/prefix).rglob('*') if p.is_file() and not p.is_symlink()
                 and '__pycache__' not in p.parts and p.suffix != '.pyc'
                 and not any(part.startswith('.') for part in p.relative_to(root).parts))
manifest = {'format': 1, 'version': version, 'commit': commit,
            'requirements': {name: hashlib.sha256((root/name).read_bytes()).hexdigest()
                for name in ['backend/requirements.txt','backend/requirements-prelayout.txt']},
            'files': {str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in files}}
assert 'frontend/dist/index.html' in manifest['files'], 'Build frontend first'
args.output.mkdir(parents=True, exist_ok=True)
bundle=args.output/'application.zip'
with zipfile.ZipFile(bundle,'w',zipfile.ZIP_DEFLATED,compresslevel=1) as archive:
    archive.writestr('update-manifest.json',json.dumps(manifest,ensure_ascii=False))
    for p in files: archive.write(p,str(p.relative_to(root)))
(args.output/'application.zip.sha256').write_text(hashlib.sha256(bundle.read_bytes()).hexdigest()+'  application.zip\n')
print(version,commit,len(files),bundle.stat().st_size)
