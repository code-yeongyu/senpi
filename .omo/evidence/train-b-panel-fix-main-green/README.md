# Train B panel-fix: re-establish a green `main` baseline

## Problem

`main` was left RED after PR #144 (PR-B2) was merged via admin bypass
(`enforce_admins=false`) while the required `Check and test` status check was
FAILING. Three consecutive push-CI runs on `main` failed across the #141/#144/#145
merges. The failures were two pre-existing **flakes**, not functional regressions
from the terminal feature:

1. **Go (current `main` HEAD `fedd29d86`, run 28870963260):**
   `TestRecovery_DaemonDeadRespawnsAndResumes` in
   `packages/neo/internal/bridge/recovery_test.go` — timed out at 4.00s in the
   `Check` step (`npm run check:neo`). Reproduced locally: **1 fail / 10 runs**.

2. **Node (gated the B2 PR's own run 28866780839; also failed the #141 merge):**
   `test/mcp/idle.test.ts` "keep-alive pings … recovers a killed fixture" —
   `condition timed out` at line 183. Reproduced locally in isolation:
   **1 fail / 5 runs** (so it is NOT purely CI-load; it is a real single-tick race).

Both tests pass in isolation *most* of the time, which is why the merges looked
acceptable, but neither ever produced a genuinely-green required check.

## Root causes

### Go recovery test — registry write races its own recovery read
The test simulated SIGKILL by `d1.stop(); d1.dropConnections(); writeRecordAtomically(dead-pid)`.
`dropConnections()` is what wakes the recovery loop, so the loop's **first**
registry read raced the test's dead-pid write. When the read won:
- `tryAttachExisting` saw the still-live record (live pid, dead socket) → dial fails → fall through.
- `cleanupStaleRecord` saw a LIVE pid → returned without cleaning.
- Spawn respawned `d2` and it registered a fresh live record …
- … then the test's late `writeRecordAtomically(dead-pid)` **clobbered** `d2`'s
  good record, wedging every subsequent attach until `WaitRecovered(4s)` expired
  (`snapshot=…Status:reconnecting Reconnects:0`).

**Fix (test-only):** write the dead-pid record and stop the listener *before*
`dropConnections()`, so the dead-pid record is already on disk when the loop
performs its first read. Deterministic respawn; no competing write remains.

### idle keep-alive test — single faked tick can hit the doomed ping path
`vi.useFakeTimers({ toFake: ["setInterval","clearInterval"] })` then a single
`advanceTimersByTimeAsync(30_000)`. `keepAlivePingOrRecover` only reconnects when
the connection has already left `"connected"`; while still `"connected"` it merely
`client.ping()`s the dead server (→ `markDegraded`, no reconnect). The transition
off `"connected"` is driven by the stdio transport's async `onclose` →
`markDegraded` (connection.ts:169-188), which is NOT gated on the faked interval.
If the single tick fired before `onclose` landed, the tick pinged, and because the
interval is faked and advanced exactly once, **no further tick ever retried** →
`waitFor` at line 183 timed out.

**Fix (test-only):** `await waitFor(() => connection.state !== "connected", 10_000)`
between `assertProcessDead` and the timer advance, so the single tick
deterministically takes the reconnect path. No production change.

## Verification (local)

| Test | Before fix | After fix |
|------|-----------|-----------|
| `TestRecovery_DaemonDeadRespawnsAndResumes` | 1 FAIL / 10 | **0 FAIL / 60** (`-count=1`) + **0 / 20** (`-race`) + `-count=20` green |
| Full `packages/neo/internal/bridge` package | — | `ok` |
| idle.test.ts keep-alive | 1 FAIL / 5 | **0 FAIL / 12** |
| Full `idle.test.ts` file | — | **0 FAIL / 5** |

Artifacts in this directory:
- `RED-go-recovery-flake.log` — captured failing Go run (pre-fix).
- `RED-idle-keepalive-flake.log` — captured failing idle run (pre-fix).
- `GREEN-go-recovery-count20.log` — post-fix `-count=20` green.
- `GREEN-idle-keepalive.log` — post-fix green.

Gates: `go vet ./internal/bridge/` clean, `go build ./...` clean,
`biome check` on the changed test clean. Both changes are test-only (no
`src/core/extensions/*` surface touched → no changes.md entry required).
