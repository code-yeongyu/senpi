## 2026-10-10 - Test-run temporary storage has an owner (senpi#3064)

### What changed

- `packages/ai/package.json`: test invocations use scripts/run-tests.mjs so TMPDIR/TEMP/TMP are scoped before the test runtime starts and cleaned after exit.
- `packages/ai/vitest.config.ts`: always load the fixture teardown adapter, retaining CI diagnostics; plain subprocess helpers do not import framework hooks.

### Why

- Vitest SSR copies and interrupted fixture writes must not accumulate in the OS temp directory.

### Why an extension could not handle it

- Test-process bootstrap is repository tooling, before runtime extensions load.

### Expected merge conflict zones

- Test command arguments and runtime selection; preserve existing reporters, shards and test filters.

## 2026-10-08 - Native ChatGPT Subscription Sol Ultrafast catalog variant

### What changed

- `packages/ai/scripts/generate-models.ts`: clones the fully processed ChatGPT Subscription `gpt-6.1-sol` row into `gpt-6.1-sol-ultrafast`, with upstream model `gpt-6.1-sol`, service tier `ultrafast`, and default thinking level `xhigh`. The generated subscription shard and manifest are regenerated with a provider-scoped run.

### Why

- Make the working subscription alias selectable from the native catalog without a local extension. Preserve Sol's Standard base and long-context cost metadata; the adapters apply the published Ultrafast 6x multiplier at request time without double-counting.
- The `xhigh` default deliberately preserves the existing local alias's high-reasoning preset while requesting faster serving; it is not the backend's default effort or a minimum-latency preset, and users can select a lower effort.

### Why an extension could not handle it

- A local extension can register the alias, but cannot make it part of the shipped catalog for every installation.

### Expected merge conflict zones

- LOW: the variant emission block after metadata application in `packages/ai/scripts/generate-models.ts`. Regenerate catalog JSON and its manifest rather than hand-merging.

## 2026-10-08 - Claude Haiku 5.5 catalog rows (senpi#2892)

### What changed

- `packages/ai/scripts/generate-models.ts`:
  - An explicit `claude-haiku-5-5` anthropic row, kept only when models.dev omits it: limits 1M/128000, text + image input, effort low..max, and the 100K tier over the 0.1 / 0.5 / 0.01 / 0.125 base.
  - `isAnthropicAdaptiveOnlyModel`, `isAnthropicAdaptiveThinkingModel`, `isAnthropicTemperatureUnsupportedModel`, `supportsAnthropicMidConvoEffort` and `supportsAnthropicMidConvoSystemMessages` match `haiku-5-5` / `haiku-5.5` the way they match Sonnet 5.5, and the effort-metadata merge covers `claude-haiku-5-5`.
  - The adaptive-only comment records that Haiku 5.5 accepts `thinking: {type: "disabled"}` at effort `high` or below (its effort docs), and that a real thinking-off waits on marker handling (senpi#2927).
  - `withClaudeHaiku55LongContextPricing`, run in the temporary-overrides pass, gives every Haiku 5.5 row that has no tier `inputTokensAbove: 100000` at five times each of its own base rates. Anthropic's long-context rates are exactly 5x the base. This covers regional Bedrock rows, OpenRouter's batch variant and gateway markups, and models.dev-tiered rows keep their tiers.
  - The explicit Sonnet 5.5 fallback row's cache read is 0.1.
  - The same pass caps every Haiku 5.5 row at `contextWindow: 100000` (the threshold of the 5x band) and, unconditionally, `maxTokens: 32000`, so compaction runs before a prompt crosses into long-context billing (upstream oh-my-pi #14903 caps the same way). The documented 1M / 128K is a `models.json` `modelOverrides` opt-in until senpi#2916 adds a first-class setting. Output drops with the window because compaction reserves min(maxTokens, half the window) for output: at 100K / 128K, emergency pruning would start at 47.5K, below the 60K adaptive threshold.
- Regenerated with `--strict --providers anthropic,amazon-bedrock,opencode,opencode-go`:
  - `anthropic.json` `claude-haiku-5-5`.
  - `amazon-bedrock.json` `anthropic.`, `global.`, `us.`, `eu.`, `jp.`, `au.anthropic.claude-haiku-5-5`.
  - `opencode.json` and `opencode-go.json` `claude-haiku-5-5`.
  - Drift that rode along in `anthropic.json` from models.dev:
    - `claude-sonnet-5-5` cache read 0.2 -> 0.1.
    - `claude-sonnet-4-5` / `claude-sonnet-4-5-20250929` context 1M -> 200K with 100 images per request (https://platform.claude.com/docs/en/build-with-claude/context-windows).
- `openrouter.json` (`anthropic/claude-haiku-5.5`, `anthropic/claude-haiku-5.5:batch`), `vercel-ai-gateway.json` (`anthropic/claude-haiku-5.5`) and `venice.json` (`claude-haiku-5-5`):
  - Each row is the generator's own output from a `--strict --providers openrouter,venice,vercel-ai-gateway` run, inserted alone into the committed file.
  - The manifest is rebuilt with `createModelDataManifest` and `check:model-data` passes.
  - The rest of that run, unrelated upstream drift, was left out: about 25 OpenRouter metadata refreshes, 3 Vercel removals, and Venice price changes.
- No `ANTHROPIC_ALLOWED_FALLBACK_MODELS` entry: Haiku 5.5 has no server-side refusal fallback.

### Why

Claude Haiku 5.5 shipped on 2026-10-07 (https://platform.claude.com/docs/en/models/haiku-5-5/overview):
- adaptive thinking only (`budget_tokens` is a 400);
- no sampling parameters;
- signed thinking bound to the preceding conversation, like Sonnet 5.5;
- forced `tool_choice` accepted;
- request-wide long-context pricing above 100K input tokens.

### Why an extension could not handle it

Generated catalog data and the generator's model-family rules.

### Expected merge conflict zones

- LOW: the Anthropic family helpers, the explicit Opus/Sonnet/Haiku 5.5 rows and the temporary-overrides loop (Haiku 5.5 tier and window cap) in `generate-models.ts`. Generated JSON regenerates. A full regeneration of openrouter, vercel-ai-gateway or venice also brings the drift left out here.

## 2026-10-02 - OpenGateway catalog stays current: shared OpenAI input cap (senpi#2552)

### What changed

- `packages/ai/scripts/generate-models.ts`: the OpenAI input/output split (`applyOpenAiInputCap`) moved to `src/utils/openai-input-cap.ts` unchanged, so the OpenGateway runtime refresh caps a newly served GPT-5.x/GPT-6 row the same way the generator caps shipped rows. The generator imports it instead of keeping a private copy.

### Why

The runtime refresh adds models the shipped catalog lacks; without the shared cap a new GPT row would advertise the raw 1,050,000-token window and over-budget prompts would be rejected upstream (#1422).

### Why an extension could not handle it

The generator and the built-in OpenGateway provider both live in the AI package and must share one input-budget rule.

### Expected merge conflict zones

- `packages/ai/scripts/generate-models.ts`: the import block and the OpenAI context-window constants next to `OPENAI_MAX_CONTEXT_INPUT_CAP`; an upstream edit to the removed helper belongs in `src/utils/openai-input-cap.ts`.

## 2026-09-30 - Scope model data generation to selected providers (senpi#1431)

### What changed

- `packages/ai/scripts/generate-models.ts` accepts `--providers <comma-separated IDs>` for strict, provider-scoped data regeneration. It preserves every unselected data file byte-for-byte, rebuilds the manifest over the mixed staged set, validates the complete catalog atomically, and leaves generated TypeScript shards untouched. `--generated-at` pins a reproducible manifest timestamp for scoped runs.
- `packages/ai/test/generate-models-strict.test.ts` exercises the real generator CLI with fixture HTTP responses, byte-stable repeat output, full manifest validation, and rejected missing or inherited provider selectors.

### Why

- A capability-only catalog correction must not pick up unrelated live-provider price, context, or inventory churn from full regeneration.

### Why an extension could not handle it

- Model-data generation and manifest integrity run at build time before extensions load.

### Expected merge conflict zones

- MEDIUM: `packages/ai/scripts/generate-models.ts` option parsing and staged data writer.

## 2026-09-30 - Toggle-only thinking maps for generated catalog rows (senpi#891)

### What changed

- `packages/ai/scripts/generate-models.ts`: normalize reasoning support for eligible toggle-only provider formats into the on/off thinking-level map while preserving explicit effort maps and unsupported-model metadata.
- `packages/ai/src/providers/data/*.json` + `.manifest.json`: regenerated catalog shards carry the normalized capability map.
- `packages/ai/test/issue-891-thinking-capabilities.test.ts` and `packages/ai/test/generate-models-strict.test.ts`: pin the GLM 4.7, Qwen, explicit-effort, preview, and transport boundaries.

### Why

Toggle-only reasoning providers must expose a selectable enabled state without advertising unsupported effort levels; otherwise clients either cannot enable thinking or send invalid effort values.

### Why an extension could not handle it

The generator and its committed catalog shards ship inside the AI package, so runtime extensions cannot change the selected thinking capabilities.

### Expected merge conflict zones

- `packages/ai/scripts/generate-models.ts`: metadata normalization order and format predicates.
- `packages/ai/src/providers/data/*.json` + `.manifest.json`: regenerate rather than hand-merge.

## 2026-09-30 - Sync with upstream v0.99.1 (6a4af07d6): renamed ChatGPT subscription tests

### What changed

- `packages/ai/test/openai-codex-oauth.test.ts` -> `packages/ai/test/chatgpt-subscription-oauth.test.ts` and `packages/ai/test/openai-codex-stream.test.ts` -> `packages/ai/test/chatgpt-subscription-stream.test.ts` under fork rename commit `3c816ead49`; upstream v0.99.1 assertions were merged into the renamed suites.

### Why

The fork renamed the provider from `openai-codex` to `chatgpt-subscription` (D-4). Keeping both test paths would duplicate the same OAuth and stream contract under conflicting provider identities.

### Why an extension could not handle it

These suites exercise provider transport and OAuth internals rather than extension behavior.

### Expected merge conflict zones

- HIGH: upstream additions to either legacy test path must be ported into the matching `chatgpt-subscription` suite.

## 2026-09-30 - Sync with upstream v0.99.1 (6a4af07d6): generator re-emits Fireworks native tool references

### What changed

- `packages/ai/scripts/generate-models.ts`: the Fireworks Anthropic-Messages compat sets `supportsToolReferences: true` again; the regenerated `src/providers/data/fireworks.json` carries it on every Fireworks Messages model.

### Why

The upstream sync auto-merge dropped this fork line from the generator, although the A2 contract keeps `AnthropicMessagesCompat.supportsToolReferences` because fork tool-search native loading and generate-models set it. Without it the shipped catalog silently turned off Fireworks native tool references (`tool_reference` deferral).

### Why an extension could not handle it

The builtin catalog is generated build-time data the runtime loads before any extension exists.

### Expected merge conflict zones

- MEDIUM: `processFireworksModels` `anthropicCompat`; upstream deleted the key, so an upstream edit there drops it again.

## 2026-09-30 - Sync with upstream v0.99.1 (6a4af07d6): ai model catalog and generator

### What changed

- `packages/ai/scripts/generate-models.ts`: resolved by L2b against upstream v0.99.1 (6a4af07d6): upstream constructs adopted, fork behavior kept.
- `packages/ai/scripts/model-data.ts`: `model-data.ts` keeps the fork's video input modality (new `isInputModalityList`) and the fork-owned/imported shard filter.

### Why

Upstream v0.99.1 (6a4af07d6) changed these paths while the fork carries its own behavior; the model catalog and generator take the upstream v6 schema while fork rows (GPT-6 family, chatgpt-subscription, fork-owned shards) win on overlap (plan D-9, D-3).

### Why an extension could not handle it

The generated catalog and its generator are build-time data the runtime loads before any extension exists.

### Expected merge conflict zones

Every path listed above conflicts again where upstream edits the hunks named in its line; the fork-kept constructs named there are the anchors to preserve.

## 2026-09-30 - Sync with upstream v0.99.1 (6a4af07d6): manifests, build and check scripts

### What changed

- `packages/ai/package.json`: Root `package.json`: fork scripts kept (`build-all.mjs` build, the fork `check` chain with conflict-marker/bun-lock/install-lock/claude-sdk-platform-lock gates, `run-workspaces.mjs` launchers, `refresh-lock`, `preinstall`); devDependencies kept (biome 2.5.14, @types/node 26.6.2, typescript 7.0.2, @typescript/typescript6, tsx 4.23.13, vitest + @vitest/coverage-v8 5.0.1). Adopted from upstream: `generate:models` runs generate-models only (the `generate-image-models` chain dropped for the D-3 image-model unification), and `test:scripts` also runs the adopted upstream `scripts/model-catalog-protocol.test.ts`. Not adopted: codemode/mcp/durable build phases, the tsx removal. `packages/ai/package.json`: `openai` 6.26.0 -> 7.19.0 (hold lifted, D-10); `generate-image-models` script and its `prepublishOnly` step removed (D-3 ADOPT form; task 28 restores both from OURS if the D-3 fallback is taken). Version, internal ranges, fork scripts and deps unchanged.

### Why

- The fork builds through `scripts/build-all.mjs` and runs sources with tsx (D-11); upstream's plain-node source execution and TypeScript-7 script rewrites are mechanism changes the fork already covers.
- Upstream codemode, MCP, tool-search and durable are excluded (D-2, D-7), so their workspace packages, dependencies, build phases, tsconfig/vitest aliases and smoke checks stay out.
- The `openai` 6.26.0 hold had no failing check behind it and the adopted upstream OpenAI adapters target 7.19.0 (D-10).
- chord follows upstream 0.99.1 with exact pins (D-12, check:pinned-deps).

### Why an extension could not handle it

Workspace manifests, tsconfig and build/check scripts are repository build infrastructure, outside any runtime extension.

### Expected merge conflict zones

Every path listed above conflicts again where upstream edits the hunks named in its line; the fork-kept constructs named there are the anchors to preserve.

## 2026-09-30 - GPT-6.1 Sol under Venice's dotless id, plus the Copilot and OpenCode rows models.dev now lists (senpi#2390)

### What changed

- `packages/ai/scripts/generate-models.ts`: `GPT_6_FAMILY_DEFAULT_CONTEXT_WINDOWS` gains the marker `gpt-61-sol` (Venice spells every point release without the dot: `openai-gpt-56-sol`, `openai-gpt-61-sol`), and `applyGpt6ThinkingLevels` forces `off: null` through the new `isGpt61SolId` for both spellings.
- `packages/ai/src/providers/data/` regenerated with `--strict` now that models.dev lists the model: +1 `github-copilot.json` (`gpt-6.1-sol`, 2/10/0.1/2.5 + tier, 400k budget, ladder low..max), +1 `opencode.json` (`gpt-6.1-sol`, 2/10/0.2/2.5 as models.dev prices it), +1 `venice.json` (`openai-gpt-61-sol`, 2.5/12.5/0.125/3.125, now the 400k budget instead of the 1,050,000 total that landed above the 922k input cap). Incidental drift: OpenRouter DeepSeek V4 Pro 0813 and `~z-ai/glm-latest` / `z-ai/glm-5.2` prices. No id removed.
- `test/openai-input-cap-catalog.test.ts`: the deliberate 400k pairing covers `gpt-61-sol`, and the Venice, OpenCode and Copilot rows are pinned to 400,000 / 128,000.

### Why

The release job regenerates the catalog before `npm run check`; a dry run on the merged head showed the Venice row would ship with `contextWindow: 1050000` because the `gpt-6.1-sol` substring markers never see the dotless id. A prompt budget above the documented input cap lets a session run into `context_too_large` instead of compacting.

### Why an extension could not handle it

The catalog shards ship inside this package.

### Expected merge conflict zones

- `packages/ai/scripts/generate-models.ts`: the GPT-6 family context-window table and `applyGpt6ThinkingLevels`.
- `packages/ai/src/providers/data/*.json` + `.manifest.json`: regenerate rather than merge.

## 2026-09-30 - GPT-6.1 Sol catalog rows and Fast variant (senpi#2390)

### What changed

- `packages/ai/scripts/generate-models.ts`: `gpt-6.1-sol` joins every OpenAI id table that carries `gpt-6-sol` (tool search + additional tools on `openai` and `chatgpt-subscription`, short-context cap, long-context pricing tiers, Fast/Priority `-fast` variants on both first-party providers) and, unlike GPT-6 Sol, `CHATGPT_SUBSCRIPTION_CONFIGURATION_UPDATE_MODEL_IDS` (openai/codex's `models.json` flags `gpt-6.1-sol` `supports_reasoning_effort_updates: true`, as it does `gpt-6-astra`). It stays out of `OPENAI_RESPONSES_NONE_REASONING_MODELS` and `applyGpt6ThinkingLevels` forces `off: null` for it as for Astra, because the model page documents `low`/`medium`/`high`/`xhigh`/`max` only. `OPENAI_GPT_6_STANDARD_COSTS["gpt-6.1-sol"]` is 2/10/0.1/2.5 per MTok (the cached-input rate halves versus GPT-6 Sol); the flagship and family context-window tables carry `gpt-6.1-sol` at the 400,000 Sol budget, listed before `gpt-6-sol` since the family lookup matches by substring. Hand-added rows land in the `openai` fallback list and the `chatgpt-subscription` list.
- `packages/ai/src/providers/data/` regenerated with `--strict`: +2 rows each on `openai.json` and `chatgpt-subscription.json` (base + `-fast`), +1 on `azure-openai-responses.json`, +4 on `openrouter.json` (`openai/gpt-6.1-sol`, `-pro`, both `:batch`), +2 on `vercel-ai-gateway.json` (`openai/gpt-6.1-sol`, `openai/gpt-6.1-sol-fast`; Vercel also added two `inclusionai/ling-3.1-flash` rows). Incidental upstream drift: OpenRouter DeepSeek V4 Pro prices refreshed and `~openai/gpt-sol-latest` now resolves to GPT-6.1 Sol (0.1 cache reads, no `none`). No model id was removed. models.dev, GitHub Copilot, OpenCode Zen and OpenGateway do not list the model yet.
- Tests: `test/gpt-6-family-catalog.test.ts` adds `gpt-6.1-sol` with `supportsNone: false` (first-party rows, pricing tiers, `off` vetoed on catalog and map-less rows, `-fast` variant, family-wide budget); `test/openai-input-cap-catalog.test.ts` exempts the deliberate `gpt-6.1-sol @ 400,000` pairing and pins the OpenRouter and Vercel rows; `test/openai-config-update.test.ts` pins the `chatgpt-subscription` flag set as `gpt-6-astra`, `gpt-6-astra-fast`, `gpt-6.1-sol`, `gpt-6.1-sol-fast`.

### Why

OpenAI released GPT-6.1 Sol on 2026-09-29 (developers.openai.com/api/docs/models/gpt-6.1-sol): near-Astra quality at GPT-6 Sol's price, and Codex made it the default catalog model. Without rows the id was unselectable on every lane, and the `gpt-6-sol` substring matchers did not cover it. Ultrafast is deliberately absent: OpenAI's Ultrafast pricing table lists `gpt-6-astra` only and the announcement says GPT-6.1 Sol Ultrafast follows "in the coming days"; senpi carries no `ultrafast` service tier yet (the openai SDK's `service_tier` union stops at `priority`), so that is its own change when it ships.

### Why an extension could not handle it

The catalog shards ship inside this package; nothing loaded at runtime can add a first-party row or change what the generator wrote.

### Expected merge conflict zones

- `packages/ai/scripts/generate-models.ts`: the OpenAI id tables near the top, `OPENAI_GPT_6_STANDARD_COSTS`, `applyGpt6ThinkingLevels`, the hand-added `openai` and `chatgpt-subscription` row lists.
- `packages/ai/src/providers/data/*.json` + `.manifest.json`: regenerate rather than merge.

## 2026-09-29 - Published tarball excludes sourcemaps (senpi#2362)

### What changed

- `packages/ai/package.json`: `files` excludes `dist/**/*.map`.

### Why

- The maps point at `src/`, which is not published, so they cannot resolve for consumers and only add install size.

### Why an extension could not handle it

- Package publish metadata.

### Expected merge conflict zones

- LOW: the `files` list in `package.json`.

## 2026-09-29 - Claude Sonnet 5.5 catalog rows (senpi#2321)

### What changed

- `packages/ai/scripts/generate-models.ts`: `ANTHROPIC_ALLOWED_FALLBACK_MODELS["claude-sonnet-5-5"] = ["claude-sonnet-5"]` (the live `allowed_fallback_models`), `supportsAnthropicMidConvoEffort` matches `claude-sonnet-5[.-]5`, `isAnthropicAdaptiveOnlyModel` adds `sonnet-5-5` / `sonnet-5.5`.
- Regenerated provider data: `anthropic.json` `claude-sonnet-5-5`, `amazon-bedrock.json` `global.anthropic.claude-sonnet-5-5`, `openrouter.json` `anthropic/claude-sonnet-5.5` (+ `:batch`), `vercel-ai-gateway.json`, `venice.json` (`claude-sonnet-5-5`, plus `claude-opus-5-5-fast` and `xiaomi-mimo-v2-6-flash` that models.dev now lists), `opencode.json`. Drift that rode along: `together.json` dropped `moonshotai/Kimi-K2.6` and `Kimi-K2.7-Code` (retired upstream; `test/together-models.test.ts` now pins `Kimi-K3`), `mistral.json` dropped `magistral-small`, OpenRouter DeepSeek and Cloudflare rows refreshed metadata.

### Why

- Claude Sonnet 5.5 shipped on 2026-09-28 with the Opus 5.5 request contract (adaptive-only thinking, effort low..max, no forced tool choice) and a server-side fallback allowlist of `claude-sonnet-5`.

### Why an extension could not handle it

- Generated catalog data.

### Expected merge conflict zones

- LOW: the three Anthropic helpers in `generate-models.ts`; generated JSON regenerates.

## 2026-09-27 - OpenRouter catalog records mandatory reasoning again (senpi#1239, senpi#2163)

### What changed

- `packages/ai/scripts/generate-models.ts`: `fetchOpenRouterModels()` passes each model's `reasoning` metadata through `getOpenRouterThinkingLevelMap()` and spreads the result into the row, so models OpenRouter reports as `mandatory: true` get `thinkingLevelMap.off: null` plus their supported efforts. This restores the call site upstream added in badlogic/pi-mono 650e7a6 (#8614). The fork merge `c1b91ace01` kept only the import.

### Why

Without `off: null`, `openai-completions` sends `reasoning: { effort: "none" }` whenever no thinking level is requested. Mandatory-reasoning endpoints such as `meta/muse-spark-1.3-contributor` and `z-ai/glm-5.3` reject that with HTTP 400 `Reasoning is mandatory for this endpoint and cannot be disabled.`, and the thinking selector offers an `off` level those models cannot run. The release model regeneration (`scripts/release-artifacts.mjs`) writes the corrected rows.

### Why an extension could not handle it

The catalog shards ship inside this package and are written only by the generator.

### Expected merge conflict zones

- `packages/ai/scripts/generate-models.ts`: the `normalizedModel` literal in `fetchOpenRouterModels()`. Upstream carries the same call, so an upstream sync should resolve toward upstream's shape.

## 2026-09-24 - configuration_update follows a catalog capability flag (senpi#2094)

### What changed

- `packages/ai/scripts/generate-models.ts`: `applyOpenAIConfigurationUpdateMetadata` runs in the final metadata pass after `applyOpenAIExplicitPromptCacheMetadata` and sets `compat.supportsConfigurationUpdate` on `openai` / `openai-responses` rows with `cost.cacheWrite > 0` (the GPT-5.6+ family) and on `chatgpt-subscription` / `openai-codex-responses` `gpt-6-astra` (`CHATGPT_SUBSCRIPTION_CONFIGURATION_UPDATE_MODEL_IDS`). Priority `-fast` variants are cloned after the pass and inherit the flag.

### Why

Live OpenAI probes on 2026-09-24 showed the direct API accepts `configuration_update` on gpt-6-luna and gpt-5.6-luna (cache kept, effort applied), so the capability belongs to the cache-write-priced family, not one id. The Codex backend was only ever verified on gpt-6-astra and stays limited to it until it can be probed.

### Why an extension could not handle it

The catalog shards ship inside this package; nothing loaded at runtime can change what the generator writes.

### Expected merge conflict zones

- `packages/ai/scripts/generate-models.ts`: the block after `applyOpenAIExplicitPromptCacheMetadata` and the final metadata pass loop.

## 2026-09-24 - Flag GPT-5.6+ OpenAI rows as accepting allowed_tools (senpi#2095)

### What changed

- `packages/ai/scripts/generate-models.ts`: `applyOpenAIExplicitPromptCacheMetadata` also sets `compat.supportsAllowedTools: true` on provider `openai` / api `openai-responses` rows with `cost.cacheWrite > 0` (the GPT-5.6+ family). Regenerated `packages/ai/src/providers/data/` with `--strict`: `openai.json` gains only the flag on the 12 GPT-5.6 / GPT-6 rows (base + `-fast`); `.manifest.json` follows. Incidental upstream drift: four OpenRouter pricing/context refreshes in `openrouter.json` (deepseek-v4-flash, kimi-k2.7-code, qwen3-30b-a3b-instruct-2507). No model id was added or removed.

### Why

Those models keep the prompt cache warm when the `tools` list is unchanged and the callable subset moves to `tool_choice: allowed_tools`; the runtime needs a catalog flag to choose that request shape.

### Why an extension could not handle it

The catalog shards ship inside this package and are written only by the generator.

### Expected merge conflict zones

- `packages/ai/scripts/generate-models.ts`: `applyOpenAIExplicitPromptCacheMetadata`.
- `packages/ai/src/providers/data/*.json` + `.manifest.json`: regenerate rather than merge.

## 2026-09-23 - GPT-6 Sol and GPT-6 Luna catalog rows

### What changed

- `packages/ai/scripts/generate-models.ts`: `gpt-6-sol` and `gpt-6-luna` join every OpenAI id table that already carried `gpt-6-astra` (tool search + additional tools on `openai` and `chatgpt-subscription`, short-context cap, long-context pricing tiers, `none` reasoning on the direct provider, Priority `-fast` variants on both first-party providers). Hand-added rows for both tiers land in the `openai` fallback list (used only when models.dev lacks the id) and in the `chatgpt-subscription` list (models.dev never carries the Codex backend), priced from the new `OPENAI_GPT_6_STANDARD_COSTS` table (Sol 2/10/0.2/2.5, Luna 0.1/0.5/0.01/0.125 per MTok) through `withOpenAiLongContextPricing`; `OPENAI_STANDARD_COSTS` merges the 5.6 and 6 tables for the direct-provider and Cloudflare price overrides. `supportsOpenAiXhigh` / `supportsOpenAiMax` and the former Astra-only final pass now key on `isGpt6FamilyId` (astra | sol | luna markers, prefixed or suffixed ids): `applyGpt6ContextWindow` stamps the tier budget on every provider row (Astra 600,000 unchanged, Sol 400,000, Luna 922,000 = the documented input cap) and `applyGpt6ThinkingLevels` stamps the documented ladder (`minimal: null`, low..max) and forces `off: null` for Astra only, since Sol and Luna document `none`.
- `packages/ai/src/providers/data/` regenerated with `--strict`: +4 rows each on `openai.json` and `chatgpt-subscription.json` (base + `-fast`), +2 on `azure-openai-responses.json`, `opencode.json` (plus incidental upstream additions `claude-opus-5-5`, `grok-4.7`), `venice.json`, +4 on `vercel-ai-gateway.json`; the eight pre-existing `openrouter.json` GPT-6 Sol/Luna rows gain the ladder and the Sol budget. Incidental upstream drift: OpenRouter pricing/context refreshes (aion, deepseek, hy3, glm, `~latest` aliases), Vercel gemini metadata. No model id was removed.
- Tests: `test/gpt-6-family-catalog.test.ts` (first-party rows, pricing tiers, ladder incl. `off`, tool metadata, `-fast` variants, map-less id inference, family-wide budget across every catalog); `test/openai-input-cap-catalog.test.ts` exempts the deliberate `gpt-6-sol @ 400,000` pairing from the documented-total check (a 1,050,000 Sol row would still fail) and pins the new direct-provider defaults.

### Why

OpenAI's GPT-6 family is Astra, Sol and Luna (developers.openai.com/api/docs/guides/latest-model). 2026.9.22-4 shipped Astra rows only; models.dev had since added Sol/Luna rows for openai, opencode, azure, openrouter and vercel, and 2026.9.22-4's regeneration had already pulled the OpenRouter passthrough rows without any effort ladder, so `xhigh` / `max` were unreachable there and the Codex backend could not select either tier at all. Budgets follow the user-stated defaults (Luna full window, Sol 400k) rather than the 272k short-context tier.

### Why an extension could not handle it

The catalog shards ship inside this package; nothing loaded at runtime can add a first-party row or change what the generator wrote.

### Expected merge conflict zones

- `packages/ai/scripts/generate-models.ts`: the OpenAI id tables near the top, `supportsOpenAiXhigh` / `supportsOpenAiMax`, the hand-added `openai` and `chatgpt-subscription` row lists, and the final metadata pass.
- `packages/ai/src/providers/data/*.json` + `.manifest.json`: regenerate rather than merge.

## 2026-09-22 - Claude Opus 5.5 catalog rows and request compat

### What changed

- `packages/ai/scripts/generate-models.ts`: `ANTHROPIC_ALLOWED_FALLBACK_MODELS["claude-opus-5-5"] = ["claude-opus-4-8", "claude-opus-5"]` (the live Models API allowlist; the generator keeps only targets that also support per-message effort, so the emitted `compat.allowedFallbackModels` is `[claude-opus-5]`); `BEDROCK_INFERENCE_PROFILE_ONLY_MODEL_IDS` gains `anthropic.claude-opus-5-5` so only the global/us/eu/jp/au profiles are emitted, mirroring Opus 5; `supportsAnthropicMidConvoEffort` matches `claude-opus-5-5` / `claude-opus-5.5`; the Fable-5 adaptive-only branch is now `isAnthropicAdaptiveOnlyModel` and covers Opus 5.5 too (`compat.supportsDisabledThinking: false` on `anthropic-messages`, `thinkingLevelMap.off: null` elsewhere). `src/providers/data/` regenerated (one strict run): anthropic, amazon-bedrock, openrouter (`anthropic/claude-opus-5.5`), vercel-ai-gateway (`anthropic/claude-opus-5.5`, `-fast`); venice picked up one unrelated metadata refresh.
- Runtime compat for the same release (Messages and Bedrock family markers, forced-tool-choice default) is tracked in `src/changes.md`.
- Tests: `test/anthropic-opus-5-5.test.ts` (catalog shape, Bedrock profile-only, thinking-off request, xhigh/max effort mapping), `test/anthropic-tool-choice-compat.test.ts` (forced `any` / named omitted for 5.5, kept for Opus 5), `test/bedrock-thinking-payload.test.ts` (Bedrock thinking-off pins effort low).

### Why

Claude Opus 5.5 (2026-09-22) returns 400 for `thinking.type` `disabled` and `enabled` alike and for `tool_choice` `any` / `tool`; on Opus 5 both were accepted. Verified against the live Models API (`thinking.types.enabled.supported: false`, `allowed_fallback_models: [claude-opus-4-8, claude-opus-5]`). Without the compat facts, a thinking-off turn or a forced-tool turn failed every request on the new model.

### Why an extension could not handle it

The catalog shards ship inside this package and the request shape is built inside the Messages and Bedrock providers before any extension hook runs.

### Expected merge conflict zones

- `packages/ai/scripts/generate-models.ts`: the Anthropic family-marker functions and the hardcoded allowlist tables, against any other model-release change.

## 2026-09-22 - generator rows for the chatgpt-subscription rename (senpi#1989)

### What changed

- `packages/ai/scripts/generate-models.ts`: the six hardcoded `openai-codex` rows now emit the `chatgpt-subscription` provider id. They were edited in place rather than regenerated.

### Why

A full `generate-models` run fetches live data for Venice, Together, Vercel AI Gateway, Vertex, NVIDIA and Bedrock, so regenerating to move one provider id would pull unrelated network drift into this diff and make it unreviewable. The six rows for this provider are hardcoded literals in the generator, so editing them in place is both sufficient and auditable.

### Why an extension could not handle it

The generator produces the committed catalog shards that ship inside this package; nothing loaded at runtime can change what it wrote.

### Expected merge conflict zones

- `packages/ai/scripts/generate-models.ts`, against any other change to the hardcoded provider tables.

## 2026-09-22 - Grok 4.7 + MiMo V2.6 Pro catalog additions (senpi#1990)

### What changed

- `packages/ai/scripts/generate-models.ts`: the xAI branch uses `getModelsDevCost(m.cost)` instead of a
  flattened cost block, so models.dev context tiers survive into `xai.json` — Grok 4.7's
  $4/$12 above-200k tier plus the tiers models.dev already publishes for 4.5/4.6. Ported
  from upstream pi-mono 1a584a7a56 (`feat(ai,coding-agent): add Grok 4.7 support`).
- `src/providers/data/` regenerated (one `bun run generate-models --strict` run):
  `xai.json` + `github-copilot.json` gain `grok-4.7`; `xiaomi.json` + the three
  `xiaomi-token-plan-*.json` + `opencode-go.json` + `openrouter.json` + `vercel-ai-gateway.json`
  gain the mimo-v2.6 family; `venice.json` gains its dashed `grok-4-7`; `opencode.json` replaces
  the selectable free model `mimo-v2.5-free` with `mimo-v2.6-flash-free` (opencode retired the
  v2.5 free tier); `openrouter.json` additionally drops six retired `:batch` ids
  (`minimax/minimax-m3:batch`, `moonshotai/kimi-k3:batch`, `openai/gpt-oss-120b:batch`,
  `qwen/qwen3.5-9b:batch`, `qwen/qwen3.8-2.4t-a95b:batch`, `thinkingmachines/inkling:batch`)
  and the directly-selectable model `kwaipilot/kat-coder-pro-v2` (also delisted), and gains
  `nex-agi/nex-n2.5-pro` (live catalog drift the generator reports honestly).
  `opencode.json` deliberately does NOT gain grok-4.7 — opencode does not serve it.
- `test/xai-responses.test.ts`, `test/model-catalog-types.test.ts`, `test/stream.test.ts`:
  Grok 4.7 effort/capabilities/tiered-pricing coverage, xai+xiaomi catalog type and
  shard-scoped presence assertions (aggregator surface, grok-4.6 / mimo-v2.5-pro controls),
  and the live-gated xAI E2E moves to grok-4.7.

### Why

- omo#8644: the direct xAI shard lacked `grok-4.7`, so `xai/grok-4.7` was unselectable;
  `mimo-v2.6-pro` was in no shard at all.

### Why this lives in the fork

- Shard layout + manifest are fork-owned; upstream uses `.models.ts`.

### Expected merge conflict zones

- LOW: `data/*.json` + `.manifest.json` on any concurrent regeneration.

## 2026-09-21 - Migrate the test runner to Vitest 5 (senpi#1895)

### What changed

- `packages/ai/package.json`: Updated the test runner to Vitest 5.0.1.

### Why

- Run this workspace on the pinned Vitest 5 release.

### Why an extension could not handle it

- The package manager resolves development tools before extensions load.

### Expected merge conflict zones

- The development dependency pins in `packages/ai/package.json`.

## 2026-09-20 - The image-model generator formats what it writes (senpi#1886)

### What changed

- `packages/ai/scripts/generate-image-models.ts` hands the file it just wrote to Biome
  (`biome check --write`) before reporting success, resolving the binary from the
  repository's own `node_modules/.bin` and falling back to `biome` on PATH.

### Why

- The serializer writes tabs by hand and uses `JSON.stringify` for `input`, `output` and
  `cost`, which emits `["text","image"]`, quoted keys and two-space indentation. Biome wants
  `["text", "image"]`, unquoted keys and tabs, so the emitted file never satisfied
  `npm run check`. The shared `check` script used to run `biome check --write`, which
  rewrote the file silently; #1443 made that gate read-only, and the release job is the first
  thing that regenerates the catalog under the strict gate. Run 35520504862 failed at
  `[release] error: npm run check failed` with the version already applied to 10 manifests,
  so no release can complete until the generator's output is clean on its own.
- Formatting through Biome rather than hand-matching its current style keeps a future Biome
  upgrade from reintroducing the same drift.

### Why an extension could not handle it

- This is a build-time code generator invoked by `scripts/release-artifacts.mjs`; it runs
  before any session exists and no extension surface participates in catalog generation.

### Expected merge conflict zones

- `packages/ai/scripts/generate-image-models.ts`: the import block and `main()`. Upstream
  edits to this generator touch the same `writeFileSync` tail.

## 2026-09-21 - Refresh the provider SDK pins (senpi#1895)

### What changed

- `packages/ai/package.json`: `@anthropic-ai/sdk` 0.123.0 -> 0.127.0, `@aws-sdk/client-bedrock-runtime` 3.1127.0 -> 3.1136.0, `@google/genai` 2.21.0 -> 2.23.0, `@bufbuild/protobuf` 2.14.0 -> 2.15.0, `@smithy/types` 4.17.2 -> 4.18.0, `typebox` 1.3.27 -> 1.3.34, `yaml` 2.9.0 -> 2.9.1 and `@types/node` 26.2.0 -> 26.6.2.

### Why

- The provider SDKs are fork-owned exact pins and the surface this package is built on; each moves to the newest release in the same minor that satisfies `min-release-age=2`. The `@anthropic-ai/sdk` line in the 2026-08-21 entry below ("stays at 0.91.1") is historical: the browser-bundle blocker it records is handled by the `anthropic-sdk-node-builtins` plugin in `scripts/check-browser-smoke.mjs`.

### Why an extension could not handle it

- Manifest dependency versions are resolved by the package manager before any extension loads.

### Expected merge conflict zones

- LOW: the dependency version block, on every upstream release bump.

## 2026-09-18 - The catalog check tolerates a shard the aggregator no longer lists

### What changed

- `packages/ai/scripts/model-data.ts` excludes a shard a provider module imports from the
  aggregator/shard equality check, the way it already excludes a fork-owned shard.
- `packages/ai/test/model-data-imported-shard.test.ts` stages the committed catalog, drops
  `kimi-coding` from the aggregator and requires `readModelDataStructure` not to throw.

### Why

- With the prune guard in place the shard survives a run that wrote none of them, but the freshly
  written aggregator no longer lists it, so `readModelDataStructure` called it an extra shard and the
  release failed a third time - after the prune failure it was meant to replace.

### Why an extension could not handle it

- The equality check is the generator's own consistency gate; only it knows which shards the run wrote.

### Expected merge conflict zones

- `packages/ai/scripts/model-data.ts` around `readModelDataStructure`'s shard comparison.

## 2026-09-18 - Never prune a model shard a provider module imports

### What changed

- `packages/ai/scripts/model-shards.ts` gains `importedModelShards` and a third argument to
  `isPrunableModelShard`: a shard a committed provider module imports is never prunable, whoever was
  supposed to write it. `FORK_OWNED_MODEL_SHARDS` stays for shards no module imports.
- `packages/ai/scripts/generate-models.ts` reads the provider modules beside the shards and passes the
  imported set to the prune, so a provider models.dev has stopped describing keeps its catalog.
- `packages/ai/test/model-shards.test.ts` adds the fresh-generation case: every imported shard survives a
  run that wrote none of them. It fails without the guard.

### Why

- The release job regenerates catalogs before type-checking. models.dev no longer describes `kimi-coding`,
  so the prune deleted `packages/ai/src/providers/kimi-coding.models.ts` while
  `packages/ai/src/providers/kimi-coding.ts` still imported it, and two consecutive releases died on
  `TS2307` with fifteen cascades. Ordinary CI type-checks the committed catalog instead of regenerating
  it, and the existing ownership test compares against that same committed aggregator, so only the release
  job could see it.

### Why an extension could not handle it

- The prune happens inside the generator's own write-and-sweep pass. Nothing outside it knows which shards
  the run produced, so the decision to keep a shard has to be made where that set exists.

### Expected merge conflict zones

- `packages/ai/scripts/model-shards.ts` around `isPrunableModelShard`, and the prune loop in
  `packages/ai/scripts/generate-models.ts`, if upstream reshapes the shard sweep.

## 2026-09-18 - Generate the official B.AI chat catalog

### What changed

- `packages/ai/scripts/bai-models.json` records B.AI's published standard context, output, modality,
  reasoning-level, and pricing metadata for the 56 chat models B.AI documents as active, sourced from each
  `docs.b.ai/llmservice/models/<slug>/` page and the standard pricing table. Promotional, DeepSeek idle, and
  long-cache rates are deliberately excluded.
- `packages/ai/scripts/generate-models-bai.ts` converts that source into provider models with family-specific
  API selection and B.AI endpoint shapes.
- `packages/ai/scripts/generate-models.ts` adds the curated B.AI rows before the shared normalization and
  generated-shard pipeline.
- Regenerated `packages/ai/src/providers/data/bai.json`, `bai.models.ts`, `models.generated.ts`, and the model
  data manifest. Image-only `gpt-image-2` is intentionally absent from the chat catalog.
- `packages/ai/test/gpt-6-astra-context-window.test.ts` includes the B.AI shard in the cross-provider Astra
  context-window invariant.
- `packages/ai/scripts/generate-models.ts` re-derives `reasoning` for B.AI models after the shared
  thinking-level passes, so a model that gains a selectable level cannot keep `reasoning: false` and silently
  lose its reasoning payload at request time.

### Why

- B.AI `/v1/models` is credential-scoped and returns IDs only. The committed generated catalog is the
  maintainable source for model capabilities and standard reference prices, while runtime discovery decides
  which classified IDs the current key may use.

### Why an extension could not handle it

- Catalog generation and validation run before extensions load and feed every built-in provider consumer.

### Expected merge conflict zones

- LOW: one import and one append in `packages/ai/scripts/generate-models.ts`.
- NONE: the B.AI generator source and metadata file are new fork-owned files.

## 2026-09-13 - Publish static provider module subpaths

### What changed

- `packages/ai/package.json` exports `./cursor-agent-provider` and `./devin-provider` from the built distribution, alongside `./bedrock-provider`.

### Why

- Standalone Bun consumers need static imports that also resolve from the published layout without exposing Node-only transports through the browser-safe root.

### Why an extension could not handle it

- `packages/ai/package.json` controls package resolution before extensions execute.

### Expected merge conflict zones

- `packages/ai/package.json` public exports block.

## 2026-09-12 - Fork-owned model catalog shards survive generation

### What changed

- `packages/ai/scripts/model-shards.ts` (new) owns shard ownership: `FORK_OWNED_MODEL_SHARDS` lists the `*.models.ts` catalogs the fork maintains by hand (currently `devin.models.ts`), and `isPrunableModelShard` decides deletion.
- `packages/ai/scripts/generate-models.ts` prunes through that predicate instead of deleting every shard the current run did not write.
- `packages/ai/scripts/model-data.ts` excludes fork-owned shards when it compares the shard directory against the aggregator's provider imports.
- `packages/ai/test/model-shards.test.ts` derives the expected fork-owned set from the tree - the shards providers import minus the shards `src/models.generated.ts` imports - so a new hand-authored provider fails this test instead of the release.

### Why

- models.dev has no `devin` provider, so `devin.models.ts` is hand-authored and the aggregator never imports it. The release job regenerates the catalog before typechecking, so generation deleted the shard and `tsc` failed with `Cannot find module './devin.models.ts'` (run 34621164006), and `check:model-data` already failed on the committed tree for the same reason. Ordinary CI typechecks the committed catalog, so neither failure is visible outside the release path.

### Why an extension could not handle it

- Catalog generation and its validation are build-time scripts that run long before any extension loads.

### Expected merge conflict zones

- LOW: the shard prune loop in `generate-models.ts` and the shard comparison in `readModelDataStructure`.

## 2026-09-10 - Venice AI catalog generation

### What changed

- `packages/ai/scripts/generate-models.ts` adds a Venice AI fetcher over the models.dev `venice` catalog (`VENICE_BASE_URL`, `VENICE_COMPAT`), emitting `openai-completions` models at `https://api.venice.ai/api/v1` under provider id `venice`. It honors the shared `tool_call !== true` and `status === "deprecated"` skips and routes reasoning metadata through `recordModelsDevReasoningOptions`, so Venice's `reasoning_effort` ladder is derived from models.dev rather than hardcoded.
- Every generated Venice model carries `compat.veniceParameters = { include_venice_system_prompt: false }`.

### Why

- Venice was the one provider a user asked for that had no representation anywhere in `packages/ai`. models.dev already publishes the catalog, so generation is the maintainable source; the generated ids were cross-checked against Venice's live `GET /models` listing and all 104 exist.
- Venice prepends its own default system prompt unless `include_venice_system_prompt` is false, which would place a second system prompt ahead of the agent's.

### Why an extension could not handle it

- The committed model catalog is a build-time artifact consumed by the provider registry before any extension loads.

### Expected merge conflict zones

- LOW: the models.dev provider block ordering in `loadModelsDevData()` when upstream adds its own provider fetchers nearby.

## 2026-09-10 - Image input token rate in the static OpenAI image catalog

## 2026-09-10 - Use native TypeScript builds for omob performance

### What changed

- packages/ai/package.json: build uses tsgo for the emitted workspace build.

### Why

- The native compiler reduces omob build time without changing runtime JavaScript.

### Why this lives in the fork

- The package build manifest owns the compiler used by the fork's release pipeline.

### Expected merge conflict zones

- The `build` script in packages/ai/package.json.

### What changed

- `packages/ai/scripts/generate-image-models.ts`: `OPENAI_IMAGE_MODELS` entries for `gpt-image-2.5-sunburst`, `gpt-image-2.5-flare`, and `gpt-image-2` carry `imageInput: 8` (USD per million image input tokens), regenerated into `packages/ai/src/image-models.generated.ts` with `--strict`; the OpenRouter block is unchanged.

### Why

- OpenAI bills image inputs (references, edit targets, masks) at $8/M against $5/M for text, so a single `input` rate under-reported every edit request.

### Why an extension could not handle it

- The builtin image catalog is generated data loaded before any extension runs.

### Expected merge conflict zones

- LOW: the `OPENAI_IMAGE_MODELS` array and its comment block.

## 2026-09-09 - GPT Image 2.5 entries in the static OpenAI image catalog

### What changed

- `packages/ai/scripts/generate-image-models.ts`: `OPENAI_IMAGE_MODELS` gains `gpt-image-2.5-sunburst` and `gpt-image-2.5-flare` (released 2026-09-08) ahead of the existing entries, with $5 input / $30 output / $1.25 cached-input per million tokens, and every GPT Image entry that the edits endpoint accepts now advertises `["text", "image"]` inputs. The regenerated OpenAI block lives in `packages/ai/src/image-models.generated.ts`; the OpenRouter block is untouched.

### Why

- OpenAI's own API exposes no image-model catalog to fetch, so the static generator entries are the only place the new model ids and their pricing can enter the builtin registry.

### Why an extension could not handle it

- The builtin image catalog is generated data loaded before any extension runs; an extension can add a provider but cannot amend the `openai` provider's shipped model list.

### Expected merge conflict zones

- LOW: the `OPENAI_IMAGE_MODELS` array and its comment block in the generator.

## 2026-09-07 - One context window for the whole GPT-6 Astra series

### What changed

- `packages/ai/scripts/generate-models.ts`: `GPT_6_ASTRA_DEFAULT_CONTEXT_WINDOW` is 600,000, and the new `applyGpt6AstraContextWindow` stamps it onto every model whose id carries `gpt-6-astra` in the final metadata pass, after `applyOpenAiInputCap` and before provider grouping. Regenerated `packages/ai/src/providers/data/` (13 Astra rows across azure-openai-responses, github-copilot, openai-codex, openai, opencode, openrouter and vercel-ai-gateway) plus `packages/ai/src/providers/data/.manifest.json`.
- `packages/ai/test/gpt-6-astra-context-window.test.ts` walks every generated catalog and requires the whole series to agree; `gpt-6-astra-catalog.test.ts`, `openai-fast-models.test.ts` and `openai-input-cap-catalog.test.ts` move their Astra expectations to the series value.

### Why

- `contextWindow` is the prompt budget senpi gates on, and the Astra series had no budget of its own: it inherited whatever the input-cap pass produced, so the model's usable window was a side effect of the provider that served it. A single series default makes the budget the same on every route, and users who want a wider or narrower one still set it through model overrides.

### Why an extension could not handle it

- Catalog data is loaded before any extension runs, so only the generator can change what every consumer of `contextWindow` sees.

### Expected merge conflict zones

- LOW: the OpenAI flagship constants block and the final `for (const model of allModels)` metadata pass in the generator.

## 2026-09-07 - OpenAI input cap applied on every provider (#1422 follow-up)

### What changed

- `packages/ai/scripts/generate-models.ts`: `applyOpenAiInputCap` runs in the final metadata pass over every provider's GPT-5.x / GPT-6 rows (`isOpenAiFlagshipFamilyId` strips the `openai/`, `openai.`, `global.openai.` gateway prefixes and excludes `gpt-oss`), mapping the 400,000 / 1,050,000 totals to 272,000 / 922,000 when `maxTokens` is 128,000, and correcting `gpt-5-pro`'s mirrored 272,000 max output to 128,000 before the mapping. The earlier `provider === "openai"`-only call and the openai-only `gpt-5-pro` fix are folded into it. Regenerated `packages/ai/src/providers/data/` (128 rows across bedrock, azure, cloudflare, copilot, openai, opencode, opencode-go, opengateway, openrouter, vercel) plus `packages/ai/src/providers/data/.manifest.json`.
- `packages/ai/test/openai-input-cap-catalog.test.ts` pins the invariant for the whole builtin catalog.

### Why

- The input/output split is a property of the model, not of the gateway: OpenRouter, Vercel, OpenGateway, Copilot and the cloud hosts forward the same upstream rejection, so luna/terra/sol/astra rows on those providers still let a session run 128k tokens past the point where the provider rejects the prompt.

### Why an extension could not handle it

- Catalog data is loaded before any extension runs; only the generator can change what every consumer of `contextWindow` sees.

### Expected merge conflict zones

- LOW: the final `for (const model of allModels)` metadata pass and the OpenAI constants block in the generator.

## 2026-09-07 - OpenAI catalog contextWindow stores the documented input cap (#1422)

### What changed

- `packages/ai/scripts/generate-models.ts`: `toOpenAiInputCap` maps the documented OpenAI window tiers to their prompt budgets for provider `openai` (400,000 -> 272,000; 1,050,000 -> 922,000 when `maxTokens` is 128,000), `GPT_6_ASTRA_DEFAULT_CONTEXT_WINDOW` and the Azure flagship overrides use the 922,000 cap. Regenerated `packages/ai/src/providers/data/openai.json`, `packages/ai/src/providers/data/chatgpt-subscription.json`, `packages/ai/src/providers/data/azure-openai-responses.json`, `packages/ai/src/providers/data/.manifest.json` (the same run picked up one OpenRouter price refresh).

### Why

- The Responses API rejects a request with `context_too_large` once the prompt alone exceeds window minus max output, regardless of `max_output_tokens`. senpi uses `contextWindow` as the prompt budget everywhere (compaction gates, usage meter, output clamp), so the totals put every gate above the point where the provider already rejects. The catalog already used the input-cap convention for gpt-5.4/5.5/5.6 (272,000); the flagship rows were the inconsistent ones.

### Why an extension could not handle it

- The catalog generator and its committed data are the source of every model's `contextWindow`; no extension hook runs before the catalog is loaded.

### Expected merge conflict zones

- LOW: the OpenAI normalization block and the flagship constants in the generator.

# 2026-09-05 - GPT-6 Astra async tool calling and WebSocket steering: deferred with design

### What changed

- No runtime change. This records the binding decision to DEFER two GPT-6 Astra wire features until the agent loop supports them, with the concrete designs below.

### Why deferred

- Async tool calling (`async: true`, late outputs on the original `call_id`): the agent loop executes tools synchronously and cannot proceed with a pending call. Proof: `packages/agent/src/agent-loop.ts:297` awaits `executeToolCalls` before `turn_end`, and the parallel batch barrier `await Promise.all(finalizedCalls)` at `packages/agent/src/agent-loop.ts:966` blocks until every `call_id` has a result. The Responses adapter sends one `response.create` (`packages/ai/src/api/openai-responses.ts:807`) and releases the socket after `response.completed`, with no call-id correlation surface. A payload-only `async: true` would advertise behavior the loop cannot honor.
- Mid-turn steering over WebSocket: steering is polled only at turn boundaries (`packages/agent/src/agent-loop.ts:212`, `:325`, `:382` via `config.getSteeringMessages()`), never during `streamAssistant` or tool execution. The subscribe target for a future loop-owned dispatcher is `Agent.steeringQueue` (`packages/agent/src/agent.ts:209`, drained at `:445`/`:483`). Both the generic and Codex adapters have their own WebSocket paths (`packages/ai/src/api/openai-codex-responses.ts:299`/`:311`/`:1520`), so a bidirectional API must be built twice.

### Designs (for future adoption)

- Async: a loop-owned `PendingToolCall` registry keyed by provider `call_id` with durable session ownership, cancellation, duplicate/unknown handling, and a completion event that resumes the same response conversation; the adapter must expose a bidirectional Responses connection and serialize `function_call_output` on the original `call_id`.
- Steering: a loop-owned active-turn command channel that subscribes to steering-queue mutation, assigns ordering/turn identity, encodes the steering event on the live socket, and defines interrupt-vs-queue-vs-merge semantics plus reconnect/abort behavior.

### Exit criteria

- Revisit only after a failing-first integration test proves (1) a detached tool returns after the model response preserving the original `call_id`, and (2) steering sent during an active WebSocket response is observed in that same turn, both with remote green evidence.

# changes.md — ai

## 2026-09-05 - Normalize GPT-6 Astra reasoning maps across OpenAI-family catalogs

### What changed

- `packages/ai/scripts/generate-models.ts` applies the canonical Astra thinking ladder to every generated OpenAI-family API entry, including Azure and OpenAI-compatible passthrough catalogs.

### Why

- Live metadata can provide a partial Astra map; normalization prevents supported low/medium/high tiers from disappearing and preserves the null vetoes for off/minimal.

### Why an extension could not handle it

- Generated provider metadata is produced before runtime extensions load.

### Expected merge conflict zones

- MEDIUM: `packages/ai/scripts/generate-models.ts` final model metadata normalization loop and regenerated provider data.

## 2026-09-05 - Widen GPT-6 Astra flagship context defaults

### What changed

- `packages/ai/scripts/generate-models.ts` applies per-model flagship context defaults on OpenAI and OpenAI Codex: GPT-5.6 Sol keeps 650,000 tokens and GPT-6 Astra ships its documented 1,050,000-token maximum (generated `-fast` variants inherit), while retaining the 272,000-token Terra/Luna defaults and long-context pricing tiers.

### Why

- OpenAI documents GPT-6 Astra with a 1,050,000-token context window; the owner wants Astra to run at that full documented maximum by default (922,000 input + 128,000 output), while Sol stays at the 650,000-token cost-tier default selected earlier.

### Why an extension could not handle it

- Model defaults and generated provider catalogs are established by the package build-time generator.

### Expected merge conflict zones

- MEDIUM: `packages/ai/scripts/generate-models.ts` OpenAI flagship constants and explicit catalog entries; regenerated provider data.

## 2026-09-05 - Account for Fast-mode service tiers

### What changed

- `packages/ai/src/api/openai-responses.ts`, `packages/ai/src/api/openai-codex-responses.ts`, and `packages/ai/src/api/openai-responses-shared.ts` accept the local `fast` service-tier spelling, apply the priority multiplier to it, and preserve Codex request-tier resolution.

### Why

- GPT-6 Astra responses echo `fast` even though the generated `-fast` catalog variants continue to send the wire-compatible `priority` value; treating `fast` as default under-billed those responses.

### Why an extension could not handle it

- Service-tier resolution and usage-cost mutation happen inside the provider stream adapters below extension hooks.

### Expected merge conflict zones

- LOW: `packages/ai/src/api/openai-responses.ts` and `packages/ai/src/api/openai-codex-responses.ts` service-tier helpers; shared stream option types.

## 2026-09-04 - Bound pi-ai CI Vitest fork concurrency

### What changed

- `packages/ai/vitest.config.ts` uses the forks pool with two workers and a bounded teardown timeout when CI is running; `packages/ai/src/api/cursor-agent.ts` clears the stream-health timer when each attempt ends.

### Why

- Provider lifecycle tests create real network clients and subprocesses; unbounded fork concurrency can strand workers while a constrained CI runner tears down the pool.

### Why this lives in the fork

- Vitest execution policy is package-owned test infrastructure and cannot be configured by a runtime extension.

### Expected merge conflict zones

- LOW: `packages/ai/vitest.config.ts` test settings.

## 2026-09-04 - Credential-store lock contention remains transient

- `src/utils/retry.ts` recognizes exhausted local credential-store lock waits as retryable infrastructure, preventing provider fallback hopping.

## 2026-09-04 - Restore the @anthropic-ai/sdk 0.123.0 pin the R4b merge dropped

### What changed

- `packages/ai/package.json`: `@anthropic-ai/sdk` 0.120.0 -> 0.123.0, restoring the declaration the 2026-09-03 upstream sync carried before the R4b re-integration reverted it; `09e23825a` resyncs the root `package-lock.json` to the restored pin.

### Why

- The synced lockfiles and the `.npmrc` `min-release-age-exclude[]=@anthropic-ai/sdk` entry assume 0.123.0, so the reverted manifest left `npm ci` resolving a manifest/lockfile mismatch.

### Why an extension could not handle it

- Dependency resolution happens from the package manifest during install, before any runtime or extension code loads.

### Expected merge conflict zones

- LOW: the `@anthropic-ai/sdk` line in `packages/ai/package.json` and the corresponding lockfile entries.

## 2026-09-04 - Generator adopts the v0.84.4 routing rules

### What changed

- `packages/ai/scripts/generate-models.ts`: Anthropic compat gains a verified `supportsMidConvoEffort` set (anthropic and openrouter providers, `claude-opus-5` and `claude-fable`/`claude-mythos` 5.1 ids); flagged models merge an `off`-capable thinking-level map and their allowed fallback lists are filtered to models that also support mid-conversation effort changes.
- `packages/ai/scripts/generate-models.ts`: OpenRouter `anthropic/` models (excluding `:batch`) route through `anthropic-messages` at `https://openrouter.ai/api` instead of `openai-completions` (upstream 4e69b0c28).
- `packages/ai/scripts/generate-models.ts`: all Fireworks `glm-` models route through `openai-completions` (previously only `glm-5p2`, upstream 1e4fbe384), and GitHub Copilot `claude-fable-` joins the Claude models routed through Anthropic Messages (upstream 69afa1050).
- The regenerated catalog data for these rules landed with the sync in 9f11abadf.

### Why

- Upstream v0.84.4 shipped these routing decisions for the new model generations and the per-turn effort semantics; adopting them in the generator keeps fork catalog regenerations in parity with upstream instead of re-diverging on every refresh.

### Why an extension could not handle it

- The generation script and the provider data it emits are build-time catalog artifacts inside this package; no runtime extension seam produces them.

### Expected merge conflict zones

- MEDIUM: `packages/ai/scripts/generate-models.ts` compat helpers and routing rules; regenerate `packages/ai/src/providers/data/` rather than merging it.

## 2026-09-04 - GPT-6 Astra catalog

### What changed

- `packages/ai/scripts/generate-models.ts`: hand-added `gpt-6-astra` entries for the `openai` and `openai-codex` providers (published pricing 10/50/1/12.5 per MTok with the >272k long-context tiers, 272k default context, 128k output, text+image input, `thinkingLevelMap` with `off`/`minimal` null and low through high, with xhigh/max merged by `supportsOpenAiXhigh`/`supportsOpenAiMax`); the id joins the tool-search, additional-tools, short-context-cap, long-context-pricing, and Priority `-fast` sets; a post-metadata override keeps `off`/`minimal` unavailable.
- `packages/ai/src/models.ts`: `XHIGH_MODEL_IDS` gains `gpt-6-astra`; the sol-only max-effort family check is generalized to `OPENAI_MAX_MODEL_IDS` (`gpt-5.6-sol`, `gpt-6-astra`).
- Regenerated `packages/ai/src/providers/data/openai.json`, `packages/ai/src/providers/data/chatgpt-subscription.json`, and `packages/ai/src/providers/data/.manifest.json` with only the Astra entries (plus their `-fast` variants) changing.
- `packages/ai/test/gpt-6-astra-catalog.test.ts`: catalog entries, pricing tiers, context limits, thinking levels, xhigh/max support, and `-fast` variants.

### Why

- OpenAI released GPT-6 Astra (`gpt-6-astra`, Responses API, efforts low/medium/high/xhigh/max, no `none`/`minimal`) and Codex's model catalog lists it for the Codex backend; without catalog entries the model was unselectable through the built-in providers.

### Why an extension could not handle it

- The static provider catalogs are generated inside this package.

### Expected merge conflict zones

- `packages/ai/scripts/generate-models.ts` (hand-added OpenAI model lists and id sets), `packages/ai/src/models.ts` (xhigh/max id lists), `packages/ai/src/providers/data/*` (regenerate, don't merge).

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
- `src/utils/chatgpt-subscription-auth.ts`: centralizes browser-safe ChatGPT account-ID extraction so normal Codex requests
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
- `src/utils/chatgpt-subscription-auth.ts`

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
- `test/chatgpt-subscription-stream.test.ts`

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

## 2026-09-12 - Upstream sync (upstream/main@71dca871) integration repairs

### What changed

- `packages/ai/package.json`: fork CalVer `2026.9.12` and `private: true`; held pins `openai 6.26.0` and `@anthropic-ai/sdk 0.123.0` instead of upstream's `6.40.0`/`0.124.0`; fork-only runtime deps `@bufbuild/protobuf`, `@smithy/types`, `yaml`; the `./auth/pool/*` and `./node/provider-scope` export subpaths; `tsx`-driven generator scripts, a `build` that does not regenerate models, `build:offline`/`dev`/`dev:tsc`, Node `>=24.0.0`, `@types/node 26.2.0`, `vitest 4.1.11`. Upstream's `typebox 1.3.27` and the rest of the D-Q bumps were adopted.
- `packages/ai/scripts/generate-models.ts`: the fork generator with its overlays (Venice, OpenGateway, Kimi coding stable rows, ZAI GLM-5.2 and Kimi K3 thinking maps, xAI thinking maps, Bedrock strict-mode ids, OpenAI priority-tier and Codex `additional_tools` sets, GPT-6 Astra 600k context, documented OpenAI input caps applied after context windows, `isPrunableModelShard` shard pruning, OpenRouter reasoning metadata) plus upstream's new provider metadata handling (DeepSeek Flash, Fireworks, Mistral GLM-5.2, OpenRouter affinity, Codex Off effort, GPT-5.4 Codex retirement, OpenCode header).

### Why

- The fork publishes its own catalog (extra providers, seven thinking levels, Astra context sizing, fast/priority clones) from upstream's model data; the generator is where those overlays live, and the manifest carries the fork's held SDK pins and export map.

### Why an extension could not handle it

- Catalog generation runs at build time and the manifest's exports/pins are resolved by the package manager; neither is reachable from runtime extension hooks.

### Expected merge conflict zones

- HIGH: `packages/ai/scripts/generate-models.ts` provider blocks (OpenAI, xAI, Fireworks, Mistral, OpenRouter) whenever upstream reshapes a provider's metadata.
- MEDIUM: `packages/ai/package.json` `dependencies` and `exports` on every upstream dependency bump.

## Adopted upstream v1.0.0 ai package manifest (2026-10-02)

### What changed

- `packages/ai/package.json` — the upstream v1.0.0 manifest is kept, including the lightweight `./models` subpath export and its export map.

### Why

The fork adopted upstream's ai package layout (D-12) on top of its kept provider/auth behaviour; every recorded pin stays.

### Why an extension could not handle it

The package manifest and its export map are not an extension surface.

### Expected merge conflict zones

Upstream manifest edits at the next sync.


## 2026-10-08 - Official Kimi K3 cache-write price

### What changed

- `packages/ai/scripts/generate-models.ts`: `KIMI_K3_COST.cacheWrite` 0 -> 3, used for Moonshot's own K3 endpoints when upstream omits a price and for the Kimi Coding implied estimate.

### Why

- The official Kimi API price list (https://platform.kimi.ai/docs/pricing/chat) bills Kimi K3 cache writes at $3 per 1M tokens for the default 5-minute TTL ($6 for 1 hour); the catalog still had them at $0, which undercounted cost on requests that write the cache and failed the 2026.10.10-8 release regeneration once upstream data caught up.

### Why an extension could not handle it

- Built-in model prices are catalog data generated or kept in this package; nothing at runtime can correct them.

### Expected merge conflict zones

- LOW: the Kimi K3 cost constants when upstream reprices Kimi models.
