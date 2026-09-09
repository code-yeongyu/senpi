# changes.md - sqlite-node

## 2026-09-05 - Decode Astra configuration-update session entries

### What changed

- packages/session-backends/sqlite-node/src/sqlite/repo.ts: decode durable GPT-6 Astra configuration_update entries with reasoning-effort validation.

### Why

- SQLite resume must preserve the durable configuration transition used by the Responses cache contract.

### Why this lives in the fork

- The backend owns durable entry decoding before the session layer can replay it.

### Expected merge conflict zones

- SQLite entry decoding and session schema compatibility.

