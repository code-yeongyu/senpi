# sanepi-mono

An opinionated fork of [badlogic/pi-mono](https://github.com/badlogic/pi-mono) that adds a dynamic system prompt engine, builtin extension infrastructure, and structured task management to the pi coding agent.

> **Upstream**: [pi-mono](https://github.com/badlogic/pi-mono) by [@mariozechner](https://github.com/badlogic) -- tools for building AI agents and managing LLM deployments.

## What This Fork Adds

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

A new extension loading tier that ships first-party extensions as part of the coding agent binary. These load automatically without requiring files in `.pi/extensions/` or `~/.pi/agent/extensions/`.

**Core builtins** (always loaded):

| Extension | Description |
|-----------|-------------|
| **todowrite** | Structured task management. Adds `todowrite` and `todoread` tools with a TUI sidebar widget. Enforces WHERE/WHY/HOW/RESULT format for each todo item. Injects task management rules into the system prompt via `before_agent_start`. |
| **parallel-tool-calls** | Intercepts OpenAI provider requests and adds `parallel_tool_calls: true` to payloads when tools are present. Covers `openai-completions`, `openai-responses`, `openai-codex-responses`, and `azure-openai-responses` APIs. Also injects a tool-agnostic Execution Strategy section into the system prompt describing parallelization and context-breadth guidance. |
| **redraws** | Adds `/tui` command to display full-redraw count for TUI debugging. |

**Global defaults** (seeded to `~/.pi/agent/extensions/` on first run):

| Extension | Description |
|-----------|-------------|
| **diff** | `/diff` command. Shows modified/deleted/new files from `git status` with colored status indicators. Selecting a file opens VS Code's diff view. |
| **files** | `/files` command. Lists all files the model has read/written/edited in the current session branch, coalesced by path and sorted newest-first. Opens selected file in VS Code. |
| **prompt-url-widget** | Detects GitHub PR/issue URLs in prompts, fetches metadata via `gh` CLI, and displays a title/author widget. Auto-sets the session name from the PR/issue. |
| **tps** | Displays tokens-per-second stats (input, output, cache read/write) as a notification after each agent turn. |

Source: [`packages/coding-agent/src/core/extensions/builtin/`](packages/coding-agent/src/core/extensions/builtin/)

### Other Changes

| Change | Details |
|--------|---------|
| **`sanepi` CLI alias** | `npx sanepi` works alongside `npx pi`. Added as a second bin entry in `package.json`. |
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
| `package.json` | Added `sanepi` bin alias |

## Packages

| Package | Description |
|---------|-------------|
| **[@mariozechner/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@mariozechner/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@mariozechner/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI (primary fork target) |
| **[@mariozechner/pi-mom](packages/mom)** | Slack bot that delegates messages to the pi coding agent |
| **[@mariozechner/pi-tui](packages/tui)** | Terminal UI library with differential rendering |
| **[@mariozechner/pi-web-ui](packages/web-ui)** | Web components for AI chat interfaces |
| **[@mariozechner/pi-pods](packages/pods)** | CLI for managing vLLM deployments on GPU pods |

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
