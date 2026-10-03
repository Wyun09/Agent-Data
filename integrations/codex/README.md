# Codex integration

The proxy does not modify Codex. Start it as a local OpenAI Responses
compatible endpoint and point Codex's provider/base URL at that endpoint using
the configuration mechanism supported by the installed Codex version.

```bash
npx agent-data proxy \
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
env_key = "OPENAI_API_KEY"
wire_api = "responses"
supports_websockets = false
```

The provider fields follow the Codex custom model provider configuration. The
proxy's `--upstream` path and Codex's `base_url` should both include `/v1` when
the upstream is an OpenAI-compatible HTTP API.

Keep the existing Codex API key in Codex's own credential configuration. The
proxy forwards the authentication header to the upstream but replaces its
value before writing raw records. Do not put a key in a command line that is
shared in shell history.

A quick connectivity check can use the included mock upstream:

```bash
# terminal 1
npx agent-data mock-upstream --port 9876

# terminal 2
npx agent-data proxy --upstream http://127.0.0.1:9876/v1 --port 8787
```

Send an OpenAI Responses request to `http://127.0.0.1:8787/v1/responses` and
check `~/.agent-data/sessions`. This exercises the same streaming path without
contacting a model provider.

Codex version compatibility is tracked in [compatibility.json](compatibility.json).
The v0.1 fixture suite has been validated against the Responses event shapes
used by Codex CLI 0.160.x; a live model call requires the user's own provider
credentials and network policy.
