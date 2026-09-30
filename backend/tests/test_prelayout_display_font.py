import os
import re
import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import Settings
from app.prelayout.api import router
from app.prelayout.detection import PrelayoutDetection
from app.prelayout.store import PrelayoutStore
from app.resources import ResourceGate


@pytest.fixture
def font_environment(tmp_path, monkeypatch):
    models = tmp_path / 'models'
    models.mkdir()
    for name in ('comictextdetector.pt', 'mit48pxctc_ocr.ckpt', 'alphabet-all-v5.txt',
                 'NotoSansCJKjp-Medium.otf', 'NotoSansCJKjp-Medium.ink-metrics.json'):
        (models / name).write_bytes(name.encode())
    monkeypatch.setenv('COMIC_PRELAYOUT_MODEL_ROOT', str(models))
    monkeypatch.setenv('COMIC_PRELAYOUT_PYTHON', sys.executable)
    monkeypatch.setenv('COMIC_PRELAYOUT_DEVICE', 'mps')
    monkeypatch.delenv('COMIC_PRELAYOUT_DISPLAY_FONT', raising=False)
    store = PrelayoutStore(tmp_path / 'prelayout')

    def detector():
        return PrelayoutDetection(Settings(), store, ResourceGate())

    def client(value):
        app = FastAPI()
        app.include_router(router(store, value, 10_000_000))
        return TestClient(app)

    return models, detector, client


@pytest.mark.parametrize('configured', [None, '', '   '])
def test_unconfigured_display_font_uses_existing_noto(font_environment, monkeypatch, configured):
    models, detector, client = font_environment
    if configured is not None:
        monkeypatch.setenv('COMIC_PRELAYOUT_DISPLAY_FONT', configured)
    value = detector()
    assert value.display_font == models / 'NotoSansCJKjp-Medium.otf'
    with client(value) as api:
        status = api.get('/api/prelayout/availability').json()
        assert status['display_font_available'] is True
        assert status['display_font_custom'] is False
        assert status['assets']['font'] is True
        assert status['methods']['ocr_aligned'] is True
        assert re.fullmatch('[0-9a-f]{64}', status['font_version'])
        font = api.get('/api/prelayout/font')
        assert font.status_code == 200
        assert font.headers['content-type'] == 'font/otf'
        assert font.content == value.display_font.read_bytes()


@pytest.mark.parametrize('extension,media_type', [('ttf', 'font/ttf'), ('OTF', 'font/otf')])
def test_display_font_api_serves_configured_font_independently_of_ocr_assets(
    font_environment, tmp_path, monkeypatch, extension, media_type,
):
    models, detector, client = font_environment
    preview = tmp_path / f'preview.{extension}'
    preview.write_bytes(b'configured display font')
    monkeypatch.setenv('COMIC_PRELAYOUT_DISPLAY_FONT', str(preview))
    (models / 'NotoSansCJKjp-Medium.otf').unlink()
    with client(detector()) as api:
        status = api.get('/api/prelayout/availability').json()
        assert status['display_font_available'] is True
        assert status['display_font_custom'] is True
        assert status['assets']['font'] is False
        assert status['methods']['ocr_aligned'] is False
        assert status['methods']['single_char'] is True
        font = api.get('/api/prelayout/font')
        assert font.status_code == 200
        assert font.content == preview.read_bytes()
        assert font.headers['content-type'] == media_type
        assert font.headers['cache-control'] == 'private, max-age=86400'


@pytest.mark.parametrize('is_directory', [False, True])
def test_missing_configured_font_does_not_fallback_or_disable_ocr(
    font_environment, tmp_path, monkeypatch, is_directory,
):
    _, detector, client = font_environment
    preview = tmp_path / 'unavailable.ttf'
    if is_directory:
        preview.mkdir()
    monkeypatch.setenv('COMIC_PRELAYOUT_DISPLAY_FONT', str(preview))
    with client(detector()) as api:
        status = api.get('/api/prelayout/availability').json()
        assert status['display_font_available'] is False
        assert status['display_font_custom'] is True
        assert status['font_version'] == ''
        assert status['assets']['font'] is True
        assert status['methods']['ocr_aligned'] is True
        assert api.get('/api/prelayout/font').status_code == 404


def test_font_version_changes_with_font_path_and_stat_without_exposing_path(
    font_environment, tmp_path, monkeypatch,
):
    _, detector, _ = font_environment
    first = tmp_path / 'first.ttf'
    second = tmp_path / 'second.ttf'
    for path in (first, second):
        path.write_bytes(b'font')
        os.utime(path, ns=(1_000_000_000, 1_000_000_000))
    monkeypatch.setenv('COMIC_PRELAYOUT_DISPLAY_FONT', str(first))
    first_detector = detector()
    original = first_detector.availability()['font_version']
    assert re.fullmatch('[0-9a-f]{64}', original)
    assert first_detector.availability()['font_version'] == original
    monkeypatch.setenv('COMIC_PRELAYOUT_DISPLAY_FONT', str(second))
    assert detector().availability()['font_version'] != original
    os.utime(first, ns=(2_000_000_000, 2_000_000_000))
    updated = first_detector.availability()['font_version']
    assert updated != original
    first.write_bytes(b'longer font')
    os.utime(first, ns=(2_000_000_000, 2_000_000_000))
    assert first_detector.availability()['font_version'] != updated
    first.unlink()
    assert first_detector.availability()['display_font_available'] is False
    assert first_detector.availability()['font_version'] == ''
