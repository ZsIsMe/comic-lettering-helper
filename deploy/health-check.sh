#!/usr/bin/env bash
set -Eeuo pipefail

COMFY_PORT=${COMFY_PORT:-6006}
WEB_PORT=${COMIC_WEB_PORT:-6008}

printf 'ComfyUI: '
curl -fsS --max-time 3 "http://127.0.0.1:$COMFY_PORT/system_stats" >/dev/null
printf 'ready\nWeb: '
curl -fsS --max-time 3 "http://127.0.0.1:$WEB_PORT/api/health"
printf '\n'
