# Codex integration

The proxy does not modify Codex. Start it as a local OpenAI Responses
compatible endpoint and point Codex's provider/base URL at that endpoint using
the configuration mechanism supported by the installed Codex version.

```bash
node packages/cli/bin/agent-data.js proxy \
  --upstream https://api.openai.com/v1 \
  --port 8787 \
  --data-dir ~/.agent-data
```

Then define a custom Codex provider in `~/.codex/config.toml` (or a profile):

```toml
model = "gpt-6.1-sol"
model_provider = "agent_data_proxy"

[model_providers.agent_data_proxy]
name = "OpenAI through Agent Data Factory"
base_url = "http://127.0.0.1:8787/v1"
requires_openai_auth = true
wire_api = "responses"
supports_websockets = false
```

`requires_openai_auth = true` 让 Codex 使用当前 `codex login` 的账号认证。
这里不需要复制 `~/.codex/auth.json`，也不需要设置 `OPENAI_API_KEY`。如果你确实
要使用 API key，改成 `env_key = "OPENAI_API_KEY"`，并通过
`--auth-mode api-key` 启动 launcher。

The provider fields follow the Codex custom model provider configuration. The
proxy's `--upstream` path and Codex's `base_url` should both include `/v1` when
the upstream is an OpenAI-compatible HTTP API.

The proxy forwards the authentication header to the upstream but replaces its
value before writing raw records. It never reads or copies Codex's credential
file. Do not put a key in a command line that is shared in shell history.

A quick connectivity check can use the included mock upstream:

```bash
# terminal 1
node packages/cli/bin/agent-data.js mock-upstream --port 9876

# terminal 2
node packages/cli/bin/agent-data.js proxy --upstream http://127.0.0.1:9876/v1 --port 8787
```

Send an OpenAI Responses request to `http://127.0.0.1:8787/v1/responses` and
check `~/.agent-data/sessions`. This exercises the same streaming path without
contacting a model provider.

Codex version compatibility is tracked in [compatibility.json](compatibility.json).
The v0.1 fixture suite has been validated against the Responses event shapes
used by Codex CLI 0.160.x; a live model call requires the user's own provider
credentials and network policy.

For the automatic background flow, run `bash agent-data.sh start` in one
terminal, then open another terminal and run `codex`. The proxy groups requests
without an explicit session header, continuously writes sanitized raw records,
and refreshes aggregate SFT/RL files under `.agent-data/datasets/auto/`.
Use `bash agent-data.sh ui` when you want a live counter dashboard. For a
single captured task, `bash agent-data.sh task "Fix the failing test"` runs the
Codex command and post-processes its session automatically.
