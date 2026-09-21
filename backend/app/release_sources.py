"""Resolve complete application releases from the two fixed public mirrors."""
from __future__ import annotations

import json
import re
import time
from urllib.parse import quote, urlparse
import urllib.request


REPOSITORY = "ZsIsMe/comic-lettering-helper"
ASSET_NAMES = ("application.zip", "application.zip.sha256")
GITEE_API = f"https://gitee.com/api/v5/repos/{REPOSITORY}"
GITHUB_API = f"https://api.github.com/repos/{REPOSITORY}"
STABLE = re.compile(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)")
JSON_LIMIT = 2_000_000


def _json(url: str, timeout: float = 8):
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/json", "User-Agent": "comic-lettering-helper"},
    )
    with urllib.request.urlopen(request, timeout=max(0.2, min(timeout, 8))) as response:
        raw = response.read(JSON_LIMIT + 1)
    if len(raw) > JSON_LIMIT:
        raise ValueError("版本資料過大")
    return json.loads(raw)


def _asset_url(source: str, version: str, name: str, value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("更新附件網址無效")
    parsed = urlparse(value)
    expected_host = "gitee.com" if source == "gitee" else "github.com"
    if parsed.scheme != "https" or parsed.hostname != expected_host or parsed.username or parsed.password:
        raise ValueError("更新附件網址不是可信來源")
    if source == "github":
        expected = f"/{REPOSITORY}/releases/download/{version}/{name}"
        if parsed.path != expected:
            raise ValueError("GitHub 更新附件路徑無效")
    else:
        expected = f"/{REPOSITORY}/releases/download/{version}/{name}"
        if parsed.path != expected:
            raise ValueError("Gitee 更新附件路徑無效")
    return value


def _complete(source: str, version: str, release: object, assets: object):
    if not isinstance(release, dict) or release.get("tag_name") != version:
        raise ValueError("Release 版本無效")
    if release.get("draft") or release.get("prerelease"):
        raise ValueError("不是正式 Release")
    if not isinstance(assets, list):
        raise ValueError("Release 附件格式無效")
    found: dict[str, str] = {}
    for asset in assets:
        if not isinstance(asset, dict) or asset.get("name") not in ASSET_NAMES:
            continue
        name = asset["name"]
        if name in found:
            raise ValueError("Release 附件名稱重複")
        key = "browser_download_url"
        found[name] = _asset_url(source, version, name, asset.get(key))
    if set(found) != set(ASSET_NAMES):
        raise ValueError("Release 缺少完整更新附件")
    page = (
        f"https://gitee.com/{REPOSITORY}/releases/tag/{version}"
        if source == "gitee"
        else f"https://github.com/{REPOSITORY}/releases/tag/{version}"
    )
    return {"source": source, "version": version, "release_url": page, "assets": found}


def gitee_release(version: str, timeout: float = 8):
    started = time.monotonic()
    release = _json(f"{GITEE_API}/releases/tags/{quote(version, safe='')}", timeout)
    release_id = release.get("id") if isinstance(release, dict) else None
    if not isinstance(release_id, int):
        raise ValueError("Gitee Release ID 無效")
    remaining = timeout - (time.monotonic() - started)
    if remaining <= 0:
        raise TimeoutError("Gitee Release 查詢逾時")
    assets = _json(f"{GITEE_API}/releases/{release_id}/attach_files?per_page=100&page=1", remaining)
    return _complete("gitee", version, release, assets)


def github_release(version: str, timeout: float = 8):
    release = _json(f"{GITHUB_API}/releases/tags/{quote(version, safe='')}", timeout)
    return _complete("github", version, release, release.get("assets") if isinstance(release, dict) else None)


def resolve_release(version: str):
    """Prefer Gitee for one version, falling back to GitHub without mixing assets."""
    if not isinstance(version, str) or STABLE.fullmatch(version) is None:
        raise ValueError("版本格式無效")
    errors = []
    deadline = time.monotonic() + 16
    for index, resolver in enumerate((gitee_release, github_release)):
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            budget = min(remaining, 6) if index == 0 else remaining
            return resolver(version, budget)
        except Exception as error:
            errors.append(error)
    raise ValueError("兩個發布來源皆無完整更新附件") from errors[-1]


def _release_versions(source: str, timeout: float = 8):
    base = GITEE_API if source == "gitee" else GITHUB_API
    records = _json(f"{base}/releases?per_page=20&page=1", timeout)
    if not isinstance(records, list):
        raise ValueError("Release 清單格式無效")
    result = []
    for record in records:
        if (isinstance(record, dict) and isinstance(record.get("tag_name"), str)
                and STABLE.fullmatch(record["tag_name"])
                and not record.get("draft") and not record.get("prerelease")):
            result.append(record["tag_name"])
    return result


def available_releases():
    """Return the newest complete stable release within a bounded lookup."""
    deadline = time.monotonic() + 12
    for index, (source, resolver) in enumerate((("gitee", gitee_release), ("github", github_release))):
        source_deadline = min(deadline, time.monotonic() + 7) if index == 0 else deadline
        try:
            remaining = source_deadline - time.monotonic()
            if remaining <= 0:
                break
            candidates = _release_versions(source, remaining)
        except Exception:
            continue
        candidates = sorted(set(candidates), key=lambda value: tuple(map(int, value.split("."))), reverse=True)[:3]
        for version in candidates:
            try:
                remaining = source_deadline - time.monotonic()
                if remaining <= 0:
                    break
                return [resolver(version, remaining)]
            except Exception:
                continue
    raise ValueError("尚無包含完整附件的正式版本")
