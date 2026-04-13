# Core Extensions Changes

## 2026-04-13 - GPT apply_patch builtin support

### What changed and why
- Added builtin `gpt-apply-patch` extension support so OpenAI GPT sessions can swap `write`/`edit` for a Codex-style `apply_patch` tool and react to mid-session model changes.
- Extended extension/tool plumbing to carry OpenAI Responses freeform grammar metadata. This core change was necessary because the existing extension API only modeled JSON-schema function tools, which made exact Codex GPT `apply_patch` parity impossible from an extension alone.

### Files modified
- `types.ts`
- `builtin/index.ts`
- `builtin/gpt-apply-patch.ts`

### Why the extension system couldn't handle this alone
- `ToolDefinition` had no way to express freeform grammar tools, only JSON-schema parameters.
- Wrapper plumbing dropped any provider-specific tool metadata before requests reached `pi-ai`.

### Expected merge conflict zones
- `types.ts` around `ToolDefinition`
- `builtin/index.ts` builtin registration ordering

