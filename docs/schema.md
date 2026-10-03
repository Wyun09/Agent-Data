# Canonical schema v1

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
