"""Batch preparation/resume contracts, using a real store with fake OCR only."""
from __future__ import annotations

import copy
import fcntl
import importlib.util
import json
from pathlib import Path

import pytest
from PIL import Image

from app.prelayout.store import PrelayoutStore, atomic_json

SPEC = importlib.util.spec_from_file_location('import_prelayout_batch_cli', Path(__file__).resolve().parents[2] / 'scripts/import_prelayout_batch.py')
cli = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cli)


class FakeAPI:
    def __init__(self, root):
        self.store = PrelayoutStore(root / 'server')
        self.calls, self.tasks = [], {}
        self.lose_import = self.lose_create = self.fail_import_before_write = False

    def request(self, method, path, **kwargs):
        self.calls.append((method, path, copy.deepcopy(kwargs)))
        assert 'matches' not in path
        if path == '/api/prelayout/availability':
            return {'methods': {'ocr_aligned': True}, 'gpu_owner': None}
        if path == '/api/prelayout/projects':
            if method == 'GET':
                return self.store.list()
            project = self.store.create(kwargs['fields']['name'], [(name, data) for _, name, data in kwargs['files']])
            if self.lose_create:
                raise OSError('create response lost')
            return project
        pid = path.split('/')[4]
        if path.endswith('/detections'):
            if method == 'POST':
                assert kwargs['data'] == {'method': 'ocr_aligned', 'font_size': 24, 'step': 2}
                self.tasks[pid] = {'id': 'd_' + 'a' * 32, 'project_id': pid, 'state': 'queued'}
            else:
                task = self.tasks[pid]
                if task['state'] != 'completed':
                    project = self.store.read(pid)
                    project['detection_id'] = task['id']
                    project['revision'] += 1
                    self.store.write(project)
                    atomic_json(self.store.directory(pid) / 'detections' / task['id'] / 'output/measure.json', {})
                    task['state'] = 'completed'
            return copy.deepcopy(self.tasks[pid])
        if path.endswith('/imports'):
            fields = kwargs['fields']
            assert fields['kind'] == 'bt'
            apply = fields['apply'] == 'true'
            if apply and self.fail_import_before_write:
                raise OSError('no response before write')
            result = self.store.import_translation(pid, kwargs['files'][0][2], 'bt', fields['expected_revision'], apply)
            if apply and self.lose_import:
                raise OSError('import response lost')
            return result
        if path.endswith('/export/bt'):
            return self.store.translation(pid)
        if method == 'GET':
            return self.store.read(pid)
        raise AssertionError((method, path, kwargs))


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False))


@pytest.fixture
def setup(tmp_path):
    folder = tmp_path / 'chapter'
    folder.mkdir()
    for name in ('10.png', ' 2.png'):
        Image.new('RGB', (80, 100), 'white').save(folder / name)
    translation = tmp_path / 'translation.json'
    original = {'comment': ' 原備註\n', 'custom': {'a': [1, 2]},
                'page_summary': {' 2.JPG': '概括', 'cover-only.jpg': 'summary-only'},
                'transMap': {' 2.JPG': [{'index': 9, 'text': ' 前\n\n後　 ', 'ocr_text': '原文',
                                        'x': .2, 'y': .8, 'font-size': 24, 'orientation': 'horizontal',
                                        'rotation': 12, 'color': '#123456', 'stroke-color': '#FFFFFF',
                                        'stroke-weight': 2, 'match_status': 'manual', 'match_confidence': .7,
                                        'extra': {'retain': True}}], '10.png': []}}
    write_json(translation, original)
    manifest = tmp_path / 'manifest.json'
    job = {'key': 'comic-1', 'title': '漫畫1', 'image_dir': str(folder), 'translation': str(translation),
           'expected_pages': 2, 'expected_items': 1}
    write_json(manifest, {'version': 1, 'jobs': [job]})
    args = cli.parser().parse_args(['--manifest', str(manifest), '--state-dir', str(tmp_path / 'state')])
    return args, job, original, FakeAPI(tmp_path)


def execute(setup):
    args, _, _, api = setup
    args.execute = True
    return cli.run(args, api)


def test_default_preflight_is_local_even_without_api_construction(setup, monkeypatch):
    args, _, _, api = setup
    monkeypatch.setattr(cli.importer, 'API', lambda *a, **kw: pytest.fail('constructed API'))
    report = cli.run(args, api)
    assert report['mode'] == 'dry_run'
    assert report['jobs'][0]['pages'] == 2
    assert not api.calls
    assert not list(args.state_dir.rglob('images.json'))
    assert not list(args.state_dir.rglob('json-import.json'))


def test_execute_preserves_all_fields_and_normalizes_only_page_summary(setup):
    args, _, original, api = setup
    report = execute(setup)
    result = api.store.translation(report['jobs'][0]['project_id'])
    assert result['transMap'][' 2.png'][0].items() >= original['transMap'][' 2.JPG'][0].items()
    assert result['page_summary'] == {' 2.png': '概括', 'cover-only.jpg': 'summary-only'}
    assert all('matches' not in path for _, path, _ in api.calls)
    assert not any(path.endswith('/review') for _, path, _ in api.calls)
    assert json.loads((args.state_dir / 'progress.json').read_text())['jobs'][0]['stage'] == 'done'
    before = len(api.calls)
    assert execute(setup)['jobs'][0]['revision'] == 2
    assert all(method == 'GET' for method, _, _ in api.calls[before:])


@pytest.mark.parametrize('path', ['/api/prelayout/projects/x/matches', '/api/prelayout/projects/x/matches/apply?x=1'])
def test_matching_hard_blocked(setup, path):
    api = setup[3]
    with pytest.raises(ValueError, match='禁止匹配'):
        cli.NoMatchAPI(api).request('POST', path)
    assert not api.calls


def test_pending_applied_json_recovers_with_reads_only(setup):
    args, _, _, api = setup
    api.lose_import = True
    with pytest.raises(ValueError, match='response lost'):
        execute(setup)
    checkpoint = args.state_dir / 'comic-1/json-import.json'
    assert json.loads(checkpoint.read_text())['pending'] == 'import'
    before = len(api.calls)
    assert execute(setup)['jobs'][0]['stage'] == 'done'
    assert all(method == 'GET' for method, _, _ in api.calls[before:])
    assert json.loads(checkpoint.read_text())['pending'] is None


def test_pending_unapplied_json_never_resends(setup):
    args, _, _, api = setup
    api.fail_import_before_write = True
    with pytest.raises(ValueError):
        execute(setup)
    before = len(api.calls)
    with pytest.raises(ValueError, match='revision'):
        execute(setup)
    assert all(method == 'GET' for method, _, _ in api.calls[before:])
    assert json.loads((args.state_dir / 'comic-1/json-import.json').read_text())['pending'] == 'import'


def test_pending_create_never_recreates(setup):
    _, _, _, api = setup
    api.lose_create = True
    with pytest.raises(ValueError):
        execute(setup)
    before = len(api.calls)
    with pytest.raises(ValueError, match='禁止自動重送'):
        execute(setup)
    assert all(method == 'GET' for method, _, _ in api.calls[before:])
    assert len(api.store.list()) == 1


def test_same_title_without_checkpoint_refuses_create(setup):
    _, job, _, api = setup
    api.store.create(job['title'], [('1.png', (Path(job['image_dir']) / '10.png').read_bytes())])
    with pytest.raises(ValueError, match='同名項目'):
        execute(setup)
    assert all(method == 'GET' for method, _, _ in api.calls)


@pytest.mark.parametrize('source', ['image', 'translation'])
def test_changed_sources_stop_before_api(setup, source):
    args, job, original, api = setup
    cli.run(args)
    if source == 'image':
        Image.new('RGB', (80, 100), 'black').save(Path(job['image_dir']) / '10.png')
    else:
        original['comment'] = 'changed'
        write_json(Path(job['translation']), original)
    with pytest.raises(ValueError, match='來源檔案'):
        execute(setup)
    assert not api.calls


@pytest.mark.parametrize('pin', ['translation', 'image'])
def test_manifest_pins_checked_on_first_preflight(setup, pin):
    args, job, _, api = setup
    if pin == 'translation':
        job['translation_sha256'] = '0' * 64
    else:
        job['images'] = [{'name': 'extra.png'}]
    write_json(args.manifest, {'version': 1, 'jobs': [job]})
    with pytest.raises(ValueError, match='不一致'):
        cli.run(args)
    assert not api.calls


def test_manual_revision_drift_preserved(setup):
    _, _, _, api = setup
    report = execute(setup)
    project = api.store.read(report['jobs'][0]['project_id'])
    project['revision'] += 1
    api.store.write(project)
    before = len(api.calls)
    with pytest.raises(ValueError, match='人工編輯'):
        execute(setup)
    assert all(method == 'GET' for method, _, _ in api.calls[before:])


@pytest.mark.parametrize('change', ['name', 'review'])
def test_name_and_review_drift_preserved_even_without_revision_change(setup, change):
    _, _, _, api = setup
    report = execute(setup)
    project = api.store.read(report['jobs'][0]['project_id'])
    if change == 'name':
        project['name'] = '人工改名'
    else:
        project['pages'][0]['reviewed_revision'] = project['pages'][0]['revision']
    api.store.write(project)
    before = len(api.calls)
    with pytest.raises(ValueError, match='人工修改'):
        execute(setup)
    assert all(method == 'GET' for method, _, _ in api.calls[before:])


def test_pending_recovery_rejects_geometry_or_match_field_change(setup, monkeypatch):
    _, _, _, api = setup
    api.lose_import = True
    with pytest.raises(ValueError):
        execute(setup)
    real = api.store.translation

    def changed(pid):
        value = real(pid)
        value['transMap'][' 2.png'][0]['match_confidence'] = 0
        return value

    monkeypatch.setattr(api.store, 'translation', changed)
    before = len(api.calls)
    with pytest.raises(ValueError, match='match_confidence'):
        execute(setup)
    assert all(method == 'GET' for method, _, _ in api.calls[before:])


def test_exact_body_pages_and_expected_counts_required(setup):
    args, job, original, api = setup
    original['transMap'].pop('10.png')
    write_json(Path(job['translation']), original)
    with pytest.raises(ValueError, match='不齊'):
        cli.run(args)
    assert not api.calls


def test_limit_and_state_lock(setup):
    args, job, _, api = setup
    second = {**job, 'key': 'comic-2', 'title': '漫畫2', 'image_dir': '/missing'}
    write_json(args.manifest, {'version': 1, 'jobs': [job, second]})
    args.limit = 1
    assert len(cli.run(args)['jobs']) == 1
    with (args.state_dir / '.batch.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with pytest.raises(ValueError, match='正在使用'):
            cli.run(args, api)
    assert not api.calls
    with pytest.raises(SystemExit):
        cli.parser().parse_args(['--manifest', 'x', '--state-dir', 'y', '--limit', '0'])


def test_question_records_rebind_references_but_preserve_snapshots(setup):
    _, job, original, api = setup
    original['questionRecords'] = {'version': 4, 'records': [{
        'id': 'question-1', 'note': ' 原疑問\n', 'createdAt': '2026-01-01T00:00:00Z',
        'updatedAt': '2026-01-01T00:00:00Z', 'texts': [{
            'key': 'old-key', 'pageId': 'old-page', 'itemId': 'old-item',
            'pageName': ' 2.JPG', 'pageNumber': 99, 'itemNumber': 1, 'text': '原快照',
            'source': {'text': '原快照', 'custom': [1, 2]}, 'pageSummary': {'a': '概括'}}]}]}
    write_json(Path(job['translation']), original)
    report = execute(setup)
    result = api.store.translation(report['jobs'][0]['project_id'])['questionRecords']
    assert result['version'] == 5
    assert result['records'][0]['texts'][0]['pageName'] == ' 2.png'
    assert result['records'][0]['texts'][0]['source'] == {'text': '原快照', 'custom': [1, 2]}
    execute(setup)  # Read-only completion verification includes the rebound metadata.


def test_progress_records_first_completion_before_later_job_fails(setup, monkeypatch):
    args, job, _, api = setup
    write_json(args.manifest, {'version': 1, 'jobs': [job, {**job, 'key': 'comic-2', 'title': '漫畫2'}]})
    real = api.request

    def fail_second(method, path, **kwargs):
        if method == 'POST' and path == '/api/prelayout/projects' and kwargs['fields']['name'] == '漫畫2':
            progress = json.loads((args.state_dir / 'progress.json').read_text())
            assert progress['jobs'][0]['stage'] == 'done'
            raise OSError('second creation failed')
        return real(method, path, **kwargs)

    monkeypatch.setattr(api, 'request', fail_second)
    with pytest.raises(ValueError, match='comic-2'):
        execute(setup)
    progress = json.loads((args.state_dir / 'progress.json').read_text())
    assert progress['jobs'][0]['stage'] == 'done'
    assert progress['error']['key'] == 'comic-2'
    checkpoint = json.loads((args.state_dir / 'comic-2/images.json').read_text())
    assert checkpoint['pending'] == 'create'
