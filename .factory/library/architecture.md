# Architecture — todotools extension + continuation feature

This document describes the target system state after this mission completes. Workers reference it when implementing features.

## Where it lives

All mission-scope code lives under `packages/coding-agent/src/core/extensions/builtin/todotools/`. This is a single **builtin extension** in the pi-mono extension system. It replaces the existing single-file extension at `packages/coding-agent/src/core/extensions/builtin/todowrite.ts`. The old file is deleted after refactor. Registration in `builtin/index.ts` preserves the existing id `"todowrite"` (so consumers, history entries, and tests that reference that id continue to work).

## Component layout

```
builtin/todotools/
├── index.ts              Extension factory. Wires state, tools, prompt,
│                         and the continuation module together.
├── prompt.ts             TASK_MANAGEMENT_SECTION constant (append to system
│                         prompt in before_agent_start).
├── state.ts              TodoItem type, TODO_STATE_ENTRY_TYPE = "sanepi.todo-state",
│                         sanitizeTodoText, getTodoMarker, getTodoWidgetLines,
│                         getTodoResultLines, getLatestTodosFromBranchEntries,
│                         and any shared helpers.
├── tools/
│   ├── todowrite.ts      Tool registration for `todowrite`. Updates the
│                         extension's currentTodos reference and calls
│                         pi.appendEntry(TODO_STATE_ENTRY_TYPE, ...).
│   └── todoread.ts       Tool registration for `todoread`.
└── continuation/
    ├── index.ts          installContinuation(pi, { getCurrentTodos }). Entry
    │                     point invoked by todotools/index.ts during factory
    │                     initialization. Registers the CLI flag, subscribes
    │                     to agent_end and session_start, owns per-session
    │                     state map.
    ├── config.ts         Pure resolver: takes already-loaded global/project
    │                     settings objects + CLI flag value, returns
    │                     { enabled: boolean }. No filesystem IO. Strict
    │                     boolean type coercion (non-boolean ⇒ default).
    ├── prompt.ts         CONTINUATION_PROMPT header constant + buildPrompt()
    │                     function assembling header + status line +
    │                     remaining-tasks bullets from a TodoItem[].
    └── runtime.ts        Agent-end handler, per-session state store,
                          re-entry guard, chain-cap counter, abort / stop
                          reason detection, and deferred auto-dispatch once
                          the session becomes idle.
```

## Data flow

### Existing flow (preserved by refactor)

1. User prompt arrives → session starts → extension's `session_start` handler restores `currentTodos` from the session branch via `getLatestTodosFromBranchEntries`.
2. Extension's `before_agent_start` handler returns `{ systemPrompt: ${original}\n${TASK_MANAGEMENT_SECTION} }`.
3. Agent loop runs. Assistant calls `todowrite` → tool's `execute` updates `currentTodos` and appends a `sanepi.todo-state` custom entry to the session.
4. Widget sidebar is synced via `ctx.ui.setWidget("todo-sidebar", getTodoWidgetLines(currentTodos))` on every state change.
5. Branch navigation / tree events re-run `session_tree` handler to rebuild `currentTodos` from the newly-active branch.

### New continuation flow

1. Extension factory calls `installContinuation(pi, { getCurrentTodos: () => currentTodos })` once during initial load.
2. `installContinuation` registers the CLI flag `disable-todo-continuation` (`type: "boolean"`, `default: false`, description mentioning "Disable" and "todo continuation").
3. `installContinuation` subscribes to `agent_end`, `session_start` (for reload/shutdown reset), and `session_shutdown`.
4. When `agent_end` fires, the runtime:
   a. Reads the last assistant message's `stopReason` — if `"aborted"` or `"error"` or any non-clean stop, **skip** (no injection).
   b. Resolves the config via `config.ts` — calls `SettingsManager.create(ctx.cwd)` to read global + project settings (NO widening of upstream `Settings` interface; narrow via local `Record<string, unknown>` accessor), reads the CLI flag via `pi.getFlag("disable-todo-continuation")`. Resolver returns `{ enabled: boolean }`.
   c. If disabled → skip.
   d. Retrieves current todos via the injected `getCurrentTodos()` accessor (NEVER from a local cache). If empty or all terminal (`completed` / `cancelled`) → skip.
   e. Checks the per-session re-entry flag — if already injected for this cycle → skip. Otherwise set the flag.
   f. Checks the per-session chain counter — if it has reached the cap (default 10 consecutive auto-injections without a human user prompt) → skip.
   g. Builds the prompt via `buildPrompt(todos)` (header + status line `[Status: X/Y completed, Z remaining]`, where `Y = completed + remaining` so cancelled todos are excluded from the displayed denominator, plus bullets `- [<status>] <content>`).
   h. Builds the prompt via `buildPrompt(todos)` (header + status line + remaining-task bullets).
   i. Schedules a deferred continuation dispatch: after the current `agent_end` microtask unwinds, poll `ctx.isIdle()` and then call `pi.sendUserMessage(prompt)` **without** `deliverAs: "followUp"`. This avoids the still-streaming `agent_end` window, where `deliverAs: "followUp"` only queues the prompt instead of starting a new turn.
   j. Increments the per-session chain counter.
5. When a fresh user-originated prompt arrives (any `before_agent_start` NOT triggered by a continuation follow-up), the runtime resets the chain counter AND the per-cycle re-entry flag for that session.
6. `session_shutdown` clears per-session state for that session id.

### Per-session state

The runtime owns a `Map<sessionId, SessionContinuationState>` keyed by the session id derived from `ctx`. Each entry holds:
- `reEntryFlag: boolean` — set when an injection happens in the current `agent_end` cycle; reset on the next fresh user prompt (via `before_agent_start` observation).
- `chainCount: number` — increments per injection; resets on the next fresh user prompt.
- `lastInjectedAt?: number` — timestamp of last injection (diagnostic only).

No module-level globals. All mutable state lives on the `Map` owned by the closure returned from `installContinuation`. This guarantees per-session isolation for concurrent `AgentSession` instances.

## Configuration resolution

The resolver is a pure function:

```ts
interface ResolveInput {
   globalSettings: Record<string, unknown>;   // from SettingsManager.getGlobalSettings(), treated as Record
   projectSettings: Record<string, unknown>;  // from SettingsManager.getProjectSettings()
   cliFlag: boolean | string | undefined;     // from pi.getFlag("disable-todo-continuation")
}

interface ResolvedConfig {
   enabled: boolean;
}

function resolveContinuationConfig(input: ResolveInput): ResolvedConfig;
```

Rules:
1. Start with `enabled = true` (default).
2. If `globalSettings.todotools?.continuation?.enabled` is a strict boolean, override.
3. If `projectSettings.todotools?.continuation?.enabled` is a strict boolean, override (project wins over global).
4. If `cliFlag === true` (strict), force `enabled = false` (CLI flag wins over settings).
5. All non-boolean settings values (string `"true"`, `"false"`, `null`, numbers, objects, arrays) are **ignored** — they do not override the prior value. This is enforced via `typeof === "boolean"` checks.
6. Non-`true` CLI flag values (string `"true"`, `"false"`, `undefined`) do NOT disable continuation. Only literal `=== true` counts.

## Injection prompt format

```
[SYSTEM DIRECTIVE: SANEPI - TODO CONTINUATION]

Incomplete tasks remain in your todo list. Continue working on the next pending task.

- Proceed without asking for permission
- Mark each task complete when finished
- Do not stop until all tasks are done
- If you believe all work is already complete, the system is questioning your completion claim. Critically re-examine each todo item from a skeptical perspective, verify the work was actually done correctly, and update the todo list accordingly.

[Status: X/Y completed, Z remaining]

Remaining tasks:
- [pending] first remaining todo
- [in_progress] second remaining todo
```

The builder takes a `TodoItem[]`, counts completed items plus remaining non-terminal items for the displayed denominator, and emits the bullets in source order. Completed and cancelled items are excluded from the bullet list. The header/footer text is a constant — a golden-file snapshot test catches drift.

## Invariants

- Extension id `"todowrite"` is preserved.
- `TODO_STATE_ENTRY_TYPE === "sanepi.todo-state"` is preserved.
- `getTodoWidgetLines`, `getTodoResultLines`, `getLatestTodosFromBranchEntries`, `TODO_STATE_ENTRY_TYPE` are exported from a stable path inside `todotools/` (either via `index.ts` re-exports or directly from `state.ts`).
- `TASK_MANAGEMENT_SECTION` is byte-equivalent to the pre-refactor constant.
- Continuation registers only on `agent_end` (NEVER on `turn_end`, which would cause infinite recursion inside the tool-calling loop).
- Continuation auto-dispatches with a deferred `pi.sendUserMessage(prompt)` call once the session is idle. Calling `deliverAs: "followUp"` directly from `agent_end` only queues the prompt while streaming is still active.
- Continuation MUST NOT modify `packages/coding-agent/src/core/settings-manager.ts`. The upstream `Settings` interface is treated as opaque; access happens through a local typed accessor.
- Non-interactive modes (`--print`, RPC) MUST NOT inject continuation (interactive-only by design; the user has no way to observe or interrupt a print-mode loop). `ExtensionContext.hasUI` is not a reliable RPC detector because rpc-mode binds a UI context.

## Off-limits

- `packages/ai`, `packages/agent`, `packages/tui`, `packages/web-ui`, `packages/mom`, `packages/pods` — cannot be modified.
- `packages/coding-agent/src/core/settings-manager.ts` — cannot be modified.
- `packages/coding-agent/src/core/agent-session.ts`, `packages/coding-agent/src/core/extensions/types.ts`, `packages/coding-agent/src/core/extensions/runner.ts`, `packages/coding-agent/src/core/extensions/loader.ts` — not modified. All capabilities consumed via the public extension API.
- Other builtin extensions under `builtin/` (permission-system, agent-system, etc.) — not modified.

## Allowed changes

- `packages/coding-agent/src/core/extensions/builtin/todotools/**` (new directory tree).
- `packages/coding-agent/src/core/extensions/builtin/index.ts` (single-line import + register change).
- `packages/coding-agent/src/core/extensions/builtin/todowrite.ts` (deleted).
- `packages/coding-agent/test/suite/todowrite-extension.test.ts` (path update only for its `TODOWRITE_EXTENSION_PATH` constant; assertions remain unchanged).
- New test files under `packages/coding-agent/test/suite/` for continuation + unit tests for state helpers.
- `packages/coding-agent/test/suite/harness.ts` — additive test-only helper for observing injected user messages (no changes to production code).
- `packages/coding-agent/CHANGELOG.md` — entry under `[Unreleased]`.

## Test infrastructure

- Existing harness at `packages/coding-agent/test/suite/harness.ts` provides `createHarness()` with a faux provider. It records `AgentSessionEvent`s but does not spy on `sendUserMessage` out of the box. The mission adds a test-only helper (e.g., `harness.getInjectedUserMessages()`) that reads from `harness.session.messages` OR wires a scoped spy on the extension action, whichever is cleaner. This helper is the canonical observability point for integration tests.
- Unit tests can import helpers (`resolveContinuationConfig`, `countIncomplete`, `buildPrompt`) directly from the new `todotools/continuation/*` modules without running the full agent loop.
- Existing broken test path `.pi/extensions/todowrite.ts` (referenced in `todowrite-extension.test.ts` but non-existent on disk) MUST be replaced with a direct import of the builtin module during the refactor.
