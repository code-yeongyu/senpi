# builtin/tool-search

## OVERVIEW
Shared deferred-tool discovery domain (score 8): extension and MCP catalogs feed custom `tool_search` and Anthropic native search.

## WHERE TO LOOK

| Task | File |
|---|---|
| Bind extension lifecycle and lazy activation | `index.ts` |
| Catalog ownership, activation, and rehydration | `service.ts` |
| Custom search tool schema/execution | `tool.ts` |
| Anthropic request/response adaptation | `native-search.ts`, `native-support.ts` |
| Search ranking | `engine/bm25.ts` |
| Catalog documents | `engine/document.ts` |
| Persisted activation markers | `engine/marker.ts` |

## CONVENTIONS

- Provider-scoped sessions install their own `ToolSearchService`; the fallback singleton is for runtimes without provider scope.
- The service binds a tool registrar and only registers the custom search tool when a catalog needs it.
- Rehydrate promoted tools at session start and replay markers on `context` events.
- The lazy activator and model-callable search path both delegate to the service's activation logic.
- Extension definitions are deferrable while inactive; MCP native deferral also checks the MCP-native-search setting.
- Native adaptation observes response status so an injection failure can fall back to the custom path.
- Marker V2 is emitted while legacy markers remain parseable for existing sessions.
- MCP discovery supplies catalog entries here; MCP does not own a separate BM25 engine.

## ANTI-PATTERNS

- Deferring the custom `tool_search` tool itself.
- Combining `defer_loading` and `cache_control`, or adding cache control to injected inactive definitions.
- Registering/activating search for an empty catalog.
- Letting tool activation or restored markers leak across provider-scoped sessions.
- Assuming every registered definition is active or should be sent eagerly to a provider.
