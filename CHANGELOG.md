# Changelog

## 0.3.0 - 2026-10-04

- Preserved Codex login Authorization headers and made `GET /v1/models` a transparent daemon probe.
- Added ChatGPT Codex login endpoint defaults and an optional Responses-to-Chat Completions bridge.
- Added stale daemon socket reset, native rollout/index projection, and resume-safe guards.
- Added the unified `session_schema.json`, Codex rollout import/export, non-blocking safety labels, and automatic verification labels/rewards.
- Expanded the regression suite to 36 tests and validated the local Codex E2E.

## 0.2.0 - 2026-10-04

- Added a login-aware `agent-data run` launcher that reuses Codex `codex login` sessions.
- Added an automatic proxy dashboard and continuous aggregate SFT/RL export for ordinary Codex sessions.
- Added environment capture, verification records, deterministic rewards, quality filters, and SFT/RL JSONL exports.
- Added shared-session correlation, request turn ids, backpressure-aware capture, compressed-response decoding, and capture limits.
- Added v0.2 regression tests and a complete local upgrade guide.

## 0.1.0 - 2026-10-03

- Added the canonical session schema v1 and event model.
- Added append-only, buffered JSONL raw event recording.
- Added a local transparent HTTP/SSE proxy with OpenAI Responses normalization.
- Added mandatory credential redaction for data written to disk.
- Added fixture replay, mock upstream, and proxy integration tests.
- Added Codex configuration documentation.
