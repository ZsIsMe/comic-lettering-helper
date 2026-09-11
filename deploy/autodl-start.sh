#!/usr/bin/env bash
set -u

APP_ROOT=${COMIC_APP_ROOT:-/root/comic-inpaint}
DATA_ROOT=${COMIC_DATA_ROOT:-/root/autodl-tmp/comic-inpaint}
LOG_ROOT="$DATA_ROOT/logs"
LOG_FILE="$LOG_ROOT/startup.log"

mkdir -p "$LOG_ROOT"
exec >>"$LOG_FILE" 2>&1

printf '\n[%s] AutoDL startup begin\n' "$(date '+%Y-%m-%d %H:%M:%S %z')"

web_status=0
comfy_status=0
health_status=0

"$APP_ROOT/deploy/start-web.sh" || web_status=$?
"$APP_ROOT/deploy/start-comfy.sh" || comfy_status=$?
"$APP_ROOT/deploy/health-check.sh" || health_status=$?

printf '[%s] AutoDL startup result: web=%s comfy=%s health=%s\n' \
  "$(date '+%Y-%m-%d %H:%M:%S %z')" \
  "$web_status" \
  "$comfy_status" \
  "$health_status"

if ((web_status != 0 || comfy_status != 0 || health_status != 0)); then
  exit 1
fi
