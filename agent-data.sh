#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CLI="$ROOT_DIR/packages/cli/bin/agent-data.js"
DATA_DIR=${AGENT_DATA_DIR:-"$ROOT_DIR/.agent-data"}
AUTH_MODE=${AGENT_DATA_AUTH_MODE:-codex-login}
if test "$AUTH_MODE" = 'api-key'; then
  DEFAULT_UPSTREAM='https://api.openai.com/v1'
else
  DEFAULT_UPSTREAM='https://chatgpt.com/backend-api/codex'
fi
UPSTREAM=${AGENT_DATA_UPSTREAM:-$DEFAULT_UPSTREAM}
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
  bash agent-data.sh ui         Start the live proxy dashboard
  bash agent-data.sh setup-codex Point Codex at the local proxy (one time)
  bash agent-data.sh reset-daemon Clean a stale Codex app-server socket
  bash agent-data.sh sync       Sync native Codex rollout indexes
  bash agent-data.sh resume ID  Resume a captured native Codex thread
  bash agent-data.sh export-rollout ID Export a unified session as Codex JSONL
  bash agent-data.sh import-rollout FILE Import Codex JSONL into canonical sessions
  bash agent-data.sh codex ...  Record a Codex login session
  bash agent-data.sh task "..."  Run, verify, filter, and export in one step
  bash agent-data.sh demo       Run a local mock end-to-end request

Environment overrides:
  AGENT_DATA_UPSTREAM   Upstream URL (default: ChatGPT Codex login backend)
  AGENT_DATA_PORT       Proxy port (default: 8787)
  AGENT_DATA_HOST       Proxy host (default: 127.0.0.1)
  AGENT_DATA_DIR        Data directory (default: ./.agent-data)
  AGENT_DATA_AUTH_MODE  codex-login (default) or api-key
  AGENT_DATA_PROTOCOL_BRIDGE off (default) or responses-to-chat
  AGENT_DATA_RESET_DAEMON 1 (default), set 0 to skip stale socket cleanup
  AGENT_DATA_AUTO_VERIFY auto (default), 0 to skip, or a custom command below
  AGENT_DATA_VERIFY_COMMAND  Verification command, for example: npm test
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
  if test "${AGENT_DATA_RESET_DAEMON:-1}" != '0'; then
    node "$CLI" reset-daemon --force --codex-home "${CODEX_HOME:-$HOME/.codex}" >/dev/null 2>&1 || true
  fi
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
    --auto-export \
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

new_session_id() {
  node -e "process.stdout.write(require('node:crypto').randomUUID())"
}

postprocess_session() {
  local session_id=$1
  local verify_status=0
  local auto_verify=${AGENT_DATA_AUTO_VERIFY:-auto}
  local -a verify_command=()

  if test -n "${AGENT_DATA_VERIFY_COMMAND:-}"; then
    read -r -a verify_command <<<"$AGENT_DATA_VERIFY_COMMAND"
  elif test "$auto_verify" != '0'; then
    if test -f package.json && node -e "const p=require('./package.json'); process.exit(p.scripts && p.scripts.test ? 0 : 1)" >/dev/null 2>&1; then
      verify_command=(npm test)
    elif { test -f pyproject.toml || test -f pytest.ini || test -f setup.cfg; } && command -v pytest >/dev/null 2>&1; then
      verify_command=(pytest -q)
    elif test -f Cargo.toml && command -v cargo >/dev/null 2>&1; then
      verify_command=(cargo test)
    elif test -f go.mod && command -v go >/dev/null 2>&1; then
      verify_command=(go test ./...)
    fi
  fi

  if test "${#verify_command[@]}" -gt 0; then
    printf '%s\n' "自动验证: ${verify_command[*]}"
    if node "$CLI" verify --data-dir "$DATA_DIR" --session "$session_id" -- "${verify_command[@]}"; then
      :
    else
      verify_status=$?
    fi
  fi

  node "$CLI" filter --data-dir "$DATA_DIR" >/dev/null 2>&1 || true
  if test -f "$DATA_DIR/sessions/$session_id.json"; then
    node "$CLI" export sft --data-dir "$DATA_DIR" --session "$session_id" >/dev/null 2>&1 || true
    node "$CLI" export rl --data-dir "$DATA_DIR" --session "$session_id" >/dev/null 2>&1 || true
    printf '%s\n' "已生成 SFT/RL 数据: $DATA_DIR/datasets"
  else
    printf '%s\n' "未发现可导出的 Session 文件: $session_id" >&2
  fi
  return "$verify_status"
}

run_codex() {
  command -v codex >/dev/null 2>&1 || { printf '%s\n' 'codex command was not found.' >&2; exit 1; }
  local session_id status=0
  session_id=$(new_session_id)
  if node "$CLI" run \
    --upstream "$UPSTREAM" \
    --host "$HOST" \
    --port 0 \
    --data-dir "$DATA_DIR" \
    --auth-mode "${AGENT_DATA_AUTH_MODE:-codex-login}" \
    --protocol-bridge "${AGENT_DATA_PROTOCOL_BRIDGE:-off}" \
    --session-id "$session_id" \
    -- codex "$@"
  then
    status=0
  else
    status=$?
  fi
  local post_status=0
  if postprocess_session "$session_id"; then
    :
  else
    post_status=$?
  fi
  if test "$status" -eq 0 && test "$post_status" -ne 0; then
    status=$post_status
  fi
  return "$status"
}

run_task() {
  test "$#" -gt 0 || { printf '%s\n' 'task requires a prompt.' >&2; return 2; }
  run_codex exec "$*"
}

run_ui() {
  node "$CLI" start \
    --upstream "$UPSTREAM" \
    --host "$HOST" \
    --port "$PORT" \
    --data-dir "$DATA_DIR"
}

setup_codex() {
  local codex_home=${CODEX_HOME:-"$HOME/.codex"}
  local config="$codex_home/config.toml"
  local backup=''
  mkdir -p "$codex_home"
  if test -f "$config"; then
    backup="$config.agent-data.bak.$(date +%Y%m%d%H%M%S)"
    cp "$config" "$backup"
  fi
  node "$ROOT_DIR/scripts/setup-codex.js" "$config"
  if command -v codex >/dev/null 2>&1; then
    if codex --version >/dev/null 2>&1; then
      printf '%s\n' 'Codex configuration is valid.'
    else
      printf '%s\n' 'Codex configuration was written; run codex doctor if it reports a config error.' >&2
    fi
  fi
  printf '%s\n' "Codex now uses http://127.0.0.1:8787/v1 when the proxy is running."
  test -z "$backup" || printf '%s\n' "Backup: $backup"
}

reset_daemon() {
  node "$CLI" reset-daemon --force --codex-home "${CODEX_HOME:-$HOME/.codex}" "$@"
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
  ui) run_ui ;;
  setup-codex) setup_codex ;;
  reset-daemon) reset_daemon "$@" ;;
  sync) node "$CLI" codex-sync --data-dir "$DATA_DIR" "$@" ;;
  resume) node "$CLI" resume --data-dir "$DATA_DIR" "$@" ;;
  export-rollout) node "$CLI" export-rollout --data-dir "$DATA_DIR" "$@" ;;
  import-rollout) node "$CLI" import-rollout --data-dir "$DATA_DIR" "$@" ;;
  codex) run_codex "$@" ;;
  task) run_task "$@" ;;
  demo) run_demo ;;
  help|--help|-h) usage ;;
  *) usage; exit 2 ;;
esac
