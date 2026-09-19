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


def bundle(tmp_path, version='0.2.3', extra=None, corrupt=False):
    app=tmp_path/'app'; app.mkdir(exist_ok=True)
    requirements={}
    for name in ['backend/requirements.txt','backend/requirements-prelayout.txt']:
        p=app/name; p.parent.mkdir(parents=True,exist_ok=True); p.write_text('fixed')
        requirements[name]=hashlib.sha256(b'fixed').hexdigest()
    values={'backend/app/main.py':b'new main', 'backend/app/updates.py':b'new version',
            'frontend/dist/index.html':b'new page'}
    values.update(extra or {})
    manifest={'format':1,'version':version,'commit':'test','requirements':requirements,
              'files':{k:hashlib.sha256(v).hexdigest() for k,v in values.items()}}
    path=tmp_path/'test.zip'
    with zipfile.ZipFile(path,'w') as archive:
        archive.writestr('update-manifest.json',json.dumps(manifest))
        for name,value in values.items(): archive.writestr(name,value+b'corrupt' if corrupt else value)
    return app,path


@pytest.mark.parametrize('extra', [{'../../escape':b'bad'}, {'config/runtime.json':b'bad'}, {'frontend/dist/../secret':b'bad'}, {'backend/app/.env':b'bad'}])
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


def test_failed_restart_restores_old_code_and_preserves_data(tmp_path,monkeypatch):
    app,path=bundle(tmp_path)
    old=app/'backend/app/main.py'; old.parent.mkdir(parents=True); old.write_bytes(b'old main')
    data=app/'projects/keep.png'; data.parent.mkdir(); data.write_bytes(b'user data')
    folder=tmp_path/'update'; folder.mkdir()
    def download(url,target,limit):
        target.write_bytes(path.read_bytes() if url.endswith('.zip') else hashlib.sha256(path.read_bytes()).hexdigest().encode())
    monkeypatch.setattr(worker,'download',download)
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
    assert not (app/'backend/app/updates.py').exists()


def test_download_failure_never_restarts(tmp_path,monkeypatch):
    app,path=bundle(tmp_path)
    def fail(*args): raise TimeoutError()
    monkeypatch.setattr(worker,'download',fail)
    monkeypatch.setattr(worker,'restart',lambda *args: pytest.fail('Must not restart'))
    folder=tmp_path/'update'; folder.mkdir(); status=tmp_path/'status.json'
    worker.perform(app,folder,status,'0.2.3','0.2.2','http://test')
    assert json.loads(status.read_text())['state']=='failed'


def test_admission_and_maintenance_lock(tmp_path,monkeypatch):
    settings=SimpleNamespace(data_root=tmp_path,app_root=tmp_path/'app')
    manager=SimpleNamespace(active_job_id=None,repository=SimpleNamespace(list=lambda **kw:[]),gpu_gate=ResourceGate())
    installer=Installer(settings,manager)
    app=FastAPI(); app.include_router(router(installer))
    app.add_middleware(MaintenanceMiddleware,installer=installer)
    @app.post('/api/projects')
    def change(): return {'ok':True}
    client=TestClient(app)
    monkeypatch.setattr(updates,'fetch_versions',lambda:['9.0.0'])
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
    assert client.post(url,json={'version':'99.0.0'},headers=headers).status_code==400
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
