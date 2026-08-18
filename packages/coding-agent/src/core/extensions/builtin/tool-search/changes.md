# Tool Search Builtin Changes

## 2026-08-11 - Defer local tool registration until the catalog is searchable

### What changed

- Deferred the first `tool_search` registration until the shared catalog contains at least one searchable MCP or extension document; sessions whose catalog stays empty never register or activate it.
- Kept the catalog lifecycle responsible for activating `tool_search` while documents exist and removing it from the active set when the catalog becomes empty. A definition registered earlier in the session remains registered but inactive because the extension API has no unregister operation.
- Added coverage for the empty-to-searchable-to-empty lifecycle and retained `noTools: "all"` as a hard empty registry and active set.

### Why

- Registering `tool_search` unconditionally made it appear in no-builtin tool listings even when there was nothing it could search.
- Deferred first registration preserves legitimate search-mode behavior while giving sessions that never gain a searchable catalog zero resident, registry, and prompt cost; active-set removal preserves zero prompt cost after a populated catalog empties.

### Expected merge conflict zones

- MEDIUM: `index.ts` owns builtin registration timing.
- LOW: `service.ts` owns catalog-driven registration and activation lifecycle.

## 2026-08-11 - Anthropic native deferral for searchable extension tools

### What changed

- Added a generalized Anthropic Messages native tool-search adapter under the shared tool-search builtin.
- Inactive searchable definitions are injected from the live catalog with their registered JSON Schema and `defer_loading: true`; injected tools never receive `cache_control`.
- MCP documents remain additionally gated by MCP's resolved `nativeToolSearch` setting, while extension documents require no user setting.
- Active extension tools, the local `tool_search` tool, gated tools absent from the catalog, and malformed definitions without parameters remain untouched.
- Anthropic 400 responses disable native injection for the remainder of the session and preserve local `tool_search` fallback.

### Why

- Search-exposed extension tools are intentionally absent from ordinary request tool arrays, so native deferral must supply their schemas without promoting them first.
- Catalog membership replaces MCP name-prefix heuristics and keeps eligibility tied to the same lazy-activation contract as local search.

### Expected merge conflict zones

- MEDIUM: `index.ts` provider-request lifecycle wiring.
- LOW: `native-search.ts` Anthropic payload hard rules.

## 2026-08-11 - Dormant shared catalog, promotion, and rehydration service

### What changed

- Added a session-scoped generalized catalog service that accepts MCP feeder documents and computes extension documents live from normalized `getAllTools()` metadata.
- Added additive extension promotion, eval/code-mode lazy activation, and ownership-aware v2 marker replay once per catalog generation.
- Authored the shared `tool_search` definition with generalized source/group filters and legacy `server` argument mapping.
- Registered the builtin lifecycle wiring without registering the shared tool definition; MCP retains its existing registration until the atomic feeder swap.

### Why

- Extension search exposure needs the shared engine loaded before MCP is rewired, while duplicate builtin tool registrations would make winner precedence unsafe during the transition.
- Catalog-owned activation keeps gated tools absent and routes every match through its source hook so MCP stub swapping can be preserved in the next increment.

### Expected merge conflict zones

- MEDIUM: `index.ts` will register the authored tool when MCP drops its legacy registration.
- MEDIUM: `service.ts` feeder and rehydration paths will gain MCP ownership in the same swap.

## 2026-08-11 - Ownership-aware activation-marker foundation

### What changed

- Added v2 `[tool_search:activated:v2]` markers carrying each promoted tool's name and host-derived registration identity.
- Added parsing for both v2 markers and legacy MCP name-only markers, with rehydration restoring v2 entries only when ownership still matches and limiting legacy restoration to MCP documents.
- Excluded missing, owner-changed, and lazy-activation-gated documents while returning deduplicated, stable-sorted names.

### Why

- Extension tool names are not sufficient ownership proof across reloads, so persisted promotion must bind a name to the registration that originally supplied it.
- Legacy MCP history remains compatible without allowing name-only markers to activate an unrelated extension tool.

### Expected merge conflict zones

- LOW: `engine/marker.ts` marker parsing, registration identity derivation, and rehydration rules.

## 2026-08-11 - Generalized tool-search document and BM25 foundation

### What changed

- Added the shared `ToolSearchDocument` model for MCP and extension sources, including group, aliases, keywords, owner label, and registration identity.
- Generalized the MCP BM25 engine to rank shared documents with weighted names, labels, aliases, keywords, groups, descriptions, and supplemental search text.
- Added source/group filtering, normalized exact-match handling, and deterministic canonical-name tie breaking.

### Why

- MCP and extension tools need one source-neutral search representation and ranking engine before they can feed a shared catalog.
- Keeping source as a filter rather than a ranking signal preserves deterministic relevance across catalog owners.

### Expected merge conflict zones

- LOW: `engine/document.ts` shared document fields.
- LOW: `engine/bm25.ts` field weighting, exact-match handling, filtering, and ordering.
