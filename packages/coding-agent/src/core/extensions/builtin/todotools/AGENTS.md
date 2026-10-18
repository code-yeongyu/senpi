# builtin/todotools

Builtin extension #8 (id `todowrite`). The op-based phased **todo** tool ported from
oh-my-pi, plus the `/todo` command suite and the `todo-sidebar` widget. Fully diverged from
`../pi-extensions/pi-todotools`; `changes.md` is the fork tracker.

## FILES (by cluster)

- **Entry/registration**: `index.ts` (in-memory `currentState = { phases, ask }`, session
  resync, Cursor native-todo mirror, `Task_Management` system-prompt section),
  `tools/todo.ts` (schema, `execute`, renderers), `commands.ts` (`/todo` verbs).
- **State**: `todo-types.ts`, `todo-storage.ts` (branch readers, parsers, type guards),
  `todo-operations.ts`, `todo-query.ts`, `todo-resolution.ts`, `fuzzy-match.ts`,
  `normalize.ts` (malformed-call auto-correction), `todo-ask.ts` (Ask capture);
  `state.ts` is the re-export barrel other builtins import.
- **Format/prompt**: `todo-format.ts` (`formatSummary`, `describeAskNowNext`),
  `prompt.ts` (`TODO_TOOL_DESCRIPTION`, `TASK_MANAGEMENT_SECTION`), `markdown.ts`.
- **First turn**: `first-turn.ts` (gate, named tool_choice wire shapes, `FIRST_TURN_REMINDER`).
- **UI**: `todo-widget.ts` (10-line window model), `todo-widget-component.ts`
  (completion strike animation), `native-todo-mirror.ts`.

## ASK / NOW / NEXT

Every todo result (success and thrown error) opens with `Ask:`, `Now:`, `Next:` lines and a
blank line before the list summary. The Ask is captured mechanically, never from a model
parameter: a list-creating call (`init`, or `append` into an empty list) anchors to the
branch's first user message when no `senpi.todo-state` entry exists yet, otherwise to the
newest user message (a mid-task `init` is an explicit redirect). Ask-user answer frames are
skipped. `start` / `done` / `drop` / `rm` / `append` keep the anchor. A compaction restore
request (`compaction.todo-restore-request`) newer than the last list and the last user
message re-emits its snapshot's ask. Now is `nextActionableTask`; Next is the first pending
task in phase order that is not Now.

## FIRST-TURN PLAN OPENER

`first-turn.ts` arms on a session's first work request, whether it is a typed prompt or an
admitted `session_control_delivery` (not a preview, not a `?`/`!` question, not an ask-user
answer frame, no earlier prompt or delivery request on the branch (answer frames do not count,
senpi#2419), `todo` active, not `print`/`json`, not another extension-triggered turn,
`todo.firstTurnPlan` not `off`). `before_agent_start` then adds the hidden
`senpi.todo-first-turn` reminder; under `force`, `before_provider_request` names `todo` in
`tool_choice` on that run's requests until the first assistant `message_end` (or
`agent_end` / abort / session change), only where the resolved compat allows a forced
choice and the model has not refused one earlier in the process (senpi#2218), the payload declares `todo` with no `tool_choice` of its own, and Anthropic thinking
is off. The decomposition mandate's single home is `TASK_MANAGEMENT_SECTION`; do not restate
it in `TODO_TOOL_DESCRIPTION`, the tool guidelines, or a preset.

## CONVENTIONS

- **Persistence**: `senpi.todo-state` custom entries, schema `v2`, carrying `phases` and the
  optional `ask`; the latest entry on the branch wins (`getLatestTodoStateFromBranchEntries`).
  Every writer (tool, `/todo`, native mirror) carries the current ask forward.
- **Tool errors are THROWN, never returned** (the agent loop ignores a returned `isError`).
  The thrown message keeps the header and the full remaining-items echo.
- **Tasks are content-keyed**; no generated ids. Keep `details.op` / `details.phases`
  stable - `goal/todo-gate.ts` and `compaction/todo-bridge.ts` read them.
- The widget stays within its 10-line budget; the Ask line renders only in the tool result
  and the `/todo` view.

## TESTS

`test/suite/todo-*.test.ts` (faux harness from `test/suite/harness.ts` or a captured
`registerTodoTool` / `registerTodoCommand` with a fake `pi`): `todo-ask-now-next.test.ts`
covers the Ask/Now/Next contract and `todo-first-turn.test.ts` the first-turn gate and
tool_choice injection (handlers driven through the faux `pi` in `todo-first-turn-harness.ts`, shared
with `regressions/2419-first-turn-answer-frame.test.ts`). `test/compaction/todo-*.test.ts`
covers the snapshot bridge, and `test/suite/fixtures/task-management-section.txt` is the
golden copy of `TASK_MANAGEMENT_SECTION`. No real providers.
