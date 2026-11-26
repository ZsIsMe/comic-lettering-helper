"""CPU font metrics for suggestion ranking, without editing project assets."""
import shutil
import time
from pathlib import Path

import pytest
from PIL import ImageFont

from app.prelayout import line_break_widths as metrics
from app.prelayout import line_breaks

ROOT = Path(__file__).resolve().parents[2]
FONT = ROOT / 'frontend/src/assets/fonts/toolbox-demibold-v2.7.ttf'


@pytest.fixture(autouse=True)
def font_config(monkeypatch):
    monkeypatch.setenv('COMIC_APP_ROOT', str(ROOT))
    monkeypatch.delenv('COMIC_PRELAYOUT_DISPLAY_FONT', raising=False)
    monkeypatch.delenv('COMIC_PRELAYOUT_MODEL_ROOT', raising=False)
    metrics._display_font.cache_clear()
    metrics._advance.cache_clear()
    metrics._pair_advance.cache_clear()
    yield
    metrics._display_font.cache_clear()
    metrics._advance.cache_clear()
    metrics._pair_advance.cache_clear()


def test_horizontal_uses_actual_glyph_advances_in_em_cells():
    font = ImageFont.truetype(str(FONT), 64, layout_engine=ImageFont.Layout.BASIC)
    widths = metrics.cumulative_widths('iW甲 乙', 'horizontal')
    expected = [0.0]
    for char in 'iW甲 乙':
        expected.append(expected[-1] + font.getlength(char) / 64)
    assert widths == pytest.approx(expected, abs=.001)
    assert widths[1] < widths[2] - widths[1] < widths[3] - widths[2]
    assert widths[4] > widths[3]  # Spaces still occupy horizontal advance.
    assert metrics.cumulative_widths('iW甲 乙') == [0, 1, 2, 3, 3, 4]
    assert metrics.cumulative_widths('甲\u0301\u200d乙', 'horizontal') == [0, 1, 1, 1, 2]


def test_pair_kerning_has_bounded_two_glyph_probes():
    font, _ = metrics._font()
    assert metrics.cumulative_widths('AV', 'horizontal')[-1] == pytest.approx(font.getlength('AV') / 64)


def test_built_frontend_font_works_without_source_tree(tmp_path, monkeypatch):
    assets = tmp_path / 'frontend/dist/assets'
    assets.mkdir(parents=True)
    deployed = assets / 'toolbox-demibold-v2.7-buildhash.ttf'
    shutil.copyfile(FONT, deployed)
    monkeypatch.setenv('COMIC_APP_ROOT', str(tmp_path))
    monkeypatch.setenv('COMIC_PRELAYOUT_MODEL_ROOT', str(tmp_path / 'no-models'))
    font, fallback = metrics._font()
    assert Path(font.path) == deployed
    assert not fallback
    assert metrics.cumulative_widths('i甲', 'horizontal') == [0, .25, 1.25]


def test_custom_font_skips_asset_lookup_and_is_cached(monkeypatch):
    monkeypatch.setenv('COMIC_PRELAYOUT_DISPLAY_FONT', str(FONT))
    def fail_glob(*_):
        raise AssertionError('A resolved custom font does not need an asset scan')
    monkeypatch.setattr(Path, 'glob', fail_glob)
    first = metrics._font()
    assert metrics._font() is first
    metrics.cumulative_widths('iii', 'horizontal')
    before = metrics._pair_advance.cache_info()
    metrics.cumulative_widths('iii', 'horizontal')
    assert metrics._pair_advance.cache_info().hits > before.hits


def test_wheel_default_handles_missing_project_fonts(tmp_path, monkeypatch):
    monkeypatch.setenv('COMIC_APP_ROOT', str(tmp_path))
    monkeypatch.setenv('COMIC_PRELAYOUT_MODEL_ROOT', str(tmp_path / 'missing'))
    font, fallback = metrics._font()
    assert fallback
    widths = metrics.cumulative_widths('iW甲乙', 'horizontal')
    assert 0 < widths[1] < widths[2] - widths[1] < 1
    assert widths[3] - widths[2] == widths[4] - widths[3] == 1
    assert font.getlength('i') > 0


def test_vertical_never_loads_font(monkeypatch):
    monkeypatch.setattr(metrics, '_font', lambda: pytest.fail('Vertical ranking uses grid cells'))
    assert metrics.cumulative_widths('甲Wi 乙\u0301') == [0, 1, 2, 3, 3, 4, 4]


def test_narrow_advances_do_not_filter_feasible_line_counts(monkeypatch):
    monkeypatch.setattr(line_breaks, '_tokens', lambda text: iter(text))
    text = 'i甲i乙i丙'
    assert metrics.cumulative_widths(text, 'horizontal')[-1] < 4
    candidates = line_breaks.line_break_candidates(text, 5, 'horizontal')
    assert [item['line_count'] for item in candidates] == [6, 5, 4]
    assert all(item['text'].replace('\n', '') == text for item in candidates)


def test_visual_width_changes_only_breaks_with_fixed_n_family():
    text = 'iiii甲乙WWWW丙丁戊己庚辛'
    vertical = line_breaks.line_break_candidates(text, 3)
    horizontal = line_breaks.line_break_candidates(text, 3, 'horizontal')
    assert [item['line_count'] for item in vertical] == [4, 3, 2]
    assert [item['line_count'] for item in horizontal] == [4, 3, 2]
    assert horizontal != vertical
    for item in horizontal + vertical:
        assert item['text'].replace('\n', '') == text


def test_long_horizontal_widths_are_linear_and_cached():
    text = 'iW甲乙' * 12500
    start = time.monotonic()
    widths = metrics.cumulative_widths(text, 'horizontal')
    assert len(widths) == 50001
    assert all(left <= right for left, right in zip(widths, widths[1:]))
    assert time.monotonic() - start < 3
    assert metrics._advance.cache_info().currsize <= 4
    assert metrics._pair_advance.cache_info().currsize <= 4


@pytest.mark.parametrize('orientation', ['', 'sideways', None, True])
def test_unknown_orientation_is_rejected(orientation):
    with pytest.raises(ValueError, match='排版方向'):
        line_breaks.line_break_candidates('甲乙', 2, orientation)


@pytest.mark.parametrize('text,tokens,penalty_offset,capacity', [
    ('甲乙丙丁戊己庚辛壬癸', ['甲乙丙', '丁戊', '己', '庚辛壬癸'], 5, 5),
    ('iiii甲乙丙丁戊己', ['iiii', '甲乙', '丙丁', '戊己'], 6, 4),
])
def test_capacity_prefers_fitting_word_boundaries_without_changing_fixed_n_family(
        monkeypatch, text, tokens, penalty_offset, capacity):
    orientation = 'horizontal' if text.startswith('i') else 'vertical'
    monkeypatch.setattr(line_breaks, '_tokens', lambda _: iter(tokens))
    monkeypatch.setattr(line_breaks, '_phrase_break_penalties', lambda _: {penalty_offset: 10})
    original = line_breaks.line_break_candidates(text, 2, orientation)
    fitted = line_breaks.line_break_candidates(text, 2, orientation, line_capacity=capacity)
    assert [row['line_count'] for row in fitted] == [row['line_count'] for row in original] == [3, 2, 1]
    before = next(row['text'] for row in original if row['line_count'] == 2)
    after = next(row['text'] for row in fitted if row['line_count'] == 2)
    assert after == text[:penalty_offset] + '\n' + text[penalty_offset:]
    def overflow(result):
        return sum(max(0, metrics.cumulative_widths(line, orientation)[-1] - capacity)
                   for line in result.split('\n'))
    assert overflow(after) < overflow(before)
    for row in fitted:
        assert row['text'].replace('\n', '') == text
        boundaries, offset = set(), 0
        for token in tokens:
            offset += len(token)
            boundaries.add(offset)
        offset = 0
        for line in row['text'].split('\n'):
            offset += len(line)
            assert offset in boundaries


def test_capacity_is_optional_and_propagates_to_short_particle_fallback(monkeypatch):
    calls = []
    arrange = line_breaks._arrange
    def capture(*args, **kwargs):
        calls.append(kwargs.get('line_capacity'))
        return arrange(*args, **kwargs)
    monkeypatch.setattr(line_breaks, '_arrange', capture)
    text = '好久不見了。'
    original = line_breaks.line_break_candidates(text, 2)
    assert line_breaks.line_break_candidates(text, 2, line_capacity=None) == original
    calls.clear()
    results = line_breaks.line_break_candidates(text, 2, line_capacity=4)
    assert results
    assert len(calls) == 3  # Main N, original-script alternate N, then N-1.
    assert all(capacity == 4 for capacity in calls)


def test_fifty_thousand_character_capacity_ranking_stays_bounded():
    text = '龘' * 49900
    start = time.monotonic()
    results = line_breaks.line_break_candidates(text, 100, line_capacity=499)
    assert [row['line_count'] for row in results] == [101, 100, 99]
    assert all(row['text'].replace('\n', '') == text for row in results)
    assert time.monotonic() - start < 10


@pytest.mark.parametrize('capacity', [0, -1, True, '3', float('inf'), float('nan')])
def test_invalid_line_capacity_is_rejected(capacity):
    with pytest.raises(ValueError, match='容量'):
        line_breaks.line_break_candidates('甲乙', 2, line_capacity=capacity)


@pytest.mark.parametrize('orientation', ['vertical', 'horizontal'])
@pytest.mark.parametrize('capacity', [None, 2.5, 4, 10])
def test_particle_tail_is_avoided_only_when_exact_n_has_other_legal_boundaries(orientation, capacity):
    text = '你一臉不懷好意啊…'
    results = line_breaks.line_break_candidates(text, 3, orientation, line_capacity=capacity)
    assert [row['line_count'] for row in results] == [4, 3, 2]
    assert results[1]['text'] == '你\n一臉\n不懷好意啊…'
    assert results[0]['text'] == '你\n一臉\n不懷好意\n啊…'
    assert all(row['text'].replace('\n', '') == text for row in results)
    unavoidable = line_breaks.line_break_candidates('好啊', 2, orientation, line_capacity=capacity)
    assert unavoidable == [{'line_count': 2, 'text': '好\n啊'}, {'line_count': 1, 'text': '好啊'}]
