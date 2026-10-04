# Architecture

```text
Agent
  │ HTTP / SSE
  ▼
Generic proxy ───────────────► Provider API
  │ immediate client writes
  ├─ RawEventRecorder (sanitized JSONL)
  └─ protocol-openai normalizer
             │
             ▼
       Canonical Session v1
```

The proxy does not parse provider semantics to decide how to forward traffic.
It copies the request stream to the upstream and copies response chunks to the
client as they arrive. The recorder is a queued side path with a bounded queue;
if disk I/O fails, the session is marked incomplete while forwarding continues.

Raw records are the recovery source. The canonical writer is atomic and can be
recreated with `agent-data reprocess`.

The canonical `sessions/<id>.json` file is the single semantic source. Raw
JSONL is an append-only recovery log; Codex's `session_index.jsonl` is a
projection produced only when a matching native rollout exists. The proxy
never treats the daemon index as authoritative and never writes an index row
for a data-factory-only session that Codex cannot resume.
