# packages/coding-agent/src/client

## OVERVIEW

Public `./client` package surface: `RemoteSession` wraps `@earendil-works/pi-client` leases and protocol snapshots (score 8: package boundary, barrel and lifecycle symbols).

## WHERE TO LOOK

| Task | Location | Notes |
|---|---|---|
| Public exports | `index.ts` | Re-exports remote-session and transcript types/functions |
| Attach/create/reconnect/dispose | `remote-session.ts` | Exclusive `SessionLease`, operation lifecycle and cleanup |
| Snapshot/progress merge | `transcript.ts` | Immutable state, revision guard and streamed tool-input buffers |
| Protocol client transport | `@earendil-works/pi-client` | This package consumes it; transport implementation is outside this subtree |

## CONVENTIONS

- `RemoteSession` is stateful but exposes immutable snapshots: lifecycle is `unbound | ready | busy | disposed`.
- `open` and `create` replace an idle attachment only after the new lease supplies a snapshot; failed replacement detaches the candidate and preserves useful errors.
- `submit` prompts while idle and steers during a turn. `abort` may preempt a submit, while model and thinking changes require idle phase.
- Disposal races are explicit: pending attachment operations are tracked, the dispose signal rejects in-flight work, and cleanup errors are aggregated.
- Transcript progress is merged by item ID; stale snapshots are ignored, partial tool JSON remains a string until valid, and finished tool buffers are removed.
- Listener failures go only to `onListenerError`; they must not change transport or session state.

## ANTI-PATTERNS

- Mutating protocol snapshots or transcript items in place; use the immutable state helpers.
- Detaching the old lease before the replacement has a valid snapshot, or leaving a candidate lease undisposed after a failed replacement.
- Allowing concurrent operations by bypassing the busy lifecycle guard.
- Treating `RemoteSession` as the RPC wire protocol itself; server events and leases remain owned by `pi-client`.

## VALIDATION

Focused tests: `test/client/remote-session.test.ts`, `test/client/remote-session-lifecycle.test.ts`, `test/client/remote-session-ownership.test.ts`, and `test/client/transcript.test.ts`.
