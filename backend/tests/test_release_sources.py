import pytest

from app import release_sources as sources


def release(source, version="0.2.11"):
    host = "gitee.com" if source == "gitee" else "github.com"
    if source == "gitee":
        base = f"https://{host}/{sources.REPOSITORY}/releases/download/{version}/"
    else:
        base = f"https://{host}/{sources.REPOSITORY}/releases/download/{version}/"
    metadata = {"tag_name": version, "prerelease": False, "draft": False}
    assets = [{"name": name, "browser_download_url": base + name} for name in sources.ASSET_NAMES]
    return sources._complete(source, version, metadata, assets)


def test_gitee_is_preferred_and_github_is_fallback(monkeypatch):
    calls = []
    monkeypatch.setattr(sources, "gitee_release", lambda version, timeout=8: calls.append("gitee") or release("gitee", version))
    monkeypatch.setattr(sources, "github_release", lambda version, timeout=8: calls.append("github") or release("github", version))
    assert sources.resolve_release("0.2.11")["source"] == "gitee"
    assert calls == ["gitee"]

    def fail(version, timeout=8):
        calls.append("gitee-failed")
        raise ValueError("missing")
    calls.clear()
    monkeypatch.setattr(sources, "gitee_release", fail)
    assert sources.resolve_release("0.2.11")["source"] == "github"
    assert calls == ["gitee-failed", "github"]


def test_incomplete_or_untrusted_assets_are_not_releases():
    metadata = {"tag_name": "0.2.11", "prerelease": False, "draft": False}
    with pytest.raises(ValueError, match="缺少"):
        sources._complete("gitee", "0.2.11", metadata, [{
            "name": "application.zip",
            "browser_download_url": f"https://gitee.com/{sources.REPOSITORY}/releases/download/0.2.11/application.zip",
        }])
    with pytest.raises(ValueError, match="可信"):
        sources._complete("github", "0.2.11", metadata, [{
            "name": name, "browser_download_url": f"https://evil.invalid/{name}"
        } for name in sources.ASSET_NAMES])


def test_available_versions_only_contains_complete_releases(monkeypatch):
    monkeypatch.setattr(sources, "_release_versions", lambda source, timeout=8: ["0.2.12", "0.2.11"])
    monkeypatch.setattr(sources, "gitee_release", lambda version, timeout=8: release("gitee", version)
                        if version == "0.2.11" else (_ for _ in ()).throw(ValueError("incomplete")))
    assert [item["version"] for item in sources.available_releases()] == ["0.2.11"]
