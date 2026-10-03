#!/usr/bin/env bash
set -euo pipefail

if ! command -v codex >/dev/null 2>&1; then
  echo "codex CLI is not installed; skipping real Codex E2E" >&2
  exit 2
fi

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
e2e_dir=$(mktemp -d "${TMPDIR:-/tmp}/agent-data-codex-e2e.XXXXXX")
upstream_port=$(node -e "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
proxy_port=$(node -e "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
mock_pid=''
proxy_pid=''
cleanup() {
  test -z "$proxy_pid" || kill "$proxy_pid" 2>/dev/null || true
  test -z "$mock_pid" || kill "$mock_pid" 2>/dev/null || true
  test -z "$proxy_pid" || wait "$proxy_pid" 2>/dev/null || true
  test -z "$mock_pid" || wait "$mock_pid" 2>/dev/null || true
  rm -rf "$e2e_dir"
}
trap cleanup EXIT

node "$project_root/packages/cli/bin/agent-data.js" mock-upstream --port "$upstream_port" >"$e2e_dir/mock.log" 2>&1 & mock_pid=$!
node "$project_root/packages/cli/bin/agent-data.js" proxy \
  --upstream "http://127.0.0.1:${upstream_port}/v1" \
  --port "$proxy_port" \
  --data-dir "$e2e_dir/data" >"$e2e_dir/proxy.log" 2>&1 & proxy_pid=$!
sleep 0.5

E2E_FAKE_KEY=fixture-key codex exec \
  --ignore-user-config --skip-git-repo-check --ephemeral --json --sandbox read-only \
  -m gpt-5.6 \
  -c 'model_provider="proxy"' \
  -c 'model_providers.proxy.name="Agent Data Fixture"' \
  -c "model_providers.proxy.base_url=\"http://127.0.0.1:${proxy_port}/v1\"" \
  -c 'model_providers.proxy.env_key="E2E_FAKE_KEY"' \
  -c 'model_providers.proxy.wire_api="responses"' \
  "Say hello" >"$e2e_dir/codex.jsonl"

session_count=$(find "$e2e_dir/data/sessions" -name '*.json' | wc -l | tr -d ' ')
test "$session_count" -ge 1
grep -q 'mock stream' "$e2e_dir/codex.jsonl"
echo "Codex E2E passed with $session_count recorded session(s)."
