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
COMFY_LISTEN=${COMFY_LISTEN:-0.0.0.0}
DATA_ROOT=${COMIC_DATA_ROOT:-/root/autodl-tmp/comic-inpaint}
RUN_ROOT="$DATA_ROOT/run"
LOG_ROOT="$DATA_ROOT/logs"

mkdir -p "$RUN_ROOT" "$LOG_ROOT"
if ! curl -fsS --max-time 2 "http://127.0.0.1:$COMFY_PORT/system_stats" >/dev/null 2>&1; then
  nohup "$COMFY_PYTHON" "$COMFY_ROOT/main.py" \
    --listen "$COMFY_LISTEN" --port "$COMFY_PORT" --disable-auto-launch --bf16-text-enc --bf16-vae \
    >"$LOG_ROOT/comfyui.log" 2>&1 </dev/null &
  printf '%s\n' "$!" >"$RUN_ROOT/comfyui.pid"
fi

for _ in $(seq 1 60); do
  curl -fsS --max-time 2 "http://127.0.0.1:$COMFY_PORT/system_stats" >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS --max-time 2 "http://127.0.0.1:$COMFY_PORT/system_stats" >/dev/null
printf 'ComfyUI ready on port %s.\n' "$COMFY_PORT"
