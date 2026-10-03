# Protocol support

v0.1 supports the OpenAI Responses streaming shape. It handles text deltas,
reasoning deltas, function-call output items and argument deltas, usage,
completion, failure, malformed JSON, and unknown future event names. Unknown
events remain in raw JSONL and are represented canonically as `provider_event`.

Anthropic Messages support is scheduled for v0.2 and does not belong in the
OpenAI adapter or proxy core.
