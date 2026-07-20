# packages/coding-agent/src/core/extensions/builtin

23 in-tree extensions. Each is the canonical answer to "can senpi do X without core changes?". Registration order matters.

## INVENTORY (registration order from `builtin/index.ts`)

| # | ID | Path | Role |
|---|-----|------|------|
| 1 | `hooks` | `hooks/` | Settings-configured lifecycle command hooks (PreToolUse/PostToolUse-style) with trust hashing + live status |
| 2 | `permission-system` | `permission-system/` | Full opencode-style permission port: rules, JSONL storage, prompts |
| 3 | `gpt-apply-patch` | `gpt-apply-patch/` | Codex-style `apply_patch` tool with rich render + freeform grammar |
| 4 | `prompt-preset` | `prompt-preset/` | Per-model system prompts (gpt-5.x, claude-fable-5, claude-opus-4-{5,6,7,8}, glm-5.2, kimi-k2-{6,7}, kimi-k3) |
| 5 | `todowrite` | `todotools/` | Op-based oh-my-pi todo port + `/todo` command; fully diverged from `../pi-extensions/pi-todotools` |
| 6 | `redraws` | `redraws.ts` | Force-redraw event hooks for stable streaming visuals |
| 7 | `anthropic-web-search` | `anthropic-web-search/` | Anthropic-native web search tool |
| 8 | `anthropic-bash` | `anthropic-bash/` | Anthropic-native bash tool variant |
| 9 | `openai-web-search` | `openai-web-search/` | OpenAI-native web search |
| 10 | `service-tier` | `service-tier.ts` | Per-model service-tier (e.g., priority-tier mapping) |
| 11 | `bash-timeout` | `bash-timeout/` | Bash tool timeout + handlers |
| 12 | `terminal` | `terminal/` | Persistent PTY-backed bash + bash_output/bash_input/bash_resize/kill_bash tools |
| 13 | `tool-pair-guard` | `tool-pair-guard/` | Repairs orphaned tool_use/tool_result pairs (compaction safety) |
| 14 | `compaction` | `compaction/` | Plugsuit-style speculative + emergency compaction with restoration |
| 15 | `history-search` | `history-search/` | Cross-session transcript search overlay (indexes session files) |
| 16 | `import-repro` | `import-repro.ts` | `/ir` command — import an issue-analysis CI session gist and switch to it |
| 17 | `session-observer` | `session-observer/` | `/sessions` command — peek at previous session transcripts in a HUD |
| 18 | `websearch` | `websearch/` | Provider-backed `web_search` tool + `/websearch` (providers incl. kimi); vendored from `../pi-extensions/pi-websearch` |
| 19 | `webfetch` | `webfetch/` | `webfetch` tool (md/text/html, gated by `PI_WEBFETCH`); vendored from `../pi-extensions/pi-webfetch` |
| 20 | `nested-agents-md` | `nested-agents-md/` | Auto-injects nearby `AGENTS.md` + `/nested-agents`; vendored from `../pi-extensions/pi-nested-agents-md` |
| 21 | `rules` | `rules/` | Rule-file discovery + `/rules`/`/reload-rules`; vendored from `../pi-extensions/pi-rules` |
| 22 | `goal` | `goal/` | Budget-free goal tools + `/goal`; vendored from `../pi-extensions/pi-goal` |
| 23 | `mcp` | `mcp/` | Built-in MCP client: `mcpServers` config, stdio/http transports, `/mcp` commands, tool exposure policy — see `mcp/changes.md` |

Plus bundled extension **codemode** (`@code-yeongyu/senpi-codemode`, resolved by resource-loader.ts) and 4 **global default extensions** (resolved fast-path): `diff`, `files`, `prompt-url-widget`, `tps` (in `globalDefaultExtensionFactories`).

## ADDING A NEW BUILTIN EXTENSION

1. Create `builtin/<name>/index.ts` exporting `default function(pi: ExtensionAPI) { … }`. Single-file extensions go in `builtin/<name>.ts`.
2. Add to `builtin/index.ts` import block + `builtinExtensions` array — pick registration order with intent.
3. Add a regression test under `test/suite/<name>-extension.test.ts` using `test/suite/harness.ts`.
4. If you modify upstream files (rare for new extensions), add a section to `<extension-dir>/changes.md`.
5. Reach for `ExtensionContext` getters (the `ctx` parameter of event handlers); do NOT cross into `core/` directly.

## CONVENTIONS

- **Subdirectory extensions** ship multi-file: `index.ts` + supporting `.ts` (`registry.ts`, `types.ts`, `parsers.ts`, etc.).
- **Single-file extensions** are kept flat (`diff.ts`, `files.ts`, `redraws.ts`, `service-tier.ts`, `tps.ts`, `prompt-url-widget.ts`).
- **`prompt-preset/`** has per-model files (`gpt-5.5.ts`, `claude-opus-4-7.ts`, …) and a shared `file-operations.ts` tuning block. New model = new preset file + entry in `presets.ts`. Models covered: gpt-5.x, claude-fable-5, claude-opus-4-{5,6,7,8}, glm-5.2, kimi-k2-{6,7}, kimi-k3.
- **`permission-system/` is a full port** of opencode's permission flow.
- **`compaction/`** is policy-rich (`policy.ts`, `speculative.ts`, `restoration-tracker.ts`, `circuit-breaker.ts`, `degradation-monitor.ts`, `per-turn-cap.ts`, `tool-truncation.ts`, `checkpoint-state.ts`, `context-reduction.ts`, `openai-remote.ts`, `repair-tool-pairs.ts`, `state.ts`, `todo-bridge.ts`, `prompts.ts`). Touch only with policy tests in lock-step.
- **External versions**: `external-versions.json` pins versions of sibling `../pi-extensions` packages used as vendored builtins; refresh with `packages/coding-agent/scripts/sync-builtin-extensions.mjs`.

## ANTI-PATTERNS

- Reordering `builtinExtensions` for cosmetic reasons — registration order is load-bearing for tools and permission hooks.
- Expecting context inside the factory body — `ExtensionContext` only arrives as the `ctx` parameter of event handlers. Do side effects inside `pi.on("session_start", …)`.
- Importing from `core/` directly — extensions must use the public `pi.*` API.
- Adding a new builtin without a regression test in `test/suite/<name>-extension.test.ts`.
- Splitting an existing single-file extension into a folder "for symmetry" — only split when there's actual code to split.

## NOTES

- `permission-system/storage.ts` writes JSONL approval logs; don't change the line shape without a migration.
- `compaction/restoration-tracker.ts` powers the post-compact context restoration feature — see `compaction/changes.md`.
- `goal/elapsed-ticker.ts` drives the live 'Pursuing goal...' footer refresh on a one-second cadence.
- MCP search exposure tool is `tool_search` (mcp/expose/tool-search.ts). Do not reintroduce `mcp_search` references anywhere.
- Prompt presets routinely append the shared `file-operations.ts` tuning block. Mirror this when adding GPT-5.x presets — see `prompt-preset/changes.md` 2026-05-07.
