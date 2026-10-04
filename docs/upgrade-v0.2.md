# v0.2 upgrade

本版本吸收了两个参考训练项目中适合会话数据基础设施的设计：

- DiffSynth-Studio 的模块边界、模型/协议适配隔离和可复现实验思路。
- ai-toolkit 的配置驱动任务、可恢复输出、训练前验证和清晰的运行目录。

我们把这些原则落在会话采集链路上，而不是把训练框架或 GPU 依赖引入本项目。

## 新链路

```text
Codex login session
  -> agent-data run
  -> transparent HTTP/SSE proxy
  -> immutable sanitized JSONL
  -> canonical session with turns
  -> verify commands and reward signals
  -> quality filter and deterministic dedup
  -> SFT/RL JSONL + manifest
```

## 新增能力

- `agent-data run -- codex ...` 为一次 Codex 运行创建固定 session id，并记录 cwd、Git HEAD、分支、脏状态、Agent 可执行文件和版本。
- Codex 默认使用 `requires_openai_auth=true`，复用 `codex login` 的登录态；不会读取、复制或要求 `OPENAI_API_KEY`。API key 仍可用 `--auth-mode api-key` 显式启用。
- 同一 session 的多次请求共享一个 JSONL 文件，每个请求有独立 `turn_id`，工具调用参数增量会合并。
- `agent-data verify --session <id> -- npm test` 保存退出码、耗时、输出尾部、环境和测试/构建分类。
- `agent-data filter` 做失败、错误、短轨迹和重复轨迹筛选；原始数据不会删除。
- `agent-data export sft` 和 `agent-data export rl` 生成带 manifest 的 JSONL，并在导出边界再次脱敏。
- 代理支持响应背压、gzip/deflate/br 解压后的事件记录、请求/响应大小上限和未支持编码的显式 incomplete 标记。

## 推荐流程

```bash
cd /storage/emulated/0/Agent
npm install
bash agent-data.sh setup-codex  # 只需执行一次
bash agent-data.sh start
# 另开一个终端，直接使用已经指向本地 Provider 的 Codex
codex
```

代理会自动记录所有请求，生成 `.agent-data/datasets/auto/` 下的 SFT/RL 文件。
需要实时查看请求计数时，在第一个终端使用 `bash agent-data.sh ui`；单次任务也可以
用 `bash agent-data.sh task "Fix the failing test"` 完成运行、验证和导出。

`PLAN.md` 仍是本地计划文件，不提交到 GitHub。训练项目目录只是被记录为运行环境的 Git 仓库信息，不会自动上传源码、完整 diff、环境变量或凭据。
