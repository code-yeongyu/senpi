# src/harness/session

Durable session storage: append-only entries (message, model/thinking/tools changes, compaction, branch-summary, custom), lane operation records, and the `Session` tree that projects them. Ships JSONL and in-memory backends; the SQLite backend lives in `packages/session-backends/sqlite-node`.

Earned its own file: distinct domain from harness orchestration (score 11: `index.ts` boundary, wide type surface, `SessionRepo`/`SessionError`/`Entry` consumed across sqlite-node).

## WHERE TO LOOK

| Task | File |
|---|---|
| Durable contract: `Entry`/`LaneRecord` unions, `SessionRepo`, error codes | `types.ts` |
| Tree semantics: branching, queries, stats, `assertJsonSerializable` | `session.ts` |
| Mutation log feeding state reduction | `state.ts` (`SessionState`) |
| JSONL backend: codec, atomic storage, repo, torn-tail repair | `jsonl/` (`codec.ts`, `storage.ts`, `repo.ts`, `errors.ts`) |
| In-memory backend | `memory.ts` (`InMemorySessionStorage`, `InMemorySessionRepo`) |
| Session context projection to model messages | `context.ts` |
| Backend conformance suite | `testing/conformance.ts` (`createSessionBackendConformance`, published as `@earendil-works/pi-agent-core/session/testing`) |

## CONVENTIONS

- IDs come from an injectable `IdGenerator`, defaulting to `uuidv7` from pi-ai.
- Entries, records, and usage rows are append-only with strictly increasing sequence numbers; `SessionState` is the derived projection, never the source of truth.
- JSONL publication stages a complete sibling `.tmp` file and atomically renames it over the destination; callers must serialize publications per destination (shared deterministic temp path). Torn tails are repaired from the valid prefix on load.
- Query misuse throws `SessionError` (`invalid_query`, `invalid_payload`); `session.ts` validates limits and cursors up front.
- New backends must pass `createSessionBackendConformance`; memory, JSONL, and SQLite all run the same cases.

## ANTI-PATTERNS

- Mutating entries, records, or usage rows in place instead of appending.
- Weakening `never`-typed union members in `types.ts`.
- Claiming writer leases from scanning code; use read-only helpers (`scanningEntries` in `src/search/`) or already-open storage.
- Swallowing decode failures; malformed JSONL surfaces as `JsonlDecodeError` with the item index.
