# Canonical schema v1

The machine-readable contract is [`session_schema.json`](../session_schema.json).

Each session contains `metadata`, `agent`, `provider`, `environment`,
`turns`, `verification`, `reward`, `labels`, `privacy`, and an ordered `events`
array. Events use UTC ISO-8601 timestamps and millisecond durations where a
duration is available.

The minimum event vocabulary includes request start/message/tool definition,
response start/text/reasoning/tool call/usage/end, tool results, errors, and
session boundaries. Provider events that are not known yet are retained as
`provider_event` with their provider event name and sanitized payload.

This lets a future adapter add semantics without discarding an event received
by an older proxy.

Codex interoperability is an index projection of this schema. `thread-id` or
`session-id` request headers identify the native thread; the projection keeps
only `id`, `thread_name`, and `updated_at` in Codex's append-only index. The
canonical session remains the source for rewards, labels, verification, and
training exports.
