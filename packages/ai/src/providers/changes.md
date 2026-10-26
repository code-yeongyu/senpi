## 2026-10-26 - The faux provider captures block seeds at emission (senpi#4285, part of #4272)

### What changed

- `packages/ai/src/providers/faux.ts`: both the streamed and the deferred-fetch stream enable capture; each tool
  argument delta carries `parsedThrough: 0`, because faux never parses its generated chunks and only the end installs
  the arguments.

### Why

- Faux backs the unit tests and real-CLI QA; its streams must carry the same capture facts as provider streams so
  later stages can be exercised end to end (R3.C6.2).

### Why an extension could not handle it

- Capture has to run inside the stream's `push`, which only the provider controls.

### Expected merge conflict zones

- LOW: the two `createAssistantMessageEventStream()` sites in `createFauxCore` and the tool delta push in
  `streamWithDeltas`.

## 2026-10-24 - Kimi K3.1 Pro rows in the kimi-coding shard (senpi#4183)

### What changed

- `packages/ai/src/providers/kimi-coding.models.ts`: adds `chat:k3.1-pro` and `chat:k3.1-pro-highspeed` with the `k3` compat flags and image resize profile, the K3 thinking map, context 1048576, maxTokens 131072, text + image + video input, and the Moonshot API rates as implied cost (2 / 10 / 0.2 / 2 and 4 / 20 / 0.2 / 4 per MTok), like `k3`.

### Why

- Moonshot shipped K3.1 Pro on Kimi Code on 2026-10-23 under the ids `k3.1-pro` / `k3.1-pro-highspeed` (kimi.com/code/docs models page, checked 2026-10-24). Without a row the model could not be selected, and a mistyped id silently falls back to K2.8 Preview without thinking.

### Why an extension could not handle it

- The `kimi-coding` catalog is a hand-owned builtin shard; the builtin provider reads only this file.

### Expected merge conflict zones

- LOW: the `anthropic-messages` block of `packages/ai/src/providers/kimi-coding.models.ts`, between `chat:k3` and `chat:k3-256k`.

## 2026-10-16 - Xiaomi MiMo compat covers mimo-v2.6-pro (senpi v2026.10.16 release)

### What changed

- `packages/ai/src/providers/all.ts`: the Xiaomi MiMo compat normalization (reasoning content on assistant messages, DeepSeek thinking format, thinking cannot be disabled) applies to `mimo-v2.6-pro` as well as `mimo-v2.5-pro`.

### Why

- `packages/ai/src/providers/all.ts`: models.dev marked `mimo-v2.5-pro` deprecated, so a regenerated catalog drops it and `mimo-v2.6-pro` becomes the xiaomi default. Its generated entry already carries the same compat; the normalization keeps that guaranteed if a future regeneration loses it.

### Why an extension could not handle it

- `packages/ai/src/providers/all.ts`: built-in model normalization runs when the bundled catalog is loaded, before any extension.

### Expected merge conflict zones

- `packages/ai/src/providers/all.ts`: `normalizeBuiltinModel` and the Xiaomi provider/id sets above it.

## 2026-10-15 - Faux provider reports configurable response headers (senpi#3370)

### What changed

`RegisterFauxProviderOptions.responseHeaders` sets the headers every scripted response reports through `onResponse` (default none, unchanged behaviour).

- `packages/ai/src/providers/faux.ts`

### Why

Tests of code that reads provider response headers (subscription limit windows) need a provider that sends them, without a network call.

### Why an extension could not handle it

The faux provider is the in-tree test transport; an extension cannot change what it passes to `onResponse`.

### Expected merge conflict zones

The `onResponse` calls in the faux core and the options interface.

## 2026-10-14 - OpenCode Go registers the Google Generative AI transport (senpi#3342)

### What changed

- `packages/ai/src/providers/opencode-go.ts`: `opencodeGoProvider()` registers `google-generative-ai` (`withOpenCodeSessionHeader(googleGenerativeAIApi())`) beside its Anthropic Messages and OpenAI Completions/Responses transports, the same registration the OpenCode Zen provider (`opencode.ts`) already has. The provider's API union gains `google-generative-ai`.

### Why

- The refreshed models.dev catalog lists an OpenCode Go model in a `google-generative-ai` API group. Without a transport for it the typed catalog no longer fit the provider (TS2322), main stopped type-checking, and the v2026.10.14 release could not be cut. Registering the transport gives that model a working route instead of filtering it out.

### Why an extension could not handle it

- The builtin provider factory owns its transport map; an extension can register a separate provider but cannot add a transport to a builtin provider's catalog models.

### Expected merge conflict zones

- LOW: the import block, the API type union, and the `api` map of `opencodeGoProvider()`.

## 2026-10-14 - The direct anthropic provider offers no Claude subscription OAuth (senpi#3259)

### What changed

- `packages/ai/src/providers/anthropic.ts`: `anthropicProvider()` no longer registers the "Anthropic (Claude Pro/Max)" OAuth method; it keeps API-key, `ANTHROPIC_AUTH_TOKEN`, env and workload-identity auth. Claude subscriptions sign in through the coding-agent `anthropic-subscription` lane, which runs the same OAuth flow (`loadAnthropicOAuth`) behind the Claude Agent SDK.

### Why

- Anthropic bills a Claude subscription token sent straight to the Messages API as a third-party app: every request is refused with "Third-party apps now draw from your extra usage, not your plan limits", so a user who signed in this way could never use their plan (senpi#3259). The Agent SDK lane runs requests through Claude Code, the path that draws from plan limits.

### Why an extension could not handle it

- Login surfaces (TUI `/login`, RPC `get_auth_providers`, `AuthStorage.getOAuthProviders()`) enumerate `builtinProviders()` auth methods directly; an extension can add a provider but cannot remove a builtin provider's OAuth method.

### Expected merge conflict zones

- LOW: the `auth` block of `anthropicProvider()` and its two OAuth imports.

## 2026-10-11 - Keep unverified xAI search opt-in (senpi#3122 review)

### What changed

- `xai.ts` selects `web_search` as the Responses tool shape without enabling server search in the catalog. Users opt in with `supportsWebSearchPreview: true`.

### Why

- The held live probe returned HTTP 403; official documentation alone must not enable a route by default.

### Why an extension could not handle it

- The capability default is owned by the provider factory.

### Expected merge conflict zones

- The xAI model mapping.

## 2026-10-11 - xAI in-turn Responses search (senpi#3122)

### What changed

- `packages/ai/src/providers/xai.ts`: explicitly marks built-in Responses models with `supportsWebSearchPreview: true` and `webSearchToolType: "web_search"`, matching https://docs.x.ai/developers/tools/web-search.
- No model/API or credential migration is performed. Custom compatible routes declare their exact tool type separately.

### Why

xAI's built-in Responses route supports in-turn search and must not default to an auxiliary model.

### Why an extension could not handle it

Provider catalogue flags belong to the provider factory.

### Expected merge conflict zones

The mapped xAI model catalogue.

## 2026-10-09 - Restore providers-tracker coverage for upstream-modified paths (senpi#3006)

### What changed

- `packages/ai/src/providers/all.ts`: builtin provider set and fork-owned provider registration surviving catalog regeneration.
- `packages/ai/src/providers/amazon-bedrock.ts`: ambient shared-cloud credential chains (senpi#2327).
- `packages/ai/src/providers/anthropic.ts`: eagerly built and exported `streamAnthropic` / `streamSimpleAnthropic` (`anthropicMessagesApi()` evaluated at module load).
- `packages/ai/src/providers/cloudflare-ai-gateway.ts`: preserved provider adapter behavior re-diverged from upstream.
- `packages/ai/src/providers/faux.ts`: faux provider test surface with bounded retry jitter and abort metadata.
- `packages/ai/src/providers/github-copilot.ts`: account-own API host, account model limits, and refused-token re-exchange (senpi#2297/#2299/#2309).
- `packages/ai/src/providers/google.ts`: eagerly built and exported `streamGoogle` / `streamSimpleGoogle` (`googleGenerativeAIApi()` evaluated at module load).
- `packages/ai/src/providers/google-vertex.ts`: eagerly built and exported `streamGoogleVertex` / `streamSimpleGoogleVertex` (`googleVertexApi()` evaluated at module load), plus Vertex ambient-ADC marking (`ambient: true`) when only gcloud application default credentials are present.
- `packages/ai/src/providers/images/register-builtins.ts`: canonical images builtin registration on the v6 model surface.
- `packages/ai/src/providers/kimi-coding.ts`: regional Kimi Code login and provider-declared retry policy profiles.
- `packages/ai/src/providers/openai-codex.ts` and `packages/ai/src/providers/openai-codex.models.ts`: DELETED in the fork — renamed to `packages/ai/src/providers/chatgpt-subscription.ts` / `.models.ts` (senpi#1989, fork rename `3c816ead49`) and kept deleted through the v0.99.1 sync. Upstream edits to these paths must stay unadopted; port applicable deltas into the `chatgpt-subscription` counterparts instead of resurrecting the files.
- `packages/ai/src/providers/openai.ts`: [OI] provider family on the v0.99.1 sync.
- `packages/ai/src/providers/openrouter.ts`: OpenRouter images on the v6 model surface.

These files were covered by the parent tracker until senpi#2895 added this nearer tracker without listing them, hiding them from the audit's exact-nearest-tracker rule.

### Why

The repository audit requires every upstream-modified production path to be named by an entry in its exact nearest changes.md tracker. senpi#2895 introduced this tracker and named only the single file it touched, so the 14 pre-existing upstream-modified files beneath it lost the coverage the parent tracker had provided and were reported uncovered.

### Why an extension could not handle it

changes.md coverage is fork-owned documentation metadata; no extension or runtime hook can supply it.

### Expected merge conflict zones

- The module-load `stream*` / `streamSimple*` const-and-export blocks in `packages/ai/src/providers/anthropic.ts`, `packages/ai/src/providers/google.ts`, and `packages/ai/src/providers/google-vertex.ts`, against upstream edits to the same files; and the `vertexAuth` ambient-ADC return in `packages/ai/src/providers/google-vertex.ts`.
- HIGH: `packages/ai/src/providers/openai-codex.ts` and `packages/ai/src/providers/openai-codex.models.ts` are deleted in the fork but still edited upstream — a sync must not resurrect them; port applicable deltas into the `chatgpt-subscription` counterparts and keep these paths deleted.
- The provider registration and import lists in `packages/ai/src/providers/all.ts` and the images builtin registration in `packages/ai/src/providers/images/register-builtins.ts`, against provider additions or regeneration.

## 2026-10-07 - OpenGateway HTTP refresh failures retain status (senpi#2893)

### What changed

- `packages/ai/src/providers/opengateway-refresh.ts`: use the shared status-bearing HTTP error for catalog refresh failures without changing the message or last-good-catalog policy.

### Why

Refresh failure consumers need the original HTTP fact rather than message parsing.

### Why an extension could not handle it

The catalog's private fetch helper creates the failure.

### Expected merge conflict zones

- `fetchJson` in `opengateway-refresh.ts`.


## 2026-10-08 - Official Kimi K3 cache-write price

### What changed

- `packages/ai/src/providers/kimi-coding.models.ts`: the hand-kept Kimi Coding `k3` row's API-equivalent `cost.cacheWrite` 0 -> 3, matching the official K3 price it estimates from.

### Why

- The official Kimi API price list (https://platform.kimi.ai/docs/pricing/chat) bills Kimi K3 cache writes at $3 per 1M tokens for the default 5-minute TTL ($6 for 1 hour); the catalog still had them at $0, which undercounted cost on requests that write the cache and failed the 2026.10.10-8 release regeneration once upstream data caught up.

### Why an extension could not handle it

- Built-in model prices are catalog data generated or kept in this package; nothing at runtime can correct them.

### Expected merge conflict zones

- LOW: the Kimi K3 cost constants when upstream reprices Kimi models.
