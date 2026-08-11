# goal Extension Changes

## Explicit resume revives completed goals (2026-08-11)

### What changed

- User-originated status mutations may transition a completed goal back to `active`, so `/goal resume` and app-server `thread/goal/set {status:"active"}` revive the existing goal and queue the normal continuation path.
- Resuming clears `completedAt`, stamps `lastStartedAt`, and resets persisted continuation streak state through the existing status-transition behavior.
- Model-originated transitions remain unchanged, `complete -> paused` remains illegal, and restart-resume prompting still excludes completed goals.

### Why

Codex permits an explicit user action to reactivate a completed thread goal. Senpi parsed `/goal resume` and wired continuation delivery correctly, but its user transition guard rejected `complete -> active` before that path could run.

### Why this is not extension-only

The transition guard is private to the builtin goal store and controls both the command and app-server wire paths. An external extension cannot authorize a new persisted status edge.

### Merge-conflict zones

- LOW in `transitions.ts` around the user transition set.
- LOW in goal store and command-path tests covering completed-goal resume.

## Serialized goal mutations and stale-continuation cancellation (2026-08-10)

### What changed

- Goal read/modify/write operations now serialize per persisted goal file while unrelated threads remain parallel.
- Continuation delivery records only when the admitted goal id is still current; a clear or replacement cancels stale delivery before any hidden prompt is queued.
- App-server clear no longer races asynchronous `goal_store_changed` continuation accounting and cannot resurrect a cleared goal.

### Why

`goal_store_changed` listeners are asynchronous and fire outside the app-server thread task queue. A continuation could read an active goal, then overwrite a later clear with its stale snapshot. Store-level serialization is required because commands, tools, lifecycle callbacks, monitors, and RPC handlers all mutate the same persisted goal outside one shared handler queue.

### Why this is not extension-only

The race is inside the builtin goal persistence contract and app-server event path. An external extension cannot make core store mutations linearizable or prevent the builtin continuation listener from committing a stale read.

### Merge-conflict zones

- `store.ts`: per-goal mutation queue and serialized mutation functions.
- `lifecycle-helpers.ts`: expected goal-id fence and stale cancellation.
- `index.ts`, `monitor-continuation.ts`: nullable stale-admission handling.

## Unified wake-source continuation gating (2026-08-09)

### What changed

- Goal dual-subscribes to `wake_source_state` and the permanent `terminal_monitor_state` alias, storing last-write-wins counts by source and gating on their sum.
- Scheduled/resumed events and cache-warm entries retain `activeMonitorCount` as the aggregate compatibility field and add the complete `wakeSources` snapshot.
- Draining the aggregate count to zero while a monitor wait is armed replaces the long backstop with a one-second drain fire that bypasses the zero-count guard; its resumed record keeps the pre-reset warm iteration.
- App-server `thread/goal/set` publishes `goal_store_changed`, allowing the builtin to queue an active goal on an idle session.

### Why

Background work could remain live outside terminal monitors, and a final source drain previously cancelled the only continuation timer without delivering work. RPC-created goals also had no lifecycle edge to wake an idle agent.

### Why an extension couldn't do it

The continuation gate, iteration reset order, goal store, and app-server session event bus are fork-owned builtin/core surfaces.

### Expected merge conflict zones

- HIGH in `monitor-continuation.ts` around source snapshots, timer firing, and iteration reset order.
- MEDIUM in `index.ts` and app-server goal handlers around the internal store-change event.

## Cache-safe backstops and warm-iteration ordinals (2026-08-09)

### What changed

- Monitor continuation delays snapshot the active extension context's prompt-cache safe-wait budget and apply the configured `promptCache.goalBackstopMaxSeconds` ceiling, with the former four-minute value retained only as the unknown-budget fallback.
- Direct-input holds now consume elapsed wall-clock time instead of restarting the held remainder, and wait progress keeps the originally scheduled total.
- Cache-warm rendering stops claiming that tokens remained warm or produced savings when the planned or actual wait reaches the displayed cache TTL.
- Cache-warm scheduled/resumed events and durable entries carry an optional per-epoch iteration ordinal; legacy entries omit the iteration wording.

### Why

- Provider lanes expose materially different cache-safe budgets. A fixed four-minute backstop wakes long-TTL lanes too often and ignores the existing provider-aware budget resolver.
- Input admission time is still real cache age, so pausing the timer during admission could overrun the captured budget.
- Iteration ordinals make repeated warm cycles understandable without persisting session-global state or mislabeling old entries.

### Why an extension couldn't do it

- The resolved prompt-cache budget and merged settings are owned by the session core and must cross the typed extension-context boundary.
- Goal's monitor timer, durable entry payload, and renderer are private builtin implementation surfaces.

### Expected merge conflict zones

- MEDIUM in `monitor-continuation.ts`, `cache-warm.ts`, and `cache-warm-renderer.ts` around scheduling and entry payloads.
- LOW in `settings-manager.ts`, extension context plumbing, and goal-monitor test harnesses.

## Reload snapshots survive first session start (2026-08-09)

### What changed

- `MonitorAwareGoalContinuation` preserves source-keyed channel snapshots received
  before its first `start()`, while a subsequent `start()` on the same instance
  still clears counts from the replaced session.
- Integration coverage runs Terminal before Goal on one event bus, parks live
  monitor and background-bash state across a real reload lifecycle, and verifies
  both replayed snapshots delay Goal continuation after the new runner starts.

### Why

- Builtin order is load-bearing: Terminal's reload `session_start` claims and binds
  its parked bundle before Goal's handler runs. `bind()` immediately replays both
  terminal snapshots to the newly constructed Goal instance, so clearing counts on
  that instance's first `start()` discarded current-session liveness with no later
  transition available to restore it.
- Pre-first-start snapshots belong to the fresh runner generation. Only a later
  same-instance `start()` represents a genuine session replacement whose old
  snapshots must be discarded.

### Expected merge conflict zones

- LOW in `monitor-continuation.ts` around `start()` lifecycle reset behavior.

## System-owned aborts stay active through Goal recovery (2026-08-05)

### What changed

- Explicit `abortSource: "system"` terminal abort events no longer enter Goal's
  retries-exhausted provider-error blocking branch, including TTSR's
  provider-error shell with `stopReason: "error"`.
- A system-owned aborted `agent_end` is treated as the start of extension-owned
  recovery rather than as a clean user turn: it preserves any existing timer,
  avoids arming user grace, and lets the recovery end arm the live monitor wait.
  If no automatic retry remains, an active monitor wait is armed immediately so
  the Goal still has a live resumption channel.
- If a system-owned provider error has neither an automatic retry nor an active
  monitor, Goal stages its hidden `systemRecovery` continuation until
  `agent_settled`. This launches recovery from the idle-compatible path instead
  of leaving a native follow-up stranded behind the error stop, while a user
  abort during `agent_end` or settlement cancels the staged delivery and clears
  its single-flight latch, so an explicit `/goal resume` can admit a fresh
  continuation. The path bypasses only idle/terminal-stop eligibility and
  retains the persisted cap, repetition, pending-message, and single-flight
  guards.
- If one of those guards blocks recovery during `agent_settled`, the returned
  Goal status now flows through the same accounting and TUI refresh path as an
  `agent_end` continuation decision; the footer no longer remains
  `Pursuing goal` after persistence has changed the Goal to blocked.
- Provenance-free terminal aborted responses still block as provider failures,
  while explicit user aborts retain the dedicated `user interrupted the turn`
  block.
- Production-shaped coverage includes `willRetry: false`, an aborted assistant
  message, active monitor state, and the combined TTSR recovery continuation.

### Why

- TTSR owns a corrective recovery turn after its system abort. Treating that
  abort as a provider failure transiently blocked the Goal, disarmed monitor
  continuation ownership, and contradicted the internal-interruption contract.
- Restricting the exemption to explicit system provenance preserves existing
  protection for provider-originated terminal aborts with no source.

### Why an extension couldn't do it

- The classification and resulting Goal status transition are private to this
  builtin's `agent_end` handler.

### Expected merge conflict zones

- `agent-end-continuation.ts`, `continuation.ts`, and
  `monitor-continuation.ts` around system-abort staging and settlement routing.

## Cache-warm waits are widget-owned (2026-08-05)

### What changed

- Monitor-delayed Goal continuations no longer emit transient scheduled/resumed
  `ctx.ui.notify` messages.
- The now-dead notice builders and their prose-only tests were removed.
- The durable `goal-cache-warmup` entry remains the single notice box for the
  cache-warm story, while the `goal-wait` status ticker remains the live
  countdown surface.

### Why

- The transient notifications repeated the same scheduled/resumed event already
  rendered by the durable entry. One event now has one display owner without
  changing the continuation timer, prompt-cache metrics, wake event, or hidden
  Goal continuation message.

### Expected merge conflict zones

- LOW in `monitor-continuation.ts` around monitor schedule and resume reporting.

## Cache-warm entry renderer delegates to the shared notice kit (2026-08-04)

### What changed

- `cache-warm-renderer.ts` now renders through `noticeEntryRenderer` from `src/core/extensions/notice/`. The exported `renderGoalCacheWarmupEntry` symbol, registration, title/why/warm/expanded text, accent and success tones, and expand behavior are unchanged; `goal-cache-warm-renderer.test.ts` passes unmodified.

### Expected merge conflict zones

- LOW in `cache-warm-renderer.ts`; NONE in cache-warm metrics, continuation, or persistence.

## A terminal provider error is a prompt-recoverable block (2026-08-04)

### What changed

- `continuation-recovery.ts` exports `PROVIDER_ERROR_BLOCKED_REASON` and adds it to
  `MECHANICAL_CONTINUATION_BLOCKS`, so `isMechanicalContinuationBlock` classifies a
  retries-exhausted provider error alongside the cap, repetition, and length guards.
- `index.ts` writes that shared constant instead of repeating the literal reason and
  appends `continuationCapRecoveryHint(...)` to the blocked notice, so the TUI warning
  now ends with `Send any message to resume.` instead of only naming the failure.
- `GoalDirectInputLifecycle.onDisposition` needed no change: reactivating a mechanically
  blocked goal on accepted direct input already existed, and the provider-error reason
  now flows through it.

### Why

- A terminal provider error is infrastructure, not a decision. The user's next message is
  exactly the retry signal, so leaving the goal blocked stranded a live run behind a state
  only `/goal resume` could clear, while the notice never said so.
- Intentional blocks stay non-recoverable: `user interrupted the turn` and model-declared
  `update_goal` blocks are still excluded, because those encode a decision to stop.
- This is the in-session counterpart to the restart resume prompt below: that entry recovers
  a stopped goal when a new session loads it, this one recovers it mid-session without a
  restart or a prompt.

### Why an extension couldn't do it

- Both the block-reason writer and the mechanical-block classifier live inside this builtin;
  the policy has no public extension hook.

### Expected merge-conflict zones

- `continuation-recovery.ts` `MECHANICAL_CONTINUATION_BLOCKS` and its exported reason constants.
- `index.ts` `agent_end` terminal-provider-error branch and its import block.

## Restart resume prompt covers every stopped-but-unfinished goal (2026-08-04)

### What changed

- `lifecycle-helpers.ts` renames `isResumeOfPausedGoal` to `isResumeOfStoppedGoal`
  and admits the whole stopped-but-unfinished set (`paused` and `blocked`) instead
  of `paused` alone. The idle / has-UI / no-pending-messages guards and the
  `"resume"` session-start reason are unchanged.
- `index.ts` renames `maybePromptResumePausedGoal` to
  `maybePromptResumeStoppedGoal`, renames the `LEAVE_GOAL_PAUSED_CHOICE` constant
  to `LEAVE_GOAL_STOPPED_CHOICE` (`"Leave stopped"`), and interpolates the goal's
  real status into the prompt title (`Resume blocked goal?` / `Resume paused
  goal?`) so the dialog names the state the user is actually resuming from.
- Accepting the prompt is unchanged: the goal flips to `active` via a `"user"`
  mutation, accounting restarts, the footer refreshes, and a continuation is
  queued through the same admission path.

### Why

- Ports the upstream codex rule in
  `codex-rs/tui/src/app/thread_goal_actions.rs`
  (`maybe_prompt_resume_paused_goal_after_resume`), which prompts on resume for
  `Paused | Blocked | UsageLimited` — every status that stopped the goal without
  finishing it. senpi previously ported only the `paused` arm.
- A `blocked` goal was unrecoverable on restart: no prompt fired, and the
  session-start auto-continuation denied it with `not-eligible` because the
  status is not `active`. The goal stayed blocked with no user-visible
  affordance, even though `blocked` is reached by ordinary events — a user
  interrupt, a terminal provider error, or a tripped continuation guard.
- senpi stays budget-free, so codex's `UsageLimited` arm has no counterpart and
  no budget status is introduced. The senpi stopped set is exactly
  `paused | blocked`; `complete` and `active` are untouched.

### Expected merge conflict zones on the next sync

- LOW in `lifecycle-helpers.ts` around the renamed predicate and its status set;
  standalone `pi-goal` has no restart resume prompt.
- LOW in `index.ts` around the `session_start` handler's resume-prompt call and
  the choice constants.

## Legacy `pi-goal` state is imported once at session start (2026-07-31)

### What changed

- `persistence.ts` exports `migrateLegacyGoalFile(ref)`, and `index.ts` awaits it
  before the session's first `readGoal`, so imported state participates
  immediately.
- Legacy-only parsing deletes the old `tokenBudget` enforcement input and maps
  `budgetLimited` / `budget_limited` to `active`. Current-store reads do not run
  that normalization, so inert wire metadata and existing typed validation errors
  are preserved.
- Migration publication now uses `writeFile` with `flag: "wx"` and mode `0600`.
  This keeps atomic exclusive-create precedence without hard-link support, temp
  cleanup machinery, or a temp sibling that can be orphaned by `SIGKILL`.
- Invalid, unsupported-version, and malformed legacy files are best-effort dead
  data: they remain on disk, return no import, and do not brick the live current
  store. Unexpected filesystem errors still propagate.
- Successfully imported files, explicit-null files, and files that lose the
  exclusive-create race are renamed to a sibling `.migrated` archive on a
  best-effort basis, so completed migration is not retried on every startup.
- Segment-aware `goal` -> `pi-goal` mapping accepts both `/` and `\\` separators
  while retaining exact path-segment matching; names such as `my-goal` are never
  rewritten.
- Session-backed migration keeps its stable thread-id lookup. No-session migration
  instead enumerates the cwd-keyed `*.json` bucket because ephemeral sessions get
  a new id on every run. It searches both the legacy bucket beside the redirected
  Senpi root and `PI_CODING_AGENT_DIR` (default `~/.pi/agent`), and reports an
  explicit conflict when multiple valid live goals exist rather than guessing.

### Why

- Standalone `pi-goal` and the builtin can use different agent roots, and
  no-session filenames contain an old ephemeral session id. Rewriting only the
  current Senpi path and looking up the new id silently missed the headline
  print/in-memory upgrade path.
- Hard links fail on common non-POSIX and network filesystems. Exclusive `wx`
  creation provides the same no-clobber result portably and removes the crash-time
  orphan-temp-file durability wart.
- A stale corrupt migration source is not authoritative live state. Ignoring its
  expected parse/schema failures keeps goal creation usable while preserving the
  source for manual recovery.
- Retiring a consumed source makes migration genuinely one-shot without deleting
  the user's old data.

### Expected merge conflict zones on the next sync

- LOW in `persistence.ts` around legacy candidate discovery and `parseGoalFile`'s
  `legacy` option; standalone `pi-goal` has no migration path.
- LOW in `index.ts` at the `session_start` migration call.
- NONE in the store schema, tool schemas, status transitions, or public API.

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

## Visible continuation-wait countdown (2026-08-03)

### What changed

- `wait-progress.ts` exports the clamped 12-cell progress bar and the user-grace / monitor
  wait-label formatter, reusing `formatWakeDuration` so countdowns match existing cache-warm
  notices.
- New `wait-ticker.ts` follows the existing `GoalElapsedTicker` / `MonitorStatusTicker` pattern:
  it renders a dedicated `goal-wait` footer status immediately, refreshes once per second on an
  unref'd interval, skips unchanged labels, and clears the status when its timer ends or is
  cancelled.
- `monitor-continuation.ts` now drives that ticker from the real delayed-continuation lifecycle.
  It restores the 60-second `userGrace` continuation after a clean accepted user turn, keeps the
  existing four-minute monitor delay, freezes both timers while direct-input admission is
  unresolved, resumes rejected/handled holds with their remaining time, and clears the footer on
  delivery, accepted replacement input, goal state changes, monitor settlement, reload, and
  shutdown.
- The countdown is footer-only and transient. It does not append a durable entry: a transcript
  line per user-grace window would be permanent noise for a state whose value changes every
  second. The existing durable `goal-cache-warmup` story remains unchanged for monitor waits.
- Coverage keeps the nine pure rendering tests and adds lifecycle wiring assertions that observe
  the real user-grace status before triggering the turn, advance it with fake time, then await
  exact delivery/clear signals; cancellation is likewise observed before accepted input and
  proves no later delivery or status tick leaks.

### Why

The original 60-second grace path left an active Goal silent and visually indistinguishable from
an idle or hung session. PR #553 later removed that timer while improving correlated direct-input
admission. This change intentionally restores the grace continuation requested here without
removing those safeguards: accepted input still cancels an already-armed wait synchronously, and
only the clean end of that accepted user turn starts a fresh visible grace window.

A dedicated footer ticker matches the TUI's established live-status mechanism and keeps the
countdown independent from cumulative `Pursuing goal (…)` elapsed time. Durable timeline entries
cannot represent per-second state without transcript spam, so they are the wrong rendering
surface for this wait.

### Why the extension system could not handle this differently

The scheduler and footer status are already private implementation details of the builtin Goal
extension. The wiring stays entirely inside that builtin and uses the public `ctx.ui.setStatus`
surface; no core extension API change is required.

### Expected merge conflict zones on the next sync

- MEDIUM in `monitor-continuation.ts` around delayed timer ownership and direct-input holds.
- LOW in `continuation.ts` for the restored `userGrace` path and in `index.ts` for ticker wiring.
- LOW in the focused Goal monitor lifecycle tests and harness status signal.
- NONE in the Goal store schema, public extension API, or durable cache-warm entry contract.

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
  (`GOAL_STALL_TOOLLESS_THRESHOLD = 3`). From the third consecutive delayed continuation
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
