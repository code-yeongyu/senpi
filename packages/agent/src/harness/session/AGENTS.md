# src/harness/session

Durable session storage: append-only entries (message, model/thinking/tools changes, configuration updates, compaction, branch-summary, custom), lane operation records, and the `Session` tree that projects them. Ships JSONL and in-memory backends; the SQLite backend lives in `packages/session-backends/sqlite-node`.

Earned its own file: distinct storage domain (score 8: `index.ts` boundary, code ratio, symbol/export density; cross-workspace centrality not credited).

## WHERE TO LOOK

| Task | File |
|---|---|
| Durable contract: `Entry`/`LaneRecord` unions, `SessionRepo`, error codes | `types.ts` |
| Tree semantics: branching, queries, stats, `assertJsonSerializable` | `session.ts` |
| Mutation log feeding state reduction | `state.ts` (`SessionState`) |
| JSONL backend: codec, atomic storage, repo, torn-tail repair | `jsonl/` (`codec.ts`, `storage.ts`, `repo.ts`, `errors.ts`) |
| In-memory backend | `memory.ts` (`InMemorySessionStorage`, `InMemorySessionRepo`) |
| Context transforms, custom projectors, durable configuration projection | `context.ts` (`buildSessionContext`, `buildContextEntries`) |
| Backend conformance suite | `testing/conformance.ts` (`createSessionBackendConformance`, published as `@earendil-works/pi-agent-core/session/testing`) |

## CONVENTIONS

- IDs come from an injectable `IdGenerator`, defaulting to `uuidv7` from pi-ai.
- Entries, records, and usage rows are append-only with strictly increasing sequence numbers; `SessionState` is the derived projection, never the source of truth.
- JSONL fork publication and torn-tail repair stage a complete sibling `.tmp` file and atomically rename it over the destination; callers serialize publications per destination. Ordinary mutations append before updating in-memory state. Only a syntax-invalid final line is discarded as a torn tail; schema errors and interior corruption fail.
- Query misuse throws `SessionError` (`invalid_query`, `invalid_payload`); `session.ts` validates limits and cursors up front.
- New backends must pass `createSessionBackendConformance`; memory, JSONL, and SQLite all run the same cases.
- `findOpenOperations(lane, { limit: 2 })` distinguishes idle, one suspended operation, and corrupt multiple-open state; preserve bounded recovery queries.
- `buildSessionContext` derives configuration from the full branch before compaction trimming and custom transforms. `configurationUpdate` is separate from `thinkingLevel`; custom entries require an explicit projector to become model messages.

## ANTI-PATTERNS

- Mutating entries, records, or usage rows in place instead of appending.
- Treating labels or the session name as branch-local: they are session-wide, latest-write-wins facts.
- Claiming writer leases from scanning code; use read-only helpers (`scanningEntries` in `src/search/`) or already-open storage.
- Swallowing decode failures; the codec returns `JsonlDecodeError`, while storage load wraps it in `SessionError("invalid_entry")` with the path and physical line number.
