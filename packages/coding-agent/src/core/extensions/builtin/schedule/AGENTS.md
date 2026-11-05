# builtin/schedule

Durable scheduled prompts. Unlike `loop/` (in-process timers, interactive only), a job here is a
file that outlives the process that created it, so `--print` and other headless runs can schedule.
User docs: `packages/coding-agent/docs/schedule.md`.

## FILES

- `types.ts` - `ScheduledJob`, fail-closed `parseScheduledJob` (id shape, non-negative integers, prompt size), limits, `nextRecurringDueAt`, the fired-message header. Pure.
- `store.ts` - the file layout (`pending/`, `firing/<id>@<n>~<pid>-<start>.json`, `failed/<id>@<n>.json`, `cancelled/<id>` tombstones), listing, creation; atomic 0600 writes in 0700 dirs.
- `occurrences.ts` - state transitions: `claimOccurrence`, `restorePending`, `rearmRecurringJob`, `settleOccurrence`, `cancelScheduledJob`, `pruneTombstones`.
- `runner-lease.ts` - runner leases `runners/<pid>.json` in the terminal lease format plus a heartbeat (`liveRunners`, `isWatchRunnerAvailable`, `isOwnerAmong`) and the per-session delivery lock `sessions/<id>.lock` (`acquireSessionDeliveryLock`).
- `tool.ts` - `schedule_prompt` (create/list/cancel), flat TypeBox schema, `exposure: "search"`.
- `live-delivery.ts` - live delivery (senpi#4074): in an interactive or RPC session the extension runs `runDueJobs` scoped to its own session, arms one timer for the earliest due time, re-plans on tool create/cancel and on changes in `pending/`, and delivers with `sendUserMessage(..., { deliverAs: "steer" })`. It holds a `watch: false` runner lease for the process (ref-counted across sessions of one host) so an outside runner never treats its claims as abandoned.
- `index.ts` - `createScheduleExtension({ now, timer })`: registers the tool and the live delivery.
- The runner lives with the CLI: `src/cli/schedule-runner.ts` (`runDueJobs`), `src/cli/schedule-delivery.ts` (hook and session-resume deliveries, `deferWhileSessionOpen`), `src/cli/schedule-watch.ts` (lease, heartbeat, watch loop) and `src/cli/schedule-command.ts` (`senpi schedule list|cancel|run`).

## INVARIANTS

- **At-most-once per occurrence**: claim = `rename(pending -> firing/<id>@<n>~owner)`; a racing runner gets ENOENT. Never replace the rename with read-then-write.
- **Re-arm before delivery**: a recurring job is back in `pending/` before its occurrence is delivered, so a crash loses at most that occurrence.
- **Tombstone first**: cancel writes `cancelled/<id>` before removing files; claim and re-arm re-check it after their write, so a cancelled job cannot be resurrected.
- **Abandoned, not retried**: an occurrence whose owner lease is gone moves to `failed/`; it may already have been delivered.
- **One writer per session**: every runner holds `sessions/<id>.lock` from before the claim until the delivery settles (re-reading the pending job under the lock); the lock records the delivery pid and spawn time before the delivery may start (POSIX gate on fd 3; attach and release are serialized), and a dead runner's lock is reclaimed only after that delivery group is gone (a live leader whose start time differs or cannot be read is a reused pid); on win32 (no gate) a dead runner's lock is held until its recorded `maxDeliveryMs` has passed; deferred jobs retry after `DEFERRED_RETRY_MS`, never at their past due time; and default delivery also defers while `liveSessionHolders` reports another process on the session file.
- **Put-back never overwrites**: a generation claimed by mistake returns to `pending/` via `link` (EEXIST keeps the newer one) and is dropped if a tombstone appeared.
- **Fail closed**: an unparseable or oversized job file is reported (`invalid`) and never fired or deleted.
- **Session scoping**: the tool lists and cancels only the calling session's jobs; the CLI sees all.
- **Live holder delivers its own session**: while a session is open in an interactive or RPC process, that process fires the session's due jobs itself, steered into a running turn; runners keep deferring while the session is open, so it is the only writer then. `--print`/`json` runs never arm a timer, and jobs due after the process exits fall back to the runner. The live pass uses the same lock, claim, re-arm and settle as a runner; never give it a separate delivery path. Shutdown waits for a pass in flight before it releases the lease, and a job that fails inside a pass is reported to the user (it is retried later).
