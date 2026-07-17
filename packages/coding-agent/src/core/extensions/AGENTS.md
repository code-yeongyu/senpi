# packages/coding-agent/src/core/extensions

The extension system. **The fork's most important architectural surface** — every fork feature that *can* be an extension *is* one. `types.ts` is ~1844 lines of public API contract. Treat changes here as breaking until proven otherwise.

## FILES

```
extensions/
├── types.ts             # Public API: ExtensionAPI, Extension, ExtensionContext, ExtensionUIContext,
│                        # ExtensionEvent union (30+ events), all *EventResult types, ToolDefinition.
│                        # ~1844 LOC — VERY HIGH merge-conflict risk on every upstream sync.
├── loader.ts            # Discovery + jiti-based TS import. Shared importer per `loadExtensions()` batch
│                        # (perf fix 2026-05-08). Aliases `@mariozechner/pi-*` → workspace packages.
├── runner.ts            # ExtensionRunner — owns the runtime, dispatches events, holds shutdown handlers,
│                        # exposes `bindCore()` to wire `pi.*` stubs to real implementations.
├── wrapper.ts           # 30-line wrapper utility used to track extension origin per UI message
├── index.ts             # Re-exports from runner/loader/types
├── builtin/             # 23 builtin extensions + bundled codemode (`core/resource-loader.ts`) — see builtin/AGENTS.md
└── changes.md           # Fork tracker — DENSE. Every public-API change must add a section.
```

## EXTENSION API SHAPE (`pi`)

`types.ts` defines `ExtensionAPI` with these capability families. Reach for one of these BEFORE editing core:

| Family | Methods | Use for |
|--------|---------|---------|
| Tools | `registerTool`, `getActiveTools`, `setActiveTools`, `getAllTools` | New tool exposed to the LLM; toolset swaps |
| Commands | `registerCommand`, `registerShortcut`, `getCommands` | Slash commands / keyboard shortcuts in interactive mode |
| Flags | `registerFlag`, `getFlag` | New CLI flag |
| Providers | `registerProvider`, `unregisterProvider` | New LLM provider (extension-local) |
| Messages | `sendMessage`, `sendUserMessage`, `appendEntry`, `registerMessageRenderer` | Inject messages/entries into the session |
| Model | `setModel`, `getThinkingLevel`, `setThinkingLevel` | Model + thinking-level control |
| Session metadata | `setSessionName`, `getSessionName`, `setLabel` | Session display name + entry labels |
| Tool execution | `executeTool` | Run a tool through the normal validation/hook/permission pipeline |
| Events | `on(<event>, handler)` | 30+ events (session_start, tool_call, message_update, before_provider_request, before_agent_start, model_select, system_prompt_change, session_before_compact, session_compact, resources_discover, etc.) |
| Context | `ctx: ExtensionContext` — second parameter of every event handler | Read cwd, model, session manager, compaction settings, system prompt; `ctx.ui` for TUI dialogs/widgets |

**Context arrives per-event, not on `pi`**. Any new "core data the extension needs" should land as a typed `ExtensionContext` getter (read via the `ctx` handler parameter), not a global lookup.

## LOADING ORDER

1. In-tree factories from `builtin/index.ts`, in `builtinExtensions` array order — affects permission/agent stacking precedence.
2. Bundled extensions (currently codemode; `core/resource-loader.ts`) — resolved via package JSON entries, loaded through the same jiti path as user extensions.
3. Inline SDK/runtime factories passed to the runtime constructor (`core/resource-loader.ts`).
4. Resolved global/project/user/settings/CLI paths (includes global default extensions: `diff`, `files`, `prompt-url-widget`, `tps`; user paths from `~/.senpi/agent/extensions/`, `.senpi/extensions/`, settings.json, `-e` flag).

## CONVENTIONS

- **Every public API change** in `types.ts` MUST add a section to `changes.md` with explicit *expected merge-conflict zones*.
- **Event handlers can return values** that the runner uses — see `model_select` returning `ModelSelectEventResult` (2026-04-30) and `session_before_compact` returning a snapshot.
- **Extension factories are pure**: no top-level side effects, no fs reads, no environment captures. All side effects belong inside `pi.on("session_start", …)`.
- **`bindCore()` is privileged**: only the host (senpi `agent-session.ts` or interactive-mode shortcut path) may call it. Extensions consume the bound API only.
- **Shared jiti importer** per `loadExtensions()` call — preserve `moduleCache: false` so reloads see fresh source, but reuse the importer to avoid multi-second per-extension TS resolution cost.

## ANTI-PATTERNS

- Adding a new event without adding an `*EventResult` type and `pi.on` overload + a `runner.ts` emit helper — silent breakage downstream.
- Static-importing extension modules at the top of `loader.ts` — extensions are user-supplied; loading must stay dynamic.
- Removing the `@mariozechner/pi-*` alias in `loader.ts` — installed pi-mono extensions still resolve those peer names, and without the alias jiti pulls a duplicate runtime from the extension's own `node_modules`.
- Mutating `ExtensionContext` values returned to handlers — context is meant to be read-only.

## NOTES

- The ~1844-line `types.ts` is "the API"; treat its diffs like a public package release.
- `ToolRenderContext` now includes `imageProtocol` (terminal image protocol, or null when images can't render) and `hasResult` (lets a call renderer yield to the result renderer).
- `changes.md` already documents major fork-introduced APIs: `ModelSelectEventResult`, `SystemPromptChangeEvent`, `getCompactionSettings`, lazy/shared jiti, default-extension factory resolver. Read it before extending.
