#!/bin/bash
# Finder 可雙擊的本機啟動入口；沿用專案既有設定與服務管理。
set -u

PROJECT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd) || exit 1
cd "$PROJECT_DIR" || exit 1

/bin/bash "$PROJECT_DIR/scripts/start-local.sh" --open "$@"
result=$?
if [ "$result" -ne 0 ] && [ -t 0 ]; then
  printf '\n啟動未完成，請查看上方訊息。按 Enter 關閉。\n'
  read -r _
fi
exit "$result"
