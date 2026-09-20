#!/usr/bin/env bash
# 本機 macOS 開發入口。不啟動 ComfyUI，也不供 AutoDL 使用。
set -Eeuo pipefail

APP_ROOT=$(cd "$(dirname "$0")/.." && pwd)
ACTION=start
FOREGROUND=0
FORCE_BUILD=0
OPEN_BROWSER=0
if [ -t 1 ]; then
  OPEN_BROWSER=1
fi

usage() {
  cat <<'EOF'
本機工作台啟動入口（Apple Silicon / MPS）。不啟動 ComfyUI。

用法：
  ./scripts/start-local.sh init      複製路徑範本到 var/local/start.env
  ./scripts/start-local.sh           啟動（背景）
  ./scripts/start-local.sh --fg      前景執行
  ./scripts/start-local.sh --build   先重建 frontend/dist
  ./scripts/start-local.sh --open    啟動後開啟預排版頁
  ./scripts/start-local.sh --no-open 不開瀏覽器
  ./scripts/start-local.sh stop      停止本機服務
  ./scripts/start-local.sh status    查看狀態

本機路徑只放 var/local/start.env（不進 Git）。倉庫內範本為 scripts/local.env.example。
EOF
}

for arg in "$@"; do
  case "$arg" in
    start) ACTION=start ;;
    init) ACTION=init ;;
    stop) ACTION=stop ;;
    status) ACTION=status ;;
    --fg) FOREGROUND=1 ;;
    --build) FORCE_BUILD=1 ;;
    --open) OPEN_BROWSER=1 ;;
    --no-open) OPEN_BROWSER=0 ;;
    -h|--help) usage; exit 0 ;;
    *)
      printf '未知參數：%s\n' "$arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ "$(uname -s)" != Darwin ]; then
  printf '此腳本只供本機 macOS 開發。AutoDL 請使用 deploy/start-web.sh。\n' >&2
  exit 1
fi

LOCAL_ENV="$APP_ROOT/var/local/start.env"
EXAMPLE_ENV="$APP_ROOT/scripts/local.env.example"

init_local_env() {
  mkdir -p "$APP_ROOT/var/local"
  if [ -e "$LOCAL_ENV" ]; then
    printf '已存在 %s，未覆蓋。\n' "$LOCAL_ENV"
    return 0
  fi
  if [ ! -f "$EXAMPLE_ENV" ]; then
    printf '找不到範本 %s\n' "$EXAMPLE_ENV" >&2
    return 1
  fi
  cp "$EXAMPLE_ENV" "$LOCAL_ENV"
  printf '已寫入 %s。請填入本機模型與 Python 的絕對路徑後再啟動。\n' "$LOCAL_ENV"
}

require_local_env() {
  if [ -f "$LOCAL_ENV" ]; then
    return 0
  fi
  printf '尚未設定本機路徑。請先複製範本並填入絕對路徑：\n' >&2
  printf '  ./scripts/start-local.sh init\n' >&2
  printf '然後編輯 %s\n' "$LOCAL_ENV" >&2
  return 1
}

mkdir -p "$APP_ROOT/var/local" "$APP_ROOT/var/run"
if [ -f "$LOCAL_ENV" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$LOCAL_ENV"
  set +a
fi

WEB_HOST=127.0.0.1
WEB_PORT=${COMIC_WEB_PORT:-6008}
DATA_ROOT=${COMIC_DATA_ROOT:-$APP_ROOT/var}
RUN_ROOT=${COMIC_LOCAL_RUN_ROOT:-$APP_ROOT/var/run}
LOG_FILE=${COMIC_LOCAL_LOG:-$APP_ROOT/var/local/web.log}
PID_FILE="$RUN_ROOT/web.pid"
UVICORN="$APP_ROOT/.venv/bin/uvicorn"
PRELAYOUT_SOURCE=${COMIC_PRELAYOUT_SOURCE:-}
MODEL_ROOT=${COMIC_PRELAYOUT_MODEL_ROOT:-$APP_ROOT/var/local/prelayout-models}
PRELAYOUT_PYTHON=${COMIC_PRELAYOUT_PYTHON:-}
PRELAYOUT_DEVICE=${COMIC_PRELAYOUT_DEVICE:-mps}
DETECTION_PYTHON=${COMIC_DETECTION_PYTHON:-}
DETECTION_CONFIG=${COMIC_DETECTION_CONFIG:-}
if [ -z "$PRELAYOUT_PYTHON" ] && [ -n "$PRELAYOUT_SOURCE" ]; then
  candidate="$PRELAYOUT_SOURCE/ctd_overlay_processor/.venv/bin/python"
  if [ -x "$candidate" ]; then
    PRELAYOUT_PYTHON=$candidate
  fi
fi
if [ -z "$DETECTION_CONFIG" ] && [ -f "$APP_ROOT/var/local/detection-models.json" ]; then
  DETECTION_CONFIG="$APP_ROOT/var/local/detection-models.json"
fi
BASE_URL="http://$WEB_HOST:$WEB_PORT"
PRELAYOUT_URL="$BASE_URL/#/prelayout"

command_for_pid() {
  ps -p "$1" -o command= 2>/dev/null || true
}

is_our_server() {
  local command=$1
  [[ "$command" == *uvicorn* && "$command" == *app.main:app* && "$command" == *"--port $WEB_PORT"* ]]
}

running_pid() {
  local pid command
  if [ -f "$PID_FILE" ]; then
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      command=$(command_for_pid "$pid")
      if is_our_server "$command"; then
        printf '%s\n' "$pid"
        return 0
      fi
    fi
  fi
  pid=$(lsof -nP -iTCP:"$WEB_PORT" -sTCP:LISTEN -t 2>/dev/null | head -n 1 || true)
  if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
    command=$(command_for_pid "$pid")
    if is_our_server "$command"; then
      printf '%s\n' "$pid"
      return 0
    fi
  fi
  return 1
}

print_urls() {
  printf '本機工作台：%s/\n' "$BASE_URL"
  printf '預排版：%s\n' "$PRELAYOUT_URL"
  printf '邊緣塗白：%s/#/edgewhite\n' "$BASE_URL"
}

stop_server() {
  local pid
  pid=$(running_pid || true)
  if [ -z "${pid:-}" ]; then
    rm -f "$PID_FILE"
    printf '本機服務未在執行。\n'
    return 0
  fi
  kill "$pid"
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  printf '已停止本機服務（PID %s）。\n' "$pid"
}

status_server() {
  local pid
  pid=$(running_pid || true)
  if [ -z "${pid:-}" ]; then
    printf '本機服務未在執行。\n'
    return 1
  fi
  printf '本機服務執行中（PID %s，埠 %s）。\n' "$pid" "$WEB_PORT"
  print_urls
  if curl -fsS --max-time 3 "$BASE_URL/api/prelayout/availability" >/dev/null 2>&1; then
    summarize_availability
  fi
}

link_asset() {
  local src=$1 name=$2
  if [ -f "$src" ]; then
    ln -sfn "$src" "$MODEL_ROOT/$name"
  else
    printf '缺少來源檔：%s\n' "$src" >&2
  fi
}

prepare_models() {
  if [ -z "$PRELAYOUT_SOURCE" ]; then
    printf '未設定 COMIC_PRELAYOUT_SOURCE，跳過模型連結。\n' >&2
    return 0
  fi
  if [ ! -d "$PRELAYOUT_SOURCE" ]; then
    printf 'COMIC_PRELAYOUT_SOURCE 不是目錄：%s\n' "$PRELAYOUT_SOURCE" >&2
    return 0
  fi
  mkdir -p "$MODEL_ROOT"
  link_asset "$PRELAYOUT_SOURCE/data/comictextdetector.pt" comictextdetector.pt
  link_asset "$PRELAYOUT_SOURCE/data/models/mit48pxctc_ocr.ckpt" mit48pxctc_ocr.ckpt
  link_asset "$PRELAYOUT_SOURCE/data/alphabet-all-v5.txt" alphabet-all-v5.txt
  link_asset "$PRELAYOUT_SOURCE/assets/fonts/NotoSansCJKjp-Medium.otf" NotoSansCJKjp-Medium.otf
  link_asset "$PRELAYOUT_SOURCE/assets/fonts/NotoSansCJKjp-Medium.ink-metrics.json" NotoSansCJKjp-Medium.ink-metrics.json
}

summarize_availability() {
  "$APP_ROOT/.venv/bin/python" - <<PY
import json, urllib.request
raw = urllib.request.urlopen("$BASE_URL/api/prelayout/availability", timeout=5).read()
data = json.loads(raw)
methods = data.get("methods") or {}
assets = data.get("assets") or {}
print("設備：%s" % data.get("device"))
print("推理 Python：%s" % ("已設定" if data.get("runtime") else "未設定"))
print("CTD 單字框：%s" % ("可用" if methods.get("single_char") else "不可用"))
print("OCR 對齊字級：%s" % ("可用" if methods.get("ocr_aligned") else "不可用"))
missing = [name for name, present in assets.items() if not present]
if missing:
    print("缺少資產：" + "、".join(missing))
print(data.get("message") or "")
PY
}

wait_health() {
  local _ 
  for _ in $(seq 1 30); do
    curl -fsS --max-time 2 "$BASE_URL/api/health" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  printf '服務未在時限內回應 %s/api/health。日誌：%s\n' "$BASE_URL" "$LOG_FILE" >&2
  return 1
}

start_server() {
  local pid extra_env
  require_local_env || exit 1
  if [ ! -x "$UVICORN" ]; then
    printf '找不到 %s，請先建立本機 .venv。\n' "$UVICORN" >&2
    exit 1
  fi
  if [ "$PRELAYOUT_DEVICE" != mps ]; then
    printf '本機入口只接受 COMIC_PRELAYOUT_DEVICE=mps，目前為 %s。\n' "$PRELAYOUT_DEVICE" >&2
    exit 1
  fi
  pid=$(running_pid || true)
  if [ -n "${pid:-}" ]; then
    printf '本機服務已在執行（PID %s）。\n' "$pid"
    print_urls
    summarize_availability || true
    return 0
  fi
  if lsof -nP -iTCP:"$WEB_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    printf '埠 %s 已被其他程序占用。\n' "$WEB_PORT" >&2
    lsof -nP -iTCP:"$WEB_PORT" -sTCP:LISTEN >&2 || true
    exit 1
  fi

  prepare_models
  if [ "$FORCE_BUILD" -eq 1 ] || [ ! -f "$APP_ROOT/frontend/dist/index.html" ]; then
    printf '正在建置前端…\n'
    npm --prefix "$APP_ROOT/frontend" run build
  fi

  extra_env=(
    COMIC_APP_ROOT="$APP_ROOT"
    COMIC_DATA_ROOT="$DATA_ROOT"
    COMIC_WEB_HOST="$WEB_HOST"
    COMIC_WEB_PORT="$WEB_PORT"
    COMFY_URL="${COMFY_URL:-http://127.0.0.1:6199}"
    COMIC_PRELAYOUT_MODEL_ROOT="$MODEL_ROOT"
    COMIC_PRELAYOUT_DEVICE="$PRELAYOUT_DEVICE"
  )
  if [ -n "$PRELAYOUT_PYTHON" ] && [ -x "$PRELAYOUT_PYTHON" ]; then
    extra_env+=(COMIC_PRELAYOUT_PYTHON="$PRELAYOUT_PYTHON")
  elif [ -n "$PRELAYOUT_PYTHON" ]; then
    printf 'COMIC_PRELAYOUT_PYTHON 不可執行：%s（仍可人工編輯）\n' "$PRELAYOUT_PYTHON" >&2
  else
    printf '未設定 COMIC_PRELAYOUT_PYTHON（仍可人工編輯）\n' >&2
  fi
  if [ -n "$DETECTION_PYTHON" ] && [ -x "$DETECTION_PYTHON" ]; then
    extra_env+=(COMIC_DETECTION_PYTHON="$DETECTION_PYTHON")
  fi
  if [ -n "$DETECTION_CONFIG" ] && [ -f "$DETECTION_CONFIG" ]; then
    extra_env+=(COMIC_DETECTION_CONFIG="$DETECTION_CONFIG")
  fi

  mkdir -p "$RUN_ROOT" "$DATA_ROOT"
  if [ "$FOREGROUND" -eq 1 ]; then
    printf '前景啟動 %s …\n' "$BASE_URL"
    exec env "${extra_env[@]}" "$UVICORN" app.main:app --app-dir "$APP_ROOT/backend" \
      --host "$WEB_HOST" --port "$WEB_PORT"
  fi

  : >"$LOG_FILE"
  env "${extra_env[@]}" \
    COMIC_LOCAL_UVICORN="$UVICORN" \
    COMIC_LOCAL_APP_DIR="$APP_ROOT/backend" \
    COMIC_LOCAL_HOST="$WEB_HOST" \
    COMIC_LOCAL_PORT="$WEB_PORT" \
    COMIC_LOCAL_PID_FILE="$PID_FILE" \
    COMIC_LOCAL_LOG_FILE="$LOG_FILE" \
    "$APP_ROOT/.venv/bin/python" - "$APP_ROOT" <<'PY'
import os
import sys
import time

app_root = sys.argv[1]
uvicorn = os.environ['COMIC_LOCAL_UVICORN']
pid_file = os.environ['COMIC_LOCAL_PID_FILE']
log_file = os.environ['COMIC_LOCAL_LOG_FILE']
args = [
    uvicorn,
    'app.main:app',
    '--app-dir', os.environ['COMIC_LOCAL_APP_DIR'],
    '--host', os.environ['COMIC_LOCAL_HOST'],
    '--port', os.environ['COMIC_LOCAL_PORT'],
]
if os.fork() > 0:
    for _ in range(50):
        try:
            pid = int(open(pid_file, encoding='utf-8').read().strip())
            os.kill(pid, 0)
            os._exit(0)
        except (OSError, ValueError):
            time.sleep(0.05)
    sys.stderr.write('無法確認本機服務已脫離行程組\n')
    os._exit(1)
os.setsid()
if os.fork() > 0:
    os._exit(0)
os.chdir(app_root)
os.umask(0o22)
os.makedirs(os.path.dirname(pid_file), exist_ok=True)
with open(pid_file, 'w', encoding='utf-8') as handle:
    handle.write(f'{os.getpid()}\n')
    handle.flush()
    os.fsync(handle.fileno())
devnull = os.open(os.devnull, os.O_RDWR)
log = os.open(log_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
os.dup2(devnull, 0)
os.dup2(log, 1)
os.dup2(log, 2)
os.close(devnull)
if log > 2:
    os.close(log)
os.execve(uvicorn, args, os.environ)
PY
  if ! wait_health; then
    stop_server >/dev/null 2>&1 || true
    tail -n 40 "$LOG_FILE" >&2 || true
    exit 1
  fi
  printf '本機服務已啟動（PID %s）。\n' "$(cat "$PID_FILE")"
  print_urls
  printf '日誌：%s\n' "$LOG_FILE"
  summarize_availability || true
  if [ "$OPEN_BROWSER" -eq 1 ]; then
    open "$PRELAYOUT_URL"
  fi
}

case "$ACTION" in
  init) init_local_env ;;
  stop) stop_server ;;
  status) status_server ;;
  start) start_server ;;
esac
