#!/usr/bin/env python3
"""Publish one immutable application bundle to GitHub and Gitee. Default: plan only."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen
import uuid
import zipfile

REPO = 'ZsIsMe/comic-lettering-helper'
ROOT = Path(__file__).resolve().parents[1]
GITEE_API = f'https://gitee.com/api/v5/repos/{REPO}'
NAMES = ('application.zip', 'application.zip.sha256')
GITEE_TOKEN = None


def load_gitee_token():
    token = os.environ.get('GITEE_TOKEN')
    if not token and sys.platform == 'darwin':
        result = subprocess.run(
            ['security', 'find-generic-password', '-a', os.environ.get('USER', ''),
             '-s', 'codex-gitee-token', '-w'], text=True, capture_output=True,
        )
        if result.returncode == 0:
            token = result.stdout.strip()
    if not token:
        raise ValueError('Set GITEE_TOKEN or Keychain item codex-gitee-token locally; never paste it into chat or Git')
    return token


def run(*args):
    result = subprocess.run(args, cwd=ROOT, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(f'{args[0]} {args[1]} failed (exit {result.returncode})')
    return result.stdout


def digest(data):
    return hashlib.sha256(data).hexdigest()


def validate_bundle(folder, tag):
    if not re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', tag):
        raise ValueError('Use a stable numeric tag, e.g. 0.2.10')
    files = {name: (folder / name).read_bytes() for name in NAMES}
    expected = f'{digest(files[NAMES[0]])}  application.zip'
    if files[NAMES[1]].decode().strip() != expected:
        raise ValueError('Bundle SHA-256 does not match')
    with zipfile.ZipFile(folder / NAMES[0]) as archive:
        manifest = json.loads(archive.read('update-manifest.json'))
        if manifest['version'] != tag:
            raise ValueError('Manifest version does not match tag')
        if set(archive.namelist()) != set(manifest['files']) | {'update-manifest.json'}:
            raise ValueError('Bundle contains missing or unlisted files')
        for name, sha in manifest['files'].items():
            if digest(archive.read(name)) != sha:
                raise ValueError(f'Manifest checksum mismatch: {name}')
    commit = run('git', 'rev-parse', f'refs/tags/{tag}^{{commit}}').strip()
    if manifest['commit'] != commit:
        raise ValueError('Manifest commit does not match local tag')
    return files, commit


def check_remote_tag(host, tag, commit):
    refs = run('git', 'ls-remote', f'https://{host}/{REPO}.git',
               f'refs/tags/{tag}', f'refs/tags/{tag}^{{}}')
    mapping = {ref: sha for sha, ref in (line.split() for line in refs.splitlines())}
    actual = mapping.get(f'refs/tags/{tag}^{{}}', mapping.get(f'refs/tags/{tag}'))
    if actual != commit:
        raise ValueError(f'{host}: push the matching tag {tag} first; remote tag is missing or differs')


def gitee(path, fields=None, file=None):
    url = GITEE_API + path
    headers = {'Accept': 'application/json', 'User-Agent': 'comic-release-publisher'}
    data = None
    if fields is not None:
        if not GITEE_TOKEN:
            raise ValueError('Gitee credentials have not been loaded')
        fields = dict(fields, access_token=GITEE_TOKEN)
        if file:
            boundary = uuid.uuid4().hex
            parts = []
            for key, value in fields.items():
                parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
            name, content = file
            parts.extend([
                f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode(),
                content, f'\r\n--{boundary}--\r\n'.encode(),
            ])
            data = b''.join(parts)
            headers['Content-Type'] = f'multipart/form-data; boundary={boundary}'
        else:
            data = urlencode(fields).encode()
            headers['Content-Type'] = 'application/x-www-form-urlencoded'
    try:
        with urlopen(Request(url, data=data, headers=headers), timeout=60) as response:
            return json.load(response)
    except HTTPError as exc:
        if fields is None and exc.code == 404:
            return None
        raise RuntimeError(f'Gitee API HTTP {exc.code}') from None


def verify_download(url, expected):
    if not url.startswith('https://'):
        raise ValueError('Release asset must use HTTPS')
    request = Request(url, headers={'User-Agent': 'comic-release-publisher'})
    with urlopen(request, timeout=60) as response:
        received = response.read(len(expected) + 1)
    if received != expected:
        raise ValueError('Public download differs from local artifact (or returned a login/captcha page)')


def github_release(tag):
    result = subprocess.run(['gh', 'api', f'repos/{REPO}/releases/tags/{tag}'],
                            cwd=ROOT, text=True, capture_output=True)
    if result.returncode == 0:
        return json.loads(result.stdout)
    if 'HTTP 404' in result.stderr:
        return None
    raise RuntimeError('Cannot read GitHub release metadata')


def publish_github(tag, title, notes, folder, files):
    release = github_release(tag)
    if release is None:
        run('gh', 'release', 'create', tag, '--repo', REPO, '--verify-tag',
            '--draft', '--title', title, '--notes-file', str(notes))
        release = json.loads(run('gh', 'api', f'repos/{REPO}/releases/tags/{tag}'))
    if release['prerelease'] or release['name'] != title or release['body'].strip() != notes.read_text().strip():
        raise ValueError('Existing GitHub release metadata differs; inspect it before publishing')
    assets = {a['name']: a for a in release['assets']}
    for name, content in files.items():
        if name in assets:
            with tempfile.TemporaryDirectory() as tmp:
                run('gh', 'release', 'download', tag, '--repo', REPO,
                    '--pattern', name, '--dir', tmp)
                if (Path(tmp) / name).read_bytes() != content:
                    raise ValueError(f'GitHub existing asset differs: {name}')
        else:
            run('gh', 'release', 'upload', tag, str(folder / name), '--repo', REPO)
    if release['draft']:
        run('gh', 'release', 'edit', tag, '--repo', REPO, '--draft=false')
    for name, content in files.items():
        verify_download(f'https://github.com/{REPO}/releases/download/{tag}/{name}', content)


def publish_gitee(tag, commit, title, notes, files):
    release = gitee('/releases/tags/' + quote(tag, safe=''))
    if release is None:
        release = gitee('/releases', fields={
            'tag_name': tag, 'target_commitish': commit, 'name': title,
            'body': notes.read_text(), 'prerelease': 'false',
        })
    if release['prerelease'] or release['name'] != title or release['body'].strip() != notes.read_text().strip():
        raise ValueError('Existing Gitee release metadata differs; inspect it before publishing')
    path = f'/releases/{int(release["id"])}/attach_files'
    assets = {}
    page = 1
    while True:
        batch = gitee(f'{path}?per_page=100&page={page}')
        if not isinstance(batch, list):
            raise ValueError('Cannot list Gitee release attachments')
        for asset in batch:
            if asset['name'] in assets:
                raise ValueError('Duplicate Gitee attachment names')
            assets[asset['name']] = asset
        if len(batch) < 100:
            break
        page += 1
    for name, content in files.items():
        asset = assets.get(name)
        if asset is None:
            asset = gitee(path, fields={}, file=(name, content))
        verify_download(asset['browser_download_url'], content)


def main():
    global GITEE_TOKEN
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('tag')
    parser.add_argument('bundle_dir', type=Path)
    parser.add_argument('--notes-file', type=Path, required=True)
    parser.add_argument('--title', help='Default: tag')
    parser.add_argument('--platform', choices=['both', 'github', 'gitee'], default='both')
    parser.add_argument('--apply', action='store_true', help='Create releases and upload missing assets')
    args = parser.parse_args()
    folder, notes = args.bundle_dir.resolve(), args.notes_file.resolve()
    if not notes.read_text().strip():
        raise ValueError('Release notes must not be empty')
    files, commit = validate_bundle(folder, args.tag)
    platforms = ['github', 'gitee'] if args.platform == 'both' else [args.platform]
    for platform in platforms:
        check_remote_tag(platform + '.com', args.tag, commit)
    print(f'Validated {args.tag} at {commit}; SHA-256 {digest(files[NAMES[0]])}')
    print('Targets: ' + ', '.join(platforms))
    if not args.apply:
        print('Plan only. Add --apply to publish. Existing differing assets are never overwritten.')
        return 0
    if 'gitee' in platforms:
        GITEE_TOKEN = load_gitee_token()
    if 'github' in platforms:
        run('gh', 'auth', 'status')
    failed = []
    for platform in platforms:
        try:
            if platform == 'github':
                publish_github(args.tag, args.title or args.tag, notes, folder, files)
            else:
                publish_gitee(args.tag, commit, args.title or args.tag, notes, files)
            print(f'{platform}: published; both public downloads verified')
        except (RuntimeError, ValueError, OSError, KeyError) as exc:
            print(f'{platform}: incomplete ({type(exc).__name__}); retry this platform after inspection', file=sys.stderr)
            failed.append(platform)
    return 1 if failed else 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (RuntimeError, ValueError, OSError, KeyError, zipfile.BadZipFile) as error:
        print(str(error) if type(error) in (RuntimeError, ValueError) else type(error).__name__, file=sys.stderr)
        sys.exit(1)
