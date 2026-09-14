# Tool Search Builtin Changes

## 2026-09-14 - Side-effect-free tool_search with precision gating and hidden-tool hints (senpi #1682)

### What changed

- `tool.ts`: `tool_search` no longer activates anything. It returns up to 5 candidates as name, description and the one-line JSON parameter schema, and tells the model to call one by name; the existing lazy activator (`resolveUnknownToolCall` -> `_activateLazyTool`) promotes the tool on that first call, so the `tools` array changes only when a tool is genuinely used and the "callable from your NEXT turn" round trip is gone. `details` carries `matched` instead of `activated`; the TUI title reads "N tool(s) found". No activation marker is emitted any more.
- `engine/bm25.ts`: results carry `coverage` (share of the query's content terms present in the document, stopwords excluded); an optional `precision` gate keeps a hit only when coverage >= 0.5 AND its score >= 0.35 x the best non-exact score. Index and query terms pass through a minimal plural fold (`stemToken`: `messages` -> `message`, `libraries` -> `library`). Exact-name hits bypass the gate. The engine default stays lenient; `ToolSearchService.search()` turns the gate on.
- `service.ts`: `bindRemovedToolHints()` / `hiddenToolHints(query)` surface the host's `agent.removedToolHints` (eval-only `bash`/`powershell`/`workflow`/`monitor`, or any removed tool with a registered hint) when the query names one; `getToolParameters(name)` reads the schema of a registered inactive tool for the result text. `activate()` / `activateTool()` stay for programmatic and rehydration callers.
- `core/agent-session.ts`: `_bindToolSearchRemovedHints()` binds the hint provider at construction and again after `bindCore`, whichever creates the session-scoped service first. `_activateLazyTool()` now promotes a lazily-activatable tool itself when no catalog service claims it, so a search-exposed tool activates on a by-name call even in a session without the tool-search builtin (the exposure metadata owns the path, the catalog only enriches it).
- `builtin/imagegen/tool.ts`: `generate_image` is registered `exposure: "search"` with intent keywords; the bundled imagegen skill names the tool, so a by-name call activates it. The OpenAI native `image_generation` injector never depended on the client tool being resident.
- Tests: `test/tool-search/tool.test.ts` and `test/mcp/tool-search-promotion.test.ts` now pin the by-name contract (search leaves the payload untouched; the by-name call activates and runs in the same turn; the transcript carries no marker; legacy v1/v2 markers still rehydrate). New `test/tool-search/precision.test.ts` (gate, stemming, hidden hints, service default) and `test/suite/regressions/issue-1682-tool-search-side-effect-free.test.ts` (eval-only hint through a real session, `generate_image` deferred and by-name activated). `3592` regression drops `generate_image` from the default active list.

### Why

- In a 30-day sample of real sessions, 90 `tool_search` calls produced 0 intent hits: 80 auto-activated unrelated tools on an incidental term match (`search`, `messages`), and 10 answered "No tools matched" for eval-only `bash`/`monitor`. Each false activation changed the `tools` array and invalidated the provider prompt cache for the whole context (150-390K tokens at the time) on top of the wasted round trip.

### Why an extension could not handle it

- The search tool, the gate and the activation path are the builtin itself; the hint provider is session state (`agent.removedToolHints`) that only the host can expose.

### Expected merge conflict zones

- LOW: `tool.ts` result text and details shape; `engine/bm25.ts` search loop; the imagegen tool definition header; the three rewritten tests.

## 2026-09-08 - Wire the native 400 fallback into a session recovery signal (senpi #1481/#1482)

### What changed

- `service.ts`: `ToolSearchService` carries a one-shot pending flag (`noteNativeInjectionFailure` / `takeNativeInjectionFailure`) recording that a native-injected request was rejected.
- `index.ts`: the adapter's `onFallback` now records that reason on the service, so the session's retry branch can recover in place (senpi #1482) instead of falling back blindly.
- `test/tool-search/native-anthropic.test.ts`: a wiring case drives `emitBeforeProviderRequest` (with a supported Anthropic model and an MCP feed) and `after_provider_response` 400, asserting the flag is set once, consumed once, and injection stays off afterwards.

### Why

- `AnthropicNativeToolSearchAdapter` already disables itself permanently on a 400, but nothing told the session WHY the current turn failed; the flag is the provider-scope-scoped channel between the extension and the session's retry branch.

### Expected merge conflict zones

- LOW: the adapter construction site in `index.ts` and the service class; both are fork-owned.


## 2026-09-04 - Gate native tool-search on model support and fix the tool_reference field

### What changed

- New `native-support.ts` owns `supportsAnthropicNativeToolSearch()`. Injection now requires a model that
  actually carries tool search, not merely the `anthropic-messages` api: it honours an explicit
  `compat.supportsToolReferences`, otherwise mirrors pi-ai's private default (first-party `anthropic`
  provider, no Haiku, Opus/Sonnet/Fable 4.5+). A bare api string keeps the old api-only contract.
- `addAnthropicNativeToolSearch()` and `AnthropicNativeToolSearchAdapter.applyBeforeRequest()` take that
  target instead of an api string; `index.ts` passes `event.model ?? ctx.model`.
- `buildToolReferenceBlocks()` emits `{ type: "tool_reference", tool_name }`. It previously emitted `name`,
  which the API rejects as a malformed content block. `test/mcp/fixtures/native-search-mocks.ts` read the
  same wrong field, so its expander agreed with the bug.
- `test/suite/regressions/0000-anthropic-native-tool-search-contract.test.ts` pins the wire contract and the
  gate; each assertion was verified by mutating the production hunk and observing RED.

### Why

- Anthropic documents `tool_reference` blocks as carrying `tool_name`, and lists tool search as available
  only on Opus/Sonnet 4.5+, Fable/Mythos, and Haiku 4.5 (which rejects client-side `tool_reference`).
- Anthropic-compatible endpoints (gateways, proxies, kimi-coding) answer the same api and reject the server
  tool. Injecting there 400s the request, which permanently disables native search for that session — the
  same failure mode the 2026-09-04 name fix addressed, one layer up.

### Expected merge conflict zones

- LOW: `native-search.ts` signature block; new `native-support.ts` is additive.

## 2026-09-04 - Name the Anthropic native tool-search server tool per the API contract

### What changed

- `native-search.ts`: `ANTHROPIC_TOOL_SEARCH_NAME` is now `tool_search_tool_bm25`. The injected server tool is `{ type: "tool_search_tool_bm25_20251119", name: "tool_search_tool_bm25" }`; the type is unchanged and the local `tool_search` custom tool keeps its own name.
- `test/suite/regressions/0000-anthropic-native-tool-search-canonical-name.test.ts` pins the literal contract pair, keeps the local tool resident, and keeps non-Anthropic payloads byte-identical.

### Why

- Anthropic validates the server tool's `name` against the tool-search variant: every request carrying deferred tools was rejected with `invalid_request_error: tools.N.tool_search_tool_bm25_20251119.name: Input should be 'tool_search_tool_bm25'`, which then disabled native search for the session.

### Why an extension could not handle it

- The name is emitted by the builtin's own payload transform on `before_provider_request`; no extension hook rewrites an already-injected server tool.

### Expected merge conflict zones

- LOW: `native-search.ts` constant block.

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
