# builtin/goal

Builtin extension #30. Persistent per-thread **goal** tracking, ported from standalone
`pi-goal` with **zero dependency on it** and **budget-driven behavior fully removed**.
Registers codex-aligned `create_goal` / `update_goal` / `get_goal` plus `/goal`, persists one
goal per thread, re-engages the agent via hidden continuation prompts. 34 `.ts` files, flat;
`changes.md` is the fork tracker.

## FILES (by cluster)

- **Entry/registration**: `index.ts` (441 LOC; lifecycle, accounting, UI),
  `tool-registration.ts`, `command-registration.ts`, `command.ts`.
- **Domain/persistence**: `types.ts` (Goal, statuses, inert `tokenBudget`), `store.ts`
  (serialized mutations), `persistence.ts` (atomic writes, legacy migration),
  `validation.ts`, `errors.ts`.
- **Continuation**: `monitor-continuation.ts` (603 LOC — timers, wake sources, direct-input
  holds, cache-warm scheduling, admission, recovery, disposal) plus `continuation.ts`,
  `lifecycle-helpers.ts`, `direct-input-lifecycle.ts`, `agent-end-continuation.ts`,
  `continuation-recovery.ts`, `reload-reengagement.ts`.
- **Prompt/format**: `prompt.ts` (untrusted-objective + completion audit), `format.ts`,
  `todo-gate.ts`, `todo-owed-backstop.ts` (no-goal turn-end backstop), `last-assistant-message.ts`,
  `terminal-provider-error.ts`.
- **UI/tickers**: `ui.ts` (footer segment), `elapsed-ticker.ts`, `wait-ticker.ts`,
  `wait-progress.ts`, `cache-warm.ts`, `cache-warm-renderer.ts`.

## NO BUDGET-DRIVEN BEHAVIOR

The deliberate divergence from `pi-goal` / codex `ext/goal`. `Goal` may persist an optional
`tokenBudget` **only** as inert app-server wire-compatibility metadata; the tools neither
create nor interpret it. No `budgetLimited`/`usageLimited` status, no budget-limit continuation,
no budget-driven transition. `tokensUsed`/`timeUsedSeconds` are display-only. Status is
`active | paused | blocked | complete`; `blocked` carries `blockedReason`/`blockedAt` and
suppresses continuations.

## CONTINUATION POLICY

Admission guards: consecutive-continuation cap of 8 (persisted), stale-signature check on
immediate re-entry, single-flight latch. From the 3rd consecutive toolless turn the prompt
gains a `<goal_stall_check>` prefix — monitor-flavored bullets while monitors are active,
generic recovery bullets otherwise. Accepted direct input disarms a pending continuation; a
clean accepted user turn arms a visible 10-second grace countdown before the Goal resumes.
Mechanically blocked Goals reactivate on accepted input, including admitted steering. A
`length` stop gets exactly one truncation recovery, then blocks.

A terminal (`willRetry` false, not system-owned) provider error keeps the Goal active and
queues one guarded `providerRecovery` continuation after `agent_settled`, except a terminal
401/403 (`terminalProviderAuthFailure`, #2293) or policy rejection (#1520): those block on the
first hit. The auth block is mechanical (a new user message resumes after the user fixes the
login); the policy block is not. A terminal
*system* error preserves the active Goal: schedule the live monitor wait, or queue a guarded
hidden `systemRecovery` continuation after `agent_settled` (staging preserves late user
cancellation; canceling releases the single-flight latch for `/goal resume`). Intentional
blocks — user interrupt or a model-declared `update_goal` block — stay non-recoverable.
Resuming with 8+ trailing continuation entries suppresses session-start auto-resume. On
`session_start` reason `resume`, an idle TUI session with a stopped-but-unfinished goal
(`paused`/`blocked`) prompts first (`isResumeOfStoppedGoal`); accepting flips to `active` as
a `"user"` mutation. `active`/`complete` never prompt.

## CONVENTIONS

- **Single goal per thread.** `create_goal` fails while an UNFINISHED goal exists; over a
  `complete` goal it replaces, archiving to `<threadId>.history.jsonl`. `update_goal` marks
  `complete` or `blocked` (blocked requires a `reason`). `/goal <objective>` replaces with a
  UI confirm.
- **Tool errors are THROWN, never returned.** `AgentToolResult` has no `isError` field; the
  agent loop marks an error only when `execute()` throws (`agent-loop.ts`
  `executePreparedToolCall`). A returned `isError` property is silently ignored.
- **Persistence**: `GoalFile{version:1, goal}` at `<sessionDir>/extensions/goal/<threadId>.json`,
  falling back to `getAgentDir()/extensions/goal/no-session/<sha256(cwd)[:24]>/` when the
  session has no file. Writes are atomic, mutations serialize per goal path via the in-process promise tail
  plus a cross-process proper-lockfile lock (`goal-file-lock.ts`, senpi#2499),
  and legacy `pi-goal` stores/status spellings migrate on read. Objectives trim and cap at
  4,000 code points with a truncation marker plus full-text sidecar.
- **Continuation is opt-in by state**: hidden prompts queue only while the goal is `active`,
  the agent is idle, and no messages are pending. The todo-owed backstop
  (`todo-owed-backstop.ts`) is the no-goal mirror: it queues its hidden followUp only when
  nothing else owns the turn end, at most two per chain of unattended turns (the chain
  resets on accepted direct input, `session_start`, `session_tree`), never in print/json.
- **Live footer is ticker-driven**: `refreshGoalUi` drives `GoalElapsedTicker` once per second
  while a goal is `active` with an open accounting window; `GoalWaitTicker` independently
  refreshes the continuation countdown while a monitor or user-grace timer is armed. Both
  require a TUI context and stop on their owning lifecycle cleanup.
- Inert until a goal exists; `loop` (#31) and later builtins register after it. Tests:
  `test/suite/goal-{store,modules,extension,elapsed-ticker,wait-progress}.test.ts`
  (faux/mocked `pi`, temp-file store, no real APIs), plus
  `test/suite/goal-todo-stale-reminder.test.ts` and
  `test/suite/goal-todo-owed-backstop.test.ts` (harness + faux provider).
