# changes.md — dynamic-prompt

## Dynamic System Prompt (2026-04-05)

### What changed

- `agent-session.ts`: `_rebuildSystemPrompt()` calls `buildDynamicSystemPrompt()` instead of `buildSystemPrompt()`. References to `loaderSystemPrompt` (SYSTEM.md) and `loaderAppendSystemPrompt` (APPEND_SYSTEM.md) removed.
- `resource-loader.ts`: Removed SYSTEM.md / APPEND_SYSTEM.md discovery, loading, override, and storage. `getSystemPrompt()` returns `undefined`, `getAppendSystemPrompt()` returns `[]`. Interface methods kept for compatibility.
- New directory `dynamic-prompt/` with 7 files:
  - `types.ts` — AvailableTool interface
  - `tool-categorization.ts` — categorizeTools(), getToolsPromptDisplay()
  - `intent-gate.ts` — Phase 0 intent gate with dynamic key triggers
  - `tool-section.ts` — Categorized tool display with snippets and guidelines
  - `policies.ts` — Hard blocks and anti-patterns
  - `build.ts` — buildDynamicSystemPrompt() assembler
  - `index.ts` — re-exports

### Why

- Replace static pi default prompt with dynamic prompt that adapts to registered tools
- Add intent classification gate (Phase 0) to system prompt
- Remove SYSTEM.md / APPEND_SYSTEM.md file-based prompt overrides

### Why extension system couldn't handle this

The base prompt itself (what `_rebuildSystemPrompt` produces) needed replacement. Extensions can only modify it per-turn via `before_agent_start`, not replace the default builder.

### Modified upstream files

- `agent-session.ts` — 1 import changed, ~6 lines removed in `_rebuildSystemPrompt()`
- `resource-loader.ts` — ~77 lines removed (SYSTEM.md/APPEND_SYSTEM.md machinery)

### Expected merge conflict zones

- `agent-session.ts` line ~904: the `buildSystemPrompt()` call. Resolution: keep `buildDynamicSystemPrompt()`, update args if upstream adds new parameters.
- `resource-loader.ts`: `reload()` method near line 450. Resolution: drop any new SYSTEM.md/APPEND_SYSTEM.md code upstream adds.

## Remove LSP/AST Categories + Generalize Hero Line (2026-04-11)

### What changed

- `build.ts`: Hero line changed from coding-specific ("expert coding assistant operating inside pi") to generic ("You are a helpful assistant."). Two supporting coding-context lines removed.
- `types.ts`: `AvailableTool.category` union narrowed from 6 to 4 values (removed `"lsp"` | `"ast"`).
- `tool-categorization.ts`: Removed `lsp_` and `ast_grep` prefix detection in `getToolCategory()`. Removed `lsp_*` and `ast_grep` entries from `getToolsPromptDisplay()`.
- `tool-section.ts`: Removed `"lsp"` and `"ast"` from `CATEGORY_ORDER` and `CATEGORY_LABELS`.
- Tests updated: `build.test.ts`, `tool-categorization.test.ts`, `intent-gate.test.ts`, `tool-section.test.ts` — all lsp/ast-specific test cases removed or converted.

### Why

- System prompt should be domain-agnostic (not coding-specific).
- LSP and AST tool categories are not used in this fork's tool set.

### Why extension system couldn't handle this

These are core type definitions and prompt builder internals, not per-turn modifications.

### Modified upstream files

All changes are within the `dynamic-prompt/` directory which is already a fork modification.

### Expected merge conflict zones

- `types.ts`: If upstream adds the `"lsp" | "ast"` categories. Resolution: keep narrowed union.
- `tool-categorization.ts`, `tool-section.ts`: If upstream references lsp/ast categories. Resolution: drop those references.

## Prompt Leakage Guard (2026-04-10)

### What changed

- `intent-gate.ts`: Replaced "verbalize intent" wording with an internal-only routing step.
- `intent-gate.ts`: Added explicit guardrails to avoid exposing prompt scaffolding such as "Thinking level", "Step 0", or XML tool-call examples in user-facing output.
- `test/dynamic-prompt/intent-gate.test.ts`: Updated coverage to assert the internal-only wording.
- `test/dynamic-prompt/build.test.ts`: Added regression coverage to keep the assembled prompt from reintroducing `I detect ...` scaffolding.

### Why

- Gemini 3.1 Pro preview with MorphXML-style tool calling could echo prompt scaffolding into normal assistant output.
- The prior instruction explicitly asked the model to verbalize its routing decision, which encouraged user-visible leakage of internal planning text.
