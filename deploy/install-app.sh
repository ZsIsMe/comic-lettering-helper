#!/usr/bin/env bash
set -Eeuo pipefail

APP_ROOT=${COMIC_APP_ROOT:-/root/comic-inpaint}
COMFY_ROOT=${COMFY_ROOT:-/root/ComfyUI}
APP_PYTHON=${APP_PYTHON:-/root/miniconda3/bin/python}
PIP_MIRROR=${PIP_INDEX_URL:-https://mirrors.aliyun.com/pypi/simple/}
NPM_MIRROR=${NPM_REGISTRY:-https://registry.npmmirror.com}

test -f "$APP_ROOT/backend/requirements.txt"
test -f "$COMFY_ROOT/main.py"
command -v "$APP_PYTHON" >/dev/null

"$APP_PYTHON" "$APP_ROOT/deploy/install-workflows.py" --app-root "$APP_ROOT" --comfy-root "$COMFY_ROOT"

"$APP_PYTHON" -m venv "$APP_ROOT/.venv"
"$APP_ROOT/.venv/bin/pip" install --index-url "$PIP_MIRROR" -r "$APP_ROOT/backend/requirements.txt"
if command -v npm >/dev/null; then
  npm --prefix "$APP_ROOT/frontend" ci --registry "$NPM_MIRROR"
  npm --prefix "$APP_ROOT/frontend" run build
elif [ -f "$APP_ROOT/frontend/dist/index.html" ]; then
  printf 'Node.js is not installed; using the bundled production frontend.\n'
else
  printf 'Node.js is unavailable and frontend/dist is missing.\n' >&2
  exit 1
fi

"$APP_ROOT/.venv/bin/python" "$APP_ROOT/deploy/setup-models.py" --comfy-root "$COMFY_ROOT" --apply
"$APP_ROOT/.venv/bin/python" "$APP_ROOT/deploy/verify.py" --app-root "$APP_ROOT" --comfy-root "$COMFY_ROOT"

if [[ $(id -u) -eq 0 ]]; then
  install -m 0755 "$APP_ROOT/deploy/autodl-start.sh" /etc/autodl.sh
  printf 'Installed AutoDL boot fallback: /etc/autodl.sh\n'
else
  printf 'Not running as root; skipped /etc/autodl.sh boot fallback.\n' >&2
fi

printf 'Installed. Start with: %s/deploy/start.sh\n' "$APP_ROOT"
