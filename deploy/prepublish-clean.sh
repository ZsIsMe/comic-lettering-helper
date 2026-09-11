#!/usr/bin/env bash
set -Eeuo pipefail

APP_ROOT=${COMIC_APP_ROOT:-/root/comic-inpaint}
if [ -x "$APP_ROOT/.venv/bin/python" ]; then
  PYTHON_BIN="$APP_ROOT/.venv/bin/python"
else
  PYTHON_BIN=${APP_PYTHON:-/root/miniconda3/bin/python}
fi
exec "$PYTHON_BIN" "$APP_ROOT/deploy/prepublish_clean.py" "$@"
