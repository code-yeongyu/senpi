# changes.md — ai

## 2026-09-02 - Claude Fable 5.1 catalog

### What changed

- `packages/ai/scripts/generate-models.ts`: `ANTHROPIC_ALLOWED_FALLBACK_MODELS` gains `claude-fable-5-1` -> opus-4-8/opus-5 (the permitted refusal-fallback targets per the Fable 5.1 release notes).
- Regenerated `src/providers/data/` against live sources: `claude-fable-5-1` lands in anthropic, amazon-bedrock (3 regional ids), openrouter, and vercel-ai-gateway with 1M context, 128k output, cache reads at 0.25/MTok, xhigh+max thinking map, and adaptive-only compat. Incidental upstream drift in the same regeneration: nvidia retires nemotron-3-nano-30b-a3b, openrouter adds mercury-2.5-preview and retires three opus `-fast` variants, vercel retires deepseek-v3, fireworks/nvidia metadata churn.

### Why

- Anthropic released Claude Fable 5.1; models.dev already carries it, so the committed catalog regeneration is the canonical path. Family markers (`fable-5` substring/regex) already cover the 5.1 id at runtime.

### Why an extension could not handle it

- The committed provider catalog is generated inside this package.

### Expected merge conflict zones

- `scripts/generate-models.ts` (fallback map), `src/providers/data/*` (regenerated wholesale on both sides; regenerate, don't merge).

## 2026-08-29 - Narrow GLM-5.3 serializer matching

### What changed

- `src/api/openai-completions.ts`

### Why

- Unsupported GLM-5.3 suffixes must not inherit validated model reasoning controls.

### Why an extension could not handle it

- Z.AI request serialization is implemented inside the AI package provider adapter.

### Expected merge conflict zones

- `src/api/openai-completions.ts`

## 2026-08-29 - Preserve GLM-5.3 variant reasoning controls

### What changed

- `packages/ai/scripts/generate-models.ts`: recognize `glm-5.3` Flash and Highspeed variants as part of the Z.AI GLM-5.3 family so generated metadata retains low/high/max reasoning effort mappings and wire support.
- `packages/ai/src/api/openai-completions.ts`; `src/api/openai-completions.ts`: Z.AI GLM-5.3 thinking serialization.
- src/api/openai-completions.ts
- `src/api/openai-completions.ts`: Z.AI GLM-5.3 thinking serialization.

### Why

- Without family matching, explicit reasoning effort selections were dropped for the Flash and Highspeed models and their model controls exposed incorrect levels.

### Why an extension could not handle it

- Model-family metadata and request serialization are built into the AI package generator and provider adapter before extension code can intervene.

### Expected merge conflict zones

- `packages/ai/scripts/generate-models.ts`: Z.AI model-family detection and generated capability metadata.
- `packages/ai/src/api/openai-completions.ts`; `src/api/openai-completions.ts`: Z.AI GLM-5.3 thinking serialization.
- src/api/openai-completions.ts

## 2026-08-29 - Z.AI GLM-5.3 request and catalog fixes

### What changed

- `src/api/openai-completions.ts`: narrow GLM-5.3 thinking serialization to validated variants.
- GLM-5.3 reasoning-off requests now use the provider's lowest enabled effort instead of sending the rejected disabled-thinking payload; regenerated Z.AI catalogs retain the separate global and China sources and published model metadata.

### Why

- Unsupported GLM-5.3 suffixes must not inherit validated model reasoning controls.

### Why an extension could not handle it

- Z.AI request serialization is implemented inside the AI package provider adapter.

### Expected merge conflict zones

- `src/api/openai-completions.ts`.

## Anthropic cache checkpoints across tool loops (2026-08-29)

### What changed

- Anthropic message serialization now retains the preceding prompt-cache checkpoint only for a genuine tool-loop continuation, including interrupted turns whose tool result and following user text are coalesced into one user message.

### Why

- Ordinary multi-turn histories must not create additional premium cache writes, while tool loops need a stable rolling checkpoint across appended results.

### Why an extension could not handle it

- Cache markers and Anthropic role coalescing are applied inside the provider wire serializer below extension-visible message handling.

### Expected merge conflict zones

- MEDIUM: `src/api/anthropic-messages.ts` message coalescing and final cache-marker pass.
## Credential pool export wildcard (2026-08-27)

### What changed

- `packages/ai/package.json`: the `./auth/pool/slots` export entry became the wildcard `./auth/pool/*` so the new `select`, `classify`, and `failover` pool modules resolve through the package export map alongside `slots`.

### Why

- The credential pool engine ships as separate browser-safe modules; consumers (including `packages/coding-agent`) import them by subpath.

### Why an extension could not handle it

- Package export maps are packaging surface owned by the package itself.

### Expected merge conflict zones

- LOW: one wildcard line in the `exports` map.

## @anthropic-ai/sdk peer alignment (2026-08-26)

### What changed

- `packages/ai/package.json` bumps `@anthropic-ai/sdk` `0.91.1` -> `0.120.0` in lockstep with the root and coding-agent pins. All imported types/classes were audited symbol-by-symbol against the 0.120.0 tarball; the widened `RefusalStopDetails.category` and `StopReason` unions are additive and unread here.

### Why

- The old pin violated `@anthropic-ai/claude-agent-sdk@0.3.241`'s `>=0.93.0` peer requirement and warned on every bun install.

### Why this lives in the fork

- The exact-version pin discipline is fork-owned; upstream tracks a caret range.

### Expected merge conflict zones

- LOW: `packages/ai/package.json` dependency pins during upstream syncs.

## 2026-08-25 - Keep Cloudflare AI Gateway provider divergence covered

### What changed

- Keep `packages/ai/src/providers/cloudflare-ai-gateway.ts` with the fork's Cloudflare AI Gateway provider registration and Workers AI model mapping.

### Why

- The provider is part of the fork's supported gateway surface and must remain covered by the nearest changes tracker during upstream synchronization.

### Why this lives in the fork

- Provider registration and model routing are package-owned runtime behavior below the extension boundary.

### Expected merge conflict zones

- LOW: `packages/ai/src/providers/cloudflare-ai-gateway.ts` and adjacent provider registration during upstream syncs.

## AI package manifest and model generator re-diverge from upstream dcd4619 (2026-08-25)

### What changed

- `packages/ai/package.json` keeps the calver version, the `./utils/*` and `./node/provider-scope`
  export subpaths, and `tsx`-driven generator scripts (upstream invokes them with plain `node`).
- `packages/ai/scripts/generate-models.ts` keeps the fork catalog sources: the OpenGateway fetcher
  import, `KIMI_K3_THINKING_LEVEL_MAP`, the Kimi coding stable models, and
  `ZAI_GLM52_THINKING_LEVEL_MAP` — the ZAI map was dropped by this merge's resolution while its
  usage survived, which broke the `generate` CI job; this sync restores the pre-merge definition
  verbatim.

### Why

These are fork-owned product surfaces (senpi branding, provider wire behavior, fork runtime features) that upstream does not carry; the sync must re-assert them on top of upstream's tree.

### Why this lives in the fork

The divergence lives in core wiring, package identity, or build plumbing that executes before any extension loads, so no extension hook can express it.

### Expected merge conflict zones

- The provider-constant block near the top of `packages/ai/scripts/generate-models.ts` (the exact
  zone that silently dropped the ZAI map in this merge) and the `exports`/`scripts` blocks of
  `packages/ai/package.json`.

## Preserve OpenAI completions reasoning details after upstream merge (2026-08-25)

### What changed

- `packages/ai/src/api/openai-completions.ts`: retain structured reasoning details from thinking signatures and legacy encrypted tool-call signatures when constructing assistant messages.

### Why

- The fork's merged adapter computed these details but dropped them before serialization, regressing the upstream reasoning-details contract and fork provider compatibility.

### Why an extension could not handle it

- Assistant message serialization occurs inside the provider adapter before extension hooks can observe or modify the request.

### Expected merge conflict zones

- MEDIUM: assistant-message conversion and reasoning-detail preservation in the OpenAI Completions adapter.

> Audit backfill (2026-08-17): the entry below was recorded during the repository-wide changes.md audit
> of divergences from the upstream pin (v0.84.2, `914cf1472e`) so its audited production paths carry a
> canonical four-section record; it is dated by its underlying work.

## Credential pool slot export map (2026-08-25)

### What changed

- `packages/ai/package.json`: added an `exports` entry for `./auth/pool/slots` so consumers (including `packages/coding-agent`) can import the browser-safe credential pool slot algebra module.

### Why

- The slot algebra module introduced for multi-credential pools must be reachable through the package export map; without the subpath export, workspace consumers cannot resolve it.

### Why an extension could not handle it

- Package export maps are build/packaging surface owned by the package itself.

### Expected merge conflict zones

- LOW: single additive line in the `exports` map.

## Bedrock and TypeBox dependency refresh (2026-08-24)

### What changed

- `packages/ai/package.json`: `@aws-sdk/client-bedrock-runtime` 3.1115.0 -> 3.1116.0 and `typebox` 1.3.16 -> 1.3.18.

### Why

- These are compatible patch releases selected for the CalVer release. The Bedrock pin stays identical to coding-agent, and TypeBox stays identical across all shared runtime/protocol consumers.

### Why an extension could not handle it

- Provider clients and schema primitives are constructed below the extension boundary.

### Expected merge conflict zones

- MEDIUM: the exact dependency block in `packages/ai/package.json`.

## Dependency pin refresh and unused fork manifest entry removal (2026-08-20)

### What changed

- `packages/ai/package.json`: `@aws-sdk/client-bedrock-runtime` 3.1112.0 -> 3.1115.0, `@google/genai` 2.13.0 -> 2.18.0, `@smithy/node-http-handler` 4.11.2 -> 4.11.3, and `typebox` 1.3.8 -> 1.3.16. Removed the `chalk`, `proxy-from-env`, and `@mistralai/mistralai` dependencies. `openai` remains pinned at 6.26.0 and `@anthropic-ai/sdk` remains at 0.91.1.

### Why

- The three removed entries were retained fork manifest entries with zero imports left in this package. `proxy-from-env` in particular is no longer needed at all: `src/utils/node-http-proxy.ts` hand-rolls the `getProxyForUrl` and `no_proxy` logic, and that vendoring was itself the fix for compiled Bun binaries failing to resolve the package outside the repository, so keeping the dependency declared cannot help a compiled binary. `@mistralai/mistralai` is unused because the Mistral Conversations client is hand-rolled HTTP. `openai` stays at 6.26.0 as the documented fork pin, and `@anthropic-ai/sdk` stays at 0.91.1 because 0.120.0 breaks the browser-bundle smoke check.

### Why an extension could not handle it

- Dependency resolution happens before any runtime exists, and the browser-safety constraint that keeps `@anthropic-ai/sdk` pinned is a property of this package's own bundled export graph.

### Expected merge conflict zones

- HIGH: the `dependencies` block, which upstream edits on nearly every release; keep the fork pins and the removals.
- LOW: nothing else in the manifest changed.

## Package manifest and catalog generator divergence after the 59a71b23 sync (2026-08-19)

### What changed

- `packages/ai/package.json` stays divergent from upstream `59a71b235d` on four axes. Publication:
  `private: true` with the fork's CalVer `2026.8.18-3` line and the matching `^2026.8.18-3`
  `@earendil-works/pi-telemetry` range, instead of upstream's published `0.84.2`. Dependency pins:
  `openai` remains at `6.26.0` (upstream floats to `6.40.0`), plus fork-only runtime deps the fork's own
  code imports — `@bufbuild/protobuf` and `@mistralai/mistralai` for the cursor-agent protobuf transport
  and Mistral Conversations client, `@smithy/types` for the typed Bedrock middleware, `yaml` for the
  YAML/XML tool-call protocol, alongside the fork's retained `chalk` and `proxy-from-env` entries — and
  newer floors for
  `@aws-sdk/client-bedrock-runtime`, `@google/genai`, `@smithy/node-http-handler`, the proxy agents,
  `typebox`, `@types/node`, and Node itself (`>=24.0.0`). Export map: the fork-only `./utils/*` and
  `./node/provider-scope` subpath entries. Build scripts: `tsc`-based build/`dev` watch targets with the
  `dist/cli.js` executable-bit step and `tsx`-driven generator scripts, where upstream drives
  `node scripts/*.ts` and `tsgo`.
- `packages/ai/scripts/generate-models.ts` stays divergent as the owner of the fork's catalog overlays:
  fork-only provider ingestion (`fetchOpenGatewayModels` merged into the model set alongside models.dev,
  OpenRouter, and AI Gateway; the Alibaba Cloud Model Studio `alibaba-token-plan` prepaid catalog pinned
  to its `ap-southeast-1` compatible-mode base URL), the Kimi Coding stable-ID floor
  (`KIMI_CODING_STABLE_MODELS` merged under the live catalog so `kimi-for-coding` and
  `kimi-k2-thinking` survive an upstream listing gap) with the K3 detector, `KIMI_K3_THINKING_LEVEL_MAP`,
  and K3's video input modality, the Priority-tier table that generates `-fast` variants for exactly the
  allowlisted OpenAI/Codex models, the documented per-model xAI reasoning maps
  (`XAI_THINKING_LEVEL_MAPS`, Grok 4.6 low/medium/high/xhigh), the adaptive-thinking compat facts that
  encode a thinking-off effort pin instead of `thinkingLevelMap.off: null`, and the GLM 5.2/5.3 and
  GPT-5.6 per-model overrides.

### Why

- The pinned `openai@6.26.0` is a deliberate dependency decision the fork repairs around at the type
  level (see `packages/ai/src/changes.md`, PR #892 entry); taking upstream's manifest would silently bump
  it. The extra runtime dependencies are not optional — fork-only source files import them directly — and
  the CalVer/private/`workspace` publication identity is what makes the fork's own packages resolvable.
  The generator overlays exist because the fork ships providers and priority tiers that models.dev does
  not describe, and because upstream catalog refreshes would otherwise drop stable Kimi IDs and
  fork-selectable reasoning levels.

### Why an extension could not handle it

- Dependency resolution, the published export map, and Node engine floor are resolved by the package
  manager before any runtime exists. Generated catalog metadata is written at build time and consumed by
  model selection, compaction, and admission long before the coding-agent extension runtime loads.

### Expected merge conflict zones

- HIGH: `packages/ai/package.json` — `version`/`private`, the `dependencies` block, and the `scripts`
  block; upstream edits all three on nearly every release. Keep the fork pins and script runners.
- MEDIUM: `packages/ai/scripts/generate-models.ts` — the provider ingestion list in the main generation
  function, the Kimi/Alibaba per-provider blocks, and the reasoning/thinking-level override chain, which
  upstream also edits when refreshing model metadata.
- LOW: the export-map subpath entries and the generated `src/providers/data/*.json` snapshots that a
  strict regeneration rewrites.

## Default GPT-5.6 Sol catalogs to 650k context (2026-08-27)

### What changed

- `packages/ai/scripts/generate-models.ts`: direct `openai` and ChatGPT OAuth `openai-codex` entries for `gpt-5.6-sol`
  now default to a 650,000-token context window. Their generated `-fast` variants inherit the same limit.
- `test/openai-fast-models.test.ts`: covers both providers and both base/fast Sol IDs.
- `src/providers/data/*.json`: regenerated committed catalog data and manifest carry the new default.
- The same reviewed regeneration refreshed Vercel AI Gateway's `alibaba/qwen3.8-27b` pricing from zero-value
  placeholder metadata to the current upstream rates: input 0.1, output 0.4, and cache read 0.01.

### Why

- The GPT-5.6 Sol service can accept up to a 1M context, but the default Senpi catalog should reserve a
  650k operating window instead of inheriting the generic 272k OpenAI short-tier cap or advertising the
  full service maximum.
- Terra and Luna remain at their existing 272k defaults; this change is intentionally scoped to Sol and Sol Fast.
- The Vercel Qwen price change is retained because generated provider data is an atomic snapshot of the
  upstream sources at generation time; keeping a stale per-model value would make the checked-in artifact
  disagree with a fresh strict regeneration.

### Why this cannot be expressed as an extension

- Context-window metadata is generated before the coding-agent extension runtime loads and is consumed by
  compaction, admission, and model-selection code throughout the runtime.

### Modified upstream files

- `packages/ai/scripts/generate-models.ts`
- `packages/ai/test/openai-fast-models.test.ts`
- `packages/ai/src/providers/data/*.json`

### Expected merge conflict zones

- MEDIUM: the temporary OpenAI metadata override block and explicit OpenAI Codex model list.
- MEDIUM: generated provider JSON whenever upstream model metadata changes.

## Current xAI Grok reasoning specifications (2026-08-18)

### What changed

- `packages/ai/scripts/generate-models.ts` now treats xAI reasoning controls as model-specific instead of inheriting the generic
  Grok compatibility veto. `grok-4.6` exposes only the documented `low`, `medium`, `high`, and `xhigh` levels and
  enables OpenAI-compatible `reasoning_effort` serialization. The fixed-reasoning Grok 4.20 variant exposes only
  `high`, while the non-reasoning variant exposes only `off`; neither Grok 4.20 model sends a reasoning-effort field.
- The generated xAI catalog again includes `grok-4.20-0309-reasoning` and
  `grok-4.20-0309-non-reasoning`. They were removed with the older 0.80.9 catalog cleanup, but current official xAI
  model pages and the live models.dev catalog list both canonical IDs as active tool-capable models.
- Focused catalog and payload tests pin the exact selectable levels and Chat Completions request bodies so future
  model-data hydration cannot silently disable Grok 4.6 effort control or remove the non-reasoning option.

### Why

- Senpi's generated metadata disabled `reasoning_effort` for every xAI Chat Completions model and kept the current
  Grok 4.20 variants out of the built-in catalog, contradicting xAI's published model specifications and the live
  models.dev inventory.

### Why an extension could not handle it

- The model selector reads built-in catalog metadata before extensions can alter provider request compatibility, and
  `reasoning_effort` is serialized inside the provider-owned OpenAI Completions adapter. An extension cannot safely
  repair both the catalog and the outbound xAI wire contract.

### Expected merge conflict zones

- MEDIUM: `packages/ai/scripts/generate-models.ts` xAI model filtering and per-model metadata; upstream model-catalog refreshes
  may edit the same constants and generation loop.
- LOW: generated `src/providers/data/xai.json`, its manifest hash, and focused xAI tests.

## Catalog generation and data validation audit backfill (2026-08-17)

### What changed

- `packages/ai/scripts/generate-models.ts`: carries the fork's accumulated generator divergences from the
  pinned upstream v0.84.2 script: OpenAI `-fast` priority-tier emission (`OPENAI_PRIORITY_TIER_MODEL_IDS`
  cloning eligible `openai` models with `upstreamModelId` plus `serviceTier: "priority"`), Kimi Coding
  fallback metadata that live models.dev data may override but not silently remove, Anthropic Opus 5
  adaptive-thinking and temperature-unsupported markers, the literal `anthropic/`/`qwen/`/`google/`
  cache-control prefix allowlist shared with runtime detection, GLM 5.3 catalog cloning (`isGlm5x` across
  zai, OpenRouter, Fireworks, opencode-go), DashScope `qwen*` families pinned to
  `thinkingFormat: "qwen"` (top-level `enable_thinking`), and the PR #892 provider-metadata refresh
  (`supportsAdditionalTools` on OpenAI/Codex entries, native DeepSeek `maxTokensField`, Cloudflare
  Responses `supportsStrictMode`, DeepSeek V4 Flash `low` reasoning effort).
- `packages/ai/scripts/generate-models.ts`: `glm-5.3` was added to
  `QWEN_TOKEN_PLAN_INDIVIDUAL_MODEL_IDS` with the GLM 5.3 expansion and removed again the same day
  (2026-08-16): models.dev does not yet publish GLM 5.3 for that provider, so the strict allowlist
  validation (exact model-ID match plus the strict-generation error assertion) failed. The other 24
  `glm-5.3` entries across 17 provider data files remain because only this provider carries the strict
  models.dev allowlist.
- `packages/ai/scripts/generate-image-models.ts`: beside the live OpenRouter fetch, the generator emits
  static hand-authored `IMAGE_MODELS.openai` entries (`gpt-image-2`, `gpt-image-1.5`; text-only input for
  the v1 generations endpoint; models.dev-quoted costs, zero-filled where unpublished). Serialization was
  generalized over `ImagesApi` (`serializeImageModel()`) so the OpenRouter-only emitter became a
  multi-provider emitter.
- `packages/ai/scripts/model-data.ts`: the shared schema/load validator accepts `"video"` as a valid
  model input modality beside `"text"` and `"image"`.

### Why

- The generated catalog is committed, reviewed source: regeneration must reproduce the fork's capability
  metadata (priority tiers, thinking maps, fallback entries) or typed model IDs and regressions drift and
  release generation fails static validation. The strict qwen-token-plan-individual allowlist exists
  precisely to catch unpublished IDs, which is why the GLM 5.3 addition had to be reverted rather than
  kept. OpenAI publishes no image-model catalog endpoint, so its image entries must be authored inside
  the generator, and the data validator must accept the `video` modality the Kimi K3 catalog entries
  declare or `check:model-data` rejects committed data.

### Why an extension could not handle it

- Model inventory and image catalogs are generated build-time data inside `packages/ai`; the coding-agent
  extension runtime loads after generation and cannot add typed catalog entries, alter generation
  allowlists, or relax the committed-data validator.

### Expected merge conflict zones

- MEDIUM: `packages/ai/scripts/generate-models.ts` provider-metadata blocks (GLM, Kimi, Opus 5, qwen,
  OpenAI priority tiers) whenever upstream regenerates or extends the same generator sites.
- LOW: `packages/ai/scripts/generate-image-models.ts` static OpenAI table and shared serializer.
- LOW: `packages/ai/scripts/model-data.ts` modality validation list.

## Follow Groq Qwen catalog replacement during generation (2026-08-04)

### What changed

- `scripts/generate-models.ts`: moved the Groq Qwen reasoning-level compatibility override from the removed
  `qwen/qwen3-32b` catalog entry to the active multimodal `qwen/qwen3.6-27b` replacement.
- `test/openai-completions-tool-choice.test.ts`: moved the focused `reasoning_effort` request regression to the
  same generated model ID.
- `src/providers/data/*.json`: refreshed the reviewed live provider snapshots so strict release generation and
  checked-in model-ID types agree.

### Why

- models.dev removed Qwen 3.2 after Groq's first-party model endpoint replaced it with Qwen 3.6. The release
  generator therefore removed the old typed ID, while the compatibility regression still referenced it, causing
  the `2026.8.4-2` release to fail during root TypeScript validation before any commit or tag was created.
- Groq documents Qwen 3.6 thinking mode as `reasoning_effort: "default"` and non-thinking mode as `"none"`, so
  the existing compatibility mapping remains required on the replacement model.

### Why this cannot be expressed as an extension

- Model inventory and provider-specific reasoning metadata are generated before the coding-agent extension runtime
  loads, and the typed built-in model IDs are consumed by the AI package itself.

### Modified upstream files

- `scripts/generate-models.ts`
- `test/openai-completions-tool-choice.test.ts`
- `src/providers/data/*.json`

### Expected merge conflict zones

- MEDIUM: the Groq branch of `applyThinkingLevelMetadata()` when upstream changes Qwen reasoning controls.
- MEDIUM: generated provider JSON whenever models.dev, OpenRouter, or OpenCode metadata changes again.

## OpenAI compatibility resolver merge repair (2026-08-01)

### What changed

- Restored `getOpenAICompletionsCompat` as the single compatibility resolver used and exported by the OpenAI Completions adapter.
- Ported upstream Z.AI `max_tokens` selection into the shared resolver.
- Preserved both automatically detected and explicitly configured `toolSchemaFlavor` values, with focused Moonshot coverage.

### Why

- The merge restored an upstream-local adapter resolver beside the fork's shared browser-safe resolver. The duplicate omitted Moonshot schema flavor selection, so wire-bound tool schemas retained an unsupported root `anyOf` wrapper.
- Keeping one resolver prevents API and browser-safe compatibility decisions from diverging again.

### Why this cannot be expressed externally

- Provider compatibility selection and final wire-payload schema normalization occur inside the provider adapter before extension hooks can safely compensate.

### Expected merge conflict zones

- `src/api/openai-completions.ts`, `src/utils/prompt-cache-ttl.ts`, OpenAI compatibility types, and tool-schema/prompt-cache tests.

## Require explicit opt-in before probing Ollama in stream tests (2026-07-31)

### What changed

- `test/live-api-gates.ts`: owns Ollama discovery behind a gate that short-circuits before probing unless
  `PI_ENABLE_LOCAL_LLM=1` or `PI_ENABLE_LIVE_API_TESTS=1`, using `where ollama` on Windows and `which ollama`
  elsewhere.
- `test/live-api-gates.test.ts`: mocks the command boundary and covers the default no-probe behavior, both
  explicit opt-in paths, and both platform-specific lookup commands.
- `test/stream.test.ts`: uses the gated Ollama discovery function instead of treating the absence of
  `PI_NO_LOCAL_LLM` as permission to probe and run the live suite.
- `../../test.sh`: clears the two opt-in flags instead of exporting the retired `PI_NO_LOCAL_LLM` opt-out flag.

### Why

- A normal `npm test` on a machine with Ollama installed could enter the live suite, pull `gpt-oss:20b`, start
  a local server, and load a large model without explicit consent. Default workspace tests must not probe or
  start local model infrastructure.

### Why extension system couldn't handle this

- This behavior occurs during `packages/ai` Vitest discovery and setup, before the coding-agent extension
  surface is involved.

### Modified upstream files

- `test/live-api-gates.test.ts`
- `test/live-api-gates.ts`
- `test/stream.test.ts`
- `../../test.sh`

### Expected merge conflict zones

- LOW: `test/live-api-gates.ts` and its tests may conflict if upstream changes live-test activation helpers.
- MEDIUM: the Ollama discovery and setup block in `test/stream.test.ts` may conflict if upstream changes how
  the local OpenAI-compatible test server is detected or started.
- LOW: `../../test.sh` may conflict if upstream changes its isolated live-test environment variables.

## Shared reasoning-tier capability detection (2026-07-30)

### What changed

- Shared `xhigh` / `max` model-family constants are hoisted in `models.ts`, and map-less inference now uses
  one case-normalized, boundary-aware family matcher instead of unbounded substring checks.
- `getSupportedThinkingLevels` delegates extended-tier precedence to the exported `supportsXhigh` and
  `supportsMax` predicates rather than duplicating their map-omission and `null`-veto rules.

### Why

- Capability inference for custom map-less models should reject unrelated ids and case-normalize legitimate
  aliases while keeping one precedence implementation. Generated catalog models retain their explicit maps,
  so behavior for real catalog models is intentionally unchanged.

## Browser-safe prompt-cache TTL resolver (2026-07-28)

### What changed

- `src/utils/prompt-cache-ttl.ts` (new): `resolvePromptCacheTtlSeconds(model, env?) -> number | undefined`
  plus `PROMPT_CACHE_TTL_SHORT_SECONDS` (300) / `PROMPT_CACHE_TTL_LONG_SECONDS` (3600). It mirrors EACH
  target API's own `resolveCacheRetention` precedence verbatim rather than inventing a unified one:
  anthropic-messages falls back to `"short"` and honors the bare `process.env.PI_CACHE_RETENTION`
  set-but-not-long branch; openai-completions / openai-responses / bedrock fall back to `"short"`;
  pi-messages returns `undefined` (backend default). Retention `"none"` and every API with unknown cache
  semantics (google, mistral, pi-messages, unknown) resolve to `undefined`.
- The pure compat predicates the resolver needs moved INTO that browser-safe utility and the API modules now
  import them from there and re-export for their existing consumers: `getAnthropicCompat` +
  `isAnthropicApiBaseUrl` (from `src/api/anthropic-messages.ts`), the resolved-compat getter (from
  `src/api/openai-completions.ts`), and `supportsPromptCaching` (from `src/api/bedrock-converse-stream.ts`).
- `src/index.ts` exports the new module from the browser-safe root surface.

### Why

- senpi sizes how long its `bash` tool and omo's `task` tool may block in the foreground on the active model's
  prompt-cache lifetime. That lifetime is already decided per provider inside this package, so one shared
  resolver here is the single source of truth instead of a table duplicated in every consumer.

### Why the compat predicates had to move rather than be imported

- The root surface is browser-safe. Importing `supportsPromptCaching` directly from
  `src/api/bedrock-converse-stream.ts` pulled the AWS SDK (`@smithy/node-http-handler`, `agent-base`,
  `http-proxy-agent`) into the browser bundle and broke `npm run check:browser-smoke` with 18 unresolved
  `node:*` errors. Moving the pure predicates into the utility and re-exporting from the API modules keeps
  one definition with no divergence risk, and keeps the root import graph free of Node-only dependencies.

### Modified upstream files

- `src/api/anthropic-messages.ts`
- `src/api/bedrock-converse-stream.ts`
- `src/api/openai-completions.ts`
- `src/index.ts`

### Expected merge conflict zones

- MEDIUM: each API module's `resolveCacheRetention` / compat-getter region, where the local definition became
  an import + re-export. If upstream edits those predicates, port the edit into
  `src/utils/prompt-cache-ttl.ts` so the resolver and the adapters stay in agreement.


## Cover Claude Opus 5 in Anthropic adaptive-thinking metadata (2026-07-25)

### What changed

- `scripts/generate-models.ts`: `isAnthropicAdaptiveThinkingModel` and `isAnthropicTemperatureUnsupportedModel` now
  match Opus 5 ids, and Opus 5 joins the native `xhigh`/`max` effort ladder alongside Opus 4.7/4.8 and Sonnet 5.
- `src/api/anthropic-messages.ts`: `ADAPTIVE_THINKING_MODEL_MARKERS` gained `opus-4-8` and `opus-5`, and
  `mapThinkingLevelToEffort` maps Opus 5 `xhigh`/`max` to native efforts instead of collapsing them to `high`.
- `src/providers/data/*.json`: regenerated so every provider that serves Opus 5 (anthropic, github-copilot,
  opencode, vercel-ai-gateway, openrouter, amazon-bedrock) carries `forceAdaptiveThinking`, `supportsTemperature:
  false`, and the `xhigh`/`max` thinking level map.

### Why

- Opus 5 is adaptive-thinking only. Sending it the legacy `thinking: { type: "enabled", budget_tokens }` payload is
  accepted by the API but produces a thinking block with no thinking text, so the model answers as if reasoning were
  disabled. Measured against the live API: legacy payload returned 0 thinking characters, while
  `thinking: { type: "adaptive" }` on the same prompt returned real thinking content.
- Without markers or catalog metadata, `supportsAdaptiveThinking()` fell through to the legacy branch for every
  provider whose Opus 5 entry had no `compat`, including proxy providers.
- Opus 5 also honors native `xhigh` and `max` effort, and they scale reasoning materially (measured on one prompt:
  high 849 thinking chars, xhigh 1123, max 3217). Mapping both down to `high` silently capped the model.

### Why extension system couldn't handle this

- Adaptive-thinking detection and effort mapping happen while building the Anthropic Messages payload inside
  `packages/ai`, below any extension-visible surface, and the model catalog is generated build-time data.

### Modified upstream files

- `scripts/generate-models.ts`
- `src/api/anthropic-messages.ts`
- `src/providers/data/*.json`

### Expected merge conflict zones

- LOW: marker/predicate lists are append-only additions next to existing Opus/Sonnet entries.
- MEDIUM: regenerated provider data files conflict textually whenever upstream regenerates the same catalogs.

## Carry non-enumerable context provenance through Responses conversion (2026-07-24)

### What changed

- `src/context-provenance.ts`: added request-local, non-enumerable message/item provenance tokens.
- `src/api/openai-responses-shared.ts`: preserves those tokens while converting messages to Responses input items.
- `src/types.ts` and `src/index.ts`: expose the typed provenance helpers needed by coding-agent's replay boundary.
- `src/utils/openai-codex-auth.ts`: centralizes browser-safe ChatGPT account-ID extraction so normal Codex requests
  and remote compaction canonicalize the same wire tenant across bearer-token refreshes.

### Why

- Provider-wire value equality cannot distinguish duplicated messages after filtering or injection. Replay slicing now
  requires the exact checkpoint-origin identities to survive the canonical context pipeline.

### Why extension system couldn't handle this

- The provenance must survive conversion inside `packages/ai`, below extension-visible provider payloads.

### Modified upstream files

- `src/api/openai-responses-shared.ts`
- `src/index.ts`
- `src/types.ts`
- `src/utils/openai-codex-auth.ts`

### Expected merge conflict zones

- MEDIUM: Responses message conversion and shared public types.

## Export canonical OpenAI Responses message conversion (2026-07-24)

### What changed

- `src/index.ts`: exports `convertResponsesMessages` from the browser-safe root so coding-agent remote-compaction
  replay can locate checkpoint boundaries with the exact conversion semantics used by the real provider pipeline.

### Why

- Counting checkpoint items with a separate converter could drop or duplicate the current prompt when errored/aborted
  assistants, orphaned tool results, empty users, or provider-native blocks changed item cardinality.

### Why extension system couldn't handle this

- The boundary is defined by the provider wire conversion in `packages/ai`, below the coding-agent extension layer.

### Modified upstream files

- `src/index.ts`

### Expected merge conflict zones

- LOW: root exports if upstream reorganizes OpenAI Responses helpers.

## Commit generated model catalog data for reproducible builds (2026-07-18)

### What changed

- `../../.gitignore`: removed the `packages/ai/src/providers/data/` ignore rule so generated catalog JSON is committed,
  reviewed source, matching `src/models.generated.ts`.
- `package.json`: the ordinary `build` no longer runs `generate-models`; it compiles, restores the CLI executable bit,
  and copies the committed `src/providers/data/` into `dist`. Networked regeneration stays explicit via the
  `generate-models` script, the root `generate:models` workflow, release tooling, and `prepublishOnly`.
- `../../scripts/build-all.test.mjs`: the AI build config regression now asserts the ordinary build skips networked
  generation, keeps the committed-data copy step, retains the explicit generator workflow, and leaves catalog JSON
  unignored.
- `README.md`: model-generation guidance now describes `src/providers/data/` as committed generated values.

### Why

- The ordinary AI build fetched models.dev and provider APIs to regenerate ignored JSON catalog data, so a build could
  emit an unreviewed or different catalog and failed entirely offline. The committed `.models.ts` shards import the
  JSON at compile time, so the catalog must be committed generated source for the build to be reproducible.

### Why extension system couldn't handle this

- Model inventory is generated before the coding-agent extension runtime is loaded, and package build scripts run
  before any extension hook exists.

### Modified upstream files

- `package.json`
- `README.md`
- `../../.gitignore`
- `../../scripts/build-all.test.mjs`

### Expected merge conflict zones

- LOW: AI package build scripts if upstream changes the compiler command or bin generation flow.

## Preserve stable Kimi Coding model IDs during catalog generation (2026-07-17)

### What changed

- `scripts/generate-models.ts`: added fallback metadata for `kimi-for-coding` and `kimi-k2-thinking` that live
  `models.dev` metadata can override but cannot silently remove.

### Why

- Senpi's public model catalog and provider regressions still support these IDs. A transient upstream catalog omission
  caused release-time model regeneration to remove them and fail static validation.

### Why extension system couldn't handle this

- Model inventory is generated before the coding-agent extension runtime is loaded.

### Modified upstream files

- `scripts/generate-models.ts`

### Expected merge conflict zones

- MEDIUM: the Kimi Coding generation block if upstream changes alias or fallback handling.

## Preserve the generated CLI executable bit during builds (2026-07-13)

### What changed

- `package.json`: ordinary AI builds now restore the executable bit on `dist/cli.js`, matching the existing publish-only safeguard.
- `../../scripts/build-all.test.mjs`: added a regression assertion for the executable-bit build step.

### Why

- TypeScript can rewrite `dist/cli.js` with mode `0644` when AI sources change. The release workflow runs an ordinary build before staging its release commit, so that rewrite could silently reverse the tracked executable mode.

### Why extension system couldn't handle this

- This is package build and release behavior that runs before the coding-agent extension system is loaded.

### Modified upstream files

- `package.json`
- `../../scripts/build-all.test.mjs`

### Expected merge conflict zones

- LOW: AI package build scripts if upstream changes the compiler command or bin generation flow.

## Upstream model generation and test sync (2026-07-02)

### What changed

- `scripts/generate-models.ts`: accepted upstream removal of stale model metadata fallbacks, including Copilot Sonnet 5
  fallback cleanup.
- Updated focused AI regression tests covering Fireworks model routing, GitHub Copilot OAuth, delayed device-code polling,
  and OpenAI Codex stream request-body handling.

### Why

- The fork should now rely on live/generated model metadata instead of keeping stale fallback entries, while preserving
  coverage for provider behavior touched by the upstream sync.

### Why extension system couldn't handle this

- Model generation is a build-time catalog script, and the changed tests assert provider/library behavior outside the
  coding-agent extension runtime.

### Modified upstream files

- `scripts/generate-models.ts`
- `test/fireworks-models.test.ts`
- `test/github-copilot-oauth.test.ts`
- `test/oauth-device-code.test.ts`
- `test/openai-codex-stream.test.ts`

### Expected merge conflict zones

- MEDIUM: `scripts/generate-models.ts` if upstream changes provider metadata fetch or fallback handling again.
- LOW: focused provider tests if upstream changes request decoding, OAuth polling timing, or Fireworks model mappings.

## Explicit live API opt-in for ambient credentials (2026-05-12)

### What changed

- `test/live-api-gates.ts`: Added shared live-test gate helpers. Ambient provider keys and local model probes are ignored unless `PI_ENABLE_LIVE_API_TESTS=1` or the provider-specific flag is set.
- `test/oauth.ts`: OAuth tokens from `~/.pi/agent/auth.json` now resolve only for explicitly enabled live OAuth test providers.
- OpenRouter live suites in image, streaming, context-overflow, total-token, and thinking-disable tests now require `PI_ENABLE_OPENROUTER_LIVE=1` in addition to a key.
- Local context-overflow suites now require `PI_ENABLE_LOCAL_LLM=1`, matching the existing fork policy that local model servers must be explicit opt-in.

### Why

- `npm test --workspaces --if-present` must pass in developer environments that contain stale or unrelated credentials and local model daemons. An invalid ambient `OPENROUTER_API_KEY`, stale Anthropic OAuth token, and empty LM Studio server caused live suites to run and fail for reasons unrelated to the code under test.

### Why extension system couldn't handle this

- These are `packages/ai` integration-test activation rules. Extension hooks are not involved in test discovery or live provider credential resolution.

### Modified upstream files

- `test/oauth.ts`
- `test/context-overflow.test.ts`
- `test/google-thinking-disable.test.ts`
- `test/image-tool-result.test.ts`
- `test/images.test.ts`
- `test/live-api-gates.test.ts`
- `test/live-api-gates.ts`
- `test/stream.test.ts`
- `test/total-tokens.test.ts`

### Expected merge conflict zones

- Upstream currently gates many live suites directly on credential presence. Rebase conflicts are likely in any live provider test that changes `describe.skipIf(!process.env.<KEY>)` conditions or OAuth token bootstrapping.

## Live API test gating fixes (2026-04-09)

### What changed

- `test/tool-call-id-normalization.test.ts`: the OpenRouter `gpt-5.2-codex` cases now pass `reasoning: "high"` so the live regression test still exercises tool-call ID normalization against the endpoint's current reasoning requirement.
- `test/cross-provider-handoff.test.ts`: the minimum-fixture assertion now exits early when fewer than two live fixtures are actually generated, so the suite skips gracefully in environments without enough working provider credentials.
- `test/bedrock-utils.ts`: Bedrock live tests now require both credentials and an explicit AWS region before enabling.
- `test/context-overflow.test.ts`: the OpenRouter Anthropic overflow case now accepts the provider's current managed-overflow behavior, and LM Studio overflow tests only auto-enable when `PI_ENABLE_LOCAL_LLM=1`.
- `test/openrouter-cache-write-repro.test.ts`: the narrow OpenRouter cache-write regression is now explicit opt-in via `PI_ENABLE_OPENROUTER_CACHE_WRITE_REPRO=1`.
- `test/total-tokens.test.ts`: the unstable OpenRouter `deepseek/deepseek-chat` total-token regression is now explicit opt-in via `PI_ENABLE_OPENROUTER_DEEPSEEK_TOTAL_TOKENS=1`.

### Why

- OpenRouter now rejects `openai/gpt-5.2-codex` requests when reasoning is omitted or disabled, which broke the normalization regression for reasons unrelated to tool-call ID handling.
- The cross-provider handoff suite assumes multiple working live providers, but `npm test --workspaces --if-present` must pass even when the environment has no valid API keys (or only a partial/invalid live setup).
- Ambient Bedrock tokens without a region and auto-detected local model servers were causing unrelated live E2E suites to run in non-reproducible environments.
- A few narrow OpenRouter regressions are currently backend-specific and unstable in shared environments, so they now require explicit opt-in instead of making the default workspace test command flaky.

### Why extension system couldn't handle this

These failures are in upstream `packages/ai` live integration tests, not in the coding-agent extension surface. Fixing them required targeted test-only updates in `packages/ai/test/`.

### Modified upstream files

- `test/tool-call-id-normalization.test.ts`
- `test/cross-provider-handoff.test.ts`
- `test/bedrock-utils.ts`
- `test/context-overflow.test.ts`
- `test/openrouter-cache-write-repro.test.ts`
- `test/total-tokens.test.ts`

### Expected merge conflict zones

- `test/tool-call-id-normalization.test.ts`: OpenRouter live test options may need re-merging if upstream changes the regression coverage or request options.
- `test/cross-provider-handoff.test.ts`: fixture-count gating may need re-merging if upstream restructures the live handoff bootstrap assertions.
- `test/bedrock-utils.ts`: credential gating may need re-merging if upstream changes how Bedrock test auth is detected.
- `test/context-overflow.test.ts`: OpenRouter overflow handling and local-LM opt-in logic may need re-merging if upstream revises those E2E expectations.
- `test/openrouter-cache-write-repro.test.ts` and `test/total-tokens.test.ts`: explicit opt-in guards may need re-merging if the affected OpenRouter backends become stable again.

## TypeScript native tsc migration (2026-08-02)

### What changed

- Replaced the `tsgo` compiler invocation with `tsc` in the `build`, `build:offline`, `dev`, `dev:tsc`, and `prepublishOnly` scripts; all flags and arguments remain unchanged.
- Bumped the root `typescript` pin from `6.0.3` to `7.0.2`.
- Dropped the `@typescript/native-preview` toolchain dependency.
- Added `@typescript/typescript6@6.0.2` (Microsoft's official TypeScript-6 API bridge) so `scripts/check-ts-relative-imports.mjs` keeps working: TypeScript 7 removed the classic programmatic JS API it imported.
- Added `@typescript/native: npm:typescript@7.0.2` as a scoped alias. The `typescript6` package publicly depends on `@typescript/old` (typescript 6.x), and npm hoists it; alphabetically `@typescript/old` beats `typescript` for the `node_modules/.bin/tsc` link, which would make every bare `tsc` invocation (root check and all package builds) silently run the TypeScript 6 compiler. The alias sorts after `@typescript/old`, so it deterministically wins the `.bin/tsc` link to the 7.0.2 native compiler. It is a bin-ownership pin, not an import target.

### Why

- Adopt a stable-first toolchain policy: use the released `typescript@7.0.2` native compiler for package builds and typechecks instead of the experimental `tsgo` dev build.
- The `native-preview` compiler has been retired upstream in favor of `typescript@next`.

### Why this cannot be expressed externally

- Build scripts and `devDependencies` are package infrastructure, not runtime behavior; extensions cannot rewrite another package's manifest scripts or compiler selection.

### Expected merge conflict zones

- `package.json` `scripts` blocks and `devDependencies` anywhere upstream still references `tsgo` or `@typescript/native-preview`.

## 2026-08-25 - Upstream provider and reasoning sync coverage

### What changed

- `packages/ai/scripts/generate-models.ts`, `packages/ai/src/api/openai-completions.ts`, and `packages/ai/src/providers/cloudflare-ai-gateway.ts` adopt the upstream model metadata, reasoning replay, and provider typing updates while retaining fork behavior.

### Why

- The upstream sync changes provider generation and wire behavior that must remain tracked by the nearest fork tracker.

### Why this lives in the fork

- Provider generation and adapter serialization execute below the extension boundary.

### Expected merge conflict zones

- Generator provider loops and OpenAI/Cloudflare adapter declarations.

## 2026-08-25 - Preserve generated ZAI pricing during upstream sync

### What changed

- `packages/ai/src/providers/data/zai.json` and `packages/ai/src/providers/data/zai-coding-cn.json` retain fork API-equivalent reference pricing for Coding Plan models.

### Why

- Generated catalogs must preserve the fork's pricing contract after upstream regeneration.

### Why this lives in the fork

- Catalog values are consumed directly by provider model resolution and cannot be corrected by extensions.

### Expected merge conflict zones

- Generated ZAI provider catalog entries and the model generator's reference-cost selection.
