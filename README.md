# senpi-mono


<p align="center">
  <a href="https://discord.gg/PUwSMR9XNk"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://github.com/code-yeongyu/senpi/actions/workflows/ci.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/code-yeongyu/senpi/ci.yml?style=flat-square&branch=main" /></a>
</p>

> ⚠️ **Experimental.** senpi is an opinionated, in-flight fork of [badlogic/pi-mono](https://github.com/badlogic/pi-mono). It powers [Dori](https://sisyphuslabs.ai) under the hood and reflects what one specific AI assistant needs from a coding-agent runtime. Use it; don't bet a production pipeline on it.

senpi is a senpai-name pun and a more **sane** pi with extra batteries included — a TypeScript monorepo that rebrands pi-mono's coding agent as `senpi` and ships a curated set of builtin extensions and core tweaks on top of upstream.

> **Upstream**: [pi-mono](https://github.com/badlogic/pi-mono) by [@mariozechner](https://github.com/badlogic) — tools for building AI agents and managing LLM deployments.

## Inspired by OMO, built as Dori's coding-agent runtime

senpi was born from two influences:

- **Strong influence from [OMO (oh-my-openagent)](https://github.com/code-yeongyu/oh-my-openagent).** OMO is the heavyweight opencode harness with discipline agents (Sisyphus, Hephaestus, Prometheus), [IntentGate](https://factory.ai/news/terminal-bench), hash-anchored edits, Team Mode, skill-embedded MCPs, Ralph Loop, todo enforcers, and a lot more. senpi reuses many of OMO's signature ideas (intent gate, sub-agents, dynamic prompt, per-model presets, parallel-tool routing, todo continuation) but **keeps the surface as light as possible** so it can stay close to upstream pi-mono. Think of senpi as **a light version of OMO** that runs as a single pi CLI binary instead of an opencode plugin.
- **senpi is the coding-agent runtime for [Dori](https://sisyphuslabs.ai).** Dori is Sisyphus Labs' AI assistant — see the [Dori callout in OMO's README](https://github.com/code-yeongyu/oh-my-openagent#oh-my-openagent) for context. senpi is usable standalone, but the design decisions (intent gate phrasing, builtin extension set, prompt presets per model family, branding) are tuned for what Dori needs when it executes code work.

Core source modifications are minimised and tracked in [`changes.md`](#fork-strategy) files alongside every modified subdirectory so upstream rebases stay clean.

## Want more? Try the pi-extensions ecosystem

senpi ships a fixed set of builtin extensions and stops there. If you want **more capabilities** — LSP, AST-grep, sandboxing, goal tracking, web search/fetch, rule loading — the sibling **pi-extensions** repos cover the surface as standalone packages you can install on top:

| Extension | What it adds |
|---|---|
| [`pi-ast-grep`](https://github.com/code-yeongyu/pi-ast-grep) | AST-aware code search/replace across 25 languages (ports OMO's AST-grep tool stack). Auto-downloads `sg` on first use. |
| [`pi-lsp-client`](https://github.com/code-yeongyu/pi-lsp-client) | LSP integration: `lsp_rename`, `lsp_goto_definition`, `lsp_find_references`, `lsp_diagnostics`, plus a `/lsp` inspector (ports OMO's LSP stack). |
| [`pi-rules`](https://github.com/code-yeongyu/pi-rules) | Auto-discovers rule files from `.sisyphus/rules/`, `.claude/rules/`, `.cursor/rules/`, `.github/instructions/`, AGENTS.md, CLAUDE.md and injects them into context. |
| [`pi-sandbox`](https://github.com/code-yeongyu/pi-sandbox) | OS-level sandbox policy with native, Docker, justbash, and QEMU backends plus SSH transport facets. |
| [`pi-nested-agents-md`](https://github.com/code-yeongyu/pi-nested-agents-md) | Auto-injects nearby `AGENTS.md` files when the agent reads from a nested directory (ports OMO behavior). |
| [`pi-goal`](https://github.com/code-yeongyu/pi-goal) | Persistent goal tracking with Codex-style goal tools, TUI footer, and continuation prompts. |
| [`pi-webfetch`](https://github.com/code-yeongyu/pi-webfetch) | `web_fetch` tool — URL content as markdown / plain text / HTML with bounded time and size. |
| [`pi-websearch`](https://github.com/code-yeongyu/pi-websearch) | Provider-backed web search with config-gated activation, TUI status, and source-aware results. |

Install any of them with:

```bash
senpi install git:github.com/code-yeongyu/pi-ast-grep
senpi install git:github.com/code-yeongyu/pi-lsp-client
# … etc.
```

See [Senpi Packages](packages/coding-agent/README.md#pi-packages) for the install / update / remove flow. The other pi-extensions packages (Anthropic / OpenAI / Google native tools, `pi-apply-patch`, `pi-bash-timeout`, `pi-openai-api-parallel-tool-calls`) are **already shipped as builtins inside senpi** — you don't need to install them.

## Why "senpi"

`senpi` is a small joke on **senpai**, but it is also literal project positioning: this fork aims to be a more **sane** pi with practical additions that make everyday agent work smoother without abandoning upstream's core design.

All additions follow pi's extension-first philosophy. Core source modifications are minimized and [documented in `changes.md` files](#fork-strategy) to keep upstream rebases clean.

## What this fork adds

senpi inherits pi's extension-first design — the core stays minimal, every feature lands as a builtin extension. The bet is that an opinionated set of features is wanted often enough to be in the binary; anything you don't want is still one settings flag away from being off (`disabledBuiltinExtensions` in `settings.json`).

Verified against `git diff upstream/main..HEAD` and every `changes.md` file in the repo.

### New core subsystems

| Subsystem | What it does | Docs |
|-----------|--------------|------|
| **Dynamic system prompt** | Replaces upstream's static prompt with an adaptive builder: senpi identity → forced intent gate → exploration discipline → parallel-tool guidance → verification tiers → categorized tool reference → policies → style → optional per-model tuning. | [`dynamic-prompt/`](packages/coding-agent/src/core/dynamic-prompt/AGENTS.md) · [`changes.md`](packages/coding-agent/src/core/dynamic-prompt/changes.md) |
| **Compaction pipeline** | Plugsuit-style adaptive thresholds, empty-summarization guard, branch summarization hooks. Speculative + emergency compaction with restoration tracker lives as the [`compaction` builtin extension](#owned-builtin-extensions). | [`core/compaction/`](packages/coding-agent/src/core/compaction/) · [`changes.md`](packages/coding-agent/src/core/compaction/changes.md) |
| **Tool-call middleware rewrite** | XML / Hermes / YAML+XML / Gemma4 text-tool protocols for models without native function calling. Strict parsing, stream-error preservation. | [`tool-call-middleware/`](packages/ai/src/tool-call-middleware/AGENTS.md) · [`changes.md`](packages/ai/src/tool-call-middleware/changes.md) |

### Owned builtin extensions

In-tree, tightly coupled to senpi internals. Loaded in this exact registration order:

| # | Extension | Role | Docs |
|---|-----------|------|------|
| 1 | [`background-task`](packages/coding-agent/src/core/extensions/builtin/background-task/) | `task` / `background_output` / `background_cancel` tools, sub-agent spawning into detached subprocesses, custom session entries, desktop notifications | [AGENTS.md](packages/coding-agent/src/core/extensions/builtin/background-task/AGENTS.md) |
| 2 | [`permission-system`](packages/coding-agent/src/core/extensions/builtin/permission-system/) | Full opencode-style permission port — rules, JSONL storage, TUI prompts, parser-aware patterns (bash arity, file globs, `apply_patch` body paths), non-interactive fallback | [AGENTS.md](packages/coding-agent/src/core/extensions/builtin/permission-system/AGENTS.md) · [changes.md](packages/coding-agent/src/core/extensions/builtin/permission-system/changes.md) |
| 3 | [`gpt-apply-patch`](packages/coding-agent/src/core/extensions/builtin/gpt-apply-patch/) *(vendored)* | When the active model is OpenAI GPT, swaps `write`/`edit` for Codex-style freeform `apply_patch` with a Lark grammar. Synced from [`code-yeongyu/pi-apply-patch`](https://github.com/code-yeongyu/pi-apply-patch). | [AGENTS.md](packages/coding-agent/src/core/extensions/builtin/gpt-apply-patch/AGENTS.md) |
| 4 | [`prompt-preset`](packages/coding-agent/src/core/extensions/builtin/prompt-preset/) | Per-model system prompt presets (gpt-5.x, claude-opus-4-{5,6,7}, kimi-k2-6) layered on top of the dynamic prompt. Shared codex-style file-operations tuning. | [AGENTS.md](packages/coding-agent/src/core/extensions/builtin/prompt-preset/AGENTS.md) · [changes.md](packages/coding-agent/src/core/extensions/builtin/prompt-preset/changes.md) |
| 5 | [`todowrite`](packages/coding-agent/src/core/extensions/builtin/todotools/) | `todowrite` / `todoread` tools with branch-aware persistence, sidebar widget, and a continuation loop that nudges the model to keep working | — |
| 6 | [`redraws`](packages/coding-agent/src/core/extensions/builtin/redraws.ts) | `/tui` command reporting cumulative TUI full-redraw count. Used for differential-rendering debugging. | — |
| 7 | [`anthropic-web-search`](packages/coding-agent/src/core/extensions/builtin/anthropic-web-search/) | Anthropic native `web_search` tool | — |
| 8 | [`anthropic-tool-search`](packages/coding-agent/src/core/extensions/builtin/anthropic-tool-search/) | Anthropic native `tool_search` tool | — |
| 9 | [`anthropic-code-execution`](packages/coding-agent/src/core/extensions/builtin/anthropic-code-execution/) | Anthropic native code-execution sandbox | — |
| 10 | [`anthropic-bash`](packages/coding-agent/src/core/extensions/builtin/anthropic-bash/) | Anthropic native bash tool variant | — |
| 11 | [`anthropic-text-editor`](packages/coding-agent/src/core/extensions/builtin/anthropic-text-editor/) | Anthropic native `str_replace_based_edit_tool` | — |
| 12 | [`anthropic-computer-use`](packages/coding-agent/src/core/extensions/builtin/anthropic-computer-use/) | Anthropic native computer-use bindings | — |
| 13 | [`openai-web-search`](packages/coding-agent/src/core/extensions/builtin/openai-web-search/) | OpenAI Responses native `web_search` | — |
| 14 | [`openai-code-interpreter`](packages/coding-agent/src/core/extensions/builtin/openai-code-interpreter/) | OpenAI Responses native `code_interpreter` | — |
| 15 | [`google-google-search`](packages/coding-agent/src/core/extensions/builtin/google-google-search/) | Google `googleSearch` grounding tool | — |
| 16 | [`google-code-execution`](packages/coding-agent/src/core/extensions/builtin/google-code-execution/) | Google `codeExecution` native tool | — |
| 17 | [`google-url-context`](packages/coding-agent/src/core/extensions/builtin/google-url-context/) | Google `urlContext` grounding tool | — |
| 18 | [`openai-api-parallel-tool-calls`](packages/coding-agent/src/core/extensions/builtin/openai-api-parallel-tool-calls/) *(vendored)* | Adds `parallel_tool_calls: true` to OpenAI-family payloads + nudges the system prompt to fan out. Synced from [`code-yeongyu/pi-openai-api-parallel-tool-calls`](https://github.com/code-yeongyu/pi-openai-api-parallel-tool-calls). | — |
| 19 | [`service-tier`](packages/coding-agent/src/core/extensions/builtin/service-tier.ts) | Injects `service_tier` (`auto` / `flex` / `priority`) into OpenAI Responses payloads using per-model service tier or `openai.serviceTier` setting | — |
| 20 | [`bash-timeout`](packages/coding-agent/src/core/extensions/builtin/bash-timeout/) *(vendored)* | Injects default + max bash timeouts, appends policy to system prompt. Synced from [`code-yeongyu/pi-bash-timeout`](https://github.com/code-yeongyu/pi-bash-timeout). | — |
| 21 | [`tool-pair-guard`](packages/coding-agent/src/core/extensions/builtin/tool-pair-guard/) | Sanitizes Anthropic request payloads by removing orphan `tool_result` blocks — compaction safety | — |
| 22 | [`compaction`](packages/coding-agent/src/core/extensions/builtin/compaction/) | Speculative + emergency compaction policy: degradation monitor, circuit breaker, per-turn cap, todo bridging, checkpoint state, restoration tracker, tool-result truncation | [AGENTS.md](packages/coding-agent/src/core/extensions/builtin/compaction/AGENTS.md) · [changes.md](packages/coding-agent/src/core/extensions/builtin/compaction/changes.md) |

> **All 20 directories** above are new vs upstream `pi-mono` — none exist in `badlogic/pi-mono`. Vendored versions are pinned in [`external-versions.json`](packages/coding-agent/src/core/extensions/builtin/external-versions.json) and synced from the sibling `pi-extensions` checkout at build time via [`sync-builtin-extensions.mjs`](packages/coding-agent/scripts/sync-builtin-extensions.mjs).

Agent-profile tool filtering is no longer an owned builtin. Install `pi-agent-system` from `../pi-extensions/pi-agent-system` (or GitHub `code-yeongyu/pi-agent-system`) when named sub-agent profiles are wanted.

### Global default extensions

Not loaded as builtins; written once into `~/.senpi/agent/extensions/` on first run so you can edit or remove them locally.

| Extension | Source | What it does |
|-----------|--------|--------------|
| `diff` | [`diff.ts`](packages/coding-agent/src/core/extensions/builtin/diff.ts) | `/diff` command — picks modified / deleted / new files from `git status`, opens VS Code's diff view |
| `files` | [`files.ts`](packages/coding-agent/src/core/extensions/builtin/files.ts) | `/files` command — lists files read / written / edited in the current session branch, opens selected in VS Code |
| `prompt-url-widget` | [`prompt-url-widget.ts`](packages/coding-agent/src/core/extensions/builtin/prompt-url-widget.ts) | Detects GitHub PR / issue URLs in prompts, fetches title via `gh`, auto-sets the session name |
| `tps` | [`tps.ts`](packages/coding-agent/src/core/extensions/builtin/tps.ts) | Tokens-per-second notification (input / output / cache r/w / total / elapsed) after each agent turn |

### Modified upstream packages

| Package | What changed | Reference |
|---------|--------------|-----------|
| [`packages/ai`](packages/ai/AGENTS.md) | Senpi-branded Codex `originator` and User-Agent, shared tool-pair-repair utility, OpenAI Responses custom/freeform tool support for `apply_patch`, Claude Opus 4.7 + `"max"` thinking level, `extraBody` pass-through across every provider, [tool-call middleware rewrite](packages/ai/src/tool-call-middleware/AGENTS.md) | [`ai/src/changes.md`](packages/ai/src/changes.md) |
| [`packages/agent`](packages/agent/AGENTS.md) | Parallel tool completion emission (concurrent finalization, source-order results), inline UUIDv7 replacing the `uuid` dep, ES2021-safe harness diagnostics | [`agent/src/changes.md`](packages/agent/src/changes.md) |
| [`packages/tui`](packages/tui/AGENTS.md) | Differential rendering tightening: insert-scroll fast path, viewport remap repaint fix, flicker-budget regression tests (no post-init full clears, balanced DECSET 2026) | [`tui/src/changes.md`](packages/tui/src/changes.md) |
| [`packages/coding-agent`](packages/coding-agent/AGENTS.md) | `senpi` branding, model config controls (`upstreamModelId`, `serviceTier`, favorite models, disable/whitelist/blacklist), non-blocking startup tool discovery, disabled startup update checks, [bash `promptSnippet` swap to `rg`](packages/coding-agent/src/core/tools/AGENTS.md), generated default extension fast-path, senpi-branded outbound identity | Multiple [`changes.md`](packages/coding-agent/src/) files |

### Other branding / runtime changes

| Change | Details |
|--------|---------|
| **`senpi` CLI identity** | The coding agent identifies itself as `senpi`, uses `.senpi/agent` for config storage, publishes as `@code-yeongyu/senpi`. |
| **Senpi-branded outbound identity** | Every outbound request emits `senpi` instead of `pi`: `User-Agent` (update check + Cloudflare + GitHub releases), `X-OpenRouter-Title`, OpenAI Codex `originator` + User-Agent, sub-agent spawn fallback command. |
| **No startup update checks** | Removed npm registry version checking and package update prompts at launch. |
| **Builtin extension UI grouping** | Builtins render under a `builtin/` group in the startup header, visually distinct from user and project extensions. |
| **Updated model registry** | `models.generated.ts` refreshed with latest model additions and deprecations. |
| **Self-update target** | `senpi update senpi` queries [`code-yeongyu/senpi`](https://github.com/code-yeongyu/senpi) releases, not upstream. |

## Fork Strategy

This fork rebases periodically on `upstream/main`. To minimize merge conflicts:

1. **Extension-first**: All features use pi's [extension system](packages/coding-agent/docs/extensions.md) as builtin extensions.
2. **Document core changes**: Every upstream file modification has a corresponding `changes.md` in the affected subdirectory, documenting what changed, why, and expected conflict zones.
3. **Remotes**: `origin` = [code-yeongyu/senpi](https://github.com/code-yeongyu/senpi), `upstream` = [badlogic/pi-mono](https://github.com/badlogic/pi-mono).

Modified upstream files (high-impact, see per-directory `changes.md` for the rest):

| File | Change |
|------|--------|
| `agent-session.ts` | Calls `buildDynamicSystemPrompt()` instead of `buildSystemPrompt()`; unified compaction pipeline; model-switch system-prompt change |
| `resource-loader.ts` | Removed SYSTEM.md / APPEND_SYSTEM.md discovery; added builtin extension loading; generated-default extension fast-path |
| `interactive-mode.ts` | Builtin extension display formatting; disabled update checks; non-blocking startup tools; favorite-model cycling |
| `model-registry.ts` | Custom `upstreamModelId` and `serviceTier`; provider/model disable/whitelist/blacklist; `thinkingLevelMapMode` |
| `settings-manager.ts` | `disabledBuiltinExtensions`; `favoriteModels`; `openai.serviceTier`; steering default `"all"` |
| `agent-loop.ts` (`packages/agent`) | `executeToolCallsParallel()` |
| `tui.ts` (`packages/tui`) | Differential rendering fast paths + flicker-budget enforcement |
| `package.json` | Rebranded the coding agent package and runtime identity to `senpi` |

## Share your OSS coding agent sessions

If you use pi or other coding agents for open source work, please share your sessions.

Public OSS session data helps improve coding agents with real-world tasks, tool use, failures, and fixes instead of toy benchmarks.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `pi-share-hf`.

You can also watch [this video](https://x.com/badlogicgames/status/2041151967695634619), where I show how I publish my `pi-mono` sessions.

I regularly publish my own `pi-mono` work sessions here:

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## All Packages

| Package | Description |
|---------|-------------|
| **[@earendil-works/pi-ai](packages/ai)** | Unified multi-provider LLM API with text streaming, tool calling, OAuth helpers, and image generation |
| **[@earendil-works/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@code-yeongyu/senpi](packages/coding-agent)** | Interactive coding agent CLI, rebranded as senpi |
| **mom** | Slack bot runner for dispatching coding-agent work in a target workspace, with host or Docker sandbox modes |
| **pods** | CLI utilities for managing vLLM models on GPU pods over SSH |
| **[@earendil-works/pi-tui](packages/tui)** | Terminal UI library with differential rendering |
| **[@earendil-works/pi-web-ui](packages/web-ui)** | Web components for AI chat interfaces |

For Slack/chat automation and workflows see [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat).

## Development

```bash
npm install          # Install all dependencies
npm run build        # Build all packages (dependency order)
npm run check        # Lint, format, and type check
npm test             # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Live-API integration suite (env-gated; requires API keys)
```

> `npm run check` requires `npm run build` first. The web-ui package uses `tsc` which needs compiled `.d.ts` files from dependencies.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).

## License

MIT

## Ganbare Ganbare Senpi

> *Hora, senpi senpi, senpi te kudasai!*
> *Ganbare ganbare senpi, gan ganbare ganbare senpi ora!*

A tiny, completely unserious love letter to the [Ganbare Ganbare Senpai](https://en.wikipedia.org/wiki/Don%27t_Toy_with_Me,_Miss_Nagatoro) meme that the project's name secretly bows to. Every time the rebase is clean and the tests are green, somewhere a kouhai whispers:

- **C'mon senpi, c'mon!** Ship the PR.
- **Notice me, senpi.** ...the diagnostics noticed first.
- **Try harder, senpi!** *(she did look. and the build did pass.)*
- **You can do it, senpi!** One more agent, one more tool, one more clean rebase.
- **Ganbare, ganbare, senpi! 頑張れ頑張れ先輩!** *Do your best, do your best, senpai!*

Yes, the entire project name is a senpai pun. Type strictly, run the tests, write a `changes.md`, keep the merge surface tiny — and *gan ganbare ganbare senpi ora!*

Shoutout to [plugsuits](https://github.com/minpeter/plugsuits): senpi's compaction system takes inspiration from its design.
