# changes.md — ai

## Map-less GPT-5.6 Sol max reasoning (2026-07-30)

### What changed

- Runtime capability detection now recognizes `max` for map-less OpenAI-compatible `gpt-5.6-sol` models while
  preserving explicit map omissions and `null` vetoes.
- OpenAI-compatible request builders serialize the selected level as `reasoning.effort: "max"`.

### Why

- Custom providers such as `codex-lb` can supply Sol without generated model metadata. The UI and provider
  payload must agree instead of displaying `max` while silently sending `high`.

## Browser-safe prompt-cache TTL resolver (2026-07-28)

### What changed

- `src/utils/prompt-cache-ttl.ts` (new): `resolvePromptCacheTtlSeconds(model, env?) -> number | undefined`
  plus `PROMPT_CACHE_TTL_SHORT_SECONDS` (300) / `PROMPT_CACHE_TTL_LONG_SECONDS` (3600). It mirrors EACH
  target API's own `resolveCacheRetention` precedence verbatim rather than inventing a unified one:
  anthropic-messages falls back to `"long"` and honors the bare `process.env.PI_CACHE_RETENTION`
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
