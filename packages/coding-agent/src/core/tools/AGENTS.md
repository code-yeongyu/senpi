# packages/coding-agent/src/core/tools

Upstream-parity tool domain (score 11). **Prefer extensions for new tools** — this dir exists only for tools that ship in upstream `pi-mono` and need parity. The senpi-specific extras (`apply_patch`, web search, code execution, computer use) are builtin extensions, not core tools.

## FILES

```
tools/
├── index.ts                     # Eight tool definitions; four-tool coding/read-only factories
├── bash.ts                      # Bash tool — promptSnippet uses `rg` (not `grep`) per fork tuning
├── powershell.ts                # PowerShell definition + injectable spawn/operations
├── read.ts                      # File read tool with image/binary handling
├── write.ts                     # File create/replace tool
├── edit.ts                      # In-place edit tool (uses `edit-diff.ts` for hunks)
├── edit-diff.ts                 # Fuzzy matching + diff helpers for the edit tool (fuzzyFindText, computeEditsDiff)
├── diff-render.ts               # renderToolDiff() — diff rendering shared by edit, write, and gpt-apply-patch previews
├── grep.ts                      # Ripgrep-backed search tool
├── find.ts                      # Path search tool (gitignore-aware)
├── ls.ts                        # Directory listing
├── file-mutation-queue.ts       # Serializes write/edit/apply_patch on the same file
├── tail-window.ts               # Bounded decoded tail window used by OutputAccumulator
├── output-accumulator.ts        # Bounded streaming output snapshots; temp-file fallback preserves full output
├── path-utils.ts                # Path normalization, repo-root resolution
├── filesystem-policy.ts         # Canonical containment policy for filesystem tools
├── bounded-realpath.ts          # Resolution deadlines; serialization-key fallback is not a policy path
├── read-classifiers.ts          # Read input classification
├── unified-diff.ts, write-result.ts # Shared diff text and write-result shaping
├── render-utils.ts              # ANSI / chalk / panel helpers shared across renders
├── tool-definition-wrapper.ts   # Helper to wire ToolDefinition + render + execute
├── truncate.ts                  # Output truncation policy
└── changes.md                   # Fork tracker: bash timeout validation, shared diff rendering (edit/write/apply_patch), bash prompt tuning (rg over grep, elapsed display, syntax highlighting)
```

## TOOL DEFINITION SHAPE

```typescript
{
   name: "<tool>",
   description: "...",
   parameters: <typebox schema>,
   promptSnippet: "...",                // baked into system prompt
   promptGuidelines: ["…"],             // Tool Guidelines section
   execute: async (toolCallId, params, signal, onUpdate, ctx) => {…},
   renderCall: (params, theme, context) => <TUI component>,
   renderResult: (result, options, theme, context) => <TUI component>,
}
```

## CONVENTIONS

- **`promptSnippet` is GLOBAL prompt content** — it lands in every model's system prompt. Be precise. The fork already corrected `bash.ts` to recommend `rg` over `grep` (2026-05-07; see `changes.md`).
- **File mutation queue is mandatory** for any tool that modifies on-disk content. Bypassing it causes interleaved-write corruption.
- **Output accumulator + truncate** must be used for long stdout. Streaming the entire output is forbidden — it will blow the context window.
- **Renderers return TUI nodes**, never raw strings. Use `render-utils.ts` helpers.
- **Tools live in core only when upstream parity demands it**. Senpi-specific tools (`apply_patch`, web search, etc.) live as builtin extensions in `extensions/builtin/`.

## ANTI-PATTERNS

- Editing `bash.ts` `promptSnippet` to re-introduce `grep` — already fixed; senpi has a dedicated `grep` tool.
- Adding a new tool here when the same effect can be a builtin extension — bloats merge surface.
- Bypassing `file-mutation-queue.ts` — concurrent writes on the same path will corrupt.
- Hardcoding output limits — go through `truncate.ts` policy.
- Depending on builtin extension implementations here. The shared `extensions/types.ts` ToolDefinition contract is intentionally imported.

## NOTES

- The `apply_patch` tool exists as a **builtin extension** under `extensions/builtin/gpt-apply-patch/`, NOT here. Its hunk math is self-contained (`patch-diff.ts` on the npm `diff` package); the piece it shares with core tools is `diff-render.ts`.
- `read.ts` handles image bytes via `utils/photon.ts` (WASM resize) before returning to the LLM. PDF handling happens in extensions.
- `temporarilyDisabledToolNames` in `index.ts` currently withholds `grep` from the model-facing surface while preserving registered-tool resolution for programmatic callers such as Cursor's exec bridge. Do not equate registration with activation.
- `find.ts` is gitignore-aware; the regression suite covers nested gitignore + glob behavior (`test/suite/regressions/3302-…`, `3303-…`).
