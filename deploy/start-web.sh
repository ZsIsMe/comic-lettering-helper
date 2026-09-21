#!/usr/bin/env bash
set -Eeuo pipefail

APP_ROOT=${COMIC_APP_ROOT:-/root/comic-inpaint}
if [ -f "$APP_ROOT/.env" ]; then
  set -a
  source "$APP_ROOT/.env"
  set +a
fi

COMFY_ROOT=${COMFY_ROOT:-/root/ComfyUI}
COMFY_PYTHON=${COMFY_PYTHON:-/root/comfy-qwen21-venv/bin/python}
COMFY_PORT=${COMFY_PORT:-6006}
WEB_HOST=${COMIC_WEB_HOST:-0.0.0.0}
WEB_PORT=${COMIC_WEB_PORT:-6008}
DATA_ROOT=${COMIC_DATA_ROOT:-/root/autodl-tmp/comic-inpaint}
RUN_ROOT="$DATA_ROOT/run"
LOG_ROOT="$DATA_ROOT/logs"

mkdir -p "$RUN_ROOT" "$LOG_ROOT"
if [ -f "$RUN_ROOT/web.pid" ] && kill -0 "$(cat "$RUN_ROOT/web.pid")" 2>/dev/null; then
  printf 'Web service is already running.\n'
else
  COMIC_APP_ROOT="$APP_ROOT" COMFY_ROOT="$COMFY_ROOT" COMFY_URL="http://127.0.0.1:$COMFY_PORT" \
    COMIC_DATA_ROOT="$DATA_ROOT" COMFY_PYTHON="$COMFY_PYTHON" \
    nohup "$APP_ROOT/.venv/bin/uvicorn" app.main:app --app-dir "$APP_ROOT/backend" \
      --host "$WEB_HOST" --port "$WEB_PORT" >"$LOG_ROOT/web.log" 2>&1 </dev/null &
  printf '%s\n' "$!" >"$RUN_ROOT/web.pid"
fi

for _ in $(seq 1 30); do
  curl -fsS --max-time 2 "http://127.0.0.1:$WEB_PORT/api/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:$WEB_PORT/api/health"
printf '\nWeb application ready on port %s.\n' "$WEB_PORT"
