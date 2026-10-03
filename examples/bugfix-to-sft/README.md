# Bugfix to session (v0.1 foundation)

This example documents the v0.1 recording path. Dataset exporters arrive in a
later milestone; the generated canonical session is the input for that work.

```bash
npx agent-data proxy --upstream http://127.0.0.1:9876 --port 8787
# point Codex at http://127.0.0.1:8787 and perform the bug fix
npx agent-data sessions
npx agent-data show <session-id>
npx agent-data reprocess --session <session-id>
```
