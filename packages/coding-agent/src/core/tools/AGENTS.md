# packages/coding-agent/src/core/tools

Built-in tool implementations. **Prefer extensions for new tools** — this dir exists only for tools that ship in upstream `pi-mono` and need parity. The senpi-specific extras (`apply_patch`, web search, code execution, computer use) are builtin extensions, not core tools.

## FILES

```
tools/
├── index.ts                     # Tool definition exports (read, write, edit, bash, grep, find, ls)
├── bash.ts                      # Local bash tool: bash-core.ts + renderers, temp-file spill, local shell, detached-group tracking
├── read.ts                      # Local read tool: read-core.ts + renderers, photon image processing, fs path variants
├── write.ts                     # Local write tool: write-core.ts + renderers, fs baseline, machine-ops mutation queue
├── edit.ts                      # Local edit tool: edit-core.ts + renderers, machine-ops mutation queue
├── bash-core.ts, bash-schema.ts # Worker-safe bash core (schema, description, execute over a ToolMachine, output shaping)
├── shell-operations.ts          # One process.exec per command over a ToolMachine; ShellExecHost carries host specifics
├── shell-output.ts              # Redaction, throttled updates, spill settlement and the model-facing bash text
├── posix-signals.ts             # Signal numbers per machine OS for the 128 + n exit code of the worker path
├── read-core.ts, read-text.ts   # Worker-safe read core; read-text.ts shapes a text read (fold, truncation, notices)
├── write-core.ts, edit-core.ts  # Worker-safe write and edit cores
├── coding-tools-core.ts         # createCoreCodingTools: the four cores in createCodingTools order
├── tool-machine.ts              # ToolMachine binding over any MachineOps (worker-safe); machine.ts adds the local default
├── file-tool-host.ts            # Injected host pieces with worker defaults: POSIX paths, in-isolate queue, read variants
├── fs-error-code.ts             # Maps machine-ops error codes back to the fs codes the tools show
├── encoding.ts                  # UTF-8/base64 helpers without the Buffer global
├── output-accumulator-core.ts   # Streaming output state behind an OutputSpill; output-accumulator.ts adds the temp-file spill
├── machine-output-spill.ts      # OutputSpill that keeps the full output in a file on the tool machine
├── edit-diff.ts                 # Fuzzy matching + diff helpers for the edit tool (fuzzyFindText, generateDiffString)
├── edit-preview.ts              # computeEditsDiff: fs-reading preview for the edit renderer
├── diff-render.ts               # renderToolDiff() — diff rendering shared by edit, write, and gpt-apply-patch previews
├── grep.ts                      # Ripgrep-backed search tool
├── find.ts                      # Path search tool (gitignore-aware)
├── ls.ts                        # Directory listing
├── file-mutation-queue.ts       # Serializes write/edit/apply_patch on the same file
├── tail-window.ts               # Bounded decoded tail window used by OutputAccumulator
├── output-accumulator.ts        # Bounded streaming output snapshots; temp-file fallback preserves full output
├── path-utils.ts                # Path normalization, repo-root resolution
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
   inputSchema: <typebox schema>,
   promptSnippet: "...",                // baked into system prompt
   promptGuidelines: ["…"],             // Tool Guidelines section
   execute: async (input, ctx) => {…},
   renderCall: (input) => <terminal output>,
   renderResult: (result) => <terminal output>,
}
```

## WORKER-SAFE CORES

`src/tools-core.ts` (`@code-yeongyu/senpi/tools-core`) exports the cores. Nothing reachable from it may import a Node builtin or use the `Buffer`/`process` globals; `test/tools-core/worker-bundle.test.ts` bundles it for a browser target. Host differences are injected options with the local default in the local tool file, never runtime sniffing. `test/tools-core/parity.test.ts` runs core and local tools on one fake machine and requires identical content and details.

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
- Importing from `extensions/` — core tools must not depend on extension code.

## NOTES

- The `apply_patch` tool exists as a **builtin extension** under `extensions/builtin/gpt-apply-patch/`, NOT here. Its hunk math is self-contained (`patch-diff.ts` on the npm `diff` package); the piece it shares with core tools is `diff-render.ts`.
- `read.ts` handles image bytes via `utils/photon.ts` (WASM resize) before returning to the LLM. PDF handling happens in extensions.
- `find.ts` is gitignore-aware; the regression suite covers nested gitignore + glob behavior (`test/suite/regressions/3302-…`, `3303-…`).
