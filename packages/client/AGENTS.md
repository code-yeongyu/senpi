# packages/client

Transport-neutral client for remote pi sessions: `PiClient` exchanges framed CBOR through an injected `ByteTransportFactory`. Sole runtime dependency is `@earendil-works/pi-protocol`; the core stays runtime-neutral. Score 12: 24 files, package/config boundary, dense lifecycle symbols, 19 public barrel exports.

## STRUCTURE

```text
src/client.ts          PiClient: connection, requests, leases, cleanup reconciliation
src/connection.ts      Transport lifecycle, frame codec, connect/reconnect
src/state.ts           Authoritative snapshots, event and listener fan-out
src/session-handle.ts  SessionLease / PiSessionHandle semantics
src/transport.ts       ByteTransport / ByteTransportFactory contracts
src/errors.ts          PiServerError and client error taxonomy
src/promise.ts         Resolver helper pending the TypeScript ES2024 lib baseline
src/unix.ts            Node Unix-domain transport (separate ./unix subpath)
src/index.ts           Public barrel
test/                  Vitest suites plus support harness
```

## WHERE TO LOOK

| Task | Path |
|---|---|
| Connection lifecycle, reconnect | `src/connection.ts` |
| Session leases, attach/detach, reconciliation | `src/client.ts` |
| Lease interface and forwarding | `src/session-handle.ts`; ownership, generations and invalidation in `src/client.ts` |
| Snapshot vs event state | `src/state.ts` |
| New transports | implement `ByteTransportFactory` per `src/transport.ts` |
| Unix-domain sockets | `src/unix.ts` via `@earendil-works/pi-client/unix`; rejects Windows and overlong UTF-8 paths |
| Client behavior harness | `test/support.ts` (`MemoryByteServer`); lifecycle regressions in `test/connection.test.ts`, `test/sessions.test.ts`, `test/disposal.test.ts` |
| CLI-facing adapter | `packages/coding-agent/src/client/remote-session.ts` consumes `PiClient` |

## CONVENTIONS

- Node-only code lives in `src/unix.ts`, exported only through the separate `./unix` subpath; the `src/index.ts` barrel must stay runtime-neutral.
- `package.json` exports map is `.`, `./unix`, `./package.json`; `sideEffects: false`. Extend the map rather than adding side-effectful entry points.
- Build and tests resolve `@earendil-works/pi-protocol` via `paths`/vitest alias (`../protocol/dist` for build, `../protocol/src` for tests); keep both in sync when files move.
- Imports carry explicit `.ts` extensions per root `tsconfig.base.json`.
- Engines: Node >=22.19.0 (repo root requires >=24). Workspace package name: `@earendil-works/pi-client`.
- `SessionLease` is an interface (`PiSessionHandle` is its alias), not a public constructor. `createSession()` reserves exclusive ownership; `attachSession()` acquires a shared lease.
- Failed explicit `detach()` restores the lease for retry; failed `dispose()` relinquishes ownership and requires cleanup reconciliation before reacquisition.
- Diagnostics callbacks cannot alter connection/client state. Handshake callbacks may disconnect or reconnect synchronously; stale connection completions must not revive them.

## ANTI-PATTERNS

- No auto-reconnect: `PiClient` requires explicit `reconnect()` after disconnection; do not add hidden retry loops.
- Never apply optimistic state mutation from progress events; server snapshots and successful response snapshots are authoritative.
- Do not export or construct the internal `SessionHandle` directly; leases exist only via `acquireSession()`, `createSession()`, or `attachSession()`.
- Do not add Node/builtin imports elsewhere in `src/`; keep them confined to `src/unix.ts`.
- Keep `maxFrameLength` bounded and matching the server; transports must preserve send order and bound queued bytes.
- Disconnection or server removal invalidates every lease for the affected attachment; disposing an invalidated lease is a no-op — preserve that behavior.

## COMMANDS

From the repository root (build protocol first for the client's declaration alias):

```bash
bun run --cwd packages/protocol build
bun run --cwd packages/client build       # tsc -p tsconfig.build.json
bun run --cwd packages/client test        # vitest --run
bun run --cwd packages/client typecheck   # tsc -p tsconfig.test.json
```

`ci.yml`'s explicit workspace-test list currently omits this package; run its suite directly for client changes.
