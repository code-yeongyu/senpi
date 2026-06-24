# PR-010 Residual Risks

- Live websocket/stdio/unix reconnect against a real Codex app-server is still covered at the deterministic unit and harness-smoke layer in this PR. Full multi-transport final compatibility evidence remains PR-013.
- Exact lost-delta replay is intentionally not claimed. Resume returns authoritative snapshot plus new stream unless app-server can reconstruct or replay a specific event.
- PR-011 still owns realtime/filesystem/plugin/config surfaces.
- PR-012 still owns redaction QA harness work.
- `BLOCKED:missing-gh-project-scope` remains for GitHub Project tracking.
