"""CLI orchestration tests: real store/import contracts, fake OCR, no GPU/server."""
from __future__ import annotations

import copy
import importlib.util
import io
import json
from pathlib import Path

import pytest
from PIL import Image

from app.prelayout.store import PrelayoutStore, atomic_json

SPEC = importlib.util.spec_from_file_location('import_prelayout_cli', Path(__file__).resolve().parents[2] / 'scripts/import_prelayout.py')
cli = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cli)


class FakeAPI:
    def __init__(self, root, monkeypatch):
        self.store = PrelayoutStore(root / 'server')
        self.calls, self.task = [], None
        self.interrupt_wait = self.lose_create = self.corrupt_export = False
        self.complete = True
        monkeypatch.setattr('app.prelayout.store.match_translation', self.match)

    @staticmethod
    def match(data, measure, image_dir):
        data = copy.deepcopy(data)
        for items in data['transMap'].values():
            for item in items:
                item.update(x=.4, y=.4, match_status='auto')
        return data

    @property
    def mutations(self):
        return [call for call in self.calls if call[0] == 'POST' and
                (not call[1].endswith(('/matches', '/imports')) or call[2].get('fields', {}).get('apply') == 'true')]

    def request(self, method, path, **kwargs):
        self.calls.append((method, path, kwargs))
        if path == '/api/prelayout/availability':
            return {'methods': {'ocr_aligned': True}, 'gpu_owner': None}
        if path == '/api/prelayout/projects':
            project = self.store.create(kwargs['fields']['name'], [(name, data) for _, name, data in kwargs['files']])
            if self.lose_create:
                raise OSError('response lost')
            return project
        pid = path.split('/')[4]
        if path.endswith('/detections'):
            if method == 'POST':
                assert kwargs['data'] == {'method': 'ocr_aligned', 'font_size': 24, 'step': 2}
                self.task = {'id': 'd_' + 'a' * 32, 'project_id': pid, 'state': 'queued'}
            else:
                if self.interrupt_wait:
                    self.interrupt_wait = False
                    raise KeyboardInterrupt
                if self.complete and self.task['state'] != 'completed':
                    project = self.store.read(pid)
                    project['detection_id'] = self.task['id']
                    project['revision'] += 1
                    self.store.write(project)
                    atomic_json(self.store.directory(pid) / 'detections' / self.task['id'] / 'output/measure.json', {})
                    self.task['state'] = 'completed'
            return copy.deepcopy(self.task)
        if path.endswith('/imports'):
            fields = kwargs['fields']
            return self.store.import_translation(pid, kwargs['files'][0][2], fields['kind'], fields['expected_revision'], fields['apply'] == 'true')
        if path.endswith('/matches/apply'):
            return self.store.apply_matches(pid, kwargs['data']['expected_revision'], kwargs['data']['manual'])
        if path.endswith('/matches'):
            return self.store.matches(pid)
        if path.endswith('/export/bt'):
            result = self.store.translation(pid)
            if self.corrupt_export:
                result['transMap']['2.png'][0]['text'] += 'changed'
            return result
        if method == 'GET':
            return self.store.read(pid)
        raise AssertionError((method, path, kwargs))


@pytest.fixture
def setup(tmp_path, monkeypatch):
    folder = tmp_path / 'chapter'
    folder.mkdir()
    for name in ('10.png', '2.png'):
        Image.new('RGB', (80, 100), 'white').save(folder / name)
    args = cli.parser().parse_args([str(folder), '--state-file', str(tmp_path / 'state.json')])
    return folder, args, FakeAPI(tmp_path, monkeypatch)


def translation(folder, args, extension='json', raw=None):
    file = folder.parent / ('translation.' + extension)
    value = {'comment': '原始備註', 'custom': {'a': [1, 2]}, 'page_summary': {'2.JPG': '概括'},
             'transMap': {'2.JPG': [{'index': 1, 'text': ' 前\n\n後　 ', 'ocr_text': '原文', 'extra': {'retain': True}}]}}
    file.write_bytes(raw if raw is not None else json.dumps(value, ensure_ascii=False).encode())
    args.translation = str(file)
    return file


def test_validation_natural_order_ignores_subdirectories_and_appledouble(setup):
    folder, args, api = setup
    (folder / '._3.png').write_bytes(b'not image')
    (folder / 'nested').mkdir()
    (folder / 'nested' / 'bad.png').write_bytes(b'not image')
    prepared = cli.prepare(args)
    assert [s['name'] for s in prepared['sources']] == ['2.png', '10.png']
    assert prepared['manifest']['name'] == 'chapter'
    assert not api.calls


@pytest.mark.parametrize('failure', ['duplicate', 'bad', 'rotation', 'unknown', 'many_to_one', 'plain_txt', 'bad_item', 'duplicate_json'])
def test_invalid_inputs_stop_before_any_api_call(setup, failure):
    folder, args, api = setup
    if failure == 'duplicate':
        Image.new('RGB', (10, 10)).save(folder / '2.JPG')
    elif failure == 'bad':
        (folder / '3.png').write_bytes(b'broken')
    elif failure == 'rotation':
        exif = Image.Exif(); exif[274] = 6
        Image.new('RGB', (10, 20)).save(folder / '3.jpg', exif=exif)
    elif failure == 'plain_txt':
        translation(folder, args, 'txt', b'ordinary text\n')
    elif failure == 'duplicate_json':
        translation(folder, args, raw=b'{"transMap":{"2.png":[],"2.png":[]}}')
    else:
        data = {'transMap': {'missing.png' if failure == 'unknown' else '2.png': [{'text': 'a'}]}}
        if failure == 'many_to_one':
            data['transMap']['2.jpg'] = []
        elif failure == 'bad_item':
            data['transMap']['2.png'][0]['x'] = 999
        translation(folder, args, raw=json.dumps(data).encode())
    with pytest.raises(ValueError):
        cli.run(args, api)
    assert api.calls == []
    assert not Path(args.state_file).exists()


def test_check_only_no_mutations_or_checkpoint(setup):
    folder, args, api = setup
    translation(folder, args)
    args.check_only = True
    report = cli.run(args, api)
    assert report['stage'] == 'check_only'
    assert report['missing_translation_pages'] == ['10.png']
    assert not api.mutations and not Path(args.state_file).exists()


def test_no_translation_runs_ocr_without_import_or_match(setup):
    _, args, api = setup
    report = cli.run(args, api)
    assert report['stage'] == 'completed' and report['item_count'] == 0
    assert report['revision'] == 1 and report['page_count'] == 2
    assert len(api.mutations) == 2
    assert all(not call[1].endswith(('/imports', '/matches', '/review')) for call in api.calls)
    assert api.store.translation(report['project_id'])['transMap'] == {'2.png': [], '10.png': []}


def test_bt_roundtrip_preserves_text_blank_lines_metadata_and_reports_missing_page(setup):
    folder, args, api = setup
    translation(folder, args)
    report = cli.run(args, api)
    assert report['item_count'] == 1 and report['matches']['auto'] == 1 and report['revision'] == 3
    assert report['missing_translation_pages'] == ['10.png']
    exported = api.store.translation(report['project_id'])
    assert exported['transMap']['2.png'][0]['text'] == ' 前\n\n後　 '
    assert exported['transMap']['2.png'][0]['extra'] == {'retain': True}
    assert exported['page_summary'] == {'2.png': '概括'}
    assert report['translation_format'] == report['import_kind'] == 'bt'
    assert len(api.mutations) == 4


@pytest.mark.parametrize('body,kind', [('第一行\n第二行', 'labelplus'), (' 首尾空格 \n\n第二行　 ', 'bt')])
def test_labelplus_flow_and_lossless_bt_bridge(setup, body, kind):
    folder, args, api = setup
    raw = ('1, 0\n-\n群組\n-\n備註\n>>>>>>>>[2.jpg]<<<<<<<<\n'
           '----------------[1]----------------[0.2,0.3,1]\n' + body + '\n').encode()
    translation(folder, args, 'txt', raw)
    report = cli.run(args, api)
    assert report['translation_format'] == 'labelplus' and report['import_kind'] == kind
    assert api.store.translation(report['project_id'])['transMap']['2.png'][0]['text'] == body
    assert len(api.mutations) == 4


def test_labelplus_ambiguous_interpage_blank_line_rejected_before_mutation(setup):
    folder, args, api = setup
    translation(folder, args, 'txt', ('1, 0\n-\n群組\n-\n\n>>>>>>>>[2.png]<<<<<<<<\n'
                                    '----------------[1]----------------[0.2,0.3,1]\n文字\n\n>>>>>>>>[10.png]<<<<<<<<\n').encode())
    with pytest.raises(ValueError, match='歧義空行'):
        cli.run(args, api)
    assert not api.calls


def test_completed_rerun_only_verifies_without_mutations(setup):
    folder, args, api = setup
    translation(folder, args)
    first = cli.run(args, api)
    api.calls.clear()
    second = cli.run(args, api)
    assert first == second
    assert api.calls and all(call[0] == 'GET' for call in api.calls)


def test_interrupted_wait_resumes_same_project_and_detection(setup):
    folder, args, api = setup
    translation(folder, args)
    api.interrupt_wait = True
    with pytest.raises(KeyboardInterrupt):
        cli.run(args, api)
    checkpoint = json.loads(Path(args.state_file).read_text())
    assert checkpoint['stage'] == 'waiting' and checkpoint['pending'] is None
    api.calls.clear()
    report = cli.run(args, api)
    assert report['project_id'] == checkpoint['project_id'] and report['detection_id'] == checkpoint['detection_id']
    assert len(api.mutations) == 2  # import and match only


def test_timeout_keeps_waiting_checkpoint_without_cancelling(setup):
    _, args, api = setup
    api.complete = False
    args.detection_timeout = 0.001
    with pytest.raises(ValueError, match='未取消伺服器 OCR'):
        cli.run(args, api)
    assert json.loads(Path(args.state_file).read_text())['stage'] == 'waiting'
    assert not any(call[1].endswith('/cancel') for call in api.calls)


def test_unknown_mutation_result_is_not_resent(setup):
    _, args, api = setup
    api.lose_create = True
    with pytest.raises(ValueError, match='response lost'):
        cli.run(args, api)
    assert len(api.store.list()) == 1
    api.calls.clear()
    with pytest.raises(ValueError, match='結果不明.*禁止自動重送'):
        cli.run(args, api)
    assert not api.calls


def test_unknown_import_result_retains_known_project_id(setup, monkeypatch):
    folder, args, api = setup
    translation(folder, args)
    original = api.request
    def lose_import(method, path, **kwargs):
        result = original(method, path, **kwargs)
        if path.endswith('/imports') and kwargs['fields']['apply'] == 'true':
            raise OSError('lost import reply')
        return result
    monkeypatch.setattr(api, 'request', lose_import)
    with pytest.raises(ValueError, match='lost import reply'):
        cli.run(args, api)
    checkpoint = json.loads(Path(args.state_file).read_text())
    assert checkpoint['pending'] == 'import' and checkpoint['project_id']
    api.calls.clear()
    with pytest.raises(ValueError, match=checkpoint['project_id']):
        cli.run(args, api)
    assert not api.calls


def test_stale_revision_after_human_edit_stops_rerun(setup):
    _, args, api = setup
    report = cli.run(args, api)
    project = api.store.read(report['project_id']); project['revision'] += 1
    api.store.write(project)
    api.calls.clear()
    with pytest.raises(ValueError, match='保留後續人工編輯'):
        cli.run(args, api)
    assert not api.mutations


def test_changed_input_checkpoint_stops_before_api(setup):
    folder, args, api = setup
    cli.run(args, api)
    Image.new('RGB', (80, 100), 'black').save(folder / '2.png')
    api.calls.clear()
    with pytest.raises(ValueError, match='checkpoint 不一致'):
        cli.run(args, api)
    assert not api.calls


def test_corrupt_export_is_rejected_and_not_marked_completed(setup):
    folder, args, api = setup
    translation(folder, args)
    api.corrupt_export = True
    with pytest.raises(ValueError, match='文字／計數不一致'):
        cli.run(args, api)
    assert json.loads(Path(args.state_file).read_text())['stage'] == 'matched'
    api.corrupt_export = False
    api.calls.clear()
    assert cli.run(args, api)['stage'] == 'completed'
    assert not api.mutations


@pytest.mark.parametrize('phase', sorted(cli.ACTIVE | {'running'}))
def test_all_detection_progress_states_can_resume(setup, monkeypatch, phase):
    _, args, api = setup
    api.interrupt_wait = True
    with pytest.raises(KeyboardInterrupt):
        cli.run(args, api)
    api.complete = False
    api.task['state'] = phase
    monkeypatch.setattr(cli.time, 'sleep', lambda seconds: setattr(api, 'complete', True))
    report = cli.run(args, api)
    assert report['stage'] == 'completed'
    assert len(api.mutations) == 2


def test_publication_race_waits_for_completed_instead_of_importing_early(setup, monkeypatch):
    folder, args, api = setup
    translation(folder, args)
    api.interrupt_wait = True
    with pytest.raises(KeyboardInterrupt):
        cli.run(args, api)
    checkpoint = json.loads(Path(args.state_file).read_text())
    project = api.store.read(checkpoint['project_id'])
    project['revision'] += 1
    project['detection_id'] = checkpoint['detection_id']
    api.store.write(project)
    atomic_json(api.store.directory(project['id']) / 'detections' / checkpoint['detection_id'] / 'output/measure.json', {})
    api.task['state'], api.complete = 'publishing', False
    def publish(seconds):
        assert not any(call[1].endswith('/imports') for call in api.calls)
        api.task['state'] = 'completed'
    monkeypatch.setattr(cli.time, 'sleep', publish)
    assert cli.run(args, api)['revision'] == 3


@pytest.mark.parametrize('availability', [
    {'methods': {'ocr_aligned': False}, 'gpu_owner': None},
    {'methods': {'ocr_aligned': True}, 'gpu_owner': 'someone-else'},
])
def test_unready_or_busy_service_stops_before_mutations(setup, monkeypatch, availability):
    _, args, api = setup
    monkeypatch.setattr(api, 'request', lambda *a, **kw: availability)
    with pytest.raises(ValueError):
        cli.run(args, api)
    assert not api.store.list()


def test_stale_revision_during_wait_never_imports(setup):
    folder, args, api = setup
    translation(folder, args)
    api.interrupt_wait = True
    with pytest.raises(KeyboardInterrupt):
        cli.run(args, api)
    checkpoint = json.loads(Path(args.state_file).read_text())
    project = api.store.read(checkpoint['project_id']); project['revision'] += 1
    api.store.write(project)
    api.calls.clear()
    with pytest.raises(ValueError, match='保留後續人工編輯'):
        cli.run(args, api)
    assert not api.mutations


def test_missing_text_uses_backend_empty_string_default(setup):
    folder, args, api = setup
    translation(folder, args, raw=json.dumps({'transMap': {'2.png': [{'extra': {'a': True}}]}}).encode())
    report = cli.run(args, api)
    assert report['item_count'] == 1
    item = api.store.translation(report['project_id'])['transMap']['2.png'][0]
    assert item['text'] == '' and item['extra'] == {'a': True}


def test_default_checkpoint_rejects_changed_files_instead_of_creating_again(setup, monkeypatch):
    folder, args, api = setup
    args.state_file = None
    monkeypatch.setattr(cli, 'ROOT', folder.parent)
    cli.run(args, api)
    Image.new('RGB', (80, 100), 'black').save(folder / '2.png')
    api.calls.clear()
    with pytest.raises(ValueError, match='輸入檔案已變更'):
        cli.run(args, api)
    assert not api.calls and len(api.store.list()) == 1


def test_same_command_lock_prevents_concurrent_creation(setup):
    _, args, api = setup
    with Path(args.state_file + '.lock').open('a') as lock:
        cli.fcntl.flock(lock, cli.fcntl.LOCK_EX | cli.fcntl.LOCK_NB)
        with pytest.raises(ValueError, match='同一匯入正在執行'):
            cli.run(args, api)
    assert not api.calls


def test_corrupt_match_preview_prevents_apply(setup, monkeypatch):
    folder, args, api = setup
    translation(folder, args)
    original = api.match
    def corrupt(data, measure, image_dir):
        result = original(data, measure, image_dir)
        result['transMap']['2.png'][0]['text'] += '!'
        return result
    monkeypatch.setattr('app.prelayout.store.match_translation', corrupt)
    with pytest.raises(ValueError, match='文字／計數不一致'):
        cli.run(args, api)
    checkpoint = json.loads(Path(args.state_file).read_text())
    assert checkpoint['stage'] == 'imported' and checkpoint['pending'] is None
    assert not any(call[1].endswith('/matches/apply') for call in api.calls)


def test_detection_task_identity_mismatch_stops_before_import(setup):
    folder, args, api = setup
    translation(folder, args)
    api.interrupt_wait = True
    with pytest.raises(KeyboardInterrupt):
        cli.run(args, api)
    api.task['id'] = 'd_' + 'b' * 32
    api.calls.clear()
    with pytest.raises(ValueError, match='偵測任務 ID 與 checkpoint 不一致'):
        cli.run(args, api)
    assert not api.mutations


@pytest.mark.parametrize('field,value', [('request_timeout', float('nan')), ('detection_timeout', float('inf')),
                                         ('request_timeout', 0), ('detection_timeout', -1)])
def test_nonfinite_or_nonpositive_timeouts_fail_before_api(setup, field, value):
    _, args, api = setup
    setattr(args, field, value)
    with pytest.raises(ValueError, match='有限且大於 0'):
        cli.run(args, api)
    assert not api.calls and not Path(args.state_file).exists()


def test_wait_interrupt_prints_actual_checkpoint_and_project_id(setup, capsys):
    _, args, api = setup
    api.interrupt_wait = True
    with pytest.raises(KeyboardInterrupt):
        cli.run(args, api)
    checkpoint = json.loads(Path(args.state_file).read_text())
    message = capsys.readouterr().err
    assert args.state_file in message and checkpoint['project_id'] in message
    assert 'stage=waiting' in message and 'pending=None' in message


def test_mutation_interrupt_prints_pending_operation_and_known_project(setup, monkeypatch, capsys):
    folder, args, api = setup
    translation(folder, args)
    original = api.request
    def interrupt_import(method, path, **kwargs):
        result = original(method, path, **kwargs)
        if path.endswith('/imports') and kwargs['fields']['apply'] == 'true':
            raise KeyboardInterrupt
        return result
    monkeypatch.setattr(api, 'request', interrupt_import)
    with pytest.raises(KeyboardInterrupt):
        cli.run(args, api)
    checkpoint = json.loads(Path(args.state_file).read_text())
    message = capsys.readouterr().err
    assert args.state_file in message and checkpoint['project_id'] in message and 'pending=import' in message
    api.calls.clear()
    with pytest.raises(ValueError, match='結果不明.*禁止自動重送'):
        cli.run(args, api)
    assert not api.calls
