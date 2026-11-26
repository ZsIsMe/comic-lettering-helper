"""Windows polling readers must not make atomic progress writes fail transiently."""
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import threading
from types import SimpleNamespace

import pytest

from app.prelayout import store
from app.prelayout import detection


def windows_error(code):
    error = PermissionError('synthetic replace conflict')
    error.winerror = code
    return error


def progress_detector(tmp_path):
    did = 'd_' + 'a' * 32
    folder = tmp_path / 'detections' / did
    task = {'id': did, 'project_id': 'project', 'state': 'validating', 'created_at': '2026-11-23'}
    store.atomic_json(folder / 'task.json', task)
    store.atomic_json(folder / 'progress.json', {'state': 'calibrating', 'progress': {'completed': 20}})
    project_store = SimpleNamespace(read=lambda pid: {}, directory=lambda pid: tmp_path)
    return detection.PrelayoutDetection(None, project_store, None), folder / 'progress.json', task


@pytest.mark.skipif(os.name != 'nt', reason='Windows read-sharing diagnostic')
def test_status_uses_authoritative_task_during_windows_progress_read_conflict(tmp_path):
    detector, progress, task = progress_detector(tmp_path)
    api = ctypes.WinDLL('kernel32', use_last_error=True)
    api.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                               wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    api.CreateFileW.restype = wintypes.HANDLE
    api.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = api.CreateFileW(str(progress), 0x80000000, 0, None, 3, 0x80, None)
    assert handle != ctypes.c_void_p(-1).value
    try:
        assert detector.status('project') == task
    finally:
        api.CloseHandle(handle)
    assert detector.status('project')['state'] == 'calibrating'


def test_status_keeps_progress_access_denial_visible(tmp_path, monkeypatch):
    detector, progress, _ = progress_detector(tmp_path)
    read = Path.read_bytes
    def denied(path):
        if path == progress:
            raise PermissionError(13, 'persistent access denial')
        return read(path)
    monkeypatch.setattr(Path, 'read_bytes', denied)
    monkeypatch.setattr(detection, '_windows_progress_read_conflict', lambda path: False)
    with pytest.raises(PermissionError, match='persistent access denial'):
        detector.status('project')


def test_status_keeps_malformed_progress_visible(tmp_path):
    detector, progress, _ = progress_detector(tmp_path)
    progress.write_bytes(b'{invalid')
    with pytest.raises(json.JSONDecodeError):
        detector.status('project')


@pytest.mark.parametrize('code', [5, 32, 33])
def test_transient_windows_replace_retries_same_synced_temp(tmp_path, monkeypatch, code):
    path = tmp_path / 'progress.json'
    path.write_bytes(b'{"old":true}')
    original_replace, original_fsync = os.replace, os.fsync
    attempts, sleeps, syncs = [], [], []
    def replace(source, destination):
        assert Path(source).parent == path.parent
        attempts.append(source)
        assert path.read_bytes() == b'{"old":true}'
        assert json.loads(Path(source).read_bytes()) == {'progress': 57}
        if len(attempts) < 3:
            raise windows_error(code)
        original_replace(source, destination)
    def fsync(fd):
        syncs.append(fd)
        original_fsync(fd)
    monkeypatch.setattr(store, '_IS_WINDOWS', True)
    monkeypatch.setattr(store.os, 'replace', replace)
    monkeypatch.setattr(store.os, 'fsync', fsync)
    monkeypatch.setattr(store.time, 'sleep', sleeps.append)
    store.atomic_json(path, {'progress': 57})
    assert len(attempts) == 3 and len(set(attempts)) == 1
    assert sleeps == [.01, .02] and len(syncs) == 1
    assert json.loads(path.read_bytes()) == {'progress': 57}
    assert not list(tmp_path.glob('.writing-*'))


def test_persistent_windows_denial_is_bounded_and_preserves_old_file(tmp_path, monkeypatch):
    path = tmp_path / 'progress.json'
    old = b'{"old":true}'
    path.write_bytes(old)
    attempts, sleeps = [], []
    def denied(source, destination):
        attempts.append(source)
        assert path.read_bytes() == old
        raise windows_error(5)
    monkeypatch.setattr(store, '_IS_WINDOWS', True)
    monkeypatch.setattr(store.os, 'replace', denied)
    monkeypatch.setattr(store.time, 'sleep', sleeps.append)
    with pytest.raises(PermissionError):
        store.atomic_json(path, {'new': True})
    assert len(attempts) == 9 and len(set(attempts)) == 1
    assert len(sleeps) == 8 and sum(sleeps) < 1
    assert path.read_bytes() == old
    assert not list(tmp_path.glob('.writing-*'))


@pytest.mark.parametrize('windows,code', [(False, 5), (False, 32), (True, 112), (True, None)])
def test_other_replace_errors_fail_immediately(tmp_path, monkeypatch, windows, code):
    path = tmp_path / 'progress.json'
    path.write_bytes(b'old')
    attempts, sleeps = [], []
    def denied(source, destination):
        attempts.append(source)
        raise windows_error(code)
    monkeypatch.setattr(store, '_IS_WINDOWS', windows)
    monkeypatch.setattr(store.os, 'replace', denied)
    monkeypatch.setattr(store.time, 'sleep', sleeps.append)
    with pytest.raises(PermissionError):
        store.atomic_json(path, {'new': True})
    assert len(attempts) == 1 and sleeps == []
    assert path.read_bytes() == b'old'
    assert not list(tmp_path.glob('.writing-*'))


@pytest.mark.skipif(os.name != 'nt', reason='Windows non-delete-sharing read handle integration')
def test_windows_read_handle_release_allows_atomic_replace(tmp_path, monkeypatch):
    path = tmp_path / 'progress.json'
    path.write_bytes(b'{"old":true}')
    api = ctypes.WinDLL('kernel32', use_last_error=True)
    api.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                               wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    api.CreateFileW.restype = wintypes.HANDLE
    api.CloseHandle.argtypes = [wintypes.HANDLE]
    # GENERIC_READ, FILE_SHARE_READ only: replacement is blocked until close.
    handle = api.CreateFileW(str(path), 0x80000000, 1, None, 3, 0x80, None)
    assert handle != ctypes.c_void_p(-1).value, ctypes.WinError(ctypes.get_last_error())
    conflict = threading.Event()
    attempts, failures = [], []
    replace = os.replace
    def observed_replace(source, destination):
        attempts.append(source)
        try:
            return replace(source, destination)
        except OSError as exc:
            failures.append(exc.winerror)
            conflict.set()
            raise
    monkeypatch.setattr(store.os, 'replace', observed_replace)
    from concurrent.futures import ThreadPoolExecutor
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            write = pool.submit(store.atomic_json, path, {'progress': 58})
            try:
                assert conflict.wait(2)
                assert path.read_bytes() == b'{"old":true}'
                assert not write.done()
            finally:
                api.CloseHandle(handle)
                handle = None
            write.result(timeout=2)
        assert len(attempts) >= 2 and failures[0] in (5, 32, 33)
        assert json.loads(path.read_bytes()) == {'progress': 58}
        assert not list(tmp_path.glob('.writing-*'))
    finally:
        if handle:
            api.CloseHandle(handle)
