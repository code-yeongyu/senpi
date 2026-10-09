# packages/coding-agent/src/core/extensions/builtin

41 in-tree extensions plus 4 global defaults. Each is the canonical answer to "can senpi do X without core changes?". Registration order matters.

## INVENTORY (registration order from `builtin/index.ts`)

| # | ID | Path | Role |
|---|-----|------|------|
| 1 | `loop-guard` | `loop-guard/` | Identical-loop reminders plus first-veto blocking and system-abort recovery; similar/cyclic loops remain advisory — see `loop-guard/changes.md` |
| 2 | `moved-path-guard` | `moved-path-guard/` | Refuses writes and commands that name a path the OmO desktop moved with its data home (`omo-desktop-moved.json` breadcrumb), hints the new location on reads of a gone moved path, and exports `resolveMovedPath` for `open_session`, schedule delivery and holder claims (senpi#2898); ahead of hooks so a moved path never reaches a prompt |
| 3 | `hooks` | `hooks/` | Settings-configured lifecycle command hooks (PreToolUse/PostToolUse-style) with trust hashing + live status |
| 4 | `permission-system` | `permission-system/` | Full opencode-style permission port: rules, JSONL storage, prompts |
| 5 | `gpt-apply-patch` | `gpt-apply-patch/` | Codex-style `apply_patch` tool with rich render + freeform grammar |
| 6 | `imagegen` | `imagegen/` | Client-side image generation tool plus the bundled `skill/` guidance and shared auth/state used by the native lane |
| 7 | `openai-image-gen` | `openai-image-gen/` | OpenAI-native image generation; follows `imagegen` so the native injector's bypass wiring observes the registered client tool |
| 8 | `prompt-preset` | `prompt-preset/` | Per-model system prompts (gpt-5.x, gpt-6-astra, claude-fable-5, claude-fable-5-1, claude-opus-5-5, claude-opus-5, claude-sonnet-5-5, claude-haiku-5-5, claude-opus-4-{5,6,7,8}, glm-5.2, glm-5.3, deepseek-v4-{flash,flash-0731,pro}, deepseek-v4-1-flash, grok-4.{5,6}, kimi-k2-{6,7,8}, kimi-k3) |
| 9 | `todowrite` | `todotools/` | Op-based oh-my-pi todo port + `/todo` command; fully diverged from `../pi-extensions/pi-todotools` |
| 10 | `redraws` | `redraws.ts` | `/tui` full-redraw count diagnostic |
| 11 | `anthropic-web-search` | `anthropic-web-search/` | Anthropic-native web search tool |
| 12 | `anthropic-bash` | `anthropic-bash/` | Anthropic-native bash tool variant |
| 13 | `openai-web-search` | `openai-web-search/` | OpenAI-native web search |
| 14 | `service-tier` | `service-tier.ts` | Per-model service-tier (e.g., priority-tier mapping) |
| 15 | `reasoning` | `reasoning/` | Capability-aware `/reasoning` (on/off axis) and `/efforts` (effort ladder); reclassifies the current model on every invocation. Sits beside `service-tier` — both only read the active model and notify, so relative order is not load-bearing |
| 16 | `model-fallback` | `model-fallback/` | Fallback-chain validation + `/model-fallback` menu, `--no-model-fallback` flag (uses `core/retry-fallback/`) |
| 17 | `recommended-models` | `recommended-models/` | Auto-switches implicit default models to recommended ones; respects explicit `settings` provenance; `--no-recommended-models` |
| 18 | `bash-timeout` | `bash-timeout/` | Bash tool timeout + handlers |
| 19 | `terminal` | `terminal/` | Persistent PTY-backed bash + bash_output/bash_input/bash_resize/kill_bash tools; follows bash-timeout (default reaches PTY bash) and anthropic-bash (mutual-exclusion step-aside) |
| 20 | `tool-pair-guard` | `tool-pair-guard/` | Repairs orphaned tool_use/tool_result pairs (compaction safety) |
| 21 | `compaction` | `compaction/` | Plugsuit-style speculative + emergency compaction with restoration |
| 22 | `history-search` | `history-search/` | Cross-session transcript search overlay (indexes session files) |
| 23 | `help` | `help/` | `/help` + `/keybindings` TUI overlay panel (renders `interactive/help-content.ts`) |
| 24 | `import-repro` | `import-repro.ts` | `/ir` command — import an issue-analysis CI session gist and switch to it |
| 25 | `websearch` | `websearch/` | Provider-backed `web_search` tool + `/websearch` (providers incl. kimi); vendored from `../pi-extensions/pi-websearch` |
| 26 | `webfetch` | `webfetch/` | `webfetch` tool (md/text/html, gated by `PI_WEBFETCH`); vendored from `../pi-extensions/pi-webfetch` |
| 27 | `video-in` | `video-in/` | Model-gated `read_video` tool (kimi-code ReadMediaFile parity); active only when the model declares the "video" input modality |
| 28 | `look-at` | `look-at/` | Vision-model delegation tool for media analysis when the active model cannot accept image input |
| 29 | `nested-agents-md` | `nested-agents-md/` | Auto-injects nearby `AGENTS.md` + `/nested-agents`; vendored from `../pi-extensions/pi-nested-agents-md` |
| 30 | `rules` | `rules/` | Rule-file discovery + `/rules`/`/reload-rules`; vendored from `../pi-extensions/pi-rules` |
| 31 | `goal` | `goal/` | Budget-free goal tools + `/goal`; vendored from `../pi-extensions/pi-goal` |
| 32 | `loop` | `loop/` | Scheduled/cron loop runs driven by a loopfile + `/loop` command — see `loop/AGENTS.md` |
| 33 | `schedule` | `schedule/` | Durable scheduled prompts: `schedule_prompt` tool writes job files (works in `--print`); `senpi schedule run` fires them out of process — see `schedule/AGENTS.md` |
| 34 | `cache-keepalive` | `cache-keepalive/` | Warms the provider prompt cache between turns (`warmPromptCache`, Anthropic-aware TTL) and renders a `cache-keepalive` notice entry |
| 35 | `ttsr` | `ttsr/` | Stream-rule detection (collapse + control-token-leak) with abort→remediate→retry; ported from oh-my-pi — see `ttsr/changes.md` |
| 36 | `btw` | `btw/` | `/btw` side-question command that queries in parallel without touching the main session |
| 37 | `claude-sdk-oauth` | `anthropic-subscription/` | Claude SDK OAuth provider: multi-account OAuth, resume-first session continuity, stream-safe failover — see `anthropic-subscription/AGENTS.md` + `changes.md` |
| 38 | `cursor-cli-oauth` | `cursor-cli-oauth/` | Cursor CLI OAuth provider lane: multi-account OAuth, spawn/stream parsing, failover; registers unconditionally and reports executable/auth state through its oauth check — see `cursor-cli-oauth/AGENTS.md` |
| 39 | `config-reload` | `config-reload/` | Hash-gated watcher for trusted global/project config surfaces that defers a full session reload until idle and exposes the `config-watch:*` event protocol; registered after settings-dependent builtins so a reload rebuilds their resolved settings, and before final MCP observation |
| 40 | `tool-search` | `tool-search/` | Shared tool catalog + `tool_search` exposure tool; loads before MCP, which feeds its tools into the same catalog |
| 41 | `mcp` | `mcp/` | Built-in MCP client: `mcpServers` config, stdio/http transports, `/mcp` commands, tool exposure policy — kept last so its provider-payload tap observes all co-resident builtin mutations; see `mcp/changes.md` |

Plus bundled extension **codemode** (`@code-yeongyu/senpi-codemode`, resolved by resource-loader.ts) and 4 **global default extensions** (resolved fast-path): `diff`, `files`, `prompt-url-widget`, `tps` (in `globalDefaultExtensionFactories`). Shared non-factory modules: `rule-activation/` (appendRuleActivation + renderer, consumed by `rules/` and `ttsr/`) and `monitor-state-event.ts` (consumed by `goal/` and `terminal/`).

## ADDING A NEW BUILTIN EXTENSION

1. Create `builtin/<name>/index.ts` exporting `default function(pi: ExtensionAPI) { … }`. Single-file extensions go in `builtin/<name>.ts`.
2. Add to `builtin/index.ts` import block + `builtinExtensions` array — pick registration order with intent.
3. Add a test under `test/suite/<name>-extension.test.ts` using `test/suite/harness.ts` only where the repository keeps tests for this behavior and a regression would otherwise pass unnoticed; a bug regression must fail on the pre-fix code, and an existing owner test that already fails may be that proof. See the TEST AUTHORING GATE in the root `AGENTS.md`.
4. Reach for `ExtensionContext` getters (the `ctx` parameter of event handlers); do NOT cross into `core/` directly. If you modify upstream files (rare), add a section to `<extension-dir>/changes.md`.

## CONVENTIONS

- **Subdirectory extensions** ship multi-file: `index.ts` + supporting `.ts` (`registry.ts`, `types.ts`, `parsers.ts`, etc.).
- **Single-file extensions** are kept flat (`diff.ts`, `files.ts`, `redraws.ts`, `service-tier.ts`, `tps.ts`, `prompt-url-widget.ts`).
- **`prompt-preset/`** has per-model files plus a shared `file-operations.ts` tuning block; new model = new preset file + entry in `presets.ts`. See `prompt-preset/AGENTS.md` for the covered list.
- **`permission-system/` is a full port** of opencode's permission flow.
- **`compaction/`** is policy-rich — see `compaction/AGENTS.md` for the sub-policy map; touch only with policy tests in lock-step.
- **External versions**: `external-versions.json` pins versions of sibling `../pi-extensions` packages used as vendored builtins; refresh with `packages/coding-agent/scripts/sync-builtin-extensions.mjs`.

## ANTI-PATTERNS

- Reordering `builtinExtensions` for cosmetic reasons — registration order is load-bearing for tools and permission hooks.
- Expecting context inside the factory body — `ExtensionContext` only arrives as the `ctx` parameter of event handlers. Do side effects inside `pi.on("session_start", …)`.
- Importing from `core/` directly — extensions must use the public `pi.*` API.
- Splitting an existing single-file extension into a folder "for symmetry" — only split when there's actual code to split.

## NOTES

- MCP search exposure tool is `tool_search`, owned by the registered `tool-search` builtin (`builtin/tool-search/tool.ts`). Do not reintroduce `mcp_search` references anywhere.
- Sub-directory detail lives in per-extension `AGENTS.md` files (compaction, mcp, goal, loop, schedule, terminal, permission-system, prompt-preset, todotools, gpt-apply-patch, anthropic-subscription, cursor-cli-oauth).

---
Generated: 2026-08-22 | Commit: `a5eed4453`
