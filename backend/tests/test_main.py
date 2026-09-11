from __future__ import annotations

import re

import pytest
from fastapi import HTTPException

from app.main import parse_workflows, safe_job_name, timestamped_job_name


def test_workflows_are_canonicalized() -> None:
    assert parse_workflows("firered,flux2klein_lanpaint") == ["flux2klein_lanpaint", "firered"]


def test_duplicate_workflows_are_rejected() -> None:
    with pytest.raises(HTTPException):
        parse_workflows("firered,firered")


def test_job_name_cannot_become_a_path() -> None:
    assert safe_job_name("../../漫畫/第 1 批") == "漫畫_第 1 批"
    assert safe_job_name(" / ") == "未命名批次"


def test_job_name_gets_a_submission_timestamp() -> None:
    value = timestamped_job_name("第 89 話")
    assert value.startswith("第 89 話_")
    assert re.fullmatch(r"第 89 話_\d{4}_\d{6}", value)
