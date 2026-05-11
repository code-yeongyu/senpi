# packages/coding-agent/src/core/extensions/builtin

23 in-tree extensions. Each is the canonical answer to "can senpi do X without core changes?". Registration order matters.

## INVENTORY (registration order from `builtin/index.ts`)

| # | ID | Path | Role |
|---|-----|------|------|
| 1 | `background-task` | `background-task/` | Run / monitor long-lived background work |
| 2 | `permission-system` | `permission-system/` | Full opencode-style permission port: rules, JSONL storage, prompts |
| 3 | `gpt-apply-patch` | `gpt-apply-patch/` | Codex-style `apply_patch` tool with rich render + freeform grammar |
| 4 | `prompt-preset` | `prompt-preset/` | Per-model system prompts (gpt-5.x, claude-opus-4-{5,6,7}, kimi-k2-6) |
| 5 | `todowrite` | `todotools/` | Plan/task tools + continuation chain |
| 6 | `redraws` | `redraws.ts` | Force-redraw event hooks for stable streaming visuals |
| 7 | `anthropic-web-search` | `anthropic-web-search/` | Anthropic-native web search tool |
| 8 | `anthropic-tool-search` | `anthropic-tool-search/` | Anthropic-native tool-search tool |
| 9 | `anthropic-code-execution` | `anthropic-code-execution/` | Anthropic-native code-execution sandbox |
| 10 | `anthropic-bash` | `anthropic-bash/` | Anthropic-native bash tool variant |
| 11 | `anthropic-text-editor` | `anthropic-text-editor/` | Anthropic-native text editor tool |
| 12 | `anthropic-computer-use` | `anthropic-computer-use/` | Anthropic computer-use bindings |
| 13 | `openai-web-search` | `openai-web-search/` | OpenAI-native web search |
| 14 | `openai-code-interpreter` | `openai-code-interpreter/` | OpenAI Code Interpreter |
| 15 | `google-google-search` | `google-google-search/` | Google Search grounding |
| 16 | `google-code-execution` | `google-code-execution/` | Google native code execution |
| 17 | `google-url-context` | `google-url-context/` | Google URL grounding |
| 18 | `openai-api-parallel-tool-calls` | `openai-api-parallel-tool-calls/` | Toggles `parallel_tool_calls: true` on payload |
| 19 | `service-tier` | `service-tier.ts` | Per-model service-tier (e.g., priority-tier mapping) |
| 20 | `bash-timeout` | `bash-timeout/` | Bash tool timeout + handlers |
| 21 | `tool-pair-guard` | `tool-pair-guard/` | Repairs orphaned tool_use/tool_result pairs (compaction safety) |
| 22 | `compaction` | `compaction/` | Plugsuit-style speculative + emergency compaction with restoration |

Plus 4 **global default extensions** (resolved fast-path): `diff`, `files`, `prompt-url-widget`, `tps` (in `globalDefaultExtensionFactories`).

## ADDING A NEW BUILTIN EXTENSION

1. Create `builtin/<name>/index.ts` exporting `default function(pi: ExtensionAPI) { … }`. Single-file extensions go in `builtin/<name>.ts`.
2. Add to `builtin/index.ts` import block + `builtinExtensions` array — pick registration order with intent.
3. Add a regression test under `test/suite/<name>-extension.test.ts` using `test/suite/harness.ts`.
4. If you modify upstream files (rare for new extensions), add a section to `<extension-dir>/changes.md`.
5. Reach for `pi.context.*` getters; do NOT cross into `core/` directly.

## CONVENTIONS

- **Subdirectory extensions** ship multi-file: `index.ts` + supporting `.ts` (`registry.ts`, `types.ts`, `parsers.ts`, etc.).
- **Single-file extensions** are kept flat (`diff.ts`, `files.ts`, `redraws.ts`, `service-tier.ts`, `tps.ts`, `prompt-url-widget.ts`).
- **`prompt-preset/`** has per-model files (`gpt-5.5.ts`, `claude-opus-4-7.ts`, …) and a shared `file-operations.ts` tuning block. New model = new preset file + entry in `presets.ts`.
- **`permission-system/` is a full port** of opencode's permission flow. Agent-profile filtering now lives in the external `pi-agent-system` repository.
- **`compaction/`** is policy-rich (`policy.ts`, `speculative.ts`, `restoration-tracker.ts`, `circuit-breaker.ts`, `degradation-monitor.ts`, `per-turn-cap.ts`, `tool-truncation.ts`, `checkpoint-state.ts`, `overflow-detection.ts`, `state.ts`, `todo-bridge.ts`). Touch only with policy tests in lock-step.
- **External versions**: `external-versions.json` pins versions of upstream-equivalent deps; `prepublishOnly` may sync this.

## ANTI-PATTERNS

- Reordering `builtinExtensions` for cosmetic reasons — registration order is load-bearing for tools and permission hooks.
- Calling `pi.context.actions.*` inside the factory body — context isn't bound yet. Do it inside an event handler.
- Importing from `core/` directly — extensions must use the public `pi.*` API.
- Adding a new builtin without a regression test in `test/suite/<name>-extension.test.ts`.
- Splitting an existing single-file extension into a folder "for symmetry" — only split when there's actual code to split.

## NOTES

- `permission-system/storage.ts` writes JSONL approval logs; don't change the line shape without a migration.
- `compaction/restoration-tracker.ts` powers the post-compact context restoration feature — see `compaction/changes.md`.
- Prompt presets routinely append the shared `file-operations.ts` tuning block. Mirror this when adding GPT-5.x presets — see `prompt-preset/changes.md` 2026-05-07.
