"""Read-only checks against complete application releases."""
from __future__ import annotations

import re
import threading
import time

from fastapi import APIRouter

from . import release_sources

APP_VERSION = "0.2.11"
_lock = threading.Lock()
_cached = None
_cached_at = 0.0


def version_key(value):
    if not isinstance(value, str) or not re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", value):
        return None
    return tuple(map(int, value.split(".")))


def fetch_versions():
    return release_sources.available_releases()


def check_versions(releases):
    normalized = [item if isinstance(item, dict) else {"version": item} for item in releases]
    stable = [item for item in normalized if version_key(item.get("version")) is not None]
    if not stable:
        raise ValueError("尚無可用的正式版本")
    selected = max(stable, key=lambda item: version_key(item["version"]))
    latest = selected["version"]
    return {"current_version": APP_VERSION, "latest_version": latest,
            "update_available": version_key(latest) > version_key(APP_VERSION),
            "release_url": selected.get("release_url"),
            "source": selected.get("source"),
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
                      "update_available": None, "release_url": None, "source": None,
                      "checked_at": time.time(),
                      "error": "無法檢查更新，請稍後重試或確認伺服器可連接 Gitee / GitHub。"}
        _cached, _cached_at = result, time.monotonic()
        return result
