# Protocol support

v0.1 supports the OpenAI Responses streaming shape. It handles text deltas,
reasoning deltas, function-call output items and argument deltas, usage,
completion, failure, malformed JSON, and unknown future event names. Unknown
events remain in raw JSONL and are represented canonically as `provider_event`.

Anthropic Messages support remains a separate adapter milestone and does not
belong in the OpenAI adapter or proxy core.

When `protocol-bridge=responses-to-chat` is enabled, the boundary adapter maps
Responses `input` and function tools to Chat Completions `messages/tools`,
then maps streamed text, tool-call deltas, usage, and completion status back to
Responses SSE events. The original request remains in the sanitized raw log.
