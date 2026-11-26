"""Read-only, lossless line-break suggestions; jieba is loaded on first use."""
from __future__ import annotations

import re
import math
import unicodedata
from bisect import bisect_left
from functools import lru_cache

from .line_break_widths import cumulative_widths

MAX_TEXT_LENGTH = 50000
_TOKEN_RUNS = re.compile(r'\w+|[^\w]+')
_PAUSE = frozenset('，。！？：；、,.!?;:')
_PARTICLES = frozenset('了啊呀吧呢嗎吗嘛啦呦喔哦唷哩')
_ORDINAL = re.compile(r'第[0-9０-９]+(?:輪|轮|回|名|次|屆|届|季|章|節|节|頁|页|天|年|月|號|号|位|組|组|場|场|局|集)')
# jieba 0.42.1 HMM copies an ever-growing Viterbi path; bound that quadratic work.
_HMM_RUN_LIMIT = 256
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


@lru_cache(maxsize=1)
def _converter():
    from opencc import OpenCC
    return OpenCC('t2s')


@lru_cache(maxsize=1)
def _pos_tokenizer():
    from jieba.posseg import POSTokenizer
    return POSTokenizer(_tokenizer())


def _analysis_text(run: str) -> str:
    # Conversion is analysis-only. Equal code-point length permits direct original slicing.
    # Skip English/numbers; the converted text never reaches the saved translation.
    if not re.search(r'[\u3400-\u9fff\uf900-\ufaff]', run):
        return run
    converted = _converter().convert(run)
    return converted if isinstance(converted, str) and len(converted) == len(run) else run


@lru_cache(maxsize=4)
def _token_analysis(text: str) -> tuple[tuple[str, str], ...]:
    result = []
    tagger = _pos_tokenizer()
    for match in _TOKEN_RUNS.finditer(text):
        run = match.group()
        if not (run[0].isalnum() or run[0] == '_'):
            result.extend((char, 'x') for char in run)
            continue
        analysis = _analysis_text(run)
        tagged = tuple((pair.word, pair.flag) for pair in tagger.cut(analysis, HMM=len(run) <= _HMM_RUN_LIMIT))
        if ''.join(word for word, _ in tagged) != analysis:
            # Never guess offsets from an incomplete or otherwise unmappable token stream.
            tags = getattr(tagger, 'word_tag_tab', {})
            result.extend((word, tags.get(word, 'x')) for word in
                          _tokenizer().cut(run, cut_all=False, HMM=len(run) <= _HMM_RUN_LIMIT))
            continue
        offset = 0
        for word, flag in tagged:
            result.append((run[offset:offset + len(word)], flag))
            offset += len(word)
    return tuple(result)


def _tokens(text: str):
    # Preserve original spelling, whitespace and punctuation regardless of analysis script.
    yield from (word for word, _ in _token_analysis(text))


def _phrase_break_penalties(text: str) -> dict[int, float]:
    """Local POS preferences, never unconditional concatenation or punctuation rewriting.

    Strong adjacent units are preferred intact. Exact line counts can still fall
    back to their original jieba word boundaries; no complete dictionary word splits.
    Long-distance nominal clauses and arbitrary pronoun/verb/noun chains are excluded.
    """
    tokens = _token_analysis(text)
    offsets, offset = [], 0
    for word, _ in tokens:
        offset += len(word)
        offsets.append(offset)
    penalties = {}

    def join(index, strength):
        left, right = tokens[index][0], tokens[index + 1][0]
        if (len(left) + len(right) <= 12 and left and right
                and not left.isspace() and not right.isspace()
                and any(char.isalnum() for char in left) and any(char.isalnum() for char in right)):
            penalties[offsets[index]] = max(strength, penalties.get(offsets[index], 0))

    for index in range(len(tokens) - 1):
        word, flag = tokens[index]
        next_word, next_flag = tokens[index + 1]
        if flag == 'm' and next_flag == 'q':
            join(index, 10)
            if index + 2 < len(tokens) and tokens[index + 2][1].startswith('n'):
                join(index + 1, 8)
        if flag.startswith('v') and next_flag in {'uz', 'ug', 'ud', 'ul', 'uj', 'uv'}:
            join(index, 10)
        if flag == 'n' and next_flag == 'f':
            join(index, 8)
        if flag in {'d', 'ad'} and next_flag.startswith(('v', 'a')):
            join(index, 2)
        if flag == 'r' and next_flag.startswith('v'):
            join(index, 2)
        if next_flag in {'y', 'zg'} and next_word in {'嗎', '吗', '呢', '吧', '啊', '呀', '喔', '哦', '啦', '嘛', '唷', '哩'}:
            following = tokens[index + 2][0] if index + 2 < len(tokens) else ''
            if not following or following[0] in _CLOSE or following[0] in _PAUSE:
                join(index, 10)
        if (flag.startswith('v') and next_flag == 'm' and index + 2 < len(tokens)
                and tokens[index + 2][1].startswith('v')
                and sum(len(tokens[n][0]) for n in (index, index + 1, index + 2)) <= 8):
            join(index, 8)
            join(index + 1, 8)
    for match in _ORDINAL.finditer(text):
        first = bisect_left(offsets, match.start() + 1)
        for offset in offsets[first:bisect_left(offsets, match.end())]:
            penalties[offset] = max(10, penalties.get(offset, 0))
    return penalties


def _original_tokens(text):
    for match in _TOKEN_RUNS.finditer(text):
        run = match.group()
        if run[0].isalnum() or run[0] == '_':
            yield from _tokenizer().cut(run, cut_all=False, HMM=len(run) <= _HMM_RUN_LIMIT)
        else:
            yield from run


def _positions(text: str, orientation: str = 'vertical', *, tokens=None) -> tuple[list[int], list[float], list[str]]:
    protected = _protected_boundaries(text)
    advances = cumulative_widths(text, orientation)
    right = [''] * (len(text) + 1)
    visible = ''
    for index in range(len(text) - 1, -1, -1):
        if not text[index].isspace():
            visible = text[index]
        right[index] = visible
    positions, widths, endings = [0], [0], ['']
    offset, left = 0, ''
    for token in _tokens(text) if tokens is None else tokens:
        offset += len(token)
        for char in token:
            if not char.isspace():
                left = char
        if (offset < len(text) and offset not in protected and left and right[offset]
                and left not in _OPEN and right[offset] not in _CLOSE
                and not text[offset].isspace()):
            positions.append(offset)
            widths.append(advances[offset])
            endings.append(left)
    positions.append(len(text))
    widths.append(advances[-1])
    endings.append(left)
    return positions, widths, endings


def _arrange(positions: list[int], widths: list[int], endings: list[str], count: int,
             *, phrase_penalties: dict[int, float] | None = None,
             line_capacity: float | None = None) -> list[int]:
    """Exactly count lines in O(B + count log B + 64 count), with no line-count cap.

    Choose nearby proportional boundaries, then refine neighboring line pairs. This
    bounded local optimization favors balanced lines and natural pauses; it does not
    claim a globally optimal paragraph partition. Optional capacity prioritizes
    overflow in the supplied em cells before the ordinary preference costs.
    """
    phrase_penalties = phrase_penalties or {}
    preferred = [index for index, position in enumerate(positions)
                 if index in (0, len(positions) - 1) or phrase_penalties.get(position, 0) < 8]
    if line_capacity is None and count <= len(preferred) - 1 and len(preferred) < len(positions):
        return _arrange([positions[index] for index in preferred], [widths[index] for index in preferred],
                        [endings[index] for index in preferred], count, phrase_penalties=phrase_penalties,
                        line_capacity=line_capacity)
    last = len(positions) - 1
    target = widths[-1] / count

    def line_cost(length):
        return (length - target) ** 2 + (4 * target ** 2 if length == 1 and target >= 2 else 0)

    def pause_cost(index):
        weight = phrase_penalties.get(positions[index], 0)
        phrase_cost = weight * (max(1, target ** 2) if weight >= 8 else max(1, target / 2))
        return phrase_cost - (min(2.0, target / 2) if endings[index] in _PAUSE else 0)

    def rank(lengths, base_cost, remaining=0, remaining_width=0):
        if line_capacity is None:
            return base_cost
        excesses = [max(0, length - line_capacity) for length in lengths]
        # During the forward pass, include a lower bound for the remaining
        # lines; otherwise a short early line can needlessly overflow the tail.
        future_excess = max(0, remaining_width - remaining * line_capacity) if remaining else 0
        return (sum(excesses) + future_excess,
                sum(value ** 2 for value in excesses) + (future_excess ** 2 / remaining if remaining else 0),
                base_cost)

    mandatory = set()
    if line_capacity is None and len(preferred) < len(positions):
        # Too few complete phrases for the requested count: retain every ordinary
        # word boundary and add only the minimum number of internal phrase breaks.
        mandatory = set(preferred[1:-1])
        soft = [index for index in range(1, last) if index not in mandatory]
        extra = count - (len(preferred) - 1)
        selected, cursor = [], -1
        soft_widths = [widths[index] for index in soft]
        for slot in range(extra):
            lower, upper = cursor + 1, len(soft) - (extra - slot)
            ideal = widths[-1] * (slot + 1) / (extra + 1)
            center = max(lower, min(upper, bisect_left(soft_widths, ideal)))
            cursor = min(range(max(lower, center - 1), min(upper, center + 1) + 1),
                         key=lambda i: abs(soft_widths[i] - ideal))
            selected.append(soft[cursor])
        chosen = sorted({0, last, *mandatory, *selected})
    else:
        chosen = [0]
        for slot in range(1, count):
            lower, upper = chosen[-1] + 1, last - (count - slot)
            ideal = widths[-1] * slot / count
            center = max(lower, min(upper, bisect_left(widths, ideal)))
            best = min(range(max(lower, center - 8), min(upper, center + 8) + 1),
                       key=lambda i: rank([widths[i] - widths[chosen[-1]]],
                           (widths[i] - ideal) ** 2 + line_cost(widths[i] - widths[chosen[-1]]) + pause_cost(i),
                           count - slot, widths[-1] - widths[i]))
            chosen.append(best)
        chosen.append(last)
    for order in (range(1, count), range(count - 1, 0, -1)):
        for slot in order:
            if chosen[slot] in mandatory:
                continue
            left, right = chosen[slot - 1], chosen[slot + 1]
            ideal = (widths[left] + widths[right]) / 2
            center = max(left + 1, min(right - 1, bisect_left(widths, ideal)))
            options = range(max(left + 1, center - 8), min(right - 1, center + 8) + 1)
            chosen[slot] = min(options, key=lambda i: rank(
                [widths[i] - widths[left], widths[right] - widths[i]],
                line_cost(widths[i] - widths[left]) + line_cost(widths[right] - widths[i]) + pause_cost(i)))
    return [positions[index] for index in chosen[1:-1]]


def line_break_candidates(text: str, source_line_count: int, orientation: str = 'vertical',
                          *, line_capacity: float | None = None) -> list[dict]:
    """Return only feasible N+1 / N / N-1 suggestions, preserving non-newlines.

    CRLF, CR and LF are equivalent input line separators. All other code points,
    including spaces, remain verbatim. Known words, punctuation and common Unicode
    clusters are indivisible. Every output line must contain visible content.
    line_capacity is an optional positive em/grid-cell length, used only to rank
    breaks within a fixed count; an overflowing count remains a valid suggestion.
    """
    if not isinstance(text, str) or len(text) > MAX_TEXT_LENGTH:
        raise ValueError('每框文字上限為 50000 字')
    if type(source_line_count) is not int or source_line_count < 1:
        raise ValueError('原文行數須為正整數')
    if orientation not in ('vertical', 'horizontal'):
        raise ValueError('排版方向無效')
    if line_capacity is not None and (isinstance(line_capacity, bool) or not isinstance(line_capacity, (int, float))
                                      or not math.isfinite(line_capacity) or line_capacity <= 0):
        raise ValueError('每行容量須為正有限字格數')
    flat = text.replace('\r\n', '').replace('\r', '').replace('\n', '')
    if not flat or flat.isspace():
        return []
    counts = list(dict.fromkeys(count for count in (source_line_count + 1, source_line_count, source_line_count - 1)
                               if count > 0))
    counts = [count for count in counts if len(flat) + count - 1 <= MAX_TEXT_LENGTH]
    if not counts:
        return []
    positions, widths, endings = _positions(flat, orientation)
    if widths[-1] == 0:
        return []
    phrase_penalties = _phrase_break_penalties(flat)
    tail_end = len(flat)
    while tail_end and (flat[tail_end - 1].isspace() or flat[tail_end - 1] in _CLOSE | _PAUSE):
        tail_end -= 1
    tail_start = tail_end
    while tail_start and flat[tail_start - 1] in _PARTICLES:
        tail_start -= 1

    def arrange(line_positions, line_widths, line_endings, count):
        # A terminal particle must stay with content whenever legal word
        # boundaries can still produce the exact requested number of lines.
        safe = [index for index, position in enumerate(line_positions)
                if index in (0, len(line_positions) - 1) or not tail_start <= position < tail_end]
        if len(safe) >= count + 1:
            line_positions = [line_positions[index] for index in safe]
            line_widths = [line_widths[index] for index in safe]
            line_endings = [line_endings[index] for index in safe]
        return _arrange(line_positions, line_widths, line_endings, count,
                        phrase_penalties=phrase_penalties, line_capacity=line_capacity)

    results = []
    for count in counts:
        if count > len(positions) - 1:
            continue
        breaks = arrange(positions, widths, endings, count)
        lines, start = [], 0
        for position in breaks:
            lines.append(flat[start:position])
            start = position
        lines.append(flat[start:])
        tail = lines[-1].strip().rstrip(''.join(_CLOSE | _PAUSE)).strip()
        if (count == 2 and len(positions) == 3 and tail and len(tail) <= 2
                and all(char in _PARTICLES for char in tail)):
            # Only this orphan case may use extra, explainable word boundaries from
            # original-script jieba. Never invent a character cut or drop a feasible count.
            alternate_positions, alternate_widths, alternate_endings = _positions(
                flat, orientation, tokens=_original_tokens(flat))
            if (len(alternate_positions) > len(positions) and count <= len(alternate_positions) - 1):
                alternate_breaks = arrange(alternate_positions, alternate_widths, alternate_endings, count)
                boundaries = [0, *alternate_breaks, len(flat)]
                alternate = [flat[left:right] for left, right in zip(boundaries, boundaries[1:])]
                alternate_tail = alternate[-1].strip().rstrip(''.join(_CLOSE | _PAUSE)).strip()
                if (all(line.strip() for line in alternate)
                        and not (alternate_tail and len(alternate_tail) <= 2
                                 and all(char in _PARTICLES for char in alternate_tail))):
                    lines = alternate
        if len(lines) == count and all(line.strip() for line in lines):
            results.append({'line_count': count, 'text': '\n'.join(lines)})
    return results
