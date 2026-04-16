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

