## 2026-10-24 - Keep interrupted loop work held without user Stop attribution (senpi#4204)

### What changed

- `session-hold.ts` keeps interrupted sessions held while excluding the interrupted-run gate from user Stop detection.

### Why

- A host restart is not a user Stop and must not be attributed as one.

### Why an extension could not handle it

- This builtin owns loop hold and Stop detection.

### Expected merge conflict zones

- `session-hold.ts`: Stop hold detection.

## 2026-10-21 - A user Stop holds loop ticks without pausing or charging the loop (senpi#3811)

### What changed

- `index.ts`: while the session holds automatic turns (`ctx.getPauseState()` reports any hold other than a run fence), a due tick is still sent, the session keeps it as a notice, and the tick is settled at once: no tick count, keepalive or attribution is charged, and a fixed schedule stays armed. A user abort under a Stop (`session_hold`) settles the attributed tick instead of suspending the loop; a plain interrupt still suspends it.
- `scheduler.ts`: `onDue(..., held)` does not count a held tick.
- `session-hold.ts`: reads the session's holds.

### Why

After a Stop the loop suspended itself and needed `/loop resume` even after the session was resumed. The session's own pause now holds the ticks.

### Why an extension could not handle it

This is the loop builtin; it uses the public `ctx.getPauseState()`.

### Expected merge conflict zones

`dispatchTick`, `fireDue`, the `agent_end`/`session_abort` handlers and `settleAttributedTick` in `index.ts`; `onDue` in `scheduler.ts`.
