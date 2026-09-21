import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
import zipfile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import update_worker as worker, updates
from app.update_install import Installer, MaintenanceMiddleware, router
from app.resources import ResourceGate


def bundle(tmp_path, version='0.2.3', extra=None, corrupt=False, format=1,
           runtime_contract=None):
    app=tmp_path/'app'; app.mkdir(exist_ok=True)
    requirements={}
    for name in ['backend/requirements.txt','backend/requirements-prelayout.txt']:
        p=app/name; p.parent.mkdir(parents=True,exist_ok=True); p.write_text('fixed')
        requirements[name]=hashlib.sha256(b'fixed').hexdigest()
    values={'backend/app/main.py':b'new main', 'backend/app/updates.py':b'new version',
            'frontend/dist/index.html':b'new page'}
    values.update(extra or {})
    manifest={'format':format,'version':version,'commit':'test','requirements':requirements,
              'files':{k:hashlib.sha256(v).hexdigest() for k,v in values.items()}}
    if runtime_contract is not None:
        manifest['runtime_contract'] = runtime_contract
    path=tmp_path/'test.zip'
    with zipfile.ZipFile(path,'w') as archive:
        archive.writestr('update-manifest.json',json.dumps(manifest))
        for name,value in values.items(): archive.writestr(name,value+b'corrupt' if corrupt else value)
    return app,path


@pytest.mark.parametrize('extra', [{'../../escape':b'bad'}, {'config/.env':b'bad'},
    {'config/other.json':b'bad'}, {'frontend/dist/../secret':b'bad'}, {'backend/app/.env':b'bad'}])
def test_reject_paths_without_changing_application(tmp_path,extra):
    app,path=bundle(tmp_path,extra=extra)
    with pytest.raises(ValueError): worker.unpack(path,tmp_path/'stage',app,'0.2.3')
    assert not (app/'backend/app/main.py').exists()


def test_corrupt_and_incompatible_packages(tmp_path):
    app,path=bundle(tmp_path,corrupt=True)
    with pytest.raises(ValueError,match='校驗'): worker.unpack(path,tmp_path/'stage',app,'0.2.3')
    app,path=bundle(tmp_path)
    (app/'backend/requirements.txt').write_text('different')
    with pytest.raises(ValueError,match='執行環境'): worker.unpack(path,tmp_path/'stage',app,'0.2.3')


def test_runtime_contract_and_exact_new_paths(tmp_path):
    extra = {
        'runtime-tools/runner.py': b'runner', 'workflows/qwen21.json': b'workflow',
        'config/runtime.json': b'{}', 'config/components.json': b'{}', 'config/models.json': b'{}',
    }
    app, path = bundle(tmp_path, extra=extra, format=2,
                       runtime_contract='qwen21-native-int8-v1')
    with pytest.raises(ValueError, match='相容鏡像'):
        worker.unpack(path, tmp_path/'stage-missing', app, '0.2.3')
    (app/'runtime-capabilities.json').write_text(json.dumps({
        'format': 1, 'capabilities': ['different-runtime']}))
    with pytest.raises(ValueError, match='更換鏡像'):
        worker.unpack(path, tmp_path/'stage-wrong', app, '0.2.3')
    (app/'runtime-capabilities.json').write_text(json.dumps({
        'format': 1, 'capabilities': ['qwen21-native-int8-v1']}))
    manifest = worker.unpack(path, tmp_path/'stage-ok', app, '0.2.3')
    assert manifest['runtime_contract'] == 'qwen21-native-int8-v1'


def test_failed_restart_restores_old_code_and_preserves_data(tmp_path,monkeypatch):
    app,path=bundle(tmp_path, extra={'runtime-tools/runner.py': b'new runner'}, format=2,
                    runtime_contract='qwen21-native-int8-v1')
    (app/'runtime-capabilities.json').write_text(json.dumps({
        'format': 1, 'capabilities': ['qwen21-native-int8-v1']}))
    old=app/'backend/app/main.py'; old.parent.mkdir(parents=True); old.write_bytes(b'old main')
    old_runner=app/'runtime-tools/runner.py'; old_runner.parent.mkdir(parents=True); old_runner.write_bytes(b'old runner')
    data=app/'projects/keep.png'; data.parent.mkdir(); data.write_bytes(b'user data')
    folder=tmp_path/'update'; folder.mkdir()
    def download(url,target,limit):
        target.write_bytes(path.read_bytes() if url.endswith('.zip') else
                           (hashlib.sha256(path.read_bytes()).hexdigest() + '  application.zip\n').encode())
    monkeypatch.setattr(worker,'download',download)
    monkeypatch.setattr(worker, 'resolve_release', lambda version: {
        'source': 'gitee', 'assets': {'application.zip': 'https://gitee/application.zip',
                                     'application.zip.sha256': 'https://gitee/application.zip.sha256'}})
    calls=[]
    def restart(app,base,version):
        calls.append(version)
        if len(calls)==1: raise RuntimeError('new version fails')
        assert old.read_bytes()==b'old main'
    monkeypatch.setattr(worker,'restart',restart)
    status=tmp_path/'status.json'
    worker.perform(app,folder,status,'0.2.3','0.2.2','http://test')
    assert json.loads(status.read_text())['state']=='rolled_back'
    assert calls==['0.2.3','0.2.2']
    assert data.read_bytes()==b'user data'
    assert old_runner.read_bytes()==b'old runner'
    assert not (app/'backend/app/updates.py').exists()


def test_download_failure_never_restarts(tmp_path,monkeypatch):
    app,path=bundle(tmp_path)
    def fail(*args): raise TimeoutError()
    monkeypatch.setattr(worker,'download',fail)
    monkeypatch.setattr(worker, 'resolve_release', lambda version: {
        'source': 'github', 'assets': {'application.zip': 'https://github/zip',
                                      'application.zip.sha256': 'https://github/sha'}})
    monkeypatch.setattr(worker,'restart',lambda *args: pytest.fail('Must not restart'))
    folder=tmp_path/'update'; folder.mkdir(); status=tmp_path/'status.json'
    worker.perform(app,folder,status,'0.2.3','0.2.2','http://test')
    assert json.loads(status.read_text())['state']=='failed'


def test_outer_checksum_mismatch_never_changes_or_restarts(tmp_path, monkeypatch):
    app, path = bundle(tmp_path)
    old = app/'backend/app/main.py'; old.parent.mkdir(parents=True); old.write_bytes(b'old')
    urls = []
    def download(url, target, limit):
        urls.append(url)
        target.write_bytes(path.read_bytes() if url.endswith('/application.zip') else
                           (b'0' * 64 + b'  application.zip\n'))
    monkeypatch.setattr(worker, 'download', download)
    monkeypatch.setattr(worker, 'resolve_release', lambda version: {
        'source': 'gitee', 'assets': {
            'application.zip': 'https://gitee.test/release/application.zip',
            'application.zip.sha256': 'https://gitee.test/release/application.zip.sha256'}})
    monkeypatch.setattr(worker, 'restart', lambda *args: pytest.fail('Must not restart'))
    folder=tmp_path/'update'; folder.mkdir(); status=tmp_path/'status.json'
    worker.perform(app, folder, status, '0.2.3', '0.2.2', 'http://test')
    assert json.loads(status.read_text())['state'] == 'failed'
    assert old.read_bytes() == b'old'
    assert all('gitee.test' in url for url in urls)


def test_runtime_rejection_is_explained_without_changing_app(tmp_path, monkeypatch):
    app, path = bundle(tmp_path, format=2, runtime_contract='qwen21-native-int8-v1')
    old = app/'backend/app/main.py'; old.parent.mkdir(parents=True); old.write_bytes(b'old')
    def download(url, target, limit):
        target.write_bytes(path.read_bytes() if url.endswith('/application.zip') else
                           (hashlib.sha256(path.read_bytes()).hexdigest() + '  application.zip\n').encode())
    monkeypatch.setattr(worker, 'download', download)
    monkeypatch.setattr(worker, 'resolve_release', lambda version: {
        'source': 'gitee', 'assets': {
            'application.zip': 'https://gitee.test/application.zip',
            'application.zip.sha256': 'https://gitee.test/application.zip.sha256'}})
    monkeypatch.setattr(worker, 'restart', lambda *args: pytest.fail('Must not restart'))
    folder=tmp_path/'update'; folder.mkdir(); status=tmp_path/'status.json'
    worker.perform(app, folder, status, '0.2.3', '0.2.2', 'http://test')
    result = json.loads(status.read_text())
    assert result['state'] == 'failed'
    assert 'qwen21-native-int8-v1' in result['message']
    assert '相容鏡像' in result['message']
    assert old.read_bytes() == b'old'


@pytest.mark.parametrize('failed_name', ['application.zip.sha256', 'application.zip'])
def test_gitee_transport_failure_retries_complete_pair_from_github(tmp_path, monkeypatch, failed_name):
    app, path = bundle(tmp_path)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    calls = []
    def download(url, target, limit):
        calls.append(url)
        if 'gitee.test' in url and url.endswith(failed_name):
            raise worker.DownloadTransportError()
        target.write_bytes((digest + '  application.zip\n').encode()
                           if url.endswith('.sha256') else path.read_bytes())
    gitee = {'source': 'gitee', 'assets': {
        'application.zip': 'https://gitee.test/application.zip',
        'application.zip.sha256': 'https://gitee.test/application.zip.sha256'}}
    github = {'source': 'github', 'assets': {
        'application.zip': 'https://github.test/application.zip',
        'application.zip.sha256': 'https://github.test/application.zip.sha256'}}
    monkeypatch.setattr(worker, 'download', download)
    monkeypatch.setattr(worker, 'resolve_release', lambda version: gitee)
    monkeypatch.setattr(worker, 'github_release', lambda version: github)
    monkeypatch.setattr(worker, 'restart', lambda *args: None)
    folder=tmp_path/'update'; folder.mkdir(); status=tmp_path/'status.json'
    worker.perform(app, folder, status, '0.2.3', '0.2.2', 'http://test')
    assert json.loads(status.read_text())['state'] == 'completed'
    assert json.loads((app/'deployed-release.json').read_text())['source'] == 'github'
    assert calls[-2:] == [github['assets']['application.zip.sha256'],
                          github['assets']['application.zip']]


def test_cross_platform_checksum_difference_is_explicitly_rejected(tmp_path, monkeypatch):
    app, path = bundle(tmp_path)
    old = app/'backend/app/main.py'; old.parent.mkdir(parents=True); old.write_bytes(b'old')
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    calls = []
    def download(url, target, limit):
        calls.append(url)
        if url == 'https://gitee.test/application.zip':
            raise worker.DownloadTransportError()
        checksum = ('0' * 64) if 'github.test' in url else digest
        target.write_bytes((checksum + '  application.zip\n').encode())
    monkeypatch.setattr(worker, 'download', download)
    monkeypatch.setattr(worker, 'resolve_release', lambda version: {'source': 'gitee', 'assets': {
        'application.zip': 'https://gitee.test/application.zip',
        'application.zip.sha256': 'https://gitee.test/application.zip.sha256'}})
    monkeypatch.setattr(worker, 'github_release', lambda version: {'source': 'github', 'assets': {
        'application.zip': 'https://github.test/application.zip',
        'application.zip.sha256': 'https://github.test/application.zip.sha256'}})
    monkeypatch.setattr(worker, 'restart', lambda *args: pytest.fail('Must not restart'))
    folder=tmp_path/'update'; folder.mkdir(); status=tmp_path/'status.json'
    worker.perform(app, folder, status, '0.2.3', '0.2.2', 'http://test')
    result = json.loads(status.read_text())
    assert result['state'] == 'failed'
    assert '雙平台更新包校驗碼不一致' in result['message']
    assert 'https://github.test/application.zip' not in calls
    assert old.read_bytes() == b'old'


def test_hash_mismatch_does_not_fallback(tmp_path, monkeypatch):
    app, path = bundle(tmp_path)
    old = app/'backend/app/main.py'; old.parent.mkdir(parents=True); old.write_bytes(b'old')
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    def download(url, target, limit):
        target.write_bytes((digest + '  application.zip\n').encode()
                           if url.endswith('.sha256') else b'corrupt')
    monkeypatch.setattr(worker, 'download', download)
    monkeypatch.setattr(worker, 'resolve_release', lambda version: {'source': 'gitee', 'assets': {
        'application.zip': 'https://gitee.test/application.zip',
        'application.zip.sha256': 'https://gitee.test/application.zip.sha256'}})
    monkeypatch.setattr(worker, 'github_release', lambda version: pytest.fail('Hash mismatch must not fallback'))
    monkeypatch.setattr(worker, 'restart', lambda *args: pytest.fail('Must not restart'))
    folder=tmp_path/'update'; folder.mkdir(); status=tmp_path/'status.json'
    worker.perform(app, folder, status, '0.2.3', '0.2.2', 'http://test')
    assert json.loads(status.read_text())['state'] == 'failed'
    assert old.read_bytes() == b'old'


def test_admission_and_maintenance_lock(tmp_path,monkeypatch):
    settings=SimpleNamespace(data_root=tmp_path,app_root=tmp_path/'app')
    manager=SimpleNamespace(active_job_id=None,repository=SimpleNamespace(list=lambda **kw:[]),gpu_gate=ResourceGate())
    installer=Installer(settings,manager)
    app=FastAPI(); app.include_router(router(installer))
    app.add_middleware(MaintenanceMiddleware,installer=installer)
    @app.post('/api/projects')
    def change(): return {'ok':True}
    client=TestClient(app)
    def resolve(version):
        if version != '9.0.0':
            raise ValueError('missing')
        return {'version': version}
    monkeypatch.setattr(updates.release_sources, 'resolve_release', resolve)
    url='/api/app/install-update'
    assert client.post(url,json={'version':'9.0.0'}).status_code==403
    headers={'X-Comic-Update':'1','Origin':'https://evil.invalid'}
    assert client.post(url,json={'version':'9.0.0'},headers=headers).status_code==403
    proxied={'X-Comic-Update':'1','Origin':'https://public.example:8443',
             'Host':'127.0.0.1:6008','Sec-Fetch-Site':'same-origin'}
    assert client.post(url,json={'version':updates.APP_VERSION},headers=proxied).status_code==400
    forwarded={'X-Comic-Update':'1','Origin':'https://public.example:8443',
               'Host':'127.0.0.1:6008','X-Forwarded-Host':'public.example:8443'}
    assert client.post(url,json={'version':updates.APP_VERSION},headers=forwarded).status_code==400
    cross_site={**proxied,'Sec-Fetch-Site':'cross-site'}
    assert client.post(url,json={'version':'9.0.0'},headers=cross_site).status_code==403
    headers={'X-Comic-Update':'1'}
    assert client.post(url,json={'version':updates.APP_VERSION},headers=headers).status_code==400
    assert client.post(url,json={'version':'99.0.0'},headers=headers).status_code==502
    manager.gpu_gate.claim('inference')
    assert client.post(url,json={'version':'9.0.0'},headers=headers).status_code==409
    manager.gpu_gate.release('inference')
    installer.requests=1
    assert client.post(url,json={'version':'9.0.0'},headers=headers).status_code==409
    installer.requests=0; installer.reserved=True
    assert client.post('/api/projects').status_code==503
    assert client.get('/api/app/update-status').status_code==200
    installer.reserved=False
    assert client.post('/api/projects').status_code==200
