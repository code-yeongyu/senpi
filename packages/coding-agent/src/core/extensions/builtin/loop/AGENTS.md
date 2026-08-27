# builtin/loop

Fork-only builtin extension porting Claude Code's `/loop`: recurring (fixed-interval) and
self-paced (dynamic) scheduled prompts inside one session. A loop re-delivers a prompt or a
loop-file sentinel on a cadence; dynamic loops pick their own next delay through the
`schedule_wakeup` tool.

## FILES

- **Impure**: `index.ts` (extension entry: timers, store wiring, tick dispatch, lifecycle),
  `store.ts` (atomic versioned sidecar, fail closed), `command.ts` (/loop → scheduler),
  `tools.ts` (`schedule_wakeup`, flat TypeBox schema).
- **Pure**: `scheduler.ts` (state machine: arm/fire/settle/pause/resume/stop/suspend/restore),
  `parse.ts` (/loop argument grammar), `cron-planner.ts` (normalizeInterval/describeCron/
  computeNextFireAt), `tick-prompt.ts` (sentinel expansion, full-vs-reminder), `status.ts`
  (formatLoopStatus + 1s LoopStatusTicker), `loopfile.ts` (loop-file resolution, injected fs).
- `types.ts` — single type home (LoopState, CronEntry, lifecycle, payloads, sentinels); other
  modules re-export rather than redeclare.

## PURITY SEAM

`scheduler.ts`, `parse.ts`, `cron-planner.ts`, `tick-prompt.ts`, and `status.ts` are pure.
The scheduler never calls `Date.now` or `setTimeout`: `LoopClock` supplies `now` and a
`LoopTimerPort` owns the single armed timeout per loop, both injected by `index.ts`;
`loopfile.ts` takes an injected `fs`/`path`/`cwd` bundle. Only `index.ts` and `store.ts`
touch the real world, so every scheduling invariant is testable with a fake clock and
zero real waiting.

## PERSISTENCE

`store.ts`: one sidecar file per session, strict `version: 1` validation, atomic write
via temp file + rename, and a promise tail serializing every mutation so command, timer,
tool, and lifecycle writes cannot interleave. It FAILS CLOSED: unparseable or wrong-version
state returns a typed error, arms nothing, never silently resets. Session custom entries
are deliberately NOT the authoritative store; the `loop-tick` entry exists only for
attribution and noop folding.

## SCHEDULING INVARIANTS

- **Coalescing**: at most ONE queued or running tick per loop; a fire landing while one is
  in flight sets `coalescedFirePending` rather than enqueuing a second delivery, and
  `nextFireAt` recomputes from `now`, collapsing missed occurrences into one catch-up tick.
- **5-loop cap + max-ticks valve**: `MAX_ACTIVE_LOOPS` (5) active loops per session (further
  creation returns a typed rejection, existing loops stay armed); each loop carries a
  `DEFAULT_MAX_TICKS` (2000) dispatched-tick budget, exhaustion ending it with
  `tick_budget_exhausted` so a forgotten fast loop cannot spend without bound.
- **Expiry**: at most 7 days from `createdAt`, checked at arm, fire, re-entry, and restore;
  a new wakeup never extends it.
- **Keepalive** (dynamic loops only): two-strike. The first iteration ending without
  `schedule_wakeup` burns one credit and arms a fallback wakeup (`SENPI_LOOP_KEEPALIVE_SECONDS`,
  default 1200s, clamped 60-3600); the second consecutive omission ends the loop with
  `keepalive_exhausted`. Never applies after an ordinary user turn; a user abort PAUSES the
  loop. Provider/turn errors are never terminal for a loop.

## TICK DELIVERY

A tick never steers. When idle, `index.ts` dispatches through `sendUserMessage` with
`expandPromptTemplates: true` so a slash payload reaches the real command path; a busy
session receives the tick as a follow-up. Sentinel payloads (the four `<<...>>`
loop/loop-file forms) deliver the long instruction block once as an anchor, later ticks send
a short reminder pointing back at it, keeping the cached message prefix stable; a changed
loop-file fingerprint re-anchors. Verbatim `prompt` payloads are always sent as-is.

## LIFECYCLE

Shutdown SUSPENDS, it never terminates: every senpi shutdown reason (`quit|reload|new|
resume|fork`) leaves the session resumable, so `onShutdown` cancels timers, disposes the
status ticker, and persists the snapshot without a terminal reason. Terminal reasons are
exactly `stopped | keepalive_exhausted | expired | tick_budget_exhausted | error` (there is
deliberately no `session_closed`). `restore` re-arms suspended loops on the next session
start, re-checking expiry. A store failure ends affected loops with `error` and tells the
user — a schedule that cannot be persisted must not keep running.

## MODEL SURFACE

`schedule_wakeup` (`tools.ts`) is the only model-callable surface. Its TypeBox schema is a
flat object with no root union (several provider conversions rebuild schemas from top-level
`properties`; a root `anyOf` would arrive empty — same reasoning as `terminal/tools/monitor.ts`).
`delaySeconds` carries no schema bounds; the executor clamps out-of-range integers (60-3600s)
instead of rejecting them. All effects go through an injected scheduler port.
