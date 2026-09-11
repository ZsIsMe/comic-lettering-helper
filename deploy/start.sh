#!/usr/bin/env bash
set -Eeuo pipefail

APP_ROOT=${COMIC_APP_ROOT:-/root/comic-inpaint}
"$APP_ROOT/deploy/start-comfy.sh"
"$APP_ROOT/deploy/start-web.sh"
"$APP_ROOT/deploy/health-check.sh"

printf 'AutoDL WebUI-6006: ComfyUI\n'
printf 'AutoDL WebUI-6008: 漫畫去字工作台\n'
