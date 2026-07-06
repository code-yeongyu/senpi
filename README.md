# senpi


<p align="center">
  <a href="https://discord.gg/PUwSMR9XNk"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://github.com/code-yeongyu/senpi/actions/workflows/ci.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/code-yeongyu/senpi/ci.yml?style=flat-square&branch=main" /></a>
</p>

> ⚠️ **Experimental.** senpi is an opinionated, in-flight fork of [badlogic/pi-mono](https://github.com/badlogic/pi-mono). It powers [Dori](https://sisyphuslabs.ai) under the hood and reflects what one specific AI assistant needs from a coding-agent runtime. Use it; don't bet a production pipeline on it.

senpi is a senpai-name pun and a more **sane** pi with extra batteries included — a TypeScript monorepo that rebrands pi-mono's coding agent as `senpi` and ships a curated set of builtin extensions and core tweaks on top of upstream.

> **Upstream**: [pi-mono](https://github.com/badlogic/pi-mono) by [@mariozechner](https://github.com/badlogic) — tools for building AI agents and managing LLM deployments.

## Inspired by OMO, built as Dori's coding-agent runtime

senpi was born from two influences:

- **Strong influence from [OMO (oh-my-openagent)](https://github.com/code-yeongyu/oh-my-openagent).** OMO is the heavyweight opencode harness with discipline agents (Sisyphus, Hephaestus, Prometheus), [IntentGate](https://factory.ai/news/terminal-bench), hash-anchored edits, Team Mode, skill-embedded MCPs, Ralph Loop, todo enforcers, and a lot more. senpi reuses many of OMO's signature ideas (intent gate, dynamic prompt, per-model presets, parallel-tool routing, todo continuation) but **keeps the surface as light as possible** so it can stay close to upstream pi-mono. Think of senpi as **a light version of OMO** that runs as a single pi CLI binary instead of an opencode plugin.
- **senpi is the coding-agent runtime for [Dori](https://sisyphuslabs.ai).** Dori is Sisyphus Labs' AI assistant — see the [Dori callout in OMO's README](https://github.com/code-yeongyu/oh-my-openagent#oh-my-openagent) for context. senpi is usable standalone, but the design decisions (intent gate phrasing, builtin extension set, prompt presets per model family, branding) are tuned for what Dori needs when it executes code work.

Core source modifications are minimised and tracked in [`changes.md`](#fork-strategy) files alongside every modified subdirectory so upstream rebases stay clean.

## Coming from OMO? Recommended extension setup

If you're migrating from [OMO (oh-my-openagent)](https://github.com/code-yeongyu/oh-my-openagent), here is the practical map from "what I used in OMO" to "what to install in senpi". A lot of OMO's signature work is **already wired into senpi as a builtin** (nothing to install); the rest lives in the [`code-yeongyu/pi-*`](https://github.com/code-yeongyu?tab=repositories&q=pi-) GitHub repos and is one `senpi install` away.

> senpi is intentionally lighter than OMO — single CLI binary, not an opencode plugin. Some OMO concepts (Discipline Agents, Team Mode, Skills, Hashline, Ralph Loop, `/init-deep`) have **no 1:1 senpi counterpart** and are flagged at the bottom of this section. If you need those, keep using OMO.

### Already builtin in senpi — nothing to install

| OMO feature | senpi builtin |
|---|---|
| 🚪 **IntentGate** | [Dynamic system prompt](packages/coding-agent/src/core/dynamic-prompt/AGENTS.md) — every prompt opens with a forced intent gate before tool use. |
| ✅ **Todo Enforcer** | [`todowrite`](packages/coding-agent/src/core/extensions/builtin/todotools/) + continuation loop that re-engages idle agents. |
| **Per-model tuning** ("Model Setup") | [`prompt-preset`](packages/coding-agent/src/core/extensions/builtin/prompt-preset/) — GPT-5.x / Claude Opus 4.{5,6,7} / Kimi K2.6 presets. |
| **Session recovery / context management** | [`compaction`](packages/coding-agent/src/core/extensions/builtin/compaction/) — adaptive thresholds, restoration tracker, emergency compaction, tool-result truncation. |
| **Apply-patch on GPT models** | [`gpt-apply-patch`](packages/coding-agent/src/core/extensions/builtin/gpt-apply-patch/) — Codex-style freeform `apply_patch` with Lark grammar. |
| **Native web search** (Anthropic + OpenAI) | `anthropic-web-search`, `openai-web-search` builtins. |
| **Bash timeout discipline** | [`bash-timeout`](packages/coding-agent/src/core/extensions/builtin/bash-timeout/) — default + max-timeout enforcement, policy in system prompt. |
| **Compaction-safe tool pairing** | [`tool-pair-guard`](packages/coding-agent/src/core/extensions/builtin/tool-pair-guard/) — strips orphan `tool_result` blocks. |
| **Permission system** (opencode-style allow/deny) | [`permission-system`](packages/coding-agent/src/core/extensions/builtin/permission-system/) — rules, JSONL storage, TUI prompts, parser-aware patterns. |

### Install these pi-extension packages for the OMO-shaped senpi

```bash
senpi install git:github.com/code-yeongyu/pi-lsp-client            # 🛠️  LSP: rename / goto / refs / diagnostics + /lsp inspector
senpi install git:github.com/code-yeongyu/pi-ast-grep              # 🛠️  AST-Grep across 25 languages (auto-downloads sg)
senpi install git:github.com/code-yeongyu/pi-comment-checker       # 💬  Comment Checker — the standalone pi port of OMO's hook
senpi install git:github.com/code-yeongyu/pi-rules                 #     Context injection: .claude/rules, .cursor/rules, .github/instructions, AGENTS.md, CLAUDE.md
senpi install git:github.com/code-yeongyu/pi-nested-agents-md      # 🔍  Auto-injects nearby AGENTS.md (the runtime half of /init-deep)
senpi install git:github.com/code-yeongyu/pi-websearch             # 📚  Provider-backed web search (fills the Exa-style slot)
senpi install git:github.com/code-yeongyu/pi-webfetch              #     web_fetch tool (markdown / text / HTML, bounded time + size)
senpi install git:github.com/code-yeongyu/pi-goal                  #     Persistent goal tracking + continuation prompts (closest thing to Sisyphus discipline)

# Optional — only if you used the matching OMO surface:
senpi install git:github.com/code-yeongyu/pi-cua-integration                 # 🖥️  Computer-use bindings (desktop / browser)
senpi install git:github.com/code-yeongyu/pi-anthropic-computer-use          #     Claude-native computer use
senpi install git:github.com/code-yeongyu/pi-anthropic-code-execution        #     Claude-native code execution
senpi install git:github.com/code-yeongyu/pi-google-code-execution           #     Google-native code execution
senpi install git:github.com/code-yeongyu/pi-openai-code-interpreter         #     OpenAI Code Interpreter
senpi install git:github.com/code-yeongyu/pi-anthropic-text-editor           #     Claude-native text editor tool
senpi install git:github.com/code-yeongyu/pi-anthropic-tool-search           #     Claude-native tool search
senpi install git:github.com/code-yeongyu/pi-anthropic-web-fetch             #     Claude-native web fetch
senpi install git:github.com/code-yeongyu/pi-google-google-search            #     Google Search grounding
senpi install git:github.com/code-yeongyu/pi-google-url-context              #     Google URL grounding
senpi install git:github.com/code-yeongyu/pi-openai-api-parallel-tool-calls  #     OpenAI parallel_tool_calls payload support
```

Each package is also installable by git URL, e.g. `senpi install git:github.com/code-yeongyu/pi-comment-checker`. See [Senpi Packages](packages/coding-agent/README.md#pi-packages) for the full install / update / remove flow.

### Allow all permissions (OMO-style)

OMO runs with all tool permissions pre-approved. To replicate that behavior in senpi, add a wildcard allow rule to your global settings:

```bash
mkdir -p ~/.senpi/agent
cat > ~/.senpi/agent/settings.json << 'EOF'
{
  "permission": {
    "*": "allow"
  }
}
EOF
```

This tells the permission system to auto-approve every tool call without prompting. The `"*"` key matches all permission names, and `"allow"` grants them unconditionally. You can also set this per-project by placing the same `settings.json` in `.senpi/settings.json` at the project root.

> **Note:** This disables all interactive permission prompts. Only do this if you trust the model and the workspace you are running in.

### No direct senpi counterpart

These are part of OMO's opencode harness shape and are intentionally **not** in senpi:

- **Discipline Agents** (Sisyphus / Hephaestus / Oracle / Librarian / Explore / Multimodal Looker) and the **`ultrawork` / `ulw`** one-word orchestration entrypoint.
- **Team Mode** — lead + up to 8 parallel members, tmux visualization, `team_*` tool family, `hyperplan` / `security-research` skills riding on top.
- **Hashline / hash-anchored edit tool** — senpi stays with pi's standard `edit` / `multiedit` / `apply_patch`. `pi-comment-checker` covers the post-edit validation slot OMO uses Hashline for, just without `LINE#ID` content-hash identifiers.
- **Skill system** and **skill-embedded MCPs** — skills as a first-class concept (`SKILL.md`, scoped per-skill MCP servers) do not exist in senpi.
- **Prometheus interview-mode planner** and the **Ralph Loop / `/ulw-loop`** self-referential loop.
- **`/init-deep`** — there is no in-tree generator. Generate the hierarchical `AGENTS.md` tree manually (or with a normal agent prompt), then install `pi-nested-agents-md` so the agent actually reads them.
- **Built-in `doctor` command**, **Claude Code hook/command/skill/plugin compatibility layer**, and the **agent category router** (`visual-engineering` / `deep` / `quick` / `ultrabrain`).

## Want more? Try the pi-extensions ecosystem

senpi ships a fixed set of builtin extensions and stops there. The [`code-yeongyu/pi-*`](https://github.com/code-yeongyu?tab=repositories&q=pi-) GitHub repos contain the full extension ecosystem: some packages are vendored into senpi as builtins, while the rest can be installed on top when you want extra capabilities like LSP, AST-grep, goal tracking, web search/fetch, or rule loading.

### Installable extensions

These [`code-yeongyu/pi-*`](https://github.com/code-yeongyu?tab=repositories&q=pi-) packages are intended to be installed as standalone senpi/pi extensions:

| Extension | What it adds |
|---|---|
| [`pi-anthropic-code-execution`](https://github.com/code-yeongyu/pi-anthropic-code-execution) | Anthropic-native code execution. |
| [`pi-anthropic-computer-use`](https://github.com/code-yeongyu/pi-anthropic-computer-use) | Anthropic computer-use bindings. |
| [`pi-anthropic-text-editor`](https://github.com/code-yeongyu/pi-anthropic-text-editor) | Anthropic-native text editor tool. |
| [`pi-anthropic-tool-search`](https://github.com/code-yeongyu/pi-anthropic-tool-search) | Anthropic-native tool search. |
| [`pi-anthropic-web-fetch`](https://github.com/code-yeongyu/pi-anthropic-web-fetch) | Anthropic-native web fetch support. |
| [`pi-ast-grep`](https://github.com/code-yeongyu/pi-ast-grep) | AST-aware code search/replace across 25 languages. Auto-downloads `sg` on first use. |
| [`pi-comment-checker`](https://github.com/code-yeongyu/pi-comment-checker) | Runs comment-quality checks after file-editing tools and shows warnings in the TUI. |
| [`pi-cua-integration`](https://github.com/code-yeongyu/pi-cua-integration) | Computer-use action wiring for desktop/browser interaction surfaces. |
| [`pi-goal`](https://github.com/code-yeongyu/pi-goal) | Persistent goal tracking with Codex-style goal tools, TUI footer, and continuation prompts. |
| [`pi-google-code-execution`](https://github.com/code-yeongyu/pi-google-code-execution) | Google native code execution. |
| [`pi-google-google-search`](https://github.com/code-yeongyu/pi-google-google-search) | Google Search grounding. |
| [`pi-google-url-context`](https://github.com/code-yeongyu/pi-google-url-context) | Google URL grounding. |
| [`pi-lsp-client`](https://github.com/code-yeongyu/pi-lsp-client) | LSP integration: `lsp_rename`, `lsp_goto_definition`, `lsp_find_references`, `lsp_diagnostics`, plus a `/lsp` inspector. |
| [`pi-nested-agents-md`](https://github.com/code-yeongyu/pi-nested-agents-md) | Auto-injects nearby `AGENTS.md` files when the agent reads from a nested directory. |
| [`pi-openai-api-parallel-tool-calls`](https://github.com/code-yeongyu/pi-openai-api-parallel-tool-calls) | OpenAI `parallel_tool_calls` payload support. |
| [`pi-openai-code-interpreter`](https://github.com/code-yeongyu/pi-openai-code-interpreter) | OpenAI Code Interpreter. |
| [`pi-rules`](https://github.com/code-yeongyu/pi-rules) | Auto-discovers rule files from `.sisyphus/rules/`, `.claude/rules/`, `.cursor/rules/`, `.github/instructions/`, `AGENTS.md`, and `CLAUDE.md`. |
| [`pi-webfetch`](https://github.com/code-yeongyu/pi-webfetch) | `web_fetch` tool: URL content as markdown, plain text, or HTML with bounded time and size. |
| [`pi-websearch`](https://github.com/code-yeongyu/pi-websearch) | Provider-backed web search with config-gated activation, TUI status, and source-aware results. |

Install any of them with:

```bash
senpi install git:github.com/code-yeongyu/pi-ast-grep
senpi install git:github.com/code-yeongyu/pi-lsp-client
# ...substitute any of the package names from the table above.
```

See [Senpi Packages](packages/coding-agent/README.md#pi-packages) for the install / update / remove flow.

### pi-extension packages already shipped as senpi builtins

You do **not** need to install these packages for normal senpi use; their functionality is already included in the binary. This table is intentionally limited to packages that map to the currently registered `builtinExtensions` list:

| Package | Included as | Builtin capability |
|---|---|---|
| [`pi-anthropic-web-search`](https://github.com/code-yeongyu/pi-anthropic-web-search) | `anthropic-web-search` | Anthropic-native web search support. |
| [`pi-apply-patch`](https://github.com/code-yeongyu/pi-apply-patch) | `gpt-apply-patch` | Codex-style `apply_patch` tool for GPT-family runs. |
| [`pi-bash-timeout`](https://github.com/code-yeongyu/pi-bash-timeout) | `bash-timeout` | Bash timeout defaults, max timeout enforcement, and prompt policy. |
| [`pi-openai-web-search`](https://github.com/code-yeongyu/pi-openai-web-search) | `openai-web-search` | OpenAI Responses native web search. |
| [`pi-todotools`](https://github.com/code-yeongyu/pi-todotools) | `todowrite` | `todowrite` / `todoread`, todo sidebar state, workflow prompt guidance, and continuation follow-ups. |

Other builtins such as `permission-system`, `prompt-preset`, `anthropic-bash`, `service-tier`, `tool-pair-guard`, `compaction`, `history-search`, `session-observer`, and `kimi-web-search` are senpi-owned builtin extensions, not installable sibling packages.

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
| 1 | [`permission-system`](packages/coding-agent/src/core/extensions/builtin/permission-system/) | Full opencode-style permission port — rules, JSONL storage, TUI prompts, parser-aware patterns (bash arity, file globs, `apply_patch` body paths), non-interactive fallback | [AGENTS.md](packages/coding-agent/src/core/extensions/builtin/permission-system/AGENTS.md) · [changes.md](packages/coding-agent/src/core/extensions/builtin/permission-system/changes.md) |
| 2 | [`gpt-apply-patch`](packages/coding-agent/src/core/extensions/builtin/gpt-apply-patch/) *(vendored)* | When the active model is OpenAI GPT, swaps `write`/`edit` for Codex-style freeform `apply_patch` with a Lark grammar. Synced from [`code-yeongyu/pi-apply-patch`](https://github.com/code-yeongyu/pi-apply-patch). | [AGENTS.md](packages/coding-agent/src/core/extensions/builtin/gpt-apply-patch/AGENTS.md) |
| 3 | [`prompt-preset`](packages/coding-agent/src/core/extensions/builtin/prompt-preset/) | Per-model system prompt presets (gpt-5.x, claude-opus-4-{5,6,7}, kimi-k2-6) layered on top of the dynamic prompt. Shared codex-style file-operations tuning. | [AGENTS.md](packages/coding-agent/src/core/extensions/builtin/prompt-preset/AGENTS.md) · [changes.md](packages/coding-agent/src/core/extensions/builtin/prompt-preset/changes.md) |
| 4 | [`todowrite`](packages/coding-agent/src/core/extensions/builtin/todotools/) *(vendored)* | `todowrite` / `todoread` tools with branch-aware persistence, sidebar widget, workflow prompt guidance, and a continuation loop. Synced from [`code-yeongyu/pi-todotools`](https://github.com/code-yeongyu/pi-todotools). | — |
| 5 | [`redraws`](packages/coding-agent/src/core/extensions/builtin/redraws.ts) | `/tui` command reporting cumulative TUI full-redraw count. Used for differential-rendering debugging. | — |
| 6 | [`anthropic-web-search`](packages/coding-agent/src/core/extensions/builtin/anthropic-web-search/) | Anthropic native `web_search` tool | — |
| 7 | [`anthropic-bash`](packages/coding-agent/src/core/extensions/builtin/anthropic-bash/) | Anthropic native bash tool variant | — |
| 8 | [`openai-web-search`](packages/coding-agent/src/core/extensions/builtin/openai-web-search/) | OpenAI Responses native `web_search` | — |
| 9 | [`service-tier`](packages/coding-agent/src/core/extensions/builtin/service-tier.ts) | Injects `service_tier` (`auto` / `flex` / `priority`) into OpenAI Responses payloads using per-model service tier or `openai.serviceTier` setting | — |
| 10 | [`bash-timeout`](packages/coding-agent/src/core/extensions/builtin/bash-timeout/) *(vendored)* | Injects default + max bash timeouts, appends policy to system prompt. Synced from [`code-yeongyu/pi-bash-timeout`](https://github.com/code-yeongyu/pi-bash-timeout). | — |
| 11 | [`tool-pair-guard`](packages/coding-agent/src/core/extensions/builtin/tool-pair-guard/) | Sanitizes Anthropic request payloads by removing orphan `tool_result` blocks — compaction safety | — |
| 12 | [`compaction`](packages/coding-agent/src/core/extensions/builtin/compaction/) | Speculative + emergency compaction policy: degradation monitor, circuit breaker, per-turn cap, todo bridging, checkpoint state, restoration tracker, tool-result truncation | [AGENTS.md](packages/coding-agent/src/core/extensions/builtin/compaction/AGENTS.md) · [changes.md](packages/coding-agent/src/core/extensions/builtin/compaction/changes.md) |
| 13 | [`history-search`](packages/coding-agent/src/core/extensions/builtin/history-search/) | `/history` command — searches prompt history across sessions in an overlay | — |
| 14 | [`session-observer`](packages/coding-agent/src/core/extensions/builtin/session-observer/) | `/sessions` command — peeks at previous session transcripts in a HUD overlay | — |
| 15 | [`kimi-web-search`](packages/coding-agent/src/core/extensions/builtin/kimi-web-search/) | `SearchWeb` / `FetchURL` tools backed by the Kimi search/fetch API; toggled via `PI_KIMI_WEB_SEARCH` | — |

> The builtin directories above are new vs upstream `pi-mono` — none exist in `badlogic/pi-mono`. Vendored versions are pinned in [`external-versions.json`](packages/coding-agent/src/core/extensions/builtin/external-versions.json) and synced from the sibling `pi-extensions` checkout with [`sync-builtin-extensions.mjs`](packages/coding-agent/scripts/sync-builtin-extensions.mjs).

### Standalone extension repositories

These are maintained as public `code-yeongyu/pi-*` repositories and can be installed through `settings.json` `packages` or `senpi install git:github.com/code-yeongyu/<repo>`.

| Extension | Repository | What it does |
|-----------|------------|--------------|
| `pi-comment-checker` | [`code-yeongyu/pi-comment-checker`](https://github.com/code-yeongyu/pi-comment-checker) | Runs `@code-yeongyu/comment-checker` after `write`, `edit`, `multiedit`, and `apply_patch`, including OMO-compatible `apply_patch` metadata and raw Codex patch fallback; shows warnings in an above-editor widget |

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
| **`senpi` CLI identity** | The coding agent identifies itself as `senpi`, uses `.senpi/agent` for config storage, and publishes to npm as `@code-yeongyu/senpi`. The installed executable remains `senpi`. |
| **Senpi-branded outbound identity** | Every outbound request emits `senpi` instead of `pi`: `User-Agent` (update check + Cloudflare + GitHub releases), `X-OpenRouter-Title`, OpenAI Codex `originator` + User-Agent. |
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
| **[senpi](packages/coding-agent)** | Interactive coding agent CLI, rebranded as senpi |
| **[@earendil-works/pi-tui](packages/tui)** | Terminal UI library with differential rendering |
| **[@earendil-works/pi-web-ui](packages/web-ui)** | Web UI components for AI chat interfaces (private, not published) |

For Slack/chat automation and workflows see [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat).

## Permissions & Containerization

senpi does not include a built-in container boundary for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it.

If you need stronger boundaries, containerize senpi. See [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) for three patterns:

- **OpenShell**: run the whole `senpi` process in a policy-controlled container.
- **Gondolin extension**: keep `senpi` and provider auth on the host while routing built-in tools and `!` commands into a local Linux micro-VM.
- **Plain Docker**: run the whole `senpi` process in a local container for simple isolation.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).

## Development

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build        # Build all packages
npm run check        # Lint, format, and type check
npm test             # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Live-API integration suite (env-gated; requires API keys)
npm run publish      # Publish npm workspaces, including @code-yeongyu/senpi
```

> `npm run check` requires `npm run build` first. The web-ui package uses `tsc` which needs compiled `.d.ts` files from dependencies.

## Supply-chain hardening

We treat npm dependency changes as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent shrinkwrap.
- The published CLI package includes `packages/coding-agent/npm-shrinkwrap.json`, generated from the root lockfile, to pin transitive deps for npm users.
- Release smoke tests use `npm run release:local` to build, pack, and create isolated npm and Bun installs outside the repo before tagging a release.
- Local release installs, documented npm installs, and `senpi update senpi` use `--ignore-scripts` where supported.
- CI installs with `npm ci --ignore-scripts`, and a scheduled GitHub workflow runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`.
- Shrinkwrap generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

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
