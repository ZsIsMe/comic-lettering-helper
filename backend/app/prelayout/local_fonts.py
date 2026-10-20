"""Read the local macOS font catalogue without opening or exporting font files."""
from __future__ import annotations

import ctypes
import ipaddress
import struct
import sys
import threading
import time


_CACHE_SECONDS = 60
_cache: tuple[float, list[dict[str, str]]] | None = None
_cache_lock = threading.Lock()


def _loopback(host: str | None) -> bool:
    try:
        address = ipaddress.ip_address(host or '')
    except ValueError:
        return False
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        address = address.ipv4_mapped
    return address.is_loopback


def _localized_names(table: bytes, original: dict[str, str]) -> dict[str, str]:
    """Read a face's own Chinese OpenType names, independent of system language.

    CoreText's CTFontCopyLocalizedName follows the user's global language order.
    The name table instead lets us prefer Traditional Chinese, then Simplified
    Chinese, without changing that preference or inventing translated aliases.
    """
    result = {f'localized{field[0].upper()}{field[1:]}': original[field]
              for field in ('family', 'fullName', 'style')}
    if len(table) < 6:
        return result
    version, count, storage = struct.unpack_from('>HHH', table)
    records_end = 6 + count * 12
    if version not in (0, 1) or records_end > len(table) or storage > len(table):
        return result

    def text(length: int, offset: int) -> str:
        start, end = storage + offset, storage + offset + length
        if start < storage or end > len(table):
            return ''
        try:
            return table[start:end].decode('utf-16-be').strip('\x00\ufeff ')
        except UnicodeDecodeError:
            return ''

    languages = []
    if version == 1 and records_end + 2 <= len(table):
        language_count = struct.unpack_from('>H', table, records_end)[0]
        if records_end + 2 + language_count * 4 <= len(table):
            languages = [text(*struct.unpack_from('>HH', table, records_end + 2 + position * 4))
                         for position in range(language_count)]

    # OpenType Windows language IDs for Taiwan/Hong Kong/Macao and China/Singapore.
    traditional = {0x0404, 0x0c04, 0x1404}
    simplified = {0x0804, 0x1004}
    selected: dict[int, tuple[int, str]] = {}
    for position in range(count):
        platform, encoding, language, name_id, length, offset = struct.unpack_from('>HHHHHH', table, 6 + position * 12)
        if name_id not in (1, 2, 4, 16, 17) or not (platform == 0 or platform == 3 and encoding in (0, 1, 10)):
            continue
        rank = None
        if language >= 0x8000 and language - 0x8000 < len(languages):
            tag = languages[language - 0x8000].lower().replace('_', '-').split('-')
            if tag[0] == 'zh':
                if 'hant' in tag or any(region in tag for region in ('tw', 'hk', 'mo')):
                    rank = 0
                elif 'hans' in tag or any(region in tag for region in ('cn', 'sg')):
                    rank = 1
        elif platform == 3:
            rank = 0 if language in traditional else 1 if language in simplified else None
        if rank is None:
            continue
        value = text(length, offset)
        if value and (name_id not in selected or rank < selected[name_id][0]):
            selected[name_id] = (rank, value)

    for field, ids in (('Family', (16, 1)), ('FullName', (4,)), ('Style', (17, 2))):
        candidates = [(selected[name_id][0], order, selected[name_id][1])
                      for order, name_id in enumerate(ids) if name_id in selected]
        if candidates:
            result[f'localized{field}'] = min(candidates)[2]
    return result


def _read_macos_fonts() -> list[dict[str, str]]:
    """Use CoreText's installed catalogue; every Create/Copy result is released."""
    cf = ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
    ct = ctypes.CDLL('/System/Library/Frameworks/CoreText.framework/CoreText')
    pointer, index = ctypes.c_void_p, ctypes.c_long
    cf.CFRelease.argtypes = [pointer]
    cf.CFRelease.restype = None
    cf.CFArrayGetCount.argtypes = [pointer]
    cf.CFArrayGetCount.restype = index
    cf.CFArrayGetValueAtIndex.argtypes = [pointer, index]
    cf.CFArrayGetValueAtIndex.restype = pointer
    cf.CFStringGetLength.argtypes = [pointer]
    cf.CFStringGetLength.restype = index
    cf.CFStringGetMaximumSizeForEncoding.argtypes = [index, ctypes.c_uint32]
    cf.CFStringGetMaximumSizeForEncoding.restype = index
    cf.CFStringGetCString.argtypes = [pointer, pointer, index, ctypes.c_uint32]
    cf.CFStringGetCString.restype = ctypes.c_bool
    cf.CFDataGetLength.argtypes = [pointer]
    cf.CFDataGetLength.restype = index
    cf.CFDataGetBytePtr.argtypes = [pointer]
    cf.CFDataGetBytePtr.restype = pointer
    ct.CTFontManagerCopyAvailablePostScriptNames.argtypes = []
    ct.CTFontManagerCopyAvailablePostScriptNames.restype = pointer
    ct.CTFontCreateWithName.argtypes = [pointer, ctypes.c_double, pointer]
    ct.CTFontCreateWithName.restype = pointer
    for name in ('CTFontCopyFamilyName', 'CTFontCopyFullName'):
        function = getattr(ct, name)
        function.argtypes = [pointer]
        function.restype = pointer
    ct.CTFontCopyName.argtypes = [pointer, pointer]
    ct.CTFontCopyName.restype = pointer
    ct.CTFontCopyTable.argtypes = [pointer, ctypes.c_uint32, ctypes.c_uint32]
    ct.CTFontCopyTable.restype = pointer
    style_key = pointer.in_dll(ct, 'kCTFontStyleNameKey').value
    utf8 = 0x08000100

    def string(value) -> str:
        if not value:
            return ''
        capacity = cf.CFStringGetMaximumSizeForEncoding(cf.CFStringGetLength(value), utf8) + 1
        buffer = ctypes.create_string_buffer(capacity)
        if not cf.CFStringGetCString(value, buffer, capacity, utf8):
            return ''
        return buffer.value.decode('utf-8')

    def copied_string(value) -> str:
        try:
            return string(value)
        finally:
            if value:
                cf.CFRelease(value)

    def name_table(font) -> bytes:
        data = ct.CTFontCopyTable(font, int.from_bytes(b'name', 'big'), 0)
        if not data:
            return b''
        try:
            return ctypes.string_at(cf.CFDataGetBytePtr(data), cf.CFDataGetLength(data))
        finally:
            cf.CFRelease(data)

    names = ct.CTFontManagerCopyAvailablePostScriptNames()
    if not names:
        raise OSError('The installed font catalogue is unavailable')
    fonts = []
    try:
        for position in range(cf.CFArrayGetCount(names)):
            name = cf.CFArrayGetValueAtIndex(names, position)
            postscript = string(name)
            if not postscript:
                continue
            font = ct.CTFontCreateWithName(name, 12, None)
            if not font:
                continue
            try:
                item = {
                    'postscriptName': postscript,
                    'family': copied_string(ct.CTFontCopyFamilyName(font)),
                    'fullName': copied_string(ct.CTFontCopyFullName(font)),
                    'style': copied_string(ct.CTFontCopyName(font, style_key)),
                }
                item.update(_localized_names(name_table(font), item))
                fonts.append(item)
            finally:
                cf.CFRelease(font)
    finally:
        cf.CFRelease(names)
    unique = {font['postscriptName']: font for font in fonts}
    return sorted(unique.values(), key=lambda font: (
        font['family'].casefold(), font['fullName'].casefold(), font['postscriptName']))


def local_fonts(host: str | None, *, refresh: bool = False) -> dict:
    """Never reveal the server's font list to a remote client or another platform."""
    global _cache
    if sys.platform != 'darwin' or not _loopback(host):
        return {'available': False, 'fonts': []}
    with _cache_lock:
        now = time.monotonic()
        if refresh or _cache is None or now - _cache[0] >= _CACHE_SECONDS:
            try:
                fonts = _read_macos_fonts()
            except (OSError, AttributeError, ValueError):
                return {'available': False, 'fonts': []}
            _cache = (now, fonts)
        return {'available': True, 'fonts': [font.copy() for font in _cache[1]]}
