"""Literal, non-recursive replacement shared by preview and apply."""


def replacement(text: str, find: str, substitute: str) -> tuple[str, int]:
    occurrences = text.count(find)
    if len(text) + occurrences * (len(substitute) - len(find)) > 50000:
        raise ValueError('替換後文字超過每框 50,000 個字元')
    return (text.replace(find, substitute), occurrences) if occurrences else (text, 0)


def validate_request(find, substitute):
    if not isinstance(find, str) or not find or len(find) > 50000:
        raise ValueError('搜尋文字須為 1 至 50,000 個字元')
    if not isinstance(substitute, str) or len(substitute) > 50000:
        raise ValueError('替換文字不可超過 50,000 個字元')
