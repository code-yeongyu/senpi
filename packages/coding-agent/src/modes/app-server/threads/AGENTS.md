# modes/app-server/threads

## OVERVIEW
Thread-lifecycle and event-projection domain (score 9): session-backed registry, RPC handlers, turn execution, wire history, and content search.

## WHERE TO LOOK

| Task | File |
|---|---|
| Lifecycle entry and method wiring | `handlers.ts` |
| Session registry and listing | `registry.ts`, `registry-listing.ts` |
| Start parameters | `start-options.ts`, `handler-params.ts` |
| List/archive metadata | `list-handlers.ts`, `archive-state.ts`, `metadata-handlers.ts`, `metadata-state.ts` |
| Settings and goals | `settings-handlers.ts`, `goal-handlers.ts`, `goal-wire.ts` |
| Turn engine and runtime adaptation | `turns.ts`, `turn-runtime.ts`, `turn-terminal.ts` |
| In-memory turn history | `turn-log.ts` |
| Event projection coordinator | `projection.ts`, `projection-types.ts` |
| Wire items/messages/web search | `projection-wire-items.ts`, `projection-message-items.ts`, `projection-web-search.ts` |
| File-change and cumulative diff projection | `projection-file-changes.ts`, `projection-turn-diff.ts` |
| Persisted history and pagination | `history.ts`, `history-pagination.ts`, `wire-thread.ts` |
| Content search and occurrence pagination | `search.ts`, `search-cache.ts`, `search-occurrences.ts`, `search-params.ts` |
| MCP wire status | `mcp-wire-status.ts` |

## CONVENTIONS

- Handler clusters own method registration; parsing and wire construction remain separate from registry mutations.
- `EventProjector` translates engine events; the split projection modules share typed projection state rather than registering methods themselves.
- `createTurnEngine` composes runtime events, projection, and `TurnLog` instead of treating notifications as persisted history.
- `TurnLog` returns cloned turns/items; callers do not mutate its backing arrays directly.
- Completion status excludes `running`; duration is derived from parseable timestamps and otherwise remains null.
- Thread-content search and its cached occurrences are distinct from sibling `search/` fuzzy filename search.

## ANTI-PATTERNS

- Emitting raw engine events directly as wire items and bypassing the projector.
- Mutating a returned logged turn expecting to update the authoritative log.
- Treating filename-search ranking as the thread-content search/pagination contract.
- Adding another lifecycle dispatcher instead of extending the existing feature-specific handler cluster.
