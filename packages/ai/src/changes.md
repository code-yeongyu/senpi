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

