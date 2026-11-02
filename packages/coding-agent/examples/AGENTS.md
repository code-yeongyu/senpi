# packages/coding-agent/examples

Runnable examples for the public Senpi SDK and extension API. Examples are documentation-quality code and must reflect shipped APIs, not private core internals. Unqualified paths below are relative to this directory; `packages/...` paths are repository-relative.

## STRUCTURE

```text
extensions/          Single-file extension catalog (70+ files) + multi-file dirs
extensions/*/        Multi-file examples; several are private nested workspaces
sdk/                 Numbered SDK programs (01-minimal.ts ... 13-session-runtime.ts)
rpc-extension-ui.ts  RPC-mode extension UI as standalone JSONL child process
```

## WHERE TO LOOK

| Task | First choice |
|---|---|
| Tool/flag/command/shortcut registration | `extensions/tools.ts`, `commands.ts`, `dynamic-tools.ts` |
| Custom provider, OAuth, streaming | `extensions/custom-provider-anthropic/` |
| UI widgets, overlays, editors | `extensions/overlay-*.ts`, `modal-editor.ts`, `widget-placement.ts` |
| Session-entry persistence | `extensions/todo.ts`, `bookmark.ts`, `handoff.ts` |
| Safety guards | `extensions/permission-gate.ts`, `protected-paths.ts`, `sandbox/` |
| Full SDK composition | `sdk/12-full-control.ts`, `sdk/13-session-runtime.ts` |

Largest examples carry real complexity, not toy scope: `extensions/overlay-qa-tests.ts` (~1.5k LOC), `extensions/subagent/index.ts` (~1k), `extensions/tic-tac-toe.ts` (~1k), `extensions/custom-provider-anthropic/index.ts` (~600). See `extensions/AGENTS.md` for the catalog map.

## CONVENTIONS

- Import public package surfaces — `@code-yeongyu/senpi` (newer alias), `@earendil-works/pi-coding-agent` (lower level), `@earendil-works/pi-ai`/`pi-tui` — never `packages/coding-agent/src/core/` internals.
- Keep examples small enough to teach one pattern, while preserving real error, cleanup, cancellation, and persistence behavior where relevant.
- Extension factories have no top-level runtime side effects. Register work through the public `pi.*` API and lifecycle events.
- New interactive examples should use configurable keybindings and themed TUI helpers. Existing demos may keep fixed controls when the control scheme is part of the example. Direct terminal writes belong only in examples explicitly teaching a terminal protocol; ordinary SDK examples may use normal stdout.
- Tool string enums use the shared `StringEnum` helper for provider compatibility.
- SDK examples should use `ModelRuntime` for auth/custom-model/session composition; deprecated static catalog helpers import from `@earendil-works/pi-ai/compat`.
- Deferred-tool examples preserve the Kimi flow: expose search first, activate via `pi.setActiveTools()`, and register lifecycle work in `session_start`.
- Stateful examples persist reconstructable state in session entries or tool-result details so fork/resume behavior remains valid.
- Nested example packages are private workspaces with exact-pinned dependencies. Treat their manifests and lock impact as production dependency changes.
- Kebab-case filenames and slash-command names; camelCase named exports; one example per file default-exporting its extension factory.
- UI examples guard on `ctx.hasUI` and clean up timers/child processes on `session_shutdown`; stateful atomic tools (games, questionnaires) set `executionMode: "sequential"`.
- Tool schemas use TypeBox; handlers follow the `(toolCallId, params, signal, onUpdate, ctx)` shape.

## DOCUMENTATION CONTRACT

- Keep `extensions/README.md`, `packages/coding-agent/docs/extensions.md`, and `packages/coding-agent/docs/sdk.md` aligned with public API changes.
- New public extension capabilities should include a focused example when usage is not obvious from types alone.
- Do not present experimental or internal behavior as stable API.

## VALIDATION

- Run the focused tests for the public API demonstrated by the example.
- Typecheck examples through root `bun run check`.
- Interactive examples require real CLI or visual QA when their behavior changes.
