# Agent Session Data Factory

Agent Session Data Factory v0.1.0 is a local-first recorder and transparent
HTTP/SSE proxy for agent sessions. It forwards requests to an upstream API,
records sanitized raw protocol events as append-only JSONL, and creates a
provider-independent canonical session that can be reprocessed later.

The v0.1 release focuses on the OpenAI Responses API. Anthropic support,
launchers, verification rewards, dataset exporters, and SQLite are reserved
for later milestones.

## Requirements

- Node.js 20 or newer
- An OpenAI Responses-compatible upstream

Install from the project directory:

```bash
npm install
npm test
```

## Start the proxy

```bash
npx agent-data proxy \
  --upstream https://api.openai.com/v1 \
  --port 8787
```

The proxy binds to `127.0.0.1` unless `--host` is explicitly supplied. Data is
stored in `~/.agent-data` by default. Set `--data-dir` or `AGENT_DATA_HOME` to
choose another local directory.

Raw records are stored under:

```text
~/.agent-data/raw/YYYY-MM-DD/<session-id>.jsonl
~/.agent-data/sessions/<session-id>.json
```

Every request receives an `x-agent-data-session-id` response header. An agent or
launcher can send the same request header to correlate multiple requests:

```text
x-agent-data-session-id: 6b4c2f80-...
```

## Codex

See [integrations/codex/README.md](integrations/codex/README.md) for a
configuration that points Codex at the local proxy without changing Codex
source code.

## Inspect and reprocess

```bash
npx agent-data sessions
npx agent-data show <session-id>
npx agent-data reprocess --all
npx agent-data doctor
```

Raw JSONL is the recovery source. Reprocessing reads the sanitized provider
events and regenerates the canonical session file, so a normalizer fix does not
require collecting the session again.

## Privacy

`safe` mode is the default. `strict` additionally removes home-directory paths
and email addresses. `off` disables optional redaction but still removes
authentication material before disk writes. `Authorization`, bearer values,
cookies, API keys, JWTs, private keys, and common cloud credentials are never
written to disk.

```bash
npx agent-data proxy --upstream https://api.openai.com --privacy-mode strict
```

The proxy forwards headers to the upstream as needed for authentication; only
the on-disk representation is sanitized.

## Development

The workspace keeps provider logic outside the generic proxy:

```text
packages/core             canonical schema and event application
packages/storage          JSONL and local file storage
packages/recorder         raw-to-canonical replay
packages/proxy            HTTP forwarding and SSE passthrough
packages/protocol-openai  Responses request/SSE adapter
packages/redaction        disk-boundary secret redaction
packages/cli              agent-data command line interface
```

Run the checks with:

```bash
npm run check
```

When the Codex CLI is installed, the local mock-upstream E2E can be run without
contacting a model provider:

```bash
npm run e2e:codex
```

The repository includes OpenAI Responses fixtures for text streaming, tool
calls, unknown future events, malformed JSON, and a mock-upstream proxy test.
