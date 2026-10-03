# Privacy boundary

Forwarding and recording use separate representations. Authentication headers
are passed to the configured upstream when present, then redacted by the
recorder before JSONL append. The same redaction pass handles request bodies,
response event data, and error messages.

`safe` removes credentials and common secrets. `strict` also replaces home
paths and email addresses. `off` only disables optional transformations; it
cannot disable credential removal.
