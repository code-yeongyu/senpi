# senpi-mono

<p align="center">
  <a href="https://pi.dev">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://pi.dev/logo.svg">
      <source media="(prefers-color-scheme: light)" srcset="https://huggingface.co/buckets/julien-c/my-training-bucket/resolve/pi-logo-dark.svg">
      <img alt="senpi logo" src="https://pi.dev/logo.svg" width="128">
    </picture>
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://github.com/code-yeongyu/sanepi-mono/actions/workflows/ci.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/code-yeongyu/sanepi-mono/ci.yml?style=flat-square&branch=main" /></a>
</p>

An opinionated fork of [badlogic/pi-mono](https://github.com/badlogic/pi-mono) that turns the coding agent into **senpi**: a senpai-name pun, and a more sane pi with extra batteries included.

> **Upstream**: [pi-mono](https://github.com/badlogic/pi-mono) by [@mariozechner](https://github.com/badlogic) -- tools for building AI agents and managing LLM deployments.

## What This Fork Adds

## Why "senpi"

`senpi` is a small joke on **senpai**, but it is also literal project positioning: this fork aims to be a more **sane** pi with practical additions that make everyday agent work smoother without abandoning upstream's core design.

All additions follow pi's extension-first philosophy. Core source modifications are minimized and [documented in `changes.md` files](#fork-strategy) to keep upstream rebases clean.

### Dynamic System Prompt

Replaces pi's static system prompt with a prompt that adapts to the current tool set and session context.

| Component | What it does |
|-----------|-------------|
| **Intent Gate** | Forces the model to classify user intent (research / implementation / investigation / evaluation / fix / open-ended) and verbalize its routing decision before acting. Prevents the model from jumping straight into edits on ambiguous requests. |
| **Tool Categorization** | Groups registered tools by type (LSP, AST, search, session, command) and generates a categorized tool reference with per-tool snippets and usage guidelines. |
| **Policy Enforcement** | Injects language-agnostic hard blocks (no unauthorized git commits, no speculation about unread code, no suppression of type/lint/test failures) and anti-patterns (no deleted failing tests, no silently swallowed errors, no shotgun debugging) directly into the prompt so models self-enforce code quality rules. |

Source: [`packages/coding-agent/src/core/dynamic-prompt/`](packages/coding-agent/src/core/dynamic-prompt/)

### Builtin Extension System

A new extension loading tier that ships first-party extensions as part of the coding agent binary. These load automatically without requiring files in `.senpi/extensions/` or `~/.senpi/agent/extensions/`.

Senpi splits its builtins into two tracks. **Owned builtins** live in-tree and are tightly coupled to senpi internals (session manager, settings manager, dynamic prompt, custom session entries). **Vendored builtins** live in standalone public repos under `pi-extensions` and are synced into the coding agent at build time so that the same source is reusable as a regular pi extension by anyone, while senpi still ships them by default.

#### Owned builtins (managed in this repo)

Source: [`packages/coding-agent/src/core/extensions/builtin/`](packages/coding-agent/src/core/extensions/builtin/)

| Extension | What it does | Why it lives here |
|-----------|--------------|-------------------|
| **background-task** | Adds `task`, `background_output`, `background_cancel` tools, spawns sub-agents in detached subprocesses, persists task state via custom session entries, restores tasks on session reload, renders a "background tasks" widget, and turns sub-agent completion messages into desktop notifications. | Sub-agents are not part of upstream pi by design. We need them for parallel exploration and long-running QA, and the implementation has to plug into the session manager, custom session entries, and the TUI widget API simultaneously. |
| **agent-system** | Reads `AGENT_TYPE` from the env, looks up an agent profile from the local registry (`.senpi/agents/`, `~/.senpi/agent/agents/`), merges its tool permissions with global agent defaults, narrows the active toolset, and appends the agent's system prompt fragment. | Required to give `background-task` named agent profiles (explore, librarian, oracle, etc.) with per-agent tool whitelists and prompt overrides. Tool filtering must run before tool execution, so it has to be a builtin rather than a user extension. |
| **permission-system** | Loads permission rules from CLI (`--permission tool=action`), settings (`permissions.always_allow`, `permissions.deny`), and per-session approvals. Prompts the user for unknown tool calls, persists "always allow" decisions back to the project, blocks denied calls with a structured error, and supports parser-aware patterns (e.g., bash command prefixes, file path globs for read/write/edit/apply_patch). | Upstream pi explicitly omits permission popups. We needed an opt-in permission gate for shared infra and untrusted prompts. The integration has to read settings, modify the active toolset on session start, and intercept `tool_call` before execution, which is impossible from a user extension without race conditions. |
| **prompt-preset** | At `before_agent_start` and `model_select`, picks a system prompt preset based on the current model and `senpi-current` settings, falling back to senpi's dynamic prompt when nothing matches. Renders the active preset name in the startup header. | Different model families respond best to different system prompt styles (Claude vs GPT vs Gemini). Hard-coding one prompt for everyone is wrong, and switching prompts purely from the dynamic-prompt builder couples too much logic. Splitting it into an extension lets us tune presets per model without touching core. |
| **todowrite** | Adds `todowrite` and `todoread` tools, persists todo state per branch, renders a sidebar widget, and injects a task-management section into the system prompt. Drives a continuation loop that nudges the model to keep working until all todos are done. | Upstream pi intentionally has no built-in todos. We chose to add them because the dynamic prompt and the rest of senpi already assume todos exist; making it an in-tree builtin lets us keep the continuation loop, branch-aware persistence, and TUI widget consistent across all sessions. |
| **redraws** | Adds the `/tui` command, which reports the cumulative full-redraw count of the current TUI instance. | Tiny TUI debugging hook used while iterating on differential rendering bugs. Lives in-tree because it pokes at internal `tui.fullRedraws`. |
| **service-tier** | At `before_provider_request`, injects `service_tier` (`"auto" \| "flex" \| "priority"`) into OpenAI Responses payloads using the per-model service tier (e.g., `-fast` suffix) or the value from `settings.json -> openai.serviceTier`. | OpenAI Responses gates latency/cost via `service_tier`. We want one switch in settings or model id, applied to every outgoing payload, without forcing every model definition to repeat the field. |
| **compaction** | Owns the entire compaction pipeline: speculative compaction, blocking compaction at the hard context limit, proactive compaction near the soft limit, degradation monitoring, circuit breaker, per-turn cap, todo bridging into compaction, checkpoint state, restoration tracker, and tool-result truncation. | Compaction in senpi diverged significantly from upstream pi: we run speculative compaction in parallel, restore todos and checkpoints, and integrate with the dynamic prompt. The seam needs typed access to settings, session manager, model registry, and event ordering, which only a builtin can get. |

#### Vendored builtins (synced from `pi-extensions`)

These extensions live as their own public repos so that they are usable in any pi installation as plain `pi -e ./src/index.ts` extensions. Senpi vendors a snapshot via [`packages/coding-agent/scripts/sync-builtin-extensions.mjs`](packages/coding-agent/scripts/sync-builtin-extensions.mjs) at build time. The package name and version of each vendored snapshot are recorded in [`packages/coding-agent/src/core/extensions/builtin/external-versions.json`](packages/coding-agent/src/core/extensions/builtin/external-versions.json).

| Extension | Repo | What it does | Why it ships by default |
|-----------|------|--------------|-------------------------|
| **bash-timeout** | [code-yeongyu/pi-bash-timeout](https://github.com/code-yeongyu/pi-bash-timeout) | Intercepts `bash` tool calls. Injects a default timeout when the model omits one, caps timeouts that exceed the configured max, and appends a system-prompt section explaining the policy. Tunable via `PI_BASH_DEFAULT_TIMEOUT_SECONDS` and `PI_BASH_MAX_TIMEOUT_SECONDS`. | Bash without a sane default timeout hangs sessions when the model picks the wrong command. We standardize the policy across every model and let other pi users adopt the same behavior outside senpi. |
| **webfetch** | [code-yeongyu/pi-webfetch](https://github.com/code-yeongyu/pi-webfetch) | Registers a `webfetch` tool that retrieves a URL as markdown, plain text, or HTML, with a 30s default timeout (capped at 120s), 5 MB body limit, browser-like user agent, and a Cloudflare retry. Includes TUI renderers for compact and expanded output. | Reading docs and PRs is core to coding agent work. Upstream pi has no first-party fetcher. Splitting it into a separate package keeps senpi minimal while still shipping a useful default. |
| **gpt-apply-patch** | [code-yeongyu/pi-apply-patch](https://github.com/code-yeongyu/pi-apply-patch) | When the active model is OpenAI GPT, swaps `write`/`edit` for a freeform Codex-style `apply_patch` tool with a Lark grammar and applies multi-file patches (add/update/delete/move). Falls back to standard edit tools for non-GPT models. | GPT-class models follow Codex `apply_patch` grammar reliably, but stumble on JSON-schema edits at scale. Switching tooling per-model gives noticeably better edit quality without affecting other providers. |
| **openai-api-parallel-tool-calls** | [code-yeongyu/pi-openai-api-parallel-tool-calls](https://github.com/code-yeongyu/pi-openai-api-parallel-tool-calls) | Adds `parallel_tool_calls: true` to OpenAI-family payloads when the request has tools, covering `openai-completions`, `openai-responses`, `openai-codex-responses`, `azure-openai-responses`. Appends an Execution Strategy section to the system prompt that nudges the model to fan out independent calls. | OpenAI defaults to sequential tool calls, which is wasteful for parallel reads/searches. Combined with the prompt nudge, we measurably cut round-trips. Externalizing it makes the same gain available to non-senpi pi users. |

Builtin extensions are loaded by default. Set `enabledBuiltinExtensions` in `settings.json` to load only selected builtin ids, or `disabledBuiltinExtensions` to skip specific builtin ids. Vendored snapshots are refreshed during the coding-agent build when `../pi-extensions` or `SENPI_BUILTIN_EXTENSIONS_SOURCE` exists.

#### Global defaults (seeded to `~/.senpi/agent/extensions/` on first run)

These are not loaded as builtins; they are written once into the user's extension dir so they can be edited or removed locally.

| Extension | Description |
|-----------|-------------|
| **diff** | `/diff` command. Shows modified/deleted/new files from `git status` with colored status indicators. Selecting a file opens VS Code's diff view. |
| **files** | `/files` command. Lists all files the model has read/written/edited in the current session branch, coalesced by path and sorted newest-first. Opens selected file in VS Code. |
| **prompt-url-widget** | Detects GitHub PR/issue URLs in prompts, fetches metadata via `gh` CLI, and displays a title/author widget. Auto-sets the session name from the PR/issue. |
| **tps** | Displays tokens-per-second stats (input, output, cache read/write) as a notification after each agent turn. |

### Other Changes

| Change | Details |
|--------|---------|
| **`senpi` CLI branding** | The coding agent now identifies itself as `senpi`, uses `.senpi/agent` for config storage, and publishes as `@code-yeongyu/senpi`. |
| **No startup update checks** | Removed npm registry version checking and package update prompts at launch. |
| **Builtin extension UI grouping** | Builtin extensions render under a separate `builtin/` group in the startup header, visually distinct from user and project extensions. |
| **Updated model registry** | Refreshed `models.generated.ts` with latest model additions and deprecations. |

## Fork Strategy

This fork rebases periodically on `upstream/main`. To minimize merge conflicts:

1. **Extension-first**: All features use pi's [extension system](packages/coding-agent/docs/extensions.md) as builtin extensions.
2. **Document core changes**: Every upstream file modification has a corresponding `changes.md` in the affected subdirectory, documenting what changed, why, and expected conflict zones.
3. **Remotes**: `origin` = [code-yeongyu/sanepi-mono](https://github.com/code-yeongyu/sanepi-mono), `upstream` = [badlogic/pi-mono](https://github.com/badlogic/pi-mono).

Modified upstream files:

| File | Change |
|------|--------|
| `agent-session.ts` | Calls `buildDynamicSystemPrompt()` instead of `buildSystemPrompt()` |
| `resource-loader.ts` | Removed SYSTEM.md/APPEND_SYSTEM.md discovery; added builtin extension loading |
| `interactive-mode.ts` | Builtin extension display formatting; disabled update checks |
| `package.json` | Rebranded the coding agent package and runtime identity to `senpi` |

## Share your OSS coding agent sessions

If you use pi or other coding agents for open source work, please share your sessions.

Public OSS session data helps improve coding agents with real-world tasks, tool use, failures, and fixes instead of toy benchmarks.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `pi-share-hf`.

You can also watch [this video](https://x.com/badlogicgames/status/2041151967695634619), where I show how I publish my `pi-mono` sessions.

I regularly publish my own `pi-mono` work sessions here:

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## Packages

| Package | Description |
|---------|-------------|
| **[@mariozechner/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@mariozechner/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@code-yeongyu/senpi](packages/coding-agent)** | Interactive coding agent CLI, rebranded as senpi |
| **[@mariozechner/pi-tui](packages/tui)** | Terminal UI library with differential rendering |
| **[@mariozechner/pi-web-ui](packages/web-ui)** | Web components for AI chat interfaces |

## Chat bot workflows

For Slack/chat automation, see [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat).

## Development

```bash
npm install          # Install all dependencies
npm run build        # Build all packages (dependency order)
npm run check        # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
```

> `npm run check` requires `npm run build` first. The web-ui package uses `tsc` which needs compiled `.d.ts` files from dependencies.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).

## License

MIT
