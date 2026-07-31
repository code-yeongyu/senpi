# goal Extension Changes

## Migrate legacy pi-goal state into the builtin goal store (2026-07-31)

### What changed

- Session startup now migrates a legacy sibling `pi-goal` file when the builtin `goal` store does not yet exist.
- Legacy `budgetLimited` / `budget_limited` goals resume as active, and `tokenBudget` is stripped from runtime state while the original legacy file remains untouched.
- Existing builtin goal files remain authoritative and are never overwritten by migration.

### Why

- Moving the extension store from `pi-goal` to `goal` otherwise made existing objectives appear lost, and legacy budget metadata is incompatible with the builtin goal extension's budget-free design.

### Verification

- Goal-store coverage pins migration, runtime budget stripping, destination persistence, source preservation, and the existing app-server wire contract.

||||||| a2efa4076
## Accepted direct input leaves an active Goal idle (2026-07-31)

### What changed

- Removed the 60-second user-grace continuation path. An accepted ordinary direct input disarms any pending continuation, and its completed user turn leaves an active Goal active but idle instead of auto-pausing or resurrecting it later.
- Input candidates and reversible monitor-continuation holds remain keyed by `inputId`, so handled/rejected and overlapping prompts neither mutate Goal persistence nor lose an already armed monitor continuation. Extension input remains inert; admitted steer input gets the same recovery accounting as other direct input.
- Accepted direct input, including admitted steering, reactivates only the mechanical block reasons owned by `continuation-recovery.ts`; provider, interruption, and model-authored blocks stay blocked.
- Continuation-cap admission remains universal across immediate, monitor-delayed, and session-start delivery, and candidate goal-ID checks prevent input races from migrating state to another Goal.

### Expected merge conflict zones

- MEDIUM in `index.ts` lifecycle wiring and `monitor-continuation.ts` timer ownership.
- LOW in the focused direct-input lifecycle module.
||||||| de5de53a7
## Achieved footer shows elapsed time and truncated objective (2026-07-31)

### What changed

- `ui.ts` `goalStatusText` renders the `complete` status as
  `<truncated objective> · Goal achieved (<elapsed>)`, mirroring the elapsed
  suffix that `Pursuing goal (…)` already shows while a goal is active. The
  elapsed suffix is omitted only when `timeUsedSeconds` is 0.
- New exported `truncateGoalObjective` normalizes whitespace and truncates the
  objective to 32 characters with a trailing ellipsis for the footer preview.
- `goal-modules.test.ts` pins the new achieved-footer format, including the
  long-objective truncation case.

### Why

- The achieved footer previously dropped both the objective and the total time
  spent, so a finished goal gave no at-a-glance context about what completed or
  how long it took.

### Expected merge conflict zones on the next sync

- LOW in `ui.ts` around the `goalStatusText` switch.

## Mechanically blocked goals resume on a prompt queued while streaming (2026-07-31)

### What changed

- `index.ts` adds an `input` handler that reactivates a mechanically blocked goal
  (cap, repetition, truncation) from a direct prompt even when that prompt is
  queued as steer/follow-up while the agent is streaming.
- The idle path already unblocks in `before_agent_start`, but a queued prompt
  returns from `prompt()` before that hook runs, so a message sent mid-turn left
  the goal blocked. The new handler covers it; extension-sourced input is ignored.

### Why

- The recovery hint added in #562 tells the user "Send any message to resume",
  but a message typed while the agent was streaming was queued and returned
  before `before_agent_start`, so it did not resume. Users who act on the hint
  at the most natural moment saw no recovery.

### Expected merge conflict zones on the next sync

- LOW in `index.ts` around the new `input` handler.
- NONE in the verdict engine, goal store schema, persistence, or public extension API.

## Tool-using turns clear the output-repetition window (2026-07-31)

### What changed

- `monitor-continuation.ts` computes `turnUsedTools` before recording assistant
  output, and `#recordAssistantOutput` now clears
  `#recentNormalizedOutputHashes` for a tool-using turn instead of appending its
  final text hash. Only three consecutive **toolless** identical outputs can
  trip the `repetition` verdict and block the goal with
  "repeated assistant output".
- Coverage adds the issue #566 regression: tool-using turns with identical
  final text stay active, a mid-streak tool turn resets the window, and the
  three-toolless-identical-outputs block is pinned unchanged.

### Why

- The repetition guard recorded the last assistant text hash on every
  `agent_end`, so a goal doing real tool work each turn but ending turns with
  an identical status line (the monitor-wait pattern) was blocked after three
  turns — exactly the state a live resumption channel was about to wake. The
  cap already treats tool use as progress (#539); the repetition window now
  follows the same principle. The stale-signature guard still suppresses
  continuation spam for identical no-progress turns without blocking.

### Expected merge conflict zones on the next sync

- LOW in `monitor-continuation.ts` around `afterAgentEnd` ordering and
  `#recordAssistantOutput`.
- NONE in `continuation.ts`, the goal store schema, or the public extension
  API.

## Mechanical continuation blocks tell the user how to resume (2026-07-31)

### What changed

- New `continuation-recovery.ts` owns the three mechanical continuation-guard
  reasons (`continuation cap reached`, `repeated assistant output`,
  `output truncation repeated`) as exported constants, classifies them with
  `isMechanicalContinuationBlock`, and builds the user notice with
  `continuationCapRecoveryHint`.
- `lifecycle-helpers.ts` consumes both: `blockedReasonForContinuationGuard`
  returns the named constants, and the blocked notify now renders
  `Goal continuation blocked: <reason>. Send any message to resume.` for
  mechanical guards only.
- Intentional blocks (`user interrupted the turn`, provider-error exhaustion,
  model-authored blocks) keep the bare notice; no resume guidance is implied
  where a message does not clear the block.

### Why

- A user reported that `continuation cap reached` "stops the session so much"
  and "is not an easy guardrail to pass". The cap is a deliberate runaway
  backstop and already resets on tool use or observable progress, and
  `before_agent_start` already reactivates a cap-blocked goal on any real user
  prompt. The gap was purely informational: the warning named the guard without
  saying that one ordinary message clears it, so the state read as terminal.
- Behavior of the guard itself is unchanged: `GOAL_CONTINUATION_CAP` stays 8,
  admission logic is untouched, and the existing prompt-based recovery path is
  preserved rather than replaced.

### Expected merge conflict zones on the next sync

- LOW in `lifecycle-helpers.ts` around the guard-reason switch and the notify call.
- NONE in the verdict engine, goal store schema, persistence, or public extension API.
## Monitor-delayed continuations consume the persisted cap (2026-07-31)

### What changed

- `continuation.ts` applies the inclusive eight-delivery cap to every automatic
  continuation path, including `monitorDelayed`.
- `lifecycle-helpers.ts` now requires a continuation signature and persists the
  delivery before queueing its hidden prompt. Missing or failed persistence
  therefore fails closed instead of delivering an unaccounted continuation.
- Coverage adds the issue #506 monitor-delay regression, proves the eighth
  delayed delivery is persisted and the next is blocked, and keeps delayed test
  synchronization tied to exact persistence writes rather than timer luck.

### Why

- Monitor-delayed delivery was exempt from both cap admission and persistence
  accounting. Repeated monitor wakeups could therefore queue hidden Goal turns
  without consuming the restart-safe delivery budget introduced for #447.

### Expected merge conflict zones on the next sync

- LOW in `continuation.ts` around the cap verdict and in
  `lifecycle-helpers.ts` around continuation delivery ordering.
- LOW in monitor continuation tests that observe delayed persistence.
- NONE in the goal store schema, public extension API, or status transitions.

## Observable progress resets the persisted continuation cap streak (2026-07-30)

### What changed

- `continuation.ts` now exposes `hasGoalContinuationProgress`, which treats a
  changed persisted continuation signature as observable goal progress.
- `monitor-continuation.ts` resets `consecutiveContinuations` before the next
  admission when a non-user continuation turn either used tools or changed that
  signature. The verdict is rebuilt from the reset goal so the cap remains a
  backstop for uninterrupted non-progress rather than a raw turn counter.
- The cap stays at 8, remains inclusive at the boundary, and still applies to
  immediate, user-grace, and session-start paths. User-prompt resets,
  single-flight delivery, stale/repetition/length guards, monitor scheduling,
  and blocked-state deduplication are unchanged.
- Coverage rewrites the former distinct-text cap pins in
  `goal-monitor-continuation.test.ts` and
  `regressions/issue-447-goal-continuation.test.ts`, and adds an explicit
  below-cap/at-cap verdict boundary assertion.

### Why

- Codex has no deterministic continuation counter; its blocked audit restarts
  whenever the goal makes meaningful progress. Senpi intentionally retains an
  eight-turn safety cap, but previously reset it only for tool use. A goal that
  made distinct toolless progress therefore blocked on the ninth continuation,
  resumed on user input, then repeated the same false block cycle.

### Expected merge conflict zones on the next sync

- LOW in `continuation.ts` around signature helpers and in
  `monitor-continuation.ts` around `afterAgentEnd`.
- LOW in the two cap regression tests whose old expectations encoded raw turn
  counting rather than progress-aware streak accounting.
- NONE in persistence schema, public extension API, or goal status transitions.

## Tool-using continuations reset the persisted cap streak (2026-07-30)

### What changed

- `monitor-continuation.ts` now classifies tool use once from the completed
  continuation turn and resets the persisted `consecutiveContinuations` streak
  before admitting the next immediate or user-grace continuation.
- The existing cap remains 8 consecutive tool-less automatic continuations.
  Monitor-delayed accounting, stale/repetition guards, single-flight delivery,
  user-prompt resets, and session-start persistence are unchanged.
- Coverage: `test/suite/goal-monitor-continuation.test.ts` runs nine consecutive
  tool-using turns and proves they remain active while the existing tool-less
  boundary test still blocks the ninth continuation.

### Why

- Tool calls are observable progress, but the persisted cap previously counted
  every automatic continuation delivery. A long-running goal that kept using
  tools therefore blocked itself after eight turns with `continuation cap
  reached`, even though the separate stall detector already recognized those
  turns as non-stalled.

### Expected merge conflict zones on the next sync

- LOW in `monitor-continuation.ts` around `afterAgentEnd` and the tool-less
  streak helper.
- NONE in the verdict engine, goal store schema, persistence, or public
  extension API.

## A newly created goal starts immediately instead of waiting for user grace (2026-07-30)

### What changed

- The `create_goal` tool registration now marks the current turn goal-driven before opening
  the new goal accounting window. The clean `agent_end` therefore queues the first hidden
  continuation immediately instead of treating the explicit goal-creation request like a
  side question on an already-active goal and waiting for the 60-second grace timer.
- The existing grace policy is unchanged for real user turns that begin with a pre-existing
  active goal. Monitor delays, continuation caps, repetition/stale guards, and single-flight
  delivery are also unchanged.
- Coverage: `test/suite/regressions/goal-created-turn-continuation.test.ts` reproduces the
  exact lifecycle (`before_agent_start` -> `agent_start` -> `create_goal` -> clean
  `agent_end`) and asserts one immediate `goal-continuation` message.

### Why

- The observed release-goal session created the goal, stopped normally, and then remained
  idle for the full user-grace window. The user sent the next instruction at 59 seconds,
  just before the scheduled continuation, so the goal appeared abandoned even though the
  footer still showed it as active.

### Expected merge conflict zones on the next sync

- LOW in `index.ts` at the dependency passed to `registerGoalTools`.
- NONE in the continuation verdict, persistence, prompt, or public extension API.

## Waiting on a live resumption channel is never a blocked goal (2026-07-30)

### What changed

- `prompt.ts` `buildContinuationPrompt`: the turn-ending rule now names four legal endings
  instead of three - action, `update_goal` complete, `update_goal` blocked, or ending the
  turn while a live resumption channel (active monitor, scheduled continuation, or
  background child whose completion wakes the session) is on duty. The blocked audit gains
  a first gate: confirm no such channel can still deliver the awaited change, because a
  pending delivery is a wait, not an impasse. Fixes the observed failure where a session
  armed with a CI completion monitor called `update_goal` blocked on the same turn the
  monitor was registered.
- `tool-registration.ts`: the `update_goal` description now requires confirming no live
  resumption channel exists before blocking and routes monitored waits to ending the turn.
- Coverage: `test/suite/goal-modules.test.ts` (two new continuation-prompt pins) and
  `test/suite/goal-extension.test.ts` (two new `update_goal` description pins).

### Expected merge conflict zones on the next sync

- LOW in `prompt.ts` (fork-owned file) and `tool-registration.ts` (fork-owned); upstream
  owns neither.

## Stale-goal system reminder on todo add operations (2026-07-29)

### What changed

- `todo-gate.ts` gained the reverse-direction bridge: `todoResultAddsOpenTasks(details)`
  (structural guard: a todo result whose op is `init`/`append` and whose resulting phases
  still hold at least one open task) and `staleGoalTodoReminder(goal)` (a
  `<system-reminder>` block naming `create_goal` when the thread has no goal or only a
  stale, already-`complete` one; silent for active/paused/blocked goals).
- `index.ts` registers a `tool_result` handler on the builtin `todo` tool that appends the
  reminder to the tool-result content, plus a `turn_start` reset so at most one reminder
  is injected per assistant turn (init + append in the same turn nudges once). Mirrors the
  nested-agents-md `tool_result` injection pattern.
- Coverage: `test/suite/goal-todo-stale-reminder.test.ts` - unit pins for both helpers and
  four real-AgentSession e2e scenarios (no goal, stale complete goal, active goal +
  non-add ops stay silent, per-turn dedupe).

### Expected merge conflict zones on the next sync

- LOW in `index.ts` around the event-handler block and in `todo-gate.ts`; both are
  fork-owned surfaces.
- NONE in todotools: the feature reads `TodoToolDetails` structurally without touching the
  todo tool itself.

## Cache-warm continuation story: enriched events + durable entry + TUI renderer (2026-07-29)

### What changed

- New `cache-warm.ts`: `estimateCacheWarmMetrics(model, env, lastTurnUsage)` derives
  `GoalCacheWarmMetrics {ttlSeconds?, cachedTokens, estimatedSavedUsd?}` - prompt-cache TTL via
  pi-ai `resolvePromptCacheTtlSeconds`, warm tokens = the last turn's cacheRead+cacheWrite, and
  savings = cachedTokens x (input - cacheRead) $/Mtok clamped >= 0 - plus the scheduled/resumed
  notice builders and shared token/duration/TTL/USD formatters.
- `monitor-continuation.ts`: the monitor-wait schedule notice now explains the cache-warm
  rationale (monitors on duty, timed wake inside the prompt-cache TTL, ~tokens kept warm) while
  preserving the "4 minutes" wording RPC clients match. `goal_continuation_scheduled` gains a
  `cache` payload member; a new `goal_continuation_resumed` pi-event fires when the deferred
  continuation is queued. Both moments append a durable `goal-cache-warmup` custom entry and the
  resumed side also notifies with waited time + estimated savings.
- New `cache-warm-renderer.ts`, registered in `index.ts` via
  `pi.registerEntryRenderer("goal-cache-warmup", ...)`: themed transcript block (bold accent
  title, dim why-line, success-colored warm/savings line; expanded adds goalId + planned delay).
- Coverage: `goal-cache-warm-metrics.test.ts`, `goal-cache-warmup.test.ts`,
  `goal-cache-warm-renderer.test.ts`; the goal monitor harness gained
  `appendEntry`/`registerEntryRenderer` fakes, an optional ctx `model`, and usage-bearing
  assistant stops.

### Event/entry contract (consumed by omo-desktop-app later)

- pi-event `goal_continuation_scheduled`: `{goalId, delayMs, activeMonitorCount, cache?}`.
- pi-event `goal_continuation_resumed`: `{goalId, delayMs, waitedMs, activeMonitorCount, cache?}`.
- Custom session entry `goal-cache-warmup` (`CustomEntry.data = GoalCacheWarmupEntryData`):
  `{phase: "scheduled"|"resumed", goalId, delayMs, waitedMs?, activeMonitorCount, cache?}`,
  `cache = {ttlSeconds?, cachedTokens, estimatedSavedUsd?}`.

### Expected merge conflict zones on the next sync

- LOW in `monitor-continuation.ts` around `#schedule`/`#continueIfEligible` and `index.ts`
  renderer registration.
- NONE in persistence, tool schemas, or status transitions; standalone `pi-goal` has no terminal
  monitor integration.

## Monitor-wait continuation stall check (2026-07-28)

### What changed

- `monitor-continuation.ts` counts consecutive monitor-wait continuations per goal
  (`GOAL_MONITOR_STALL_THRESHOLD = 3`). From the third consecutive delayed continuation
  fired while monitors stayed active, the hidden continuation prompt is prefixed with a
  `<goal_monitor_stall_check>` block (`buildMonitorStallNotice` in `prompt.ts`) telling
  the agent the repeated wait looks abnormal and to actively inspect the monitored state
  (bash_output, process health, kill_bash + alternate approach, or the blocked audit)
  before waiting again. A `goal_continuation_scheduled`/stall notice is emitted and a UI
  notice shown when the check is injected.
- The streak resets on every signal that breaks the unattended wait loop: monitor
  completion (`terminal_monitor_state` activeCount 0), a real user prompt
  (`before_agent_start` via the new `noteUserPrompt()`), the goal leaving `active` or
  being replaced (goal id change), the immediate no-monitor continuation path, session
  start, and dispose.
- Coverage: `test/suite/goal-monitor-stall.test.ts` (threshold + all reset paths).

### Expected merge conflict zones on the next sync

- LOW in `monitor-continuation.ts` around `#continueIfEligible` and the monitor-state
  subscription.
- LOW in `prompt.ts` (appended exported builder) and `index.ts` `before_agent_start`.

## Goal continuation guardrails (2026-07-29)

### What changed

- `continuation.ts` now persists the continuation cap as stateful goal metadata and treats
  continued stale signatures and repeated normalized assistant outputs as stop conditions.
  The cap remains 8, stale-signature comparison stays immediate-path only, and a single-flight
  latch prevents duplicate queued continuations.
- `prompt.ts` generalizes the stall notice from monitor-only to goal-wide: the same
  continuation block now covers toolless continuation streaks from the 3rd consecutive turn,
  uses `<goal_stall_check>` for the renamed block, keeps the monitor-flavored bullets when
  monitors are active, and emits generic recovery bullets otherwise. The user-prompt grace
  delay remains 60s, truncation recovery remains one minimal prompt, and terminal provider
  errors now block the goal when `AgentEndEvent.willRetry` is false.
- `monitor-continuation.ts`, `lifecycle-helpers.ts`, and `index.ts` route immediate,
  monitor-delayed, and session-start continuation entry points through the verdict engine;
  user prompts reset the streak state, and the session-start admission path suppresses
  resumed flooded sessions with 8+ historical trailing continuation entries.
- `types.ts` and persistence/store code now carry the continuation streak and signature
  fields so a restart cannot bypass the cap, while the existing `tokenBudget` field stays
  inert compatibility metadata only.

### Why

- The built-in goal feature had multiple independent loop sources: repeated clean agent turns,
  stale hidden control prompts after state changes, immediate re-entry after a real user turn,
  truncation loops, silent provider terminal failures, and resumed sessions that replayed long
  continuation histories. These guards close those paths without introducing budget-based policy.

### Expected merge conflict zones on the next sync

- HIGH in `continuation.ts`, `monitor-continuation.ts`, `lifecycle-helpers.ts`, and `index.ts`
  where continuation admission and reset state are wired.
- MEDIUM in `prompt.ts` and the goal store/persistence files for the new guard state.
- LOW in `extensions/types.ts` and related core event plumbing for `AgentEndEvent.willRetry`.

## Blank reasons treated as omitted for update_goal complete (2026-07-28)

### What changed

- `tool-registration.ts` normalizes `reason` at the model boundary (trim, non-string
  treated as absent) before validating. An empty, whitespace-only, or null `reason`
  no longer triggers "reason must not be provided when status is complete" — strict
  tool-calling providers that serialize omitted optional strings as `""`/`null`
  previously hit that rejection on every retry and spun. A non-empty reason remains
  rejected for `complete`; `blocked` still requires a non-blank reason.

### Expected merge conflict zones on the next sync

- LOW in `tool-registration.ts` around the update_goal execute validation.

## Continuity across newer user instructions (2026-07-28)

### What changed

- Rewrote the existing continuation prompt guidance so a newer user message
  amends only the active objective's conflicting parts and preserves
  non-conflicting work. An explicit replacement or redirect remains a full
  objective override.

### Expected merge conflict zones on the next sync

- LOW in `prompt.ts` if the standalone goal continuation wording changes.


## Overview
Persistent per-thread goal tracking as an in-tree builtin. Ports the standalone
`pi-goal` extension into senpi with no dependency on it, file-based persistence,
codex-aligned tool naming, and budget-driven behavior removed. An optional
`tokenBudget` is retained only as inert persistence/wire compatibility metadata.

## Elapsed ticker skips unchanged footer labels (2026-07-28)

### What changed
- `GoalElapsedTicker` remembers the last rendered `formatGoalElapsedSeconds()` label and does not call `setStatus`
  again until that visible label changes. `sync()` clears the memo before its promised immediate render, so switching
  active goals or snapshots still repaints even when their formatted elapsed labels match; `stop()` also clears it.
- The ticker still samples once per second. Seconds remain live below one minute; minute/hour/day labels refresh at
  their actual display boundary instead of repainting identical text every second.

### Why
- After one minute, `formatGoalElapsedSeconds()` intentionally omits seconds. The previous ticker nevertheless
  requested a full TUI render every second, producing up to 59 redundant renders per visible minute and compounding
  the cost of large resumed histories.

### Expected merge conflict zones on next upstream sync
- LOW in `elapsed-ticker.ts` around `sync()`, `tick()`, and lifecycle reset.
- LOW in `goal-elapsed-ticker.test.ts` around fake-timer render expectations.

## Decisive completion/blocked audits + todo completion gate (2026-07-28)

### What changed
- New `todo-gate.ts`: `openTodoTaskContents(entries)` reads the thread's latest todo phases (todotools
  `senpi.todo-state` entries / todo tool results via `getLatestPhasesFromBranchEntries`) and returns every
  non-terminal task; `openTodoCompletionError` renders the rejection message.
- `tool-registration.ts`: `update_goal {status:"complete"}` now throws while any todo task is `pending` or
  `in_progress`, naming the open tasks. `blocked` is not gated. The `update_goal` description was rewritten:
  completion requires the completion audit and is rejected while todos are open, a passing audit must call the
  tool in that same turn, and blocking demands an unmistakably clear impasse recurring for 3+ consecutive goal
  turns.
- `prompt.ts`: `buildContinuationPrompt` restructured (codex `ext/goal` continuation.md alignment, budget-free):
  Continuation behavior (objective stays intact; open todos are remaining goal work; every goal turn ends in a
  concrete action or an `update_goal` call — never a bare status narration), a Completion audit that is decisive
  in BOTH directions (uncertainty keeps working; a fully passing audit must flip to `update_goal complete` in the
  same turn), and a new conservative Blocked audit (self-question for an unmistakable impasse, three-consecutive-
  turn recurrence, never for hard/slow/uncertain work).

### Why
- Observed in real sessions (e.g. 95 `goal-continuation` entries against 2 `update_goal` calls) and reported via
  Discord: the agent loops "all done"/status narration forever without completing the goal, and abandons open
  todo items when new instructions arrive. The old prompt framed completion only as dangerous with no
  counterweight, had no blocked audit, and knew nothing about todos.

### Why extension system couldn't handle this differently
- The gate reads todo state through the public `ctx.sessionManager.getBranch()` surface, mirroring
  `compaction/todo-bridge.ts`; no core change.

### Expected merge conflict zones on next upstream sync
- MEDIUM in `prompt.ts` and the `update_goal` description if standalone `pi-goal` reworks its prompt; the
  standalone package still ships the old prompt and needs the same rewrite plus todo gate on its next sync
  (its host has no todotools builtin, so the gate needs a host-capability check there).
- LOW in `tool-registration.ts` around the complete branch and `todo-gate.ts` imports.

## Four-minute continuation cadence while monitors are live (2026-07-28)

### What changed
- New `monitor-continuation.ts` owns monitor-aware goal continuation timing. A clean
  `agent_end` still queues immediately when no terminal monitor is live; while one
  or more monitors are live, it schedules one continuation for 240 seconds later.
- Repeated clean turns share one timer. Monitor settlement, goal pause/block/complete,
  pending messages at the boundary, session reload, and session shutdown cancel or
  suppress stale delayed work.
- Scheduling emits `goal_continuation_scheduled` on `pi.events` and calls
  `ctx.ui.notify`, so the classic TUI and RPC `extension_ui_request{method:"notify"}`
  clients receive the same informational notice.

### Why
- Monitor-driven work already wakes the session when decisive output arrives. Queuing
  a goal continuation after every clean turn created tight agent loops while the
  monitor was still waiting; a four-minute cadence keeps the goal alive without
  repeatedly consuming turns.

### Expected merge conflict zones on next upstream sync
- MEDIUM in `index.ts` around `session_start`, `agent_end`, `refreshGoalUi`, and
  `session_shutdown` lifecycle wiring.
- LOW in the new `monitor-continuation.ts`; the standalone `pi-goal` package has no
  terminal monitor integration today.
- NONE in persistence, tool schemas, status transitions, or public extension types.

## App-server token budget compatibility metadata (2026-07-19)

### What changed
- `Goal.tokenBudget?: number` is accepted when reading stored goals so the app-server adapter can preserve Codex's
  required nullable `ThreadGoal.tokenBudget` wire member.
- The builtin goal tools and continuation engine remain budget-free: they do not create, update, enforce, or react to
  this metadata.

### Why
- Codex's app-server goal shape always includes `tokenBudget`, while older Senpi goal files have no such field. Keeping
  it optional in persistence supports both formats without adding budget statuses, continuations, or transitions.

### Expected merge conflict zones on next upstream sync
- LOW in `types.ts` and `store.ts` around the additive compatibility field and stored-goal parser.
- NONE in the tool schemas, continuation policy, usage accounting, or status model.

## Mid-turn token usage accounting via message_end (2026-07-20)

### What changed
- New `turn-usage.ts`: `TurnUsageTracker` accumulates assistant usage from `message_end` events
  (`pending`), tracks what mid-turn checkpoints already stored (`flushed`), and at `agent_end` accounts
  only `collectAssistantUsage(messages) - flushed` (clamped per field) so nothing is double counted.
- `index.ts`: subscribes to `message_end`, resets the tracker on `agent_start`, and
  `accountCurrentAgentTurn(ctx, mode, agentRunMessages?)` now sources usage from the tracker
  (pending for mid-turn checkpoints, remaining for `agent_end`) instead of taking a usage argument.
  `beginAgentGoalAccounting` discards pending usage when a new accounting window opens so a goal
  created or replaced mid-turn is not charged tokens streamed before it existed (matching the
  existing time-window semantics).
- `tool-registration.ts` / `command-registration.ts`: `accountCurrentAgentTurn` deps drop the
  `EMPTY_USAGE` argument; `get_goal` checkpoints before reading so its snapshot carries fresh
  tokens and elapsed time.

### Why
- Long goal-driven runs complete inside one agent turn; usage was only harvested at `agent_end`,
  so `update_goal`/`get_goal` reported `tokensUsed: 0` after hours of work (observed: a completed
  goal reporting `tokensUsed: 0, timeUsedSeconds: 6652` while the session had consumed ~379K tokens).

### Why extension system couldn't handle this differently
- `message_end` already delivers each finalized assistant message with usage through the public
  `pi.on` API; the fix is entirely builtin-local with no core change.

### Expected merge conflict zones on next upstream sync
- MEDIUM in `index.ts` around `accountCurrentAgentTurn`/`agent_end` if standalone `pi-goal`
  reworks usage accounting; the standalone package needs the same tracker on its next sync.
- LOW in `tool-registration.ts`/`command-registration.ts` deps signatures.

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
- Dropped the `token_budget` create param and initially dropped the `Goal.tokenBudget` field. The optional field was
  later reintroduced solely as inert app-server persistence/wire compatibility metadata; the create tool still has no
  budget parameter.
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

## Sync from pi-goal 0.3.0 (2026-07-26)

### Source

- Canonical source: `code-yeongyu/pi-goal` 0.3.0, merged by
  [pi-goal PR #1](https://github.com/code-yeongyu/pi-goal/pull/1).
- Version metadata was regenerated through `sync-builtin-extensions.mjs`; this
  builtin remains a manual-merge package because of senpi-only structure.

### What changed

- Imported the blocked lifecycle (`blockedReason`/`blockedAt`), model-only
  blocked/complete transitions, and blocked continuation suppression.
- `create_goal` now replaces a completed goal after JSONL archival; oversized
  objectives are marker-budget truncated and preserve their full text in a
  per-thread spill file.
- Aligned tool schemas and guidance with the 4,000-character, complete-replace,
  and blocked-audit contract while retaining budget-free behavior.

### Senpi conflict zone: abort detection

- Standalone pi-goal 0.3.0 captures `ctx.signal` and treats any aborted signal
  as a user interruption. Senpi deliberately does not retain that heuristic:
  todo 11 supplies an internal agent-end aborted flag so only a real user abort
  blocks an active goal.
- Follow up upstream: add an aborted flag and source to the published extension
  API so standalone pi-goal can remove its `ctx.signal` heuristic too.

### Expected merge conflict zones on the next sync

- HIGH: `store.ts`/`persistence.ts` retain senpi's atomic writes and stale-brace
  recovery while upstream owns the lifecycle persistence semantics.
- MEDIUM: `index.ts`, `tool-registration.ts`, and `ui.ts` retain senpi's split
  registration, elapsed ticker, and core abort-event integration.


## Reload no longer auto-starts a stopped goal; gap-abort blocks active goal (2026-07-27)

### What changed
- `index.ts` session_start handler: `queueGoalContinuation` is now gated on `event.reason !== "reload"`.
  A config reload emits `session_start` with reason `"reload"` (agent-session.ts reload()). Previously this
  queued a hidden continuation prompt for any active goal, auto-starting an agent the user had stopped.
  Now reload only reloads; startup/resume/new/fork keep existing continuation behavior.
- `types.ts`: new `SessionAbortEvent` (`type: "session_abort"`) added to the `SessionEvent` union and
  `ExtensionAPI.on()` overloads.
- `agent-session.ts`: `abort()` now captures gap-state before `_abortActiveAgentAndRetry` resets retry
  counters, and emits `session_abort` (via both `_extensionRunner.emit` and `this._emit`) when the gap case
  is detected: `retryAttempt > 0` (retry backoff — the error agent_end already fired, agent.abort() is a no-op,
  no new agent_end with abortSource "user" will reach extensions), or `!isStreaming && (isCompacting || pendingMessageCount > 0)`.
  Mid-run aborts (`isStreaming && retryAttempt === 0`) are excluded — agent_end owns those. Purely-idle
  defensive aborts (e.g. RPC session-registry closeMarked on an idle session) are excluded.
- `index.ts` new `session_abort` handler: accounts the current agent turn (mode "active"), then if the goal
  is still active, transitions it to `blocked` with reason `"user interrupted the turn"`, clears accounting,
  and refreshes the UI.

### Why
- A user-abort that stops in-flight work outside an active LLM run (retry backoff, compaction, queued
  continuation) left the goal `active` because `_agentAbortSource` is set only when `isStreaming`, and the
  earlier error `agent_end` had no abortSource. The goal then auto-restarted on config reload (bug 1) or
  session resume, contradicting the user's explicit stop.

### Expected merge conflict zones on next upstream sync
- LOW in `types.ts` around the `SessionEvent` union and `on()` overloads (additive).
- LOW in `agent-session.ts` around `abort()` and the `AgentSessionEvent` union (additive).
- LOW in `goal/index.ts` around the session_start handler and the new session_abort handler.

