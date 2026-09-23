"""Pure fixed-font measurement used by the CTD worker and unit tests."""


def fixed_font_measurement(default_font_size: float, orientation: str) -> tuple[list, float, str, dict]:
    font_size = round(float(default_font_size), 1)
    method = 'fixed'
    return [], font_size, method, {
        'method': method,
        'accepted': True,
        'orientation': orientation,
        'font_size': font_size,
        'skipped_font_measurement': True,
    }
