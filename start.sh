#!/usr/bin/env bash
# Start the dictionary locally, killing any instance that is already running.
#
#   ./start.sh            build data if missing, (re)start on port 8080
#   PORT=9000 ./start.sh  use another port
#   ./start.sh --rebuild  regenerate public/data first
#   ./start.sh stop       stop the running server
#   ./start.sh status     show whether it is running
#
# Env: PORT (8080), BIND (0.0.0.0), DICT_LEVEL (standard), OPENCC_CONFIG (s2tw)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

PORT="${PORT:-8080}"
BIND="${BIND:-0.0.0.0}"
DICT_LEVEL="${DICT_LEVEL:-standard}"
OPENCC_CONFIG="${OPENCC_CONFIG:-s2tw}"
ECDICT_URL="${ECDICT_URL:-https://raw.githubusercontent.com/skywind3000/ECDICT/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b/ecdict.csv}"
IPA_URL="${IPA_URL:-https://raw.githubusercontent.com/open-dict-data/ipa-dict/41d62f55bd9c9275fcfd2843e8cf10c75e2696d7/data}"
RUN_DIR="$ROOT/.run"
PID_FILE="$RUN_DIR/server.pid"
LOG_FILE="$RUN_DIR/server.log"
VENV="$ROOT/.venv"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

is_running() { [[ -n "${1:-}" ]] && kill -0 "$1" 2>/dev/null; }

kill_pid() {
  local pid="$1"
  is_running "$pid" || return 0
  log "Stopping PID $pid"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    is_running "$pid" || return 0
    sleep 0.25
  done
  log "PID $pid did not exit, sending SIGKILL"
  kill -9 "$pid" 2>/dev/null || true
}

stop_server() {
  # 1) The PID we started last time.
  if [[ -f "$PID_FILE" ]]; then
    kill_pid "$(cat "$PID_FILE")"
    rm -f "$PID_FILE"
  fi
  # 2) Anything else still holding the port (e.g. started by hand).
  if command -v lsof >/dev/null 2>&1; then
    local pids
    pids="$(lsof -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
    for pid in $pids; do kill_pid "$pid"; done
  elif command -v fuser >/dev/null 2>&1; then
    fuser -k "$PORT/tcp" 2>/dev/null || true
  fi
}

build_data() {
  if [[ ! -x "$VENV/bin/python" ]]; then
    log "Creating Python virtualenv in .venv"
    python3 -m venv "$VENV"
  fi
  if ! "$VENV/bin/python" -c 'import opencc' 2>/dev/null; then
    log "Installing OpenCC"
    "$VENV/bin/pip" install --quiet opencc==1.4.2
  fi
  mkdir -p "$RUN_DIR"
  if [[ ! -s "$RUN_DIR/ecdict.csv" ]]; then
    log "Downloading ECDICT (~65 MB)"
    curl -fL --progress-bar -o "$RUN_DIR/ecdict.csv.part" "$ECDICT_URL"
    mv "$RUN_DIR/ecdict.csv.part" "$RUN_DIR/ecdict.csv"
  fi
  for f in en_UK en_US; do
    if [[ ! -s "$RUN_DIR/$f.txt" ]]; then
      log "Downloading $f IPA"
      curl -fsSL -o "$RUN_DIR/$f.txt.part" "$IPA_URL/$f.txt"
      mv "$RUN_DIR/$f.txt.part" "$RUN_DIR/$f.txt"
    fi
  done
  log "Building dictionary data (level=$DICT_LEVEL, opencc=$OPENCC_CONFIG)"
  "$VENV/bin/python" scripts/build_dict.py --csv "$RUN_DIR/ecdict.csv" --out public/data \
    --level "$DICT_LEVEL" --opencc "$OPENCC_CONFIG" \
    --ipa-uk "$RUN_DIR/en_UK.txt" --ipa-us "$RUN_DIR/en_US.txt"
}

case "${1:-start}" in
  stop)
    stop_server
    log "Stopped"
    exit 0
    ;;
  status)
    if [[ -f "$PID_FILE" ]] && is_running "$(cat "$PID_FILE")"; then
      log "Running (PID $(cat "$PID_FILE")) on port $PORT"
    else
      log "Not running"
      exit 1
    fi
    exit 0
    ;;
  start | --rebuild) ;;
  -h | --help)
    sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    echo "Unknown command: $1 (use start, stop, status, --rebuild)" >&2
    exit 2
    ;;
esac

stop_server

if [[ "${1:-}" == "--rebuild" || ! -f public/data/meta.json ]]; then
  build_data
fi

mkdir -p "$RUN_DIR"
log "Starting server on http://$BIND:$PORT/ (also /dict/)"
nohup python3 scripts/serve.py --port "$PORT" --bind "$BIND" >"$LOG_FILE" 2>&1 &
echo $! >"$PID_FILE"

sleep 1
if ! is_running "$(cat "$PID_FILE")"; then
  echo "Server failed to start; see $LOG_FILE:" >&2
  tail -n 20 "$LOG_FILE" >&2
  exit 1
fi
log "Running (PID $(cat "$PID_FILE")), logs: $LOG_FILE"
log "Open http://localhost:$PORT/"
