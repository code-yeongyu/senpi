## 2026-10-05 - Keenable web search provider, keyed and keyless-public

### What changed

- `websearch/providers/keenable.ts` (new): POSTs `{query, max_results (<=50), site?}` to `https://api.keenable.ai/v1/search` with `X-API-Key` when `apiKey` is configured, and to `https://api.keenable.ai/v1/search/public` with an `X-Keenable-Title: <APP_NAME>` header when it is not. A lone `allowedDomains` entry maps to the native host-only `site` field; multiple allowed or any blocked domains stay `site:`/`-site:` query terms via `appendDomainFilters`. Response `results[]` normalize `snippet` (falling back to `description`) and `published_at` into `publishedAt`; non-http(s) or control-character URLs are dropped.
- `websearch/types.ts`, `provider-endpoints.ts`, `providers.ts`, `config.ts`: `keenable` joins the provider union, the default endpoint table, the module registry and `PROVIDERS`/`KEYLESS_PROVIDERS`. Keyless means `websearch.json` may list it without `apiKey`, and a block cools it down like the other keyless engines; it is deliberately not in `DEFAULT_FREE_CONFIG` because the public tier is a shared per-IP pool.
- Covered by `test/suite/websearch-keenable-provider.test.ts`.

### Why

- Keenable is a search API with a keyless public tier; explicit config entries can use it with or without a key.

### Why an extension could not handle it

- The provider registry and config validation are private to this builtin.

### Expected merge conflict zones

- LOW: one line per provider in `types.ts`, `config.ts` `PROVIDERS`/`KEYLESS_PROVIDERS`, `provider-endpoints.ts`, `providers.ts`.

## 2026-09-29 - Free keyless engine chain, per-engine cooldown, SearXNG (senpi#2339)

### What changed

- `websearch/providers/{startpage,mojeek,ecosia,google-html,exa-mcp,searxng}.ts` (new): keyless engines. The four results-page scrapers read a parsed document (`normalizeDocument`) and send one stable Chrome navigation fingerprint (`browserHeaders` in `providers/shared.ts`). Parsing uses `linkedom` (already a coding-agent dependency) behind the lazy boundary `websearch/html-document.lazy.ts`, so the CLI's startup graph never reaches it (`test/startup-import-graph.test.ts`); `normalizeSearchResponse` is therefore async. `exa-mcp` calls Exa's hosted MCP endpoint (`https://mcp.exa.ai/mcp`, tool `web_search_exa`) on its anonymous tier, without a key. `searxng` queries a user-configured instance's `/search?format=json`.
- `providers/duckduckgo-html.ts`: posts the no-JS form (`q`, `kl=us-en`) with the browser fingerprint instead of a bare GET, and recognizes the anomaly page.
- `providers/shared.ts` `ProviderModule` gains optional `responseFormat` (`json` | `html` | `event-stream`), `detectChallenge`, `responseError` and `prepareRequest` (Startpage's homepage-token handshake). `BuiltSearchRequest.form` carries a pre-encoded form body for form posts.
- `search.ts`: `performProviderSearch` runs the handshake, checks for a challenge page before status handling, and records `blocked` (`challenge` | `rate_limited` | `forbidden` | `network`) plus `Retry-After`. `SearchRoutingState.cooldowns` holds a per-engine exponential cooldown (1 min base, doubling, 15 min cap, cleared by a success) for keyless engines only; a cooling engine is recorded as a `skipped` attempt and shown in the routing line. `tool.ts` carries the cooldown map across routing-state resets so it lasts the session.
- `config.ts`: the no-config default becomes `duckduckgo-html -> exa-mcp -> startpage -> mojeek -> ecosia -> google-html` (the two engines that answer plain fetch from a residential connection first, the challenge-prone results-page scrapers after them) (source `default:free-engines`); `KEYLESS_PROVIDERS` replaces the DuckDuckGo-only key exemption; `searxng` requires `baseUrl` and is validated by `isAllowedSearxngBaseUrl` (`provider-endpoints.ts`), which additionally accepts `http:` for loopback, private-address, single-label and `.local`/`.lan`/`.internal`/`.home.arpa` hosts. Every other provider keeps the public-HTTPS-only guard.
- `renderers.ts`: attempts render `skipped` / `challenged` states.

### Why

- With no config the only engine was DuckDuckGo, so one rate limit or bot page failed every search in sessions without a native route, and the bot page surfaced as "returned no results" (senpi#2339).
- SearXNG's local `http:` allowance: the URL comes from the user's own config file, not from the model, and a search sends only the query; a public host still needs https so queries never travel in cleartext.

### Why an extension could not handle it

- The provider registry, default config and routing state are private to this builtin.

### Expected merge conflict zones

- MEDIUM: `websearch/search.ts` `performProviderSearch` and the `performSearch` loop, if upstream pi-websearch changes them.
- LOW: one line per provider in `types.ts`, `config.ts` `PROVIDERS`, `provider-endpoints.ts`, `providers.ts`.

## 2026-09-29 - Native web search runs on a cheaper same-provider model, with the session model as fallback (senpi#2340)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/websearch/websearch/search-model.ts` (new): `resolveNativeSearchModel` picks the model a native search runs on for the session's own route. A `nativeModel` setting wins when the registry lists that id (or `provider/id`) on the same provider and the same `nativeRouteKey` as the session model; otherwise it is ignored with a warning. Without the setting, a per-provider default table ported from oh-my-pi's `web-search-model` catalog axis (`claude-haiku-4-5`/`claude-haiku-4.5`, `gpt-5.6-luna`, `grok-4.3`, `deepseek-v4-flash`) applies only when the candidate is on the same route and its catalog `cost` is no higher than the session model's on input and output and lower on at least one. `"session"` pins the session model.
- `packages/coding-agent/src/core/extensions/builtin/websearch/websearch/native.ts`: `NativeModelInfo` carries optional `cost`; `nativeMapping`, `NativeProviderMapping` and `nativeRouteKey` are exported; `buildNativeEntries` takes an optional `{ model, fallbackModel }` applied to the active session route entry only (discovered routes keep their own model). Auth still resolves through the session model, so the credential never changes.
- `packages/coding-agent/src/core/extensions/builtin/websearch/websearch/route-attempts.ts` (new): `providerEntryLabel` moved here unchanged (re-exported from `search.ts`), plus `attemptRouteLabel` (`label (model)`) and `routeAttemptEntries`, which expands an entry with `fallbackModel` into the chosen-model attempt and the session-model retry.
- `packages/coding-agent/src/core/extensions/builtin/websearch/websearch/search.ts`: `performSearch` runs each route through `searchRoute`, which retries a failed or empty chosen-model attempt on `fallbackModel` before the routing strategy moves on (also with `fallback: false`). Attempts and details record `model`; route labels, the routing-attempts line, the `via` fragment and the all-failed message name it.
- `packages/coding-agent/src/core/extensions/builtin/websearch/websearch/types.ts`: `WebsearchConfig.nativeModel`, `SearchProviderEntry.fallbackModel`, `SearchDetails.model`, `SearchAttempt.model`.
- `packages/coding-agent/src/core/extensions/builtin/websearch/websearch/config.ts`: reads top-level `nativeModel` (both the `providers` form and the single-provider shorthand) and rejects a non-string or empty value with a named message.
- `packages/coding-agent/src/core/extensions/builtin/websearch/websearch/tool.ts`: resolves the choice before building native entries; `createWebSearchTool` takes an optional `onSearchComplete` callback.
- `packages/coding-agent/src/core/extensions/builtin/websearch/websearch/renderers.ts`: the expanded route line and the result summary use `attemptRouteLabel`.
- `packages/coding-agent/src/core/extensions/builtin/websearch/index.ts`: `/websearch status` reports `native model=<id> (falls back to <session id>)`, the route and model of the last successful search, and a `warning`-level line when `nativeModel` is ignored.
- Covered by `test/suite/websearch-native-search-model.test.ts` and `test/suite/websearch-native-search-model-status.test.ts`.

### Why

- Native search sub-requests ran on the session model itself, so an Opus-class session paid Opus rates (or spent Opus subscription usage) for a request that only has to find URLs. senpi#2340.
- The setting is a new `nativeModel` key rather than a reuse of `model`: in `websearch.json` `model` already means a configured provider's model, and in the single-provider shorthand the top-level `model` *is* that provider's model, so reusing it would change the meaning of existing files. The settings.json per-purpose keys (`compaction.model`, `lookAt.models`) each need a dedicated `ExtensionContext` getter threaded through `agent-session.ts`; this builtin already owns its config file, so the setting lives there.

### Why an extension could not handle it

- The native route construction, routing loop and `/websearch` command are private to this builtin.

### Expected merge conflict zones

- MEDIUM: `performSearch` in `websearch/search.ts` (the per-route loop now calls `searchRoute`) and `formatSearchText`.
- LOW: the `buildNativeEntries` signature and its active-entry push in `websearch/native.ts`; the `NativeModelInfo` fields; `configFromObject` and `loadWebsearchConfig` in `websearch/config.ts`; the status handler in `index.ts`. Re-vendoring must carry `route-attempts.ts` and `search-model.ts`, or restore `providerEntryLabel` in `search.ts`.

## 2026-09-29 - ChatGPT subscription hosted search and opt-in Google Search grounding (senpi#2341)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/websearch/websearch/hosted-routes.ts` (new): `hostedRouteMapping` maps `openai-codex-responses` models (except `-spark`) to the `chatgpt-subscription` search provider at `<baseUrl>/codex/responses`; it is the only new automatic route. Google Search grounding is opt-in, so no Google model maps automatically: `googleLoginEndpoint` gives the API root of a `google`-provider Google model and is used only for a `google` entry listed in `websearch.json`. `credentialHeaders` merges catalog `model.headers` with the registry's credential headers, a `null` credential header deleting the catalog one.
- `packages/coding-agent/src/core/extensions/builtin/websearch/websearch/native.ts`: `nativeMapping` consults `hostedRouteMapping` first; mappings may carry an `endpoint` builder (`mappingEndpointUrl`) instead of the `/v1/<resource>` rule; `NativeModelInfo` gains `headers`, and every native entry now carries the merged credential `headers` (only the two new provider modules send them). The active-provider discovery rule is unchanged.
- `packages/coding-agent/src/core/extensions/builtin/websearch/websearch/providers/chatgpt-subscription.ts` (new): streaming, `store: false` Responses request with the `web_search` tool, `tool_choice: { type: "web_search" }`, bearer token, `chatgpt-account-id` from the token, `OpenAI-Beta: responses=experimental`, the wire-identity `originator`/`User-Agent`, and the credential headers. Results only when the output has a `web_search_call`: `url_citation` annotations first, then `action.sources`; answer-text URLs never count.
- `packages/coding-agent/src/core/extensions/builtin/websearch/websearch/providers/response-stream.ts` (new): folds the SSE stream into `{ output }`; `error`/`response.failed` events become `error.message`.
- `packages/coding-agent/src/core/extensions/builtin/websearch/websearch/providers/google.ts` (new): `POST <root>/models/<model>:generateContent` with `x-goog-api-key`, the `google_search` tool, domain filters folded into the query; results are `groundingMetadata.groundingChunks[].web` (`uri`, `title`), snippets from `groundingSupports`. No grounding chunks means zero results.
- `packages/coding-agent/src/core/extensions/builtin/websearch/websearch/session-login-entries.ts` (new) and `websearch/tool.ts`: a `websearch.json` `chatgpt-subscription` or `google` entry without `apiKey` resolves the matching senpi login (same-provider model, the entry's `model` preferred; `google` resolves only the `google` API-key login, never Vertex) and is sent to that login's endpoint; an entry with no matching login is dropped, and a config left empty that way returns an explicit error.
- `packages/coding-agent/src/core/extensions/builtin/websearch/websearch/types.ts`, `websearch/config.ts`, `websearch/provider-endpoints.ts`, `websearch/providers.ts`, `websearch/providers/shared.ts`: the two provider ids, their defaults, `headers` on entries (never read from `websearch.json`), apiKey-optional validation for both, `ProviderModule.parseBody`, `parseProviderBody`, and `withConfigHeaders`.
- `packages/coding-agent/src/core/extensions/builtin/websearch/websearch/search.ts`: `responsePayload` asks the provider's own `parseBody` first (the subscription's full SSE stream), before the `responseFormat` handling added by senpi#2339; a successful response with zero results and an `error` field reports that error instead of "returned no results".

### Why

- ChatGPT subscription and Google model sessions had no hosted search and fell back to the scraper (senpi#2341). The existing `codex` provider id stays the API-key Responses route. Google Search grounding is opt-in by owner decision so nobody is billed by Google without asking.

### Why an extension could not handle it

- The provider registry, native mapping and entry construction are private to this builtin.

### Expected merge conflict zones

- MEDIUM: `nativeMapping` head, `mappingEndpointUrl` call sites and the end of `buildNativeEntryForModel` in `websearch/native.ts` (senpi#2340 edits the same file).
- LOW: one line each in `types.ts`, `config.ts` `PROVIDERS`, `provider-endpoints.ts`, `providers.ts`; the payload/zero-result block in `search.ts`; the native-route call in `tool.ts`.


## 2026-09-29 - Answer-text URLs are not search sources (senpi#2337)

### What changed

- `websearch/providers/openai-responses.ts`: `normalizeResponsesPayload` no longer falls back to regex-extracted URLs from the answer text (`resultsFromTextUrls` removed). Results come only from `url_citation` annotations, `web_search_call` action sources, and, for xAI, the server `citations` array.

### Why

- A response with no `web_search_call` was reported as a successful search whose sources were whatever URLs the model typed, including invented ones, and the router never fell back.

### Why an extension could not handle it

- The normalizer is private to this builtin.

### Expected merge conflict zones

- LOW: the tail of `normalizeResponsesPayload` if upstream pi-websearch keeps the text-URL fallback.
## 2026-09-28 - Native web search uses the credential's own API host (senpi#2309)

### What changed

- `websearch/native.ts`: `NativeAuthResult` accepts `baseUrl`; when the credential names one, the native entry's endpoint is built from it instead of the catalog `model.baseUrl`, and it passes the same `isAllowedProviderBaseUrl` check.

### Why

- A GitHub Copilot Business or Enterprise account is served from its own API host; the individual catalog host refuses its requests with `421 Misdirected Request` (omo#8662). The session's chat requests already honoured the credential's host, this path did not.

### Why an extension could not handle it

- The fix is inside this builtin's own request construction.

### Expected merge conflict zones

- LOW: the end of `buildNativeEntryForModel` in `websearch/native.ts`.

# changes.md — websearch (vendored)

## 2026-09-24 - Sync with pi-websearch 0.4.0: Kagi and SERPdive providers (senpi#2079)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/websearch/websearch/providers/kagi.ts` (new, pi-websearch#9): POSTs to `https://kagi.com/api/v1/search` with bearer auth, caps `limit` at 20, maps domain filters to `lens.sites_included` / `lens.sites_excluded`, and normalizes `data.search[]` with `time` as `publishedAt`.
- `packages/coding-agent/src/core/extensions/builtin/websearch/websearch/providers/serpdive.ts` (new, pi-websearch#7): POSTs to `https://api.serpdive.com/v1/search` with bearer auth, caps `max_results` at 10, folds domain filters into the query, and uses `results[].content` as the snippet.
- `packages/coding-agent/src/core/extensions/builtin/websearch/websearch/types.ts`, `config.ts`, `provider-endpoints.ts`, `providers.ts`: `kagi` and `serpdive` join the provider union, config validation (both require `apiKey`), default endpoints and the module registry.
- Upstream's dot-to-bracket property access, `NativeAuthResult` nullable headers, and `ExtensionContext`-typed `tool.ts` context were already equivalent in senpi or are superseded by the senpi adaptations below; not re-applied.
- `packages/coding-agent/test/suite/websearch-kagi-serpdive-providers.test.ts` ports upstream's provider request/normalization and config-validation cases.

### Why

senpi#2079 adopts pi-websearch 0.4.0; the two providers are the only runtime changes in that release.

### Why an extension could not handle it

The provider registry and `SearchProvider` union are private to this builtin; another extension cannot add a provider to its routing.

### Expected merge conflict zones

- LOW in `websearch/types.ts`, `websearch/config.ts` `PROVIDERS`, `websearch/provider-endpoints.ts`, `websearch/providers.ts` (one line each per provider).

## Senpi merge repair (2026-08-13)

- Native route discovery accepts registry `ProviderHeaders`, preserving nullable deletion markers while it
  resolves credentials. Since senpi#2341 the entry carries the merged headers (`credentialHeaders`), and the
  `chatgpt-subscription` and `google` modules send them.
- This remains a Senpi adaptation because the builtin bridges Senpi's model registry into the vendored
  extension; re-vendoring can overwrite `native.ts` and `tool.ts`.

Vendored from [`code-yeongyu/pi-websearch`](https://github.com/code-yeongyu/pi-websearch) at `7fb28c31623bafb77f437095d57315c26f202dc2` (0.3.0); the 0.4.0 providers (`d0ca9b5`) were ported by hand on 2026-09-24.

## Senpi adaptations vs upstream

- Imports rewritten manually for the senpi source tree:
  - `@earendil-works/pi-coding-agent` public imports (`defineTool`, `ExtensionAPI`/`ExtensionContext` types) -> senpi-local `../../types.ts` / `../../../types.ts`
  - relative `.js` import suffixes -> `.ts`
  - the `@earendil-works/pi-tui` import is identical in both trees and needs no rewrite
- Senpi forwards the tool `AbortSignal` into native route discovery (`buildNativeEntries(model, registry, signal)` and the `configWithNativeRoute` call in `tool.ts`) so cancellation stops waiting for pending authentication before any provider request begins. Not upstream as of 0.3.0.
- `nativeRouteKey` additionally strips one permitted terminal DNS dot from the hostname before hashing, so `host.` and `host` collapse to one discovered candidate. The hashed `provider|endpoint` route key itself is upstream. Covered by `test/websearch-native-route-dedup.test.ts`.
- `index.ts` diverges from upstream's provider-name bypass (`provider === "openai" || provider === "anthropic"`): the `provider_native_bypass` state is instead gated on `supportsNativeAnthropicWebSearch` / `supportsNativeOpenAiWebSearch` (+ their enable envs) from the sibling `anthropic-web-search` / `openai-web-search` builtins, and recomputed on `model_select`. Upstream's check disabled the standalone `web_search` tool for any model whose provider id is `anthropic`/`openai`, including proxied baseUrls (ccapi, quotio, …) where the injecting builtins never add the server-side tool — leaving those sessions with no web search at all, and leaving a stale bypass after mid-session model switches. Covered by `test/suite/websearch-extension-bypass.test.ts`.
- `config.ts` reads senpi's own config dir (`CONFIG_DIR_NAME` from `packages/coding-agent/src/config.ts`, resolved to `.senpi`) ahead of the legacy `.pi` directory, while keeping `.pi` as a fallback so existing users keep loading. Project `.senpi` wins over project `.pi`; both project paths win over anything in the home dir; the legacy `~/websearch.json` keeps its precedence over `~/<config dir>/websearch.json`. Covered by `test/websearch-config-paths.test.ts`.
- Native auto-routing now derives an active custom provider's hosted OpenAI Responses or Anthropic Messages route from the model API while retaining the configured provider ID in progress/result labels (for example, `quotio-openai/native`). Discovered first-party OpenAI/Anthropic routes are eligible only when their provider ID matches the active model provider, so unrelated first-party accounts no longer outrank a custom active provider. Covered by `test/websearch-native-provider-routing.test.ts` and `test/websearch-native-tool.test.ts`.
- Result rendering no longer appends the routing-strategy suffix: the TUI summary (`renderers.ts`) and the `formatSearchText` route fragment (`search.ts`) show `via <provider>` only, never `via <provider> (<strategy>)`. The `strategy` field stays on the details metadata; only display changed. Mirrored in `../pi-extensions/pi-websearch`; re-apply after any re-vendor from GitHub upstream. Covered by `test/websearch-progress.test.ts`.
- Native auto-routing now requires the discovered route's provider to match the active model provider for ALL providers, not just OpenAI/Anthropic candidates. Cross-provider routes such as `z-ai/native` are no longer discovered while running another provider's model (e.g. a deepseek model); the active model's own native route (including `z-ai/native` for GLM models) is still prepended. Covered by `test/websearch-native-provider-routing.test.ts`.
- Search progress text no longer appends `(max N)`: the `tool.ts` progress line and the partial TUI renderer (`renderers.ts`) show `Searching "…" via <provider>` only. `maxResults` stays on the request and on the `SearchProgressDetails` metadata; only display changed. Covered by `test/websearch-progress.test.ts`.
- `deepseek` is a first-party provider backed by DeepSeek's Anthropic-compatible endpoint (`https://api.deepseek.com/anthropic/v1/messages`, server-side `web_search_20250305` tool, default model `deepseek-v4-flash`; shared request builder/normalizer with the anthropic provider). Native auto-routing maps official `deepseek-v4-*` models (provider id `deepseek`) to a `deepseek/native` route at `/anthropic/v1/messages` via a per-mapping endpoint path override; provider-scoped discovery keeps that route exclusive to official deepseek models, so proxied deepseek models never bind it. Not upstream as of 0.3.0; mirror in `../pi-extensions/pi-websearch` before re-vendoring. Covered by `test/websearch-deepseek-provider.test.ts`, `test/websearch-native-model-matrix.test.ts`, and `test/websearch-native-provider-routing.test.ts`.

Per-attempt search progress and the three-state route rendering landed upstream in 0.3.0 (they were previously senpi-only), so the senpi tree now mirrors that logic exactly: one shared `providerEntryLabel` (`provider/id`, discovered native ids collapsed to `provider/native`), resolved `routeLabels` on every progress update, no `[n/m]` step counter, and a `route <label>:<state>` line listing already-tried, currently-running, and pending sources when expanded. Covered by `test/websearch-progress.test.ts` and `test/websearch-native-tool.test.ts`.

## Conflict zones

Re-vendoring overwrites `index.ts` and the `websearch/` directory. There is no active auto-vendor script in this branch; re-vendor by copying upstream `src/index.ts` + `src/websearch/`, applying the import/suffix transforms above, then running the senpi checks.
