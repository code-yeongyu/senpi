# Senpi Documentation

Senpi is a minimal terminal coding harness. It is designed to stay small at the core while being extended through TypeScript extensions, skills, prompt templates, themes, and senpi packages. It is an opinionated fork of [badlogic/pi-mono](https://github.com/badlogic/pi-mono).

## Quick start

Install with npm:

```bash
npm install -g @code-yeongyu/senpi
```

To uninstall senpi itself, use the package manager that installed it:

```bash
npm uninstall -g @code-yeongyu/senpi
```

For pnpm, Yarn, or Bun installs, use the matching global remove command: `pnpm remove -g @code-yeongyu/senpi`, `yarn global remove @code-yeongyu/senpi`, or `bun uninstall -g @code-yeongyu/senpi`.

Then run it in a project directory:

```bash
senpi
```

Authenticate with `/login` for subscription providers, or set an API key such as `ANTHROPIC_API_KEY` before starting senpi.

For the full first-run flow, see [Quickstart](quickstart.md).

## Start here

- [Quickstart](quickstart.md) - install, authenticate, and run a first session.
- [Using Senpi](usage.md) - interactive mode, slash commands, context files, and CLI reference.
- [Providers](providers.md) - subscription and API-key setup for built-in providers.
- [Security](security.md) - project trust, sandbox boundaries, and vulnerability reporting.
- [Containerization](containerization.md) - sandbox senpi with Gondolin, Docker, or OpenShell.
- [Settings](settings.md) - global and project settings.
- [Keybindings](keybindings.md) - default shortcuts and custom keybindings.
- [Sessions](sessions.md) - session management, branching, and tree navigation.
- [Compaction](compaction.md) - context compaction and branch summarization.
- [Compaction user guide](compaction-guide.md) - when to compact, how `/compact` works.

## Customization

- [Extensions](extensions.md) - TypeScript modules for tools, commands, events, custom UI, and builtin command hooks.
- [Skills](skills.md) - Agent Skills for reusable on-demand capabilities.
- [MCP](mcp.md) - built-in Model Context Protocol client: servers, context-efficient tool exposure, resources, prompts, auth.
- [Prompt templates](prompt-templates.md) - reusable prompts that expand from slash commands.
- [Themes](themes.md) - built-in and custom terminal themes.
- [Senpi packages](packages.md) - bundle and share extensions, skills, prompts, and themes.
- [Custom models](models.md) - add model entries for supported provider APIs.
- [Custom providers](custom-provider.md) - implement custom APIs and OAuth flows.

## Programmatic usage

- [SDK](sdk.md) - embed senpi in Node.js applications.
- [RPC mode](rpc.md) - integrate over stdin/stdout JSONL.
- [JSON event stream mode](json.md) - print mode with structured events.
- [TUI components](tui.md) - build custom terminal UI for extensions.

## Reference

- [Session format](session-format.md) - JSONL session file format, entry types, and SessionManager API.

## Platform setup

- [Windows](windows.md)
- [Termux on Android](termux.md)
- [tmux](tmux.md)
- [Terminal setup](terminal-setup.md)
- [Shell aliases](shell-aliases.md)

## Development

- [Development](development.md) - local setup, project structure, and debugging.
