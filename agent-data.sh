#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CLI="$ROOT_DIR/packages/cli/bin/agent-data.js"
DATA_DIR=${AGENT_DATA_DIR:-"$ROOT_DIR/.agent-data"}
UPSTREAM=${AGENT_DATA_UPSTREAM:-"https://api.openai.com/v1"}
HOST=${AGENT_DATA_HOST:-127.0.0.1}
PORT=${AGENT_DATA_PORT:-8787}
PID_FILE="$DATA_DIR/proxy.pid"
LOG_FILE="$DATA_DIR/proxy.log"

usage() {
  cat <<'HELP'
Usage:
  bash agent-data.sh start      Start the background proxy
  bash agent-data.sh stop       Stop the background proxy
  bash agent-data.sh restart    Restart the background proxy
  bash agent-data.sh status     Show proxy status
  bash agent-data.sh logs       Follow proxy logs
  bash agent-data.sh codex ...  Record a Codex login session
  bash agent-data.sh demo       Run a local mock end-to-end request

Environment overrides:
  AGENT_DATA_UPSTREAM   Upstream URL (default: https://api.openai.com/v1)
  AGENT_DATA_PORT       Proxy port (default: 8787)
  AGENT_DATA_HOST       Proxy host (default: 127.0.0.1)
  AGENT_DATA_DIR        Data directory (default: ./.agent-data)
  AGENT_DATA_AUTH_MODE  codex-login (default) or api-key
HELP
}

pid_is_running() {
  test -s "$PID_FILE" || return 1
  local pid
  pid=$(cat "$PID_FILE")
  test "$pid" -gt 0 2>/dev/null || return 1
  kill -0 "$pid" 2>/dev/null
}

start_proxy() {
  mkdir -p "$DATA_DIR"
  local current_upstream=${AGENT_DATA_UPSTREAM:-$UPSTREAM}
  local current_host=${AGENT_DATA_HOST:-$HOST}
  local current_port=${AGENT_DATA_PORT:-$PORT}
  if pid_is_running; then
    printf '%s\n' "Proxy already running (PID $(cat "$PID_FILE")) at http://$HOST:$PORT"
    return 0
  fi
  node "$CLI" proxy \
    --upstream "$current_upstream" \
    --host "$current_host" \
    --port "$current_port" \
    --data-dir "$DATA_DIR" \
    >"$LOG_FILE" 2>&1 &
  local pid=$!
  printf '%s\n' "$pid" >"$PID_FILE"
  for _ in $(seq 1 30); do
    if ! kill -0 "$pid" 2>/dev/null; then
      printf '%s\n' "Proxy failed to start. See $LOG_FILE" >&2
      cat "$LOG_FILE" >&2 || true
      return 1
    fi
    if grep -q 'proxy listening on' "$LOG_FILE" 2>/dev/null; then
      printf '%s\n' "Proxy started at http://$current_host:$current_port"
      printf '%s\n' "Upstream: $current_upstream"
      printf '%s\n' "Data: $DATA_DIR"
      return 0
    fi
    sleep 0.1
  done
  printf '%s\n' "Proxy is still starting; follow $LOG_FILE" >&2
}

stop_proxy() {
  if ! test -s "$PID_FILE"; then
    printf '%s\n' 'Proxy is not running.'
    return 0
  fi
  local pid
  pid=$(cat "$PID_FILE")
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 30); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
  fi
  rm -f "$PID_FILE"
  printf '%s\n' 'Proxy stopped.'
}

status_proxy() {
  local current_host=${AGENT_DATA_HOST:-$HOST}
  local current_port=${AGENT_DATA_PORT:-$PORT}
  if pid_is_running; then
    printf '%s\n' "Proxy running (PID $(cat "$PID_FILE")) at http://$current_host:$current_port"
    printf '%s\n' "Upstream: $UPSTREAM"
    printf '%s\n' "Data: $DATA_DIR"
  else
    printf '%s\n' 'Proxy is not running.'
    test ! -e "$PID_FILE" || rm -f "$PID_FILE"
    return 1
  fi
}

run_codex() {
  command -v codex >/dev/null 2>&1 || { printf '%s\n' 'codex command was not found.' >&2; exit 1; }
  node "$CLI" run \
    --upstream "$UPSTREAM" \
    --host "$HOST" \
    --port 0 \
    --data-dir "$DATA_DIR" \
    --auth-mode "${AGENT_DATA_AUTH_MODE:-codex-login}" \
    -- codex "$@"
}

run_demo() {
  local demo_dir demo_pid
  if pid_is_running; then
    printf '%s\n' 'Stop the existing proxy before running demo.' >&2
    return 1
  fi
  demo_dir=$(mktemp -d "${TMPDIR:-/tmp}/agent-data-demo.XXXXXX")
  node "$CLI" mock-upstream --port 0 >"$demo_dir/mock.log" 2>&1 & demo_pid=$!
  local mock_port
  mock_port=""
  for _ in $(seq 1 50); do
    mock_port=$(sed -n 's/.*127\.0\.0\.1:\([0-9][0-9]*\).*/\1/p' "$demo_dir/mock.log" | head -1)
    test -n "$mock_port" && break
    if ! kill -0 "$demo_pid" 2>/dev/null; then
      break
    fi
    sleep 0.1
  done
  if test -z "$mock_port"; then
    printf '%s\n' 'Mock upstream failed to start.' >&2
    cat "$demo_dir/mock.log" >&2 || true
    kill "$demo_pid" 2>/dev/null || true
    rm -rf "$demo_dir"
    return 1
  fi
  local demo_proxy_port
  demo_proxy_port=$(node -e "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
  AGENT_DATA_UPSTREAM="http://127.0.0.1:$mock_port/v1" AGENT_DATA_PORT="$demo_proxy_port" start_proxy
  curl -fsS "http://$HOST:$demo_proxy_port/v1/responses" \
    -H 'content-type: application/json' \
    -H 'authorization: Bearer demo-token' \
    -d '{"model":"gpt-5.6","stream":true,"input":"hello"}'
  printf '%s\n' "Demo complete. Records are in $DATA_DIR"
  stop_proxy
  kill "$demo_pid" 2>/dev/null || true
  rm -rf "$demo_dir"
}

command=${1:-help}
shift || true
case "$command" in
  start) start_proxy ;;
  stop) stop_proxy ;;
  restart) stop_proxy; start_proxy ;;
  status) status_proxy ;;
  logs) mkdir -p "$DATA_DIR"; touch "$LOG_FILE"; tail -f "$LOG_FILE" ;;
  codex) run_codex "$@" ;;
  demo) run_demo ;;
  help|--help|-h) usage ;;
  *) usage; exit 2 ;;
esac
