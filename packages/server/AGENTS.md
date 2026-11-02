# packages/server

Commit: `baf15a54d` (2026-08-24)

`@code-yeongyu/senpi-server` is an experimental private package. It is a composable, transport-neutral protocol server built on `@earendil-works/pi-protocol`. The old daemon/IPC/Radius stack under `src/legacy/` and the `server` CLI bin were removed upstream in v0.84.1; applications supply their own `PiServerService`. Node `>=22.19.0`.

## STRUCTURE

```text
src/index.ts             Re-exports errors, listener, protocol, server, types
src/server.ts            PiServer: handshake, auth token hash, message dispatch
src/protocol.ts          pi-ai <-> pi-protocol type bridging and transcript mapping
src/listener.ts          PiServerListener interface (start/close, accept)
src/connection.ts        ByteConnection, handler, ConnectionState stages
src/sessions.ts          LiveSessionManager: session runtimes + subscriber fanout
src/snapshots.ts         ServerSnapshotPublisher: revisioned server-snapshot broadcast
src/errors.ts            PiServerError
src/types.ts             PiServerOptions, PiServerService, PiSessionRuntime
src/transports/unix/     createUnixListener, createUnixServer preset
src/testing/             TestServerService, TestSessionRuntime, ProtocolTestClient, createTestServer
```

Package exports: `.` (core), `./testing`, `./unix`.

## INVARIANTS

- Transports are byte-level only. `ByteConnection` gives an ordered byte sink; all framing, hello handshake, and protocol-version checks belong to `PiServer` in `src/server.ts`.
- Handshake is bounded (5s default timeout) and validates the protocol version.
  Authentication is transport/application-specific; `PiServer` performs no token auth
  (upstream #7551) — never add string-compare token checks to the core.
- Connection stages progress `awaitingHello -> handshaking -> ready -> closing -> closed`; dispatch only after `ready`.
- `LiveSessionManager` owns runtime lifecycle: unsubscribe on dispose, settle in-flight operations on disconnect, guard double-dispose via the `disposing` promise.
- Snapshot broadcasts serialize through `broadcastQueue` and carry a monotonic revision; do not publish out of order.
- Keep type bridging in `src/protocol.ts` exhaustive; the compile-time `Assert`/`ExactKeys` checks there must stay so pi-ai/pi-protocol drift fails typecheck.
- Tests are Vitest (`bun run test` runs `vitest --run`), not the Node test runner.

## WHERE TO LOOK

| Task | Path |
|---|---|
| Handshake, auth, dispatch | `src/server.ts` |
| Session runtime lifecycle | `src/sessions.ts`, `src/types.ts` |
| Server snapshot fanout | `src/snapshots.ts` |
| Add a transport | `src/listener.ts`, `src/connection.ts`, `src/transports/unix/` as template |
| Unix socket specifics (stale sockets) | `src/transports/unix/listener.ts`, `test/unix.test.ts`, `test/unix-connection.test.ts`, `test/fixtures/stale-socket-server.mjs` |
| Test harness/backend fakes | `src/testing/` |
| Protocol conformance | `test/conformance.test.ts`, `test/protocol.test.ts` |

## VALIDATION

- `bun run test` (Vitest) from this package; root `bun run check` after code changes.
- Add lifecycle tests for handshake timeout, disconnect mid-operation, duplicate close, and stale-socket takeover.
- Inspect logs and fixtures for secret safety before committing.

---
Updated: 2026-08-24 | Commit `baf15a54d` (was `4f26b8282`)
