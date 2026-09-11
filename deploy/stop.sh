#!/usr/bin/env bash
set -Eeuo pipefail

DATA_ROOT=${COMIC_DATA_ROOT:-/root/autodl-tmp/comic-inpaint}
RUN_ROOT="$DATA_ROOT/run"

stop_one() {
  local name=$1
  local expected=$2
  local file="$RUN_ROOT/$name.pid"
  [ -f "$file" ] || return 0
  local pid
  pid=$(cat "$file")
  if kill -0 "$pid" 2>/dev/null; then
    local command
    command=$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)
    if [[ "$command" != *"$expected"* ]]; then
      printf 'Refusing to stop PID %s: command does not match %s\n' "$pid" "$expected" >&2
      return 1
    fi
    kill "$pid"
    for _ in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
  fi
  rm -f "$file"
}

stop_one web uvicorn
stop_one comfyui ComfyUI/main.py
printf 'Application services stopped. The AutoDL instance is still powered on.\n'
