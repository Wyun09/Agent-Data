# Codex integration

The proxy does not modify Codex. Start it as a local OpenAI Responses
compatible endpoint and point Codex's provider/base URL at that endpoint using
the configuration mechanism supported by the installed Codex version.

```bash
node packages/cli/bin/agent-data.js proxy \
  --upstream https://chatgpt.com/backend-api/codex \
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

Codex's local `base_url` includes `/v1`. The default upstream for ChatGPT login
is `https://chatgpt.com/backend-api/codex`, matching the installed Codex client;
the proxy maps local `/v1/responses` to `/backend-api/codex/responses`. API-key
mode instead defaults to `https://api.openai.com/v1`. Keep an explicit relay
URL when using a third-party provider.

For a relay that only exposes Chat Completions, start the proxy with
`--protocol-bridge responses-to-chat` (or set
`AGENT_DATA_PROTOCOL_BRIDGE=responses-to-chat`). The proxy sends the translated
request to `/v1/chat/completions`, converts text/tool-call SSE events back to
Responses events, and keeps the original Responses request in the raw record.

The proxy forwards the authentication header to the upstream but replaces its
value before writing raw records. It never reads or copies Codex's credential
file. Do not put a key in a command line that is shared in shell history.

`GET /v1/models` is forwarded directly without creating a recorded session.
The original authorization, status code, body, and request ID are preserved.
A forwarded 401/403 with `Missing scopes` still indicates an upstream credential
or endpoint mismatch; transparent forwarding cannot grant missing scopes.
ChatGPT subscription access and API-key access are distinct authentication
methods ([official authentication guide](https://learn.chatgpt.com/docs/auth)).

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

For one-time setup, run `bash agent-data.sh setup-codex`; it backs up the
existing `~/.codex/config.toml` and points the default Codex provider at the
local proxy while preserving the current `codex login` session. For the
automatic background flow, run `bash agent-data.sh start` in one
terminal, then open another terminal and run `codex`. The proxy groups requests
without an explicit session header, continuously writes sanitized raw records,
and refreshes aggregate SFT/RL files under `.agent-data/datasets/auto/`.
Use `bash agent-data.sh ui` when you want a live counter dashboard. For a
single captured task, `bash agent-data.sh task "Fix the failing test"` runs the
Codex command and post-processes its session automatically.
