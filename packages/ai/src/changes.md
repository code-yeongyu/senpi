# AI Source Changes

## 2026-04-13 - OpenAI Responses custom tool support for apply_patch

### What changed and why
- Added optional freeform grammar metadata to tool types.
- Updated OpenAI Responses request/history conversion to emit and preserve `custom` / `custom_tool_call` / `custom_tool_call_output` items for freeform tools. This was required to match Codex GPT `apply_patch` behavior instead of falling back to JSON function tools.

### Files modified
- `types.ts`
- `providers/openai-responses-shared.ts`

### Why the higher-level extension system couldn't handle this alone
- `pi-ai` only serialized tools as JSON function definitions for OpenAI Responses, so a builtin extension could not produce Codex-compatible freeform tools without core provider changes.

### Expected merge conflict zones
- `types.ts` tool model
- `providers/openai-responses-shared.ts` request/stream conversion paths

## 2026-04-17 - Claude Opus 4.7, `max` effort alignment, and extra-body pass-through

### What changed and why
- Added `claude-opus-4-7` to the Anthropic provider and its Bedrock cross-region profiles (`anthropic.*`, `us.*`, `eu.*`, `global.*`) so Opus 4.7 is available in the catalog and survives re-runs of `generate-models.ts`.
- Expanded `supportsXhigh()` to include `opus-4-7` / `opus-4.7` so the coding agent exposes `xhigh` for Opus 4.7 users.
- Expanded Anthropic adaptive thinking support (`supportsAdaptiveThinking`) and effort mapping (`mapThinkingLevelToEffort`) for Opus 4.7:
  - `xhigh` now maps to the native `"xhigh"` effort on Opus 4.7 (Anthropic's newest tier).
  - `xhigh` still maps to `"max"` on Opus 4.6 (Opus 4.6 doesn't support native `xhigh`).
  - Added explicit `"max"` to the effort type union for future use.
  - Cast through `{ output_config?: { effort: AnthropicEffort } }` while the @anthropic-ai/sdk upstream types still reject `"xhigh"`.
- Added `StreamOptions.extraBody` for pass-through custom body fields (matches opencode's provider `options`). Wired it through every builtin provider's payload builder (`anthropic`, `openai-responses`, `openai-completions`, `azure-openai-responses`, `openai-codex-responses`, `mistral`, `google`, `google-vertex`, `google-gemini-cli`, `amazon-bedrock`). A shared `applyExtraBody` helper and per-provider reserved-key sets live in `providers/simple-options.ts` to prevent users from overriding provider-managed fields (model id, messages, stream flag, etc.).

### Files modified
- `types.ts`
- `models.ts`
- `models.generated.ts`
- `providers/simple-options.ts`
- `providers/anthropic.ts`
- `providers/openai-responses.ts`
- `providers/openai-completions.ts`
- `providers/azure-openai-responses.ts`
- `providers/openai-codex-responses.ts`
- `providers/mistral.ts`
- `providers/google.ts`
- `providers/google-vertex.ts`
- `providers/google-gemini-cli.ts`
- `providers/amazon-bedrock.ts`
- `scripts/generate-models.ts`

### Why the higher-level extension system couldn't handle this alone
- Extra-body pass-through has to be read inside each provider's payload builder (pre-`onPayload` hook), which is core `pi-ai` territory; a coding-agent extension cannot reach into `pi-ai` provider payload construction.
- Opus 4.7 model metadata, xhigh capability detection, and adaptive thinking effort mapping all live in `pi-ai`. `supportsXhigh`, `supportsAdaptiveThinking`, and `mapThinkingLevelToEffort` are internal to the provider.
- Running `generate-models.ts` regenerates `models.generated.ts` from models.dev; the Opus 4.7 override block ensures the upstream regeneration keeps our entry.

### Expected merge conflict zones
- `scripts/generate-models.ts` Opus override block (lines around the 4.6 additions).
- `src/providers/anthropic.ts` `supportsAdaptiveThinking` / `mapThinkingLevelToEffort` / `AnthropicEffort`.
- `src/providers/simple-options.ts` (new exports).
- `src/models.ts` `supportsXhigh`.
- `src/types.ts` `StreamOptions.extraBody`.

## 2026-04-17 (follow-up) - "max" ThinkingLevel + tightened extraBody guards + Google `config` merge

### What changed and why
- Exposed Anthropic's native `"max"` effort through the unified `ThinkingLevel` surface: `StreamOptions.reasoning: "max"` maps to `max` on Opus 4.6/4.7, clamps to `high` on other adaptive models, and falls back to the `high` budget on budget-based Anthropic models. OpenAI-style providers clamp `max` to `xhigh` on xhigh-capable models (GPT-5.2/5.3/5.4) and to `high` otherwise via a new `clampMaxForOpenAI` helper.
- Extended the per-provider reserved-key sets so `extraBody` cannot stomp library-managed fields. New reservations include `metadata`, `temperature`, `store`, `stream_options`, `provider`, `providerOptions`, `tool_stream`, `prompt_cache_key`, `prompt_cache_retention`, `service_tier`, `promptMode`, `requestMetadata`. The Google reserved set now targets the inner `config` object (which the @google/genai SDK serializes as the HTTP request body) with `systemInstruction` / `tools` / `toolConfig` / `generationConfig` / `thinkingConfig` / `responseMimeType` / `responseSchema` / `cachedContent` / `abortSignal` / `httpOptions` reserved.
- Merged Google and Google Vertex `extraBody` into `params.config` instead of the top-level `GenerateContentParameters` so user-supplied fields actually reach the Gemini wire (the SDK does not serialize root-level unknown fields).
- Updated `adjustMaxTokensForThinking` / `clampReasoning` to accept the new `"max"` level without crashing on missing budget entries.

### Files modified (follow-up)
- `src/types.ts` (ThinkingLevel adds `"max"`)
- `src/providers/simple-options.ts` (added `clampMaxForOpenAI`, tightened reserved sets, Google reservations target `config`)
- `src/providers/anthropic.ts` (`mapThinkingLevelToEffort` native `max` case, JSDoc refresh, reserved keys `metadata` + `temperature`)
- `src/providers/openai-responses.ts`, `openai-completions.ts`, `openai-codex-responses.ts`, `azure-openai-responses.ts` (use `clampMaxForOpenAI` on xhigh-capable models)
- `src/providers/amazon-bedrock.ts` (budget table adds `max`, clamp `max` on budget-based path)
- `src/providers/google.ts`, `google-vertex.ts` (merge extraBody into `config`)

### Why the higher-level extension system couldn't handle this alone
- The `ThinkingLevel` union, provider effort mapping, and reserved-key sets all live inside `pi-ai`. Exposing `"max"` to the coding agent requires widening the shared union and updating every provider's payload builder and option-derivation logic.

### Expected merge conflict zones (follow-up)
- `src/types.ts` `ThinkingLevel` union.
- Each provider's `streamSimple<Provider>` reasoning mapping block.
- `src/providers/simple-options.ts` exported reserved-key sets.

