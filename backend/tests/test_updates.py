import pytest
from app import updates


def test_stable_versions_numeric_order_and_no_downgrade():
    result = updates.check_versions([
        {"version": "0.2.0", "source": "github", "release_url": "old"},
        {"version": "0.10.0", "source": "gitee", "release_url": "new"},
        {"version": "0.3.0"}, {"version": "v8.0.0"}, {"version": "9.0.0-beta"},
    ])
    assert result["latest_version"] == "0.10.0"
    assert result["source"] == "gitee"
    assert result["release_url"] == "new"
    assert result["update_available"] is True
    assert updates.check_versions(["0.2.0"])["update_available"] is False
    assert updates.check_versions([updates.APP_VERSION])["update_available"] is False
    with pytest.raises(ValueError):
        updates.check_versions(["v1.0.0", "1.0.0-rc1"])


def test_check_failure_is_not_reported_as_up_to_date_and_cache_is_bounded(monkeypatch):
    monkeypatch.setattr(updates, "_cached", None)
    calls = []
    def fail():
        calls.append(1)
        raise TimeoutError("internal details")
    monkeypatch.setattr(updates, "fetch_versions", fail)
    result = updates.updates()
    assert result["error"] and result["update_available"] is None
    assert "internal details" not in result["error"]
    assert updates.updates() == result
    assert len(calls) == 1
    monkeypatch.setattr(updates, "_cached_at", -100)
    monkeypatch.setattr(updates, "fetch_versions", lambda: [{"version": "9.0.0", "source": "github"}])
    assert updates.updates()["update_available"] is True
