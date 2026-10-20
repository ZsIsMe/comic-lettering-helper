import struct

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.prelayout import local_fonts
from app.prelayout.api import router


FONT = {'postscriptName': 'Example-Regular', 'family': 'Example', 'fullName': 'Example Regular', 'style': 'Regular',
        'localizedFamily': '示例', 'localizedFullName': '示例 標準體', 'localizedStyle': '標準體'}


def name_table(records, languages=()):
    payload = bytearray()
    packed_records = []
    for language, name_id, value in records:
        data = value.encode('utf-16-be')
        packed_records.append(struct.pack('>HHHHHH', 3, 1, language, name_id, len(data), len(payload)))
        payload.extend(data)
    language_records = []
    for value in languages:
        data = value.encode('utf-16-be')
        language_records.append(struct.pack('>HH', len(data), len(payload)))
        payload.extend(data)
    language_section = struct.pack('>H', len(languages)) + b''.join(language_records) if languages else b''
    return struct.pack('>HHH', bool(languages), len(records), 6 + len(records) * 12 + len(language_section)) + b''.join(packed_records) + language_section + payload


def test_chinese_font_names_prefer_traditional_then_simplified_then_original():
    table = name_table([(0x804, 1, '示例简体'), (0x404, 1, '示例繁體'),
                        (0x804, 2, '标准体'), (0x409, 4, 'English full name')])
    assert local_fonts._localized_names(table, FONT) == {
        'localizedFamily': '示例繁體', 'localizedFullName': 'Example Regular', 'localizedStyle': '标准体'}


def test_typographic_family_and_style_use_actual_face_names():
    table = name_table([(0x404, 1, '舊字族'), (0x404, 16, '字族'), (0x404, 2, '標準'), (0x404, 17, '半粗體')])
    assert local_fonts._localized_names(table, FONT) == {
        'localizedFamily': '字族', 'localizedFullName': 'Example Regular', 'localizedStyle': '半粗體'}
    # Prefer Chinese language before preferred/typographic naming IDs.
    table = name_table([(0x804, 16, '简体字族'), (0x404, 1, '繁體字族')])
    assert local_fonts._localized_names(table, FONT)['localizedFamily'] == '繁體字族'


def test_format_one_language_tags_support_chinese_names():
    table = name_table([(0x8000, 1, '简体字族'), (0x8001, 1, '繁體字族'), (0x8001, 4, '繁體字族 細體')],
                       ['zh-Hans-CN', 'zh-Hant-TW'])
    assert local_fonts._localized_names(table, FONT) == {
        'localizedFamily': '繁體字族', 'localizedFullName': '繁體字族 細體', 'localizedStyle': 'Regular'}


@pytest.mark.parametrize('table', [b'', b'broken', b'\x00\x00\xff\xff\x00\x06', name_table([(0x404, 1, '字族')])[:-1]])
def test_missing_or_invalid_font_table_keeps_original_names(table):
    assert local_fonts._localized_names(table, FONT) == {
        'localizedFamily': 'Example', 'localizedFullName': 'Example Regular', 'localizedStyle': 'Regular'}


@pytest.fixture(autouse=True)
def fresh_catalogue(monkeypatch):
    monkeypatch.setattr(local_fonts, '_cache', None)
    monkeypatch.setattr(local_fonts.sys, 'platform', 'darwin')


@pytest.mark.parametrize('host', ['127.0.0.1', '127.42.0.1', '::1', '::ffff:127.0.0.1'])
def test_local_client_gets_installed_font_names(monkeypatch, host):
    monkeypatch.setattr(local_fonts, '_read_macos_fonts', lambda: [FONT.copy()])
    assert local_fonts.local_fonts(host) == {'available': True, 'fonts': [FONT]}


@pytest.mark.parametrize('host', [None, 'testclient', 'localhost.evil', '192.168.0.2', '8.8.8.8', '::ffff:192.168.0.2'])
def test_remote_client_does_not_enumerate_server_fonts(monkeypatch, host):
    def forbidden():
        pytest.fail('A remote request must not enumerate fonts')
    monkeypatch.setattr(local_fonts, '_read_macos_fonts', forbidden)
    local_fonts._cache = (0, [FONT.copy()])
    assert local_fonts.local_fonts(host, refresh=True) == {'available': False, 'fonts': []}


def test_non_mac_platform_does_not_load_frameworks(monkeypatch):
    monkeypatch.setattr(local_fonts.sys, 'platform', 'linux')
    monkeypatch.setattr(local_fonts, '_read_macos_fonts', lambda: pytest.fail('Non-macOS cannot load CoreText'))
    assert local_fonts.local_fonts('127.0.0.1') == {'available': False, 'fonts': []}


def test_cache_refresh_expiry_and_returned_copy(monkeypatch):
    calls = []
    clock = [10]
    monkeypatch.setattr(local_fonts.time, 'monotonic', lambda: clock[0])
    monkeypatch.setattr(local_fonts, '_read_macos_fonts', lambda: calls.append(1) or [FONT.copy()])
    result = local_fonts.local_fonts('127.0.0.1')
    result['fonts'][0]['postscriptName'] = 'changed'
    assert local_fonts.local_fonts('127.0.0.1')['fonts'] == [FONT]
    assert len(calls) == 1
    local_fonts.local_fonts('127.0.0.1', refresh=True)
    assert len(calls) == 2
    clock[0] = 70
    local_fonts.local_fonts('127.0.0.1')
    assert len(calls) == 3


def test_framework_failure_is_unavailable_without_leaking_error(monkeypatch):
    def fail():
        raise OSError('/private/user/font/location')
    monkeypatch.setattr(local_fonts, '_read_macos_fonts', fail)
    assert local_fonts.local_fonts('127.0.0.1') == {'available': False, 'fonts': []}


def test_route_loopback_and_cache_privacy_headers(monkeypatch):
    monkeypatch.setattr(local_fonts, '_read_macos_fonts', lambda: [FONT.copy()])
    app = FastAPI()
    app.include_router(router(None, None, 1024))
    with TestClient(app, client=('127.0.0.1', 51000)) as client:
        response = client.get('/api/prelayout/local-fonts?refresh=true')
        assert response.status_code == 200
        assert response.json() == {'available': True, 'fonts': [FONT]}
        assert response.headers['cache-control'] == 'no-store'
    with TestClient(app, client=('192.168.1.20', 51000)) as client:
        response = client.get('/api/prelayout/local-fonts', headers={'X-Forwarded-For': '127.0.0.1'})
        assert response.json() == {'available': False, 'fonts': []}
