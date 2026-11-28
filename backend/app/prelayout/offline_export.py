"""Build a portable editor package from one published prelayout snapshot."""
from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile
import zipfile

from prelayout_core.data import read_json
from prelayout_core.preview import load_overlay


OFFLINE_ASSETS = Path(__file__).resolve().parents[3] / 'frontend' / 'dist' / 'offline'
INDEX_HTML = '''<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>離線漫畫排版</title>
  <link rel="stylesheet" href="./editor.css">
</head>
<body>
  <div id="root"></div>
  <script src="./editor.js"></script>
</body>
</html>
'''


class OfflineAssetsUnavailable(RuntimeError):
    pass


def _asset(root, relative):
    """Only read files owned by this project, even for a damaged manifest."""
    if not isinstance(relative, str) or '\\' in relative:
        raise ValueError('離線匯出資產路徑無效')
    value = Path(relative)
    if value.is_absolute() or '..' in value.parts:
        raise ValueError('離線匯出資產不可離開項目目錄')
    path = root / value
    if not path.resolve().is_relative_to(root.resolve()):
        raise ValueError('離線匯出資產不可離開項目目錄')
    if not path.is_file():
        raise FileNotFoundError('離線匯出缺少項目資產')
    return path


def _snapshot(store, pid, root):
    with store.lock(pid):
        project = store.read(pid)
        pages, assets = [], []
        for index, page in enumerate(project['pages'], 1):
            state_path = _asset(root, page['state'])
            state = store._line_break_state(pid, page, read_json(state_path.read_bytes()))
            original = _asset(root, f'originals/{page["name"]}')
            original_name = f'assets/{index:06d}-original{original.suffix.lower()}'
            record = {key: page[key] for key in ('id', 'name', 'width', 'height')}
            record.update(original=original_name,
                          itemIds=[item['_id'] for item in state['items']])
            if state.get('line_break_suggestions'):
                record['line_break_suggestions'] = state['line_break_suggestions']
            assets.append((original, original_name, None))
            if page.get('clean'):
                path = _asset(root, page['clean'])
                overlay = page.get('clean_kind') == 'inpainted'
                kind = 'overlay' if overlay else 'clean'
                name = f'assets/{index:06d}-{kind}{".png" if overlay else path.suffix.lower()}'
                record[kind] = name
                assets.append((path, name, (page['width'], page['height']) if overlay else None))
            pages.append(record)
        manifest = {'version': 1, 'name': project['name'], 'pages': pages}
        translation = store.translation(pid)
        # An imported offline draft may carry IDs from an older package.
        # The current project's IDs also anchor its question references and suggestions.
        identity = translation.get('_offlinePrelayout')
        if isinstance(identity, dict) and identity.get('version') == 1:
            identity['itemIds'] = {page['name']: page['itemIds'] for page in pages}
        return manifest, translation, assets


def export_offline(store, pid):
    try:
        runtime = {name: (OFFLINE_ASSETS / name).read_bytes() for name in ('editor.js', 'editor.css')}
        if any(not content for content in runtime.values()):
            raise FileNotFoundError
    except FileNotFoundError as exc:
        raise OfflineAssetsUnavailable('尚未建置離線編輯器，請先建置前端') from exc

    # Snapshot template, text and stable IDs together. Published page states and
    # images are immutable; a reader keeps them alive while allowing later edits.
    with store.reader(pid) as (_, root):
        manifest, translation, assets = _snapshot(store, pid, root)
        fd, temporary = tempfile.mkstemp(prefix='prelayout-offline-', suffix='.zip', dir=store.root)
        os.close(fd)
        path = Path(temporary)
        try:
            with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=1) as archive:
                archive.writestr('index.html', INDEX_HTML)
                for name, content in runtime.items():
                    archive.writestr(name, content)
                archive.writestr('project.json', json.dumps(manifest, ensure_ascii=False, allow_nan=False))
                archive.writestr('Meo.json', json.dumps(translation, ensure_ascii=False, allow_nan=False, indent=2))
                for source, name, overlay_size in assets:
                    if overlay_size is None:
                        archive.write(source, name, compress_type=zipfile.ZIP_STORED)
                    else:
                        with load_overlay(source, overlay_size) as image, archive.open(name, 'w') as output:
                            image.save(output, 'PNG')
            return path
        except BaseException:
            path.unlink(missing_ok=True)
            raise
