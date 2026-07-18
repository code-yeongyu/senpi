# goal Extension Changes

## Overview
Persistent per-thread goal tracking as an in-tree builtin. Ports the standalone
`pi-goal` extension into senpi with no dependency on it, file-based persistence,
codex-aligned tool naming, and the budget concept removed.

## Live elapsed footer ticker (2026-07-17)

### What changed
- New `elapsed-ticker.ts`: `GoalElapsedTicker` drives a once-per-second footer refresh, plus the pure
  `goalLiveElapsedSeconds(goal, measuredFromMs, nowMs)` helper (committed `timeUsedSeconds` + whole seconds since
  the current measurement window opened, mirroring `accountCurrentAgentTurn`'s rounding).
- `ui.ts`: `goalStatusText`/`updateGoalUi` accept an optional `liveElapsedSeconds`; when present, an active goal
  renders `Pursuing goal (…)` from the live value (including `0s`) instead of the frozen `timeUsedSeconds`.
- `index.ts`: added `refreshGoalUi` — while `ctx.hasUI` and the goal is `active` with a matching open accounting
  window, it syncs the ticker (live refresh); otherwise it stops the ticker and falls back to a static
  `updateGoalUi`. The ticker is stopped on pause/complete/clear and `session_shutdown`. `refreshGoalUi` is injected
  into `command-registration.ts` and `tool-registration.ts`, replacing their direct `updateGoalUi` calls.

### Why
- The footer showed a stale `Pursuing goal (…)` (or no time at all on a fresh goal) because `timeUsedSeconds` only
  advances at `agent_end`/`session_shutdown`/`/goal` checkpoints and the footer was only re-set at those same
  points. Users pursuing a goal saw the elapsed time freeze instead of ticking live.

### Why extension system couldn't handle this differently
- `setStatus` is fire-and-forget with no scheduler; the per-second refresh must be owned by the builtin. It is
  implemented entirely via the public `pi.*` API + `ctx.ui.setStatus`; no core change.

### Expected merge conflict zones on next upstream sync
- LOW in `ui.ts`/`index.ts` if standalone `pi-goal` restyles the footer or refactors UI wiring.
- The standalone `pi-goal` package needs the same ticker on its next sync (it shares this `ui.ts`/`format.ts` shape).

## Atomic goal store and narrow stale-brace recovery (2026-07-10)

### What changed
- Fork-specific divergence from standalone `pi-goal`: `store.ts` writes complete JSON to a unique sibling temporary
  file with mode `0600`, then atomically renames it over the destination and cleans up the temporary file on failure.
- Goal reads recover only the observed corruption shape: one complete root JSON object followed solely by whitespace
  and one or more stale closing braces. Truncated JSON, arbitrary trailing bytes, unsupported versions, and invalid
  goal shapes still fail normally.

### Why this belongs in the builtin
- The persistence path, file format, and recovery boundary are private to the vendored goal builtin. Keeping this
  fork-specific behavior in `goal/store.ts` protects session resume without broadening shared session storage or the
  public extension API.

### Expected merge conflict zones on next upstream sync
- HIGH in `store.ts` for standalone `pi-goal` changes to imports, temporary-file handling, `writeGoal`,
  `parseGoalFile`, or malformed JSON recovery.
- MEDIUM in goal store tests covering persistence and malformed JSON behavior.
- NONE in shared core session storage and `extensions/types.ts`, which this divergence does not touch.

## Continuation halts on aborts and terminal turns (2026-06-21)

### What changed
- `continuation.ts`: goal continuation no longer re-prompts after a tool call was aborted, and stops after terminal
  turns instead of nudging a finished conversation.
- `index.ts` split registration into `command-registration.ts` / `tool-registration.ts` alongside the continuation
  fix.

### Why
- Continuation nudges after a user abort or a terminal turn fought the user's intent and could loop the session.

### Why extension system couldn't handle this differently
- Continuation is this builtin's own `pi.*`-API logic; no core change involved.

### Expected merge conflict zones on next upstream sync
- NONE upstream (fork-native builtin); internal file split only matters for future vendored pi-goal syncs.

## Initial port — budget-free, file-based goal builtin (2026-06-15)

### What changed
- New builtin extension `goal` (`builtin/goal/`), registered last in
  `builtin/index.ts` `builtinExtensions`. Exposes `create_goal`, `update_goal`,
  `get_goal` and the `/goal` command.
- Ported from `code-yeongyu/pi-goal` (`src/goal/*`) module-for-module:
  `store`, `types`, `validation`, `continuation`, `prompt`, `format`, `command`,
  `errors`, `index`. No runtime or dev dependency on `pi-goal`.
- File-based persistence retained: `GoalFile{version:1, goal}` under
  `<sessionDir>/extensions/goal/<threadId>.json`, with a
  `getAgentDir()/extensions/goal/no-session/<sha256(cwd)[:24]>` fallback.

### Budget removal (the deliberate divergence)
- Dropped the `token_budget` create param and the `Goal.tokenBudget` field.
- Dropped the `budgetLimited` status; `GoalStatus` is now `active|paused|complete`.
- Removed `validateTokenBudget`, the budget-limit continuation prompt, the
  `goal-budget-limit` message type, and every budget-driven status transition
  (`statusAfterBudgetLimit`/`statusAfterAccounting` budget branches).
- `GoalAccountingMode` collapsed to `active | activeOrComplete`; `accountGoalUsage`
  only increments `tokensUsed`/`timeUsedSeconds` and never changes status.
- Tool descriptions and the continuation prompt rewritten to drop budget language
  (the `get_goal` "budgets / remaining token budget" wording, the create
  "token budget" lines, the update "budget-limit" lines).

### Senpi adaptations vs upstream pi-goal
- Imports `getAgentDir()` from `src/config.ts` (env `SENPI_CODING_AGENT_DIR`,
  fallback `~/.senpi/agent`) instead of pi-goal's `.pi` agent dir.
- Tool error results are signaled by throwing from `execute()`; senpi's
  `AgentToolResult` has no `isError` field and the agent loop only marks an error
  on throw (`agent-loop.ts` `executePreparedToolCall`).
- UI simplified to a single `ctx.ui.setStatus("goal", …)` footer segment instead
  of pi-goal's full footer-replacement component.

### Why extension system couldn't handle this differently
- Implemented entirely as a builtin extension via the public `pi.*` API
  (`registerTool`, `registerCommand`, `pi.on`, `sendMessage`) plus the
  `getAgentDir()` config helper. No change to `extensions/types.ts` or other core.

### Expected merge conflict zones on next upstream sync
- LOW: `builtin/index.ts` import block + `builtinExtensions` array if upstream
  reorders or adds builtins.
- NONE for `extensions/types.ts` (untouched).
