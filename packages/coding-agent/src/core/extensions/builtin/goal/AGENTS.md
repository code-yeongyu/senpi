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
├── agent-end-continuation.ts # Agent-end routing into Goal continuation ownership
├── store.ts          # File persistence: read/write/create/update/clear/accountGoalUsage
├── types.ts          # Goal (+ inert tokenBudget compatibility metadata), GoalStatus, GoalFile, refs, snapshots
├── validation.ts     # validateObjective (trim + max length)
├── continuation.ts   # shouldQueueGoalContinuation* gating predicates
├── monitor-continuation-types.ts # Monitor scheduler lifecycle contracts
├── last-assistant-message.ts # Shared last-assistant lookup for terminal classification
├── prompt.ts         # buildContinuationPrompt (untrusted-objective + completion audit)
├── format.ts         # Tool/UI formatting + goalToolResponse snapshot
├── command.ts        # parseGoalCommand (show|pause|resume|clear|setObjective)
├── ui.ts             # ctx.ui.setStatus footer segment for the active goal
├── cache-warm.ts     # Cache-warm metrics/formatting + goal-cache-warmup entry contract
├── cache-warm-renderer.ts # Scheduled/resumed TUI renderer for goal-cache-warmup entries
├── elapsed-ticker.ts # GoalElapsedTicker + goalLiveElapsedSeconds (live footer refresh)
├── wait-progress.ts  # Pure continuation-wait progress bar + label formatting
├── wait-ticker.ts    # GoalWaitTicker (live footer countdown lifecycle)
├── terminal-provider-error.ts # Terminal provider-failure classification
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
recovery bullets otherwise. Accepted direct input disarms a pending continuation,
and a clean accepted user turn arms a visible 10-second grace countdown before the Goal
resumes; mechanically blocked Goals are reactivated on accepted input, including admitted
steering. A `length` stop gets exactly one minimal truncation recovery before the goal
blocks on repetition. Terminal provider errors block the goal only when
`AgentEndEvent.willRetry` is false and the abort is not explicitly system-owned; those
blocks count as mechanical, so a new user message resumes the goal and the blocked notice
says so. A terminal system error instead preserves the active Goal: it schedules the live
monitor wait when one exists, or queues a guarded hidden `systemRecovery` continuation
after `agent_settled` when no monitor or retry can resume the run. Staging recovery until
settlement makes an error-compatible idle turn while preserving late user cancellation;
canceling the staged delivery also releases the single-flight latch so `/goal resume`
can start fresh recovery.
Intentional blocks — a user interrupt or a model-declared `update_goal` block — stay
non-recoverable. Resumed sessions with 8+
trailing historical continuation entries suppress session-start auto-resume.
`tokenBudget` remains inert compatibility metadata only; this policy is budget-free by
design.

## RESTART RESUME PROMPT

On `session_start` with reason `resume`, an idle TUI session with no pending
messages prompts before doing anything else when the stored goal is stopped but
unfinished — `paused` or `blocked`. `isResumeOfStoppedGoal` (lifecycle-helpers.ts)
owns that admission and `maybePromptResumeStoppedGoal` (index.ts) renders it;
the title names the actual status (`Resume blocked goal?`). Accepting flips the
goal to `active` as a `"user"` mutation and queues a continuation; declining
leaves the status untouched. `active` and `complete` goals never prompt; a completed
goal is revived only by an explicit `/goal resume`. This mirrors codex
`maybe_prompt_resume_paused_goal_after_resume`, minus its
`UsageLimited` arm, which senpi has no counterpart for.

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
| Change the continuation-wait countdown | `wait-progress.ts`, `wait-ticker.ts`, and `monitor-continuation.ts` |
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
  is `active` and its accounting window is open. `GoalWaitTicker` independently
  refreshes the transient continuation countdown while a monitor or user-grace
  timer is armed. Both tickers only run with a TUI context and stop on their owning
  lifecycle cleanup.

## NOTES

- Tests: `test/suite/goal-store.test.ts`, `goal-modules.test.ts`,
  `goal-extension.test.ts`, `goal-elapsed-ticker.test.ts`, `goal-wait-progress.test.ts` (faux/mocked `pi`, temp-file store, no real APIs).
- Registered last in `builtin/index.ts` `builtinExtensions`; inert until a goal
  is created.
