"""Read-only checks against the application's published stable Git tags."""
from __future__ import annotations

import json
import re
import threading
import time
import urllib.request

from fastapi import APIRouter

APP_VERSION = "0.2.1"
REPOSITORY = "https://github.com/ZsIsMe/comic-lettering-helper"
TAGS_API = "https://api.github.com/repos/ZsIsMe/comic-lettering-helper/git/matching-refs/tags/"
_lock = threading.Lock()
_cached = None
_cached_at = 0.0


def version_key(value):
    if not isinstance(value, str) or not re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", value):
        return None
    return tuple(map(int, value.split(".")))


def fetch_versions():
    request = urllib.request.Request(TAGS_API, headers={"Accept": "application/vnd.github+json", "User-Agent": "comic-lettering-helper"})
    with urllib.request.urlopen(request, timeout=8) as response:
        raw = response.read(2_000_001)
    if len(raw) > 2_000_000:
        raise ValueError("版本清單過大")
    records = json.loads(raw)
    if not isinstance(records, list):
        raise ValueError("版本清單格式無效")
    return [record["ref"].removeprefix("refs/tags/") for record in records
            if isinstance(record, dict) and isinstance(record.get("ref"), str) and record["ref"].startswith("refs/tags/")]


def check_versions(versions):
    stable = [value for value in versions if version_key(value) is not None]
    if not stable:
        raise ValueError("尚無可用的正式版本")
    latest = max(stable, key=version_key)
    return {"current_version": APP_VERSION, "latest_version": latest,
            "update_available": version_key(latest) > version_key(APP_VERSION),
            "release_url": f"{REPOSITORY}/releases/tag/{latest}",
            "checked_at": time.time(), "error": None}


router = APIRouter(prefix="/api/app", tags=["application"])


@router.get("/version")
def version():
    return {"current_version": APP_VERSION}


@router.get("/updates")
def updates():
    global _cached, _cached_at
    with _lock:
        # Bound upstream traffic even when several browser tabs check together.
        if _cached is not None and time.monotonic() - _cached_at < 60:
            return _cached
        try:
            result = check_versions(fetch_versions())
        except Exception:
            result = {"current_version": APP_VERSION, "latest_version": None,
                      "update_available": None, "release_url": None, "checked_at": time.time(),
                      "error": "無法檢查更新，請稍後重試或確認伺服器可連接 GitHub。"}
        _cached, _cached_at = result, time.monotonic()
        return result
