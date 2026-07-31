# builtin/goal

Builtin extension #16. Persistent per-thread **goal** tracking, ported from the
standalone `pi-goal` extension with **zero dependency on it** and **budget-driven
behavior fully removed**. Registers the codex-aligned `create_goal` /
`update_goal` / `get_goal` tools plus a `/goal` command, persists a single goal
per thread to a JSON file, and re-engages the agent toward an active goal via
hidden continuation prompts.

## FILES

```
goal/
├── index.ts          # Extension entry — tools + /goal command + session/agent lifecycle + usage accounting
├── store.ts          # File persistence: read/write/create/update/clear/accountGoalUsage
├── types.ts          # Goal (+ inert tokenBudget compatibility metadata), GoalStatus, GoalFile, refs, snapshots
├── validation.ts     # validateObjective (trim + max length)
├── continuation.ts   # shouldQueueGoalContinuation* gating predicates
├── prompt.ts         # buildContinuationPrompt (untrusted-objective + completion audit)
├── format.ts         # Tool/UI formatting + goalToolResponse snapshot
├── command.ts        # parseGoalCommand (show|pause|resume|clear|setObjective)
├── ui.ts             # ctx.ui.setStatus footer segment for the active goal
├── cache-warm.ts     # Cache-warm metrics estimator + scheduled/resumed notices + goal-cache-warmup entry contract
├── cache-warm-renderer.ts # TUI entry renderer for goal-cache-warmup custom entries
├── elapsed-ticker.ts # GoalElapsedTicker + goalLiveElapsedSeconds (live footer refresh)
├── wait-progress.ts  # renderGoalWaitBar + formatGoalWaitLabel (continuation-wait countdown render)
├── errors.ts         # Goal{AlreadyExists,NotFound}/store error classes
└── changes.md        # Fork tracker (port + budget behavior removal + wire compatibility)
```

## NO BUDGET-DRIVEN BEHAVIOR

This is the deliberate divergence from `pi-goal` / codex `ext/goal`. `Goal` may
persist an optional `tokenBudget` only as inert app-server wire-compatibility
metadata. The builtin tools do not create or interpret it. There is no
`budgetLimited`/`usageLimited` status, budget-limit continuation, or
budget-driven status transition. `tokensUsed` and `timeUsedSeconds` remain
display-only usage metrics. Status is `active | paused | blocked | complete`; `blocked` carries `blockedReason`/`blockedAt` and suppresses continuations.

## CONTINUATION POLICY

Continuation admission is guarded by a persisted consecutive-continuation cap of 8,
a stale-signature check on immediate re-entry, and a single-flight latch so only one
hidden continuation can be queued at a time. The stall notice is goal-wide: from the
3rd consecutive toolless continuation turn it prefixes the prompt with `<goal_stall_check>`
and switches between monitor-flavored bullets while monitors are active and generic
recovery bullets otherwise. Accepted direct input disarms pending continuation
and leaves an active Goal active but idle after the user turn; it reactivates only mechanically
blocked Goals, including admitted steering. A `length` stop gets exactly one minimal truncation recovery before the goal
blocks on repetition, terminal provider errors block the goal only when `AgentEndEvent.willRetry`
is false, and resumed sessions with 8+ trailing historical continuation entries suppress
session-start auto-resume. `tokenBudget` remains inert compatibility metadata only; this
policy is budget-free by design.

## PERSISTENCE

`store.ts` writes `GoalFile{version:1, goal}` to
`<sessionDir>/extensions/goal/<threadId>.json`, falling back to
`getAgentDir()/extensions/goal/no-session/<sha256(cwd)[:24]>/` when the session
has no file (in-memory / print mode). One goal per thread.

## ERRORS

Tool error results are signaled by **throwing** from `execute()` — senpi's
`AgentToolResult` has no `isError` field and the agent loop only marks a result
as an error when the tool throws (`agent-loop.ts` `executePreparedToolCall`).
Do not return an `isError` property; it is ignored.

## WHERE TO LOOK

| Task | File |
|------|------|
| Change a tool schema or description | `index.ts` `registerTool` |
| Adjust status transitions / persistence | `store.ts` |
| Tune the continuation prompt | `prompt.ts` |
| Change the footer status text | `ui.ts` |
| Change the live footer elapsed ticker | `elapsed-ticker.ts` (+ `refreshGoalUi` in `index.ts`) |
| `/goal` argument parsing | `command.ts` |

## CONVENTIONS

- **Single goal per thread.** `create_goal` fails while an UNFINISHED goal exists;
  over a `complete` goal it replaces, archiving the old goal to
  `<threadId>.history.jsonl`. `update_goal` marks `complete` or `blocked` (blocked
  requires a `reason`). `/goal <objective>` replaces with a UI confirm.
- **Continuation is opt-in by state**: hidden prompts are queued only while a goal
  is `active`, idle, and there are no pending messages.
- **Usage accounting is display-only**: `accountGoalUsage` increments
  `tokensUsed`/`timeUsedSeconds`; it never changes status.
- **Live footer is ticker-driven**: `refreshGoalUi` (index.ts) drives
  `GoalElapsedTicker` to refresh `Pursuing goal (…)` once per second while a goal
  is `active` and its accounting window is open, so the footer advances live
  instead of freezing between `agent_end` accounting checkpoints. The ticker only
  runs when `ctx.hasUI` and is stopped on pause/complete/clear and session shutdown.

## NOTES

- Tests: `test/suite/goal-store.test.ts`, `goal-modules.test.ts`,
  `goal-extension.test.ts`, `goal-elapsed-ticker.test.ts`, `goal-wait-progress.test.ts` (faux/mocked `pi`, temp-file store, no real APIs).
- Registered last in `builtin/index.ts` `builtinExtensions`; inert until a goal
  is created.
