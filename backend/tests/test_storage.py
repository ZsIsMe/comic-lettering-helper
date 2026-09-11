from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image

from app.storage import basename, validate_pairs


def make_image(path: Path, color: int = 255, size: tuple[int, int] = (8, 8)) -> Path:
    Image.new("L", size, color).save(path)
    return path


def test_basename_removes_browser_folder_path() -> None:
    assert basename("原圖/01.png") == "01.png"
    assert basename("C:\\Mask\\01.png") == "01.png"
    with pytest.raises(ValueError):
        basename("原圖/._01.png")


def test_validate_pairs_reports_black_masks(tmp_path: Path) -> None:
    source = make_image(tmp_path / "source.png", color=128)
    mask = make_image(tmp_path / "mask.png", color=0)
    stems, black = validate_pairs({"01": source}, {"01": mask})
    assert stems == ["01"]
    assert black == ["01"]


def test_validate_pairs_rejects_size_mismatch(tmp_path: Path) -> None:
    source = make_image(tmp_path / "source.png", size=(8, 8))
    mask = make_image(tmp_path / "mask.png", size=(9, 8))
    with pytest.raises(ValueError, match="尺寸不一致"):
        validate_pairs({"01": source}, {"01": mask})
