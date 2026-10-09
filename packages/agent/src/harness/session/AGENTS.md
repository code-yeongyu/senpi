# src/harness/session

Durable session storage: append-only entries (message, compaction, branch-summary, custom), a usage ledger, keyed values and lists (lane config/state, operation meta/state/result, pending outputs), and the `Session` tree that projects them. Ships JSONL and in-memory backends; the SQLite backend lives in `packages/session-backends/sqlite-node`.

Earned its own file: distinct domain from harness orchestration (`index.ts` boundary, wide type surface, `SessionRepo`/`Storage`/`Entry` consumed across sqlite-node).

## WHERE TO LOOK

| Task | File |
|---|---|
| Durable contract: `Entry` union, `OperationState`, `Write`, `Storage`, `SessionRepo` | `types.ts` |
| Value/list addresses and write constructors | `values.ts` (`value`, `list`, `setValue`, `appendList`, `laneState`, `operationState`) |
| Tree semantics: branching, queries, stats, mutation errors | `session.ts` (`StorageBackedSession`, `SessionInvariantError`, `SessionUnknownTargetError`) |
| Committing writes: sequence assignment, validation | `commit.ts` (`prepareStorageCommit`, `commitWrite`, `validateCommittedWrites`) |
| Fork snapshots and current-state policy | `fork.ts` (`createForkSnapshot`), `fork-policy.ts` (`projectForkCurrentStateWrite`) |
| JSONL backend: storage, repo, atomic publish, legacy v3 upgrade, fork | `jsonl/` (`storage.ts` `JsonlStorage`, `repo.ts` `JsonlSessionRepo`, `io.ts` `publishJsonl`, `codec.ts`, `legacy-v3.ts`, `fork.ts` `runJsonlFork`, `types.ts` `JSONL_FORMAT_VERSION`) |
| In-memory backend | `memory.ts` (`MemoryStorage`, `MemorySessionRepo`), `in-memory-storage-state.ts` (`InMemoryStorageState`) |
| Session context projection to model messages | `context.ts` (`buildSessionContext`) |
| Backend conformance and benchmark suites | `testing/` (`conformance/storage.ts` `createStorageConformance`, `conformance/session-repo.ts` `createSessionRepoConformance`, `benchmark/`; published as `@earendil-works/pi-agent-core/harness/session/testing`) |
| Test storage decorators | `testing/gating-storage.ts` (`GatingStorage`), `testing/instrumented-storage.ts` (`InstrumentedStorage`) |

## CONVENTIONS

- IDs come from an injectable `IdGenerator` (`types.ts`); `MemorySessionRepo` defaults to `uuidv7` from pi-ai.
- Entries and usage rows are append-only with strictly increasing sequence numbers assigned in `commit.ts`; values and lists are keyed by the addresses in `values.ts`. Lane and operation state are derived projections stored as values, never a second source of truth.
- JSONL publication (`jsonl/io.ts`) stages a complete sibling `.tmp` file and atomically renames it over the destination; callers must serialize publications per destination (shared deterministic temp path). Torn tails are trimmed to the last complete line on load (`jsonl/storage.ts`).
- Legacy v3 JSONL headers are recognised in `jsonl/codec.ts` and upgraded through `jsonl/legacy-v3.ts` (`LegacyV3Source`) rather than parsed ad hoc.
- Session misuse throws the typed errors in `session.ts` (`SessionInvalidBranchError`, `SessionBranchExistsError`, `SessionPendingAssistantMessageError`); storage failures stay inside `Result` values.
- New backends must pass `createStorageConformance` and `createSessionRepoConformance`; memory, JSONL, and SQLite all run the same cases.

## ANTI-PATTERNS

- Mutating entries or usage rows in place instead of appending.
- Weakening `never`-typed union members in `types.ts`.
- Writing lane or operation state outside the `values.ts` addresses, or inventing new value namespaces without updating `docs/harness.md`.
- Swallowing decode failures; malformed JSONL headers and transactions must surface through `Result` errors from `jsonl/codec.ts` and `jsonl/io.ts`, not be skipped silently.
