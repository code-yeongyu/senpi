# coding-agent

Main CLI application. **Primary package** of the monorepo and primary focus for fork work.

## FORK STRATEGY (THIS PACKAGE)

Changes here have the highest merge conflict risk with upstream. Before modifying any file:

1. **Check if an extension can do it** - See `docs/extensions.md` (2262 lines of API reference)
2. **If yes**: Add as a **builtin extension** at `src/core/extensions/builtin/` and register in `builtin/index.ts`. These load automatically via `resource-loader.ts` without requiring `.pi/extensions/` or `~/.pi/agent/extensions/`.
3. **If no**: Modify source, then create/update `changes.md` in the affected subdirectory

Extension system supports: tools, commands, shortcuts, flags, providers, event interception, UI customization, message renderers. 30+ event types. See root AGENTS.md for the capability table.

## STRUCTURE

```
src/
├── cli.ts / main.ts            # CLI entry points
├── cli/                         # Argument parsing, helpers
├── core/                        # Core engine (32 files)
│   ├── agent-session.ts         # Session lifecycle, event emission
│   ├── session-manager.ts       # Session persistence
│   ├── model-registry.ts        # Built-in + custom model resolution
│   ├── model-resolver.ts        # DEFAULT_MODELS, provider defaults
│   ├── system-prompt.ts         # System prompt construction
│   ├── extensions/              # Extension system (types, loader, runner)
│   │   ├── types.ts             # 1450 lines - ExtensionAPI, events, tools
│   │   ├── loader.ts            # jiti-based TS loading, discovery
│   │   ├── runner.ts            # ExtensionRunner, event emission
│   │   └── builtin/             # Builtin extensions (todowrite, diff, files, etc.)
│   └── tools/                   # Built-in tools
│       ├── bash.ts, read.ts, write.ts, edit.ts
│       ├── grep.ts, find.ts, ls.ts
│       └── (each tool: definition + execute + render)
├── modes/
│   ├── interactive/             # TUI mode
│   │   └── components/          # 35 TUI components
│   ├── rpc/                     # RPC mode (JSONL protocol)
│   └── print-mode.ts            # Non-interactive mode
├── utils/                       # Git, MIME, clipboard, etc.
└── bun/                         # Bun-specific CLI entry (binary builds)

test/
├── suite/
│   ├── harness.ts               # Modern test harness (use this)
│   └── regressions/             # Issue-specific: <number>-<slug>.test.ts
├── session-manager/             # SessionManager unit tests
├── test-harness.ts              # Legacy harness
└── utilities.ts                 # Shared helpers (createTestSession, etc.)
```

## WHERE TO LOOK

| Task | File(s) | Notes |
|------|---------|-------|
| Add a tool | `src/core/tools/` + extension system | Prefer extension; core tools only for upstream parity |
| Add a slash command | Extension: `pi.registerCommand()` | Never modify `src/core/slash-commands.ts` directly |
| Modify session lifecycle | `src/core/agent-session.ts` | Heavy file, high conflict risk |
| Add CLI flag | Extension: `pi.registerFlag()` | Or `src/cli/args.ts` if upstream-compatible |
| Modify system prompt | `src/core/system-prompt.ts` | Use `context` event in extensions instead |
| Custom compaction | Extension: `on("session_before_compact")` | See `examples/extensions/custom-compaction.ts` |
| Input transformation | Extension: `on("input")` | See `examples/extensions/input-transform.ts` |
| Add TUI component | `src/modes/interactive/components/` | 35 existing components |
| Write tests | `test/suite/harness.ts` + faux provider | Never use real APIs |

## EXTENSION LIFECYCLE

1. **Discovery**: `.pi/extensions/`, `~/.pi/agent/extensions/`, settings.json paths, `-e` flag
2. **Loading**: jiti imports TS directly (no compilation)
3. **Factory**: `export default function(pi: ExtensionAPI) { ... }` runs
4. **Binding**: `ExtensionRunner.bindCore()` connects stubs to real implementations
5. **Events**: `session_start` -> `resources_discover` -> runtime events
6. **Reload**: `session_shutdown` -> reload files -> re-run factories -> `session_start(reason: "reload")`

## CONVENTIONS

- Tools follow pattern: definition (TypeBox schema) + execute function + renderCall/renderResult
- Keybindings: always configurable via `DEFAULT_EDITOR_KEYBINDINGS` / `DEFAULT_APP_KEYBINDINGS`
- Test naming: regression tests as `<issue-number>-<short-slug>.test.ts`
- Pi philosophy: no built-in MCP, sub-agents, permission popups, plan mode, todos

## ANTI-PATTERNS

- Modifying `src/core/extensions/types.ts` without checking upstream compatibility
- Hardcoding key bindings
- Using real LLM APIs in tests (use faux provider)
- Adding features to core that could be extensions
