#!/usr/bin/env bash
set -Eeuo pipefail

APP_ROOT=${COMIC_APP_ROOT:-/root/comic-inpaint}
DATA_ROOT=${COMIC_DATA_ROOT:-/root/autodl-tmp/comic-inpaint}
PID_FILE="$DATA_ROOT/run/web.pid"

if [ -f "$PID_FILE" ]; then
  pid=$(cat "$PID_FILE")
  if kill -0 "$pid" 2>/dev/null; then
    command=$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)
    if [[ "$command" != *uvicorn* || "$command" != *"--port 6008"* ]]; then
      printf 'Refusing to stop PID %s: it is not the managed port-6008 web service.\n' "$pid" >&2
      exit 1
    fi
    kill "$pid"
    for _ in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
    if kill -0 "$pid" 2>/dev/null; then
      printf 'Web service PID %s did not stop in time.\n' "$pid" >&2
      exit 1
    fi
  fi
  rm -f "$PID_FILE"
fi

exec "$APP_ROOT/deploy/start-web.sh"
