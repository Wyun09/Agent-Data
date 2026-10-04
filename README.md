# Agent Session Data Factory

Agent Session Data Factory v0.2.0 is a local-first recorder and transparent
HTTP/SSE proxy for agent sessions. It forwards requests to an upstream API,
records sanitized raw protocol events as append-only JSONL, and creates a
provider-independent canonical session that can be reprocessed later.

The v0.2 release adds a session launcher, Codex `login` authentication,
environment capture, verification rewards, deterministic filtering, and SFT/RL
JSONL exporters while preserving the raw replay source.

## Requirements

- Node.js 20 or newer
- An OpenAI Responses-compatible upstream

Install from the project directory:

```bash
npm install
npm test
```

## Start the proxy

最简单的方式是使用项目根目录的 `agent-data.sh`：

```bash
bash agent-data.sh start
bash agent-data.sh status
bash agent-data.sh logs
bash agent-data.sh stop
```

`start` 会在后台启动代理，并自动把每个会话写成
`.agent-data/datasets/auto/` 下的 SFT/RL 数据。要查看实时计数器，可以使用：

```bash
bash agent-data.sh ui
```

完成一次 Codex Provider 配置后，日常流程只有两步。先在一个终端启动代理：

```bash
bash agent-data.sh start
```

再开一个终端直接运行 Codex：

```bash
codex
```

所有经过 `http://127.0.0.1:8787/v1` 的对话都会自动记录、脱敏、归档并生成训练数据。
如果只想一条命令完成一次 Codex 任务，也可以使用：

```bash
bash agent-data.sh task "Fix the failing test"
```

首次验证可以运行：

```bash
bash agent-data.sh demo
```

也可以通过 `AGENT_DATA_UPSTREAM`、`AGENT_DATA_PORT`、`AGENT_DATA_DIR`
覆盖默认值。`bash agent-data.sh codex ...` 默认复用 `codex login` 的账号会话，
不会要求 `OPENAI_API_KEY`。只有显式使用 `--auth-mode api-key` 时才读取 API key。

```bash
node packages/cli/bin/agent-data.js proxy \
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

## Capture a project run

`run` 会把一次 Agent 运行中的多个请求串到同一个 session，并保存最小环境
元数据。源码和完整 Git diff 不会自动写入数据目录。

```bash
node packages/cli/bin/agent-data.js run --data-dir .agent-data -- codex exec "Fix the failing test"
node packages/cli/bin/agent-data.js verify --data-dir .agent-data --session <session-id> -- npm test
node packages/cli/bin/agent-data.js filter --data-dir .agent-data
node packages/cli/bin/agent-data.js export sft --data-dir .agent-data
node packages/cli/bin/agent-data.js export rl --data-dir .agent-data
```

参考两个训练项目后形成的设计取舍见
[docs/upgrade-v0.2.md](docs/upgrade-v0.2.md)。

## Inspect and reprocess

```bash
node packages/cli/bin/agent-data.js sessions
node packages/cli/bin/agent-data.js show <session-id>
node packages/cli/bin/agent-data.js reprocess --all
node packages/cli/bin/agent-data.js doctor
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
node packages/cli/bin/agent-data.js proxy --upstream https://api.openai.com/v1 --privacy-mode strict
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
packages/environment      Git, runtime, and agent environment capture
packages/verification     reproducible command verification records
packages/rewards         deterministic reward signal aggregation
packages/filters         quality filtering and trajectory deduplication
packages/exporters       SFT/RL JSONL exporters with manifests
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
