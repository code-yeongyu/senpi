# changes.md - sqlite-node

## 2026-09-12 - Adopt upstream's simplified SQLite session repository

### What changed

- `packages/session-backends/sqlite-node/src/sqlite/repo.ts` and `src/sqlite/index.ts`: taken from upstream (`Q-A=upstream-sqlite`), along with upstream's test organization and `session/` storage modules.
- Dropped the fork-only `src/sqlite/storage/lanes.ts`, `src/sqlite/storage/records.ts`, `src/sqlite/storage/facts.ts`, and `src/sqlite/storage/writer-leases.ts` (lane-scoped operation records, global facts, fenced writer leases) together with `src/sqlite/branch-cache.ts`, `src/sqlite/search-backend.ts`, and their tests (`test/branch-cache.test.ts`, `test/facts-query.test.ts`, `test/search.test.ts`). Upstream's schema (`sessions`, `entries`, scalar and list values, `usage_ledger`, `branch_entries`, `branch_meta`) has no home for them.
- The rich `SqliteSessionRepository` API in `src/sqlite/repo.ts` and `src/sqlite/index.ts` is replaced by upstream's `SqliteSessionRepo`.
- The fork's 2026-09-05 delta (decode durable GPT-6 Astra `configuration_update` entries with reasoning-effort validation in `src/sqlite/repo.ts`, plus its `test/repository.test.ts` round-trip case) is dropped on purpose: upstream's `Entry` union no longer has a `configuration_update` member, and the shipped CLI JSONL session path keeps its own Astra configuration handling in `packages/coding-agent`. The 2026-09-05 block below stays as history.

### Why

- Upstream rewrote the backend around its runtime/drive harness generation; carrying the fork's richer schema forward would mean re-implementing the whole repository against contracts the harness no longer exposes. The package is private and nothing in the shipped `senpi` CLI imports it.

### Why an extension could not handle it

- Session storage backends are wired below the extension layer; an extension cannot change the durable schema or replace `SessionRepo`.

### Expected merge conflict zones

- `src/sqlite/repo.ts`, `src/sqlite/index.ts`, `src/sqlite/migrations/001_initial.sql`, and every file under `src/sqlite/storage/` (fork) versus `src/sqlite/session/` (upstream) on the next sync. Expect deletions on the fork side, not edits.

## 2026-09-10 - Use native TypeScript builds for omob performance

### What changed

- packages/session-backends/sqlite-node/package.json: build uses tsgo for the emitted workspace build.

### Why

- The native compiler reduces omob build time without changing runtime JavaScript.

### Why this lives in the fork

- The package build manifest owns the compiler used by the fork's release pipeline.

### Expected merge conflict zones

- The `build` script in packages/session-backends/sqlite-node/package.json.

## 2026-09-05 - Decode Astra configuration-update session entries

### What changed

- packages/session-backends/sqlite-node/src/sqlite/repo.ts: decode durable GPT-6 Astra configuration_update entries with reasoning-effort validation.

### Why

- SQLite resume must preserve the durable configuration transition used by the Responses cache contract.

### Why this lives in the fork

- The backend owns durable entry decoding before the session layer can replay it.

### Expected merge conflict zones

- SQLite entry decoding and session schema compatibility.

