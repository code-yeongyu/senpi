# packages/coding-agent/examples/extensions

Flat catalog of executable extension examples plus multi-file extension packages. Own file because it is the densest `pi.*` registration surface in the repo (score 14: 110+ files, 10 subdirs, heavy symbol/export density). Load any single file with `senpi -e <path>.ts`; per-example docs live in `README.md`.

## STRUCTURE

```text
*.ts                        Single-file examples, one pattern each (kebab-case)
subagent/                   Subagent tool: single/parallel/chain dispatch (~1k LOC)
custom-provider-anthropic/  OAuth + Anthropic-compatible streaming provider
custom-provider-gitlab-duo/ Provider against GitLab Duo
gondolin/                   Route built-in tools + `!` commands into a Gondolin micro-VM
sandbox/                    OS-level sandboxing via @anthropic-ai/sandbox-runtime
plan-mode/                  Read-only planning mode (generated instructions)
openai-codex-usage/         Codex usage tracking
dynamic-resources/          Dynamic resource examples
with-deps/                  Extension with its own private dependency manifest
doom-overlay/               WASM Doom rendered as live overlay; doom/build/ is generated
```

## WHERE TO LOOK

| Task | First choice |
|---|---|
| Register tool/command/flag/shortcut/renderer | `tools.ts`, `commands.ts`, `dynamic-tools.ts`, `custom-header.ts` |
| Built-in tool override or rendering | `minimal-mode.ts`, `built-in-tool-renderer.ts` |
| Overlays, focus, geometry | `overlay-test.ts`, `overlay-qa-tests.ts`, `widget-placement.ts` |
| Provider auth/payload | `custom-provider-anthropic/`, `provider-payload.ts` |
| Persistent state via session entries | `todo.ts`, `tic-tac-toe.ts`, `bookmark.ts`, `handoff.ts` |
| Prompt/preset/config files | `preset.ts`, `prompt-customizer.ts`, `system-prompt-header.ts` |
| Games / keyboard input | `snake.ts`, `space-invaders.ts`, `tic-tac-toe.ts` |
| Deferred-tool activation (Kimi flow) | `kimi-deferred-tools.ts` |
| RPC/UI child process | `../rpc-extension-ui.ts`, `rpc-demo.ts` |

## CONVENTIONS

- Event seams used across examples: `session_start`/`session_shutdown`, `turn_*`, `agent_*`, `before_agent_start`, `tool_call`/`tool_result`, `input`, `user_bash`, `model_select`.
- Presets read `~/.senpi/agent/presets.json` then `<cwd>/.senpi/presets.json`; project file wins. `provider-payload.ts` writes under `CONFIG_DIR_NAME`.
- `overlay-qa-tests.ts` is a runtime QA extension (many overlay commands, timers, spawned streaming processes), not a conventional test target.

## ANTI-PATTERNS

- Custom tools MUST truncate output (`truncated-tool.ts` demonstrates ripgrep wrapping with 50KB/2000-line caps).
- Games never expose the user's cursor and never split a tool-call sequence across responses.
- Never leave timers or child processes alive past `session_shutdown`.
- Shell/process-delegating examples (`ssh.ts`, `interactive-shell.ts`, `inline-bash.ts`, `auto-commit-on-exit.ts`, `git-merge-and-resolve.ts`) cross trust boundaries; adopt deliberately, never as boilerplate.

---

Parent: `examples/AGENTS.md` (import rules, factory discipline, validation).
