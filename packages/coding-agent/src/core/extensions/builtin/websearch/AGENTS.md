# builtin/websearch

## OVERVIEW
Provider-backed search domain (score 11): `web_search` routes configured providers and capability-gated native search through one result model.

## WHERE TO LOOK

| Task | File |
|---|---|
| Tool/command lifecycle | `index.ts` |
| Config loading, free fallback, validation | `websearch/config.ts` |
| Endpoint restrictions | `websearch/provider-endpoints.ts` |
| Tool schema and output formatting | `websearch/tool.ts` |
| Routing strategy and fallback attempts | `websearch/search.ts` |
| Provider registry | `websearch/providers.ts` |
| Provider request/response adapters | `websearch/providers/` |
| Native capability and enablement checks | `websearch/native.ts` |
| Shared result/config types | `websearch/types.ts` |
| Display route and result rendering | `websearch/renderers.ts` |

## CONVENTIONS

- Provider modules implement `buildRequest` and `normalizeResponse`; filenames alone do not register a backend.
- Config accepts `priority`, `round-robin`, and `fill-first` strategies with explicit fallback/auto settings.
- The free default is DuckDuckGo HTML, priority routing, fallback enabled, auto enabled, and ten results.
- Provider endpoint rules are centralized; provider-specific URL/auth requirements remain in validation/adapters.
- DeepSeek reuses the Anthropic-compatible adapter; xAI reuses the OpenAI Responses adapter.
- Native bypass requires the exact capability and enablement checks, not a matching provider display name.
- Display text omits strategy while structured metadata preserves routing information.

## ANTI-PATTERNS

- Adding a provider without updating the typed registry, config validation, and response normalization together.
- Assuming absence of configured credentials means no search path exists.
- Replacing native capability checks with a provider-name allowlist.
- Leaking raw provider responses or credentials into route/status rendering.
