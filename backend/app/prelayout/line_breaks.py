"""Read-only, lossless line-break suggestions; jieba is loaded on first use."""
from __future__ import annotations

import re
import unicodedata
from bisect import bisect_left
from functools import lru_cache

MAX_TEXT_LENGTH = 50000
_TOKEN_RUNS = re.compile(r'\w+|[^\w]+')
_PAUSE = frozenset('，。！？：；、,.!?;:')
# jieba 0.42.1 HMM copies an ever-growing Viterbi path; bound that quadratic work.
_HMM_RUN_LIMIT = 2048
_OPEN = frozenset('（(［[｛{【「『《〈“‘｢〝')
_CLOSE = frozenset('，。！？：；、,.!?;:%％）)］]｝}】」』》〉”’｣〟…—～')


@lru_cache(maxsize=1)
def _tokenizer():
    # Importing the API must not initialize jieba or read its dictionary.
    import jieba
    return jieba.Tokenizer()


def _word_char(char: str) -> bool:
    """Keep non-CJK alphabetic/numeric identifiers together, even outside ASCII."""
    if not char:
        return False
    value = ord(char)
    cjk = (0x3400 <= value <= 0x9fff or 0xf900 <= value <= 0xfaff
           or 0x20000 <= value <= 0x323af or 0x3040 <= value <= 0x30ff
           or 0xac00 <= value <= 0xd7af)
    return not cjk and (char.isalnum() or char == '_')


def _protected_boundaries(text: str) -> set[int]:
    """Protect common Unicode clusters and identifiers across tokenizer boundaries."""
    protected = set()
    regional_count = 0
    previous_base = ''
    for index, char in enumerate(text):
        value = ord(char)
        regional = 0x1f1e6 <= value <= 0x1f1ff
        if index:
            previous = text[index - 1]
            if (unicodedata.category(char).startswith('M') or char == '\u200d'
                    or previous == '\u200d' or 0x1f3fb <= value <= 0x1f3ff
                    or 0xe0020 <= value <= 0xe007f
                    or regional and regional_count % 2
                    or _word_char(previous_base) and _word_char(char)
                    or previous in '…—' and char == previous
                    or previous in '!?！？' and char in '!?！？'):
                protected.add(index)
            # Dates, decimal numbers, hyphenated words, URLs and email addresses.
            if (char in ".'’:+/@%_-" and index + 1 < len(text)
                    and _word_char(previous) and _word_char(text[index + 1])):
                protected.update((index, index + 1))
        regional_count = regional_count + 1 if regional else 0
        if not unicodedata.category(char).startswith('M'):
            previous_base = char
    # URL scheme punctuation contains multiple adjacent separators.
    for match in re.finditer(r'[A-Za-z][A-Za-z0-9+.-]{0,31}://[A-Za-z0-9_./:@%?=&+#~;-]+', text):
        end = match.end()
        while end > match.start() and not _word_char(text[end - 1]):
            end -= 1
        protected.update(range(match.start() + 1, end))
    return protected


def _tokens(text: str):
    tokenizer = _tokenizer()
    for match in _TOKEN_RUNS.finditer(text):
        run = match.group()
        if run[0].isalnum() or run[0] == '_':
            # Precise dictionary mode still protects whole known words in long strings.
            yield from tokenizer.cut(run, cut_all=False, HMM=len(run) <= _HMM_RUN_LIMIT)
        else:
            yield from run


def _positions(text: str) -> tuple[list[int], list[int], list[str]]:
    protected = _protected_boundaries(text)
    right = [''] * (len(text) + 1)
    visible = ''
    for index in range(len(text) - 1, -1, -1):
        if not text[index].isspace():
            visible = text[index]
        right[index] = visible
    positions, widths, endings = [0], [0], ['']
    offset, width, left = 0, 0, ''
    for token in _tokens(text):
        offset += len(token)
        for char in token:
            if not char.isspace():
                left = char
                # Combining marks and joiners do not create visible character width.
                if not unicodedata.category(char).startswith('M') and char != '\u200d':
                    width += 1
        if (offset < len(text) and offset not in protected and left and right[offset]
                and left not in _OPEN and right[offset] not in _CLOSE
                and not text[offset].isspace()):
            positions.append(offset)
            widths.append(width)
            endings.append(left)
    positions.append(len(text))
    widths.append(width)
    endings.append(left)
    return positions, widths, endings


def _arrange(positions: list[int], widths: list[int], endings: list[str], count: int) -> list[int]:
    """Exactly count lines in O(B + count log B + 64 count), with no line-count cap.

    Choose nearby proportional boundaries, then refine neighboring line pairs. This
    bounded local optimization favors balanced lines and natural pauses; it does not
    claim a globally optimal paragraph partition.
    """
    last = len(positions) - 1
    target = widths[-1] / count

    def line_cost(length):
        return (length - target) ** 2 + (4 * target ** 2 if length == 1 and target >= 2 else 0)

    def pause_cost(index):
        return -min(2.0, target / 2) if endings[index] in _PAUSE else 0

    chosen = [0]
    for slot in range(1, count):
        lower, upper = chosen[-1] + 1, last - (count - slot)
        ideal = widths[-1] * slot / count
        center = max(lower, min(upper, bisect_left(widths, ideal)))
        best = min(range(max(lower, center - 8), min(upper, center + 8) + 1),
                   key=lambda i: (widths[i] - ideal) ** 2
                   + line_cost(widths[i] - widths[chosen[-1]]) + pause_cost(i))
        chosen.append(best)
    chosen.append(last)
    for order in (range(1, count), range(count - 1, 0, -1)):
        for slot in order:
            left, right = chosen[slot - 1], chosen[slot + 1]
            ideal = (widths[left] + widths[right]) / 2
            center = max(left + 1, min(right - 1, bisect_left(widths, ideal)))
            options = range(max(left + 1, center - 8), min(right - 1, center + 8) + 1)
            chosen[slot] = min(options, key=lambda i:
                               line_cost(widths[i] - widths[left])
                               + line_cost(widths[right] - widths[i]) + pause_cost(i))
    return [positions[index] for index in chosen[1:-1]]


def line_break_candidates(text: str, source_line_count: int) -> list[dict]:
    """Return only feasible N+1 / N / N-1 suggestions, preserving non-newlines.

    CRLF, CR and LF are equivalent input line separators. All other code points,
    including spaces, remain verbatim. Known words, punctuation and common Unicode
    clusters are indivisible. Every output line must contain visible content.
    """
    if not isinstance(text, str) or len(text) > MAX_TEXT_LENGTH:
        raise ValueError('每框文字上限為 50000 字')
    if type(source_line_count) is not int or source_line_count < 1:
        raise ValueError('原文行數須為正整數')
    flat = text.replace('\r\n', '').replace('\r', '').replace('\n', '')
    if not flat or flat.isspace():
        return []
    counts = list(dict.fromkeys(count for count in (source_line_count + 1, source_line_count, source_line_count - 1)
                               if count > 0))
    counts = [count for count in counts if len(flat) + count - 1 <= MAX_TEXT_LENGTH]
    if not counts:
        return []
    positions, widths, endings = _positions(flat)
    results = []
    for count in counts:
        if count > len(positions) - 1 or count > widths[-1]:
            continue
        breaks = _arrange(positions, widths, endings, count)
        lines, start = [], 0
        for position in breaks:
            lines.append(flat[start:position])
            start = position
        lines.append(flat[start:])
        if len(lines) == count and all(line.strip() for line in lines):
            results.append({'line_count': count, 'text': '\n'.join(lines)})
    return results
