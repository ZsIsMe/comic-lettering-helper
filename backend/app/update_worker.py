"""Standalone application updater, copied outside the app before execution."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import time
import urllib.request
import zipfile

ACTIVE = {'queued', 'downloading', 'validating', 'installing', 'restarting', 'rolling_back'}
REPO = 'https://github.com/ZsIsMe/comic-lettering-helper'
PREFIXES = ('backend/app/', 'backend/imaging/', 'backend/prelayout_core/', 'frontend/dist/')


def atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    temporary.replace(path)


def allowed(name):
    path = PurePosixPath(name)
    return (not path.is_absolute() and '..' not in path.parts and '\\' not in name
            and name.startswith(PREFIXES) and '__pycache__' not in path.parts
            and not any(part.startswith('.') for part in path.parts))


def download(url, target, limit):
    req = urllib.request.Request(url, headers={'User-Agent': 'comic-lettering-helper'})
    with urllib.request.urlopen(req, timeout=30) as response, target.open('wb') as output:
        count = 0
        while block := response.read(256 * 1024):
            count += len(block)
            if count > limit:
                raise ValueError('更新檔案超過大小限制')
            output.write(block)


def unpack(bundle, stage, app, target_version):
    with zipfile.ZipFile(bundle) as archive:
        entries = archive.infolist()
        if len(entries) > 5000 or sum(e.file_size for e in entries) > 300_000_000:
            raise ValueError('更新包過大')
        names = [e.filename for e in entries]
        if len(names) != len(set(names)) or 'update-manifest.json' not in names:
            raise ValueError('更新包清單無效')
        for entry in entries:
            if entry.filename != 'update-manifest.json' and not allowed(entry.filename):
                raise ValueError('更新包包含不允許的路徑')
            if entry.is_dir() or ((entry.external_attr >> 16) & 0o170000) == 0o120000:
                raise ValueError('更新包不接受連結或目錄項目')
        manifest = json.loads(archive.read('update-manifest.json'))
        if manifest['version'] != target_version or manifest['format'] != 1:
            raise ValueError('更新包版本不符')
        hashes = manifest['files']
        if set(names) != set(hashes) | {'update-manifest.json'}:
            raise ValueError('更新包檔案不完整')
        for required in ['backend/app/main.py', 'backend/app/updates.py', 'frontend/dist/index.html']:
            if required not in hashes:
                raise ValueError('更新包缺少必要檔案')
        for name, digest in manifest['requirements'].items():
            if name not in {'backend/requirements.txt', 'backend/requirements-prelayout.txt'}:
                raise ValueError('環境要求格式無效')
            if hashlib.sha256((app / name).read_bytes()).hexdigest() != digest:
                raise ValueError('此版本需要新版執行環境，請使用相容鏡像')
        if set(manifest['requirements']) != {'backend/requirements.txt', 'backend/requirements-prelayout.txt'}:
            raise ValueError('更新包缺少環境要求')
        for name, digest in hashes.items():
            data = archive.read(name)
            if hashlib.sha256(data).hexdigest() != digest:
                raise ValueError('更新檔案校驗失敗')
            # Do not follow local links out of the application tree.
            target = app / name
            if not target.resolve().is_relative_to(app.resolve()) or target.is_symlink():
                raise ValueError('應用路徑不允許更新')
            out = stage / name
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(data)
    return manifest


def backup_files(app, backup, names):
    existing = []
    for name in names:
        source = app / name
        if source.exists():
            target = backup / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            existing.append(name)
    atomic(backup / 'inventory.json', {'files': list(names), 'existing': existing})


def install_files(app, stage, names):
    for name in sorted(names, key=lambda n: n == 'frontend/dist/index.html'):
        target = app / name
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(target.name + '.upgrade')
        shutil.copyfile(stage / name, temporary)
        temporary.replace(target)


def restore_files(app, backup):
    inventory = json.loads((backup / 'inventory.json').read_text())
    for name in inventory['files']:
        target = app / name
        if name in inventory['existing']:
            shutil.copyfile(backup / name, target)
        else:
            target.unlink(missing_ok=True)


def restart(app, base_url, expected_version):
    subprocess.run([str(app / 'deploy/restart-web.sh')], check=True, timeout=90)
    with urllib.request.urlopen(base_url + '/api/app/version', timeout=10) as response:
        if json.load(response)['current_version'] != expected_version:
            raise ValueError('重啟後版本驗證失敗')
    with urllib.request.urlopen(base_url + '/api/health', timeout=10) as response:
        if json.load(response)['app'] != 'ok':
            raise ValueError('重啟後健康檢查失敗')


def perform(app, folder, state_file, version, previous, base_url):
    record = {'version': version, 'previous_version': previous, 'pid': os.getpid(), 'started_at': time.time()}
    def state(value, message):
        record.update(state=value, message=message, updated_at=time.time())
        atomic(state_file, record)
    changed = False
    backup = folder / 'backup'
    try:
        state('downloading', '正在下載正式更新包')
        bundle = folder / 'application.zip'
        checksum = folder / 'application.zip.sha256'
        base = f'{REPO}/releases/download/{version}'
        download(base + '/application.zip.sha256', checksum, 1024)
        expected = checksum.read_text().split()[0]
        if not re.fullmatch('[a-f0-9]{64}', expected):
            raise ValueError('更新包校驗碼無效')
        download(base + '/application.zip', bundle, 100_000_000)
        if hashlib.sha256(bundle.read_bytes()).hexdigest() != expected:
            raise ValueError('更新包校驗失敗，未修改應用')
        state('validating', '正在校驗檔案與執行環境')
        stage = folder / 'stage'
        manifest = unpack(bundle, stage, app, version)
        names = list(manifest['files'])
        backup_files(app, backup, names)
        state('installing', '正在安裝，漫畫資料與模型保留')
        changed = True
        install_files(app, stage, names)
        state('restarting', '正在重啟網頁，請等待重新連線')
        restart(app, base_url, version)
        atomic(app / 'deployed-release.json', {'tag': version, 'version': version,
               'commit': manifest['commit'], 'backup': str(backup), 'updated_files': manifest['files'],
               'method': '6008 web updater'})
        state('completed', '更新完成，網頁已恢復')
    except Exception as error:
        print(type(error).__name__, str(error), flush=True)
        if changed:
            try:
                state('rolling_back', '新版啟動失敗，正在回復舊版')
                restore_files(app, backup)
                restart(app, base_url, previous)
                state('rolled_back', '更新失敗，已自動回復舊版；資料保持不變')
            except Exception as rollback_error:
                print('Rollback:', type(rollback_error).__name__, str(rollback_error), flush=True)
                state('failed', '更新與回復未完成，請聯絡管理員；備份已保留')
        else:
            state('failed', '更新包下載或驗證失敗，應用未變更；請稍後重試')


if __name__ == '__main__':
    perform(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4], sys.argv[5], sys.argv[6])
