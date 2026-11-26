import subprocess
import sys
import time
from pathlib import Path

import pytest

from app.prelayout.line_breaks import line_break_candidates


def flat(text):
    return text.replace('\r\n', '').replace('\r', '').replace('\n', '')


def assert_contract(text, count, results):
    assert len({result['line_count'] for result in results}) == len(results)
    for result in results:
        assert set(result) == {'line_count', 'text'}
        assert result['line_count'] in {value for value in (count + 1, count, count - 1) if value > 0}
        assert len(result['text']) <= 50000
        assert flat(result['text']) == flat(text)
        lines = result['text'].split('\n')
        assert len(lines) == result['line_count']
        assert all(line.strip() for line in lines)


def test_dictionary_and_import_are_lazy():
    backend = Path(__file__).resolve().parents[1]
    script = """
import sys
from app.prelayout.api import router
from app.prelayout.line_breaks import line_break_candidates, _tokenizer
assert 'jieba' not in sys.modules
assert line_break_candidates('', 5) == []
assert line_break_candidates('  \\n \\n', 5) == []
assert 'jieba' not in sys.modules
line_break_candidates('今天下雨', 3)
assert 'jieba' in sys.modules
assert _tokenizer().initialized
assert _tokenizer() is _tokenizer()
"""
    result = subprocess.run([sys.executable, '-c', script], cwd=backend,
                            capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr


def test_real_precise_words_balancing_and_natural_pauses():
    text = '因為今天下雨，所以我們決定明天出發。'
    results = line_break_candidates(text, 4)
    assert results == [
        {'line_count': 5, 'text': '因為今天\n下雨，\n所以我們\n決定明天\n出發。'},
        {'line_count': 4, 'text': '因為今天\n下雨，所以\n我們決定\n明天出發。'},
        {'line_count': 3, 'text': '因為今天下雨，\n所以我們決定\n明天出發。'},
    ]
    assert_contract(text, 4, results)
    assert max(map(len, results[1]['text'].split('\n'))) - min(map(len, results[1]['text'].split('\n'))) <= 1


def test_exact_requested_counts_or_skip_without_hard_cutting_words():
    assert line_break_candidates('中华人民共和国', 3) == []
    assert line_break_candidates('中华人民共和国', 2) == [
        {'line_count': 1, 'text': '中华人民共和国'}]
    # N=1 omits zero lines; original-identical text is allowed.
    assert line_break_candidates('你好', 1) == [{'line_count': 1, 'text': '你好'}]
    for text, count in [('甲\n乙', 2), ('Supercalifragilisticexpialidocious', 1000000000),
                        ('我想要閱讀這本圖書館借來的書。', 4)]:
        assert_contract(text, count, line_break_candidates(text, count))


@pytest.mark.parametrize('text', [
    '「真的嗎！？」然後他說：「再見……我們還會見面——對吧？」',
    '（我們明天出發），「你也一起來吧！」……真的！？',
    '甲「 乙 」丙……丁——戊！？己',
])
def test_quotes_punctuation_and_multi_character_marks(text):
    results = line_break_candidates(text, 5)
    assert_contract(text, 5, results)
    assert results
    for result in results:
        for line in result['text'].split('\n'):
            assert line.rstrip()[-1] not in '（(［[｛{【「『《〈“‘｢〝'
            assert line.lstrip()[0] not in '，。！？：；、,.!?;:%％）)］]｝}】」』》〉”’｣〟…—～'
        assert '…\n…' not in result['text']
        assert '—\n—' not in result['text']
        assert '！\n？' not in result['text']


@pytest.mark.parametrize('word', ['Supercalifragilisticexpialidocious', 'ABC123_def',
                                  '2026-11-26', '3.1415926', 'John-Doe',
                                  'hello@example.com', 'https://example.com/a',
                                  'cafe\u0301ine', '👩🏽\u200d💻', '🇹🇼', 'क\u093f',
                                  '張三豐', '圖書館'])
def test_names_identifiers_and_unicode_clusters(word):
    text = ('我聽說張三豐今天也會到這裡來。' if word == '張三豐' else
            '我要去圖書館閱讀小說，然後我們一起出發。' if word == '圖書館' else
            '甲' + word + '乙丙丁戊己庚辛壬癸')
    results = line_break_candidates(text, 3)
    assert_contract(text, 3, results)
    assert results
    for result in results:
        assert word in result['text']


@pytest.mark.parametrize('text', ['', ' ', '\n\n', ' \r\n \n', '\u0301\u0301'])
def test_no_empty_or_whitespace_only_lines(text):
    assert line_break_candidates(text, 4) == []


@pytest.mark.parametrize('text', ['\n\n甲\n乙\n\n', '甲\n \t\n乙',
                                  '甲\r\n\r\n乙', '  甲 乙\t丙  ',
                                  '甲\n乙\n\n丙\r丁', '甲\n \n\t\n乙',
                                  '\u0301甲乙丙丁'])
def test_crlf_cr_lf_and_other_characters_are_lossless(text):
    results = line_break_candidates(text, 2)
    assert results
    assert_contract(text, 2, results)
    assert all('\r' not in result['text'] for result in results)


def test_spaces_never_become_new_blank_lines():
    text = '甲' + ' ' * 20000 + '乙 丙 丁'
    results = line_break_candidates(text, 3)
    assert results
    assert_contract(text, 3, results)


@pytest.mark.parametrize('text,count', [
    ('龘' * 49900, 100), ('甲' * 49900, 100), ('a' * 50000, 2),
    ('。' * 50000, 2), ('甲\n' * 25000, 25000),
    ('甲' + '\u0301' * 49999, 2), ('甲' * 20000, 10000),
    ('a' * 49999, 2), ('A-' * 24000, 2), (('龘' * 2048 + '，') * 24, 3),
], ids=lambda value: f'{len(value)}chars' if isinstance(value, str) and len(value) > 100 else None)
def test_extreme_lengths_line_counts_and_performance(text, count):
    start = time.monotonic()
    results = line_break_candidates(text, count)
    assert_contract(text, count, results)
    # Includes 25000 lines and long unknown Han strings; no small line-count cap.
    if text.startswith('龘') or count >= 10000:
        expected = {count, count - 1}
        if text.startswith('龘') or count == 10000:
            expected.add(count + 1)
        assert {r['line_count'] for r in results} == expected
    assert time.monotonic() - start < 10


def test_newline_budget_skips_only_unsavable_counts():
    text = '甲' * 49999
    results = line_break_candidates(text, 2)
    assert_contract(text, 2, results)
    assert [r['line_count'] for r in results] == [2, 1]
    assert len(results[0]['text']) == 50000
    assert abs(len(results[0]['text'].split('\n')[0]) - len(results[0]['text'].split('\n')[1])) <= 1
    assert [r['line_count'] for r in line_break_candidates('甲' * 50000, 2)] == [1]


def test_long_string_disables_only_quadratic_hmm(monkeypatch):
    from app.prelayout import line_breaks as module
    real = module._tokenizer()
    calls = []
    class Spy:
        def cut(self, text, **kwargs):
            calls.append((len(text), kwargs['HMM']))
            return real.cut(text, **kwargs)
    monkeypatch.setattr(module, '_tokenizer', lambda: Spy())
    line_break_candidates('龘' * 3000 + '，今天下雨。', 2)
    assert (3000, False) in calls
    assert (4, True) in calls


@pytest.mark.parametrize('text,count', [('甲' * 50001, 1), (None, 1), ('甲', True),
                                        ('甲', 0), ('甲', -1), ('甲', 1.5)])
def test_internal_contract_validation(text, count):
    with pytest.raises(ValueError):
        line_break_candidates(text, count)


def test_one_source_line_offers_two_and_one_but_never_zero():
    results = line_break_candidates('今天下雨，明天出發。', 1)
    assert [result['line_count'] for result in results] == [2, 1]
    assert_contract('今天下雨，明天出發。', 1, results)
