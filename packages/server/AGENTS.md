# packages/server

Commit: `4f26b8282` (2026-08-07)

`@code-yeongyu/senpi-server` is an experimental private package. Top level is a composable, transport-neutral protocol server built on `@earendil-works/pi-protocol`. The old daemon/IPC/Radius stack lives on under `src/legacy/` and still backs the `server` CLI bin (`dist/legacy/cli.js`). Node `>=22.19.0`.

## STRUCTURE

```text
src/index.ts             Re-exports errors, listener, protocol, server, types, legacy
src/server.ts            PiServer: handshake, auth token hash, message dispatch
src/protocol.ts          pi-ai <-> pi-protocol type bridging and transcript mapping
src/listener.ts          PiServerListener interface (start/close, accept)
src/connection.ts        ByteConnection, handler, ConnectionState stages
src/sessions.ts          LiveSessionManager: session runtimes + subscriber fanout
src/snapshots.ts         ServerSnapshotPublisher: revisioned server-snapshot broadcast
src/errors.ts            PiServerError
src/types.ts             PiServerOptions, PiSessionBackend, PiSessionRuntime
src/transports/unix/     createUnixListener, createUnixServer preset
src/testing/             TestSessionBackend, ProtocolTestClient, createTestServer
src/legacy/              Old daemon: serve, ipc/, rpc-process, supervisor, radius,
                         config, storage, cli (the `server` bin)
```

Package exports: `.` (core + legacy re-export), `./testing`, `./unix`, `./legacy`.

## INVARIANTS

- Transports are byte-level only. `ByteConnection` gives an ordered byte sink; all framing, hello handshake, and protocol-version checks belong to `PiServer` in `src/server.ts`.
- Handshake is bounded (5s default timeout) and auth compares token hashes with `timingSafeEqual`; never short-circuit with string equality.
- Connection stages progress `awaitingHello -> handshaking -> ready -> closing -> closed`; dispatch only after `ready`.
- `LiveSessionManager` owns runtime lifecycle: unsubscribe on dispose, settle in-flight operations on disconnect, guard double-dispose via the `disposing` promise.
- Snapshot broadcasts serialize through `broadcastQueue` and carry a monotonic revision; do not publish out of order.
- Keep type bridging in `src/protocol.ts` exhaustive; the compile-time `Assert`/`ExactKeys` checks there must stay so pi-ai/pi-protocol drift fails typecheck.
- Tests are Vitest (`npm test` runs `vitest --run`), not the Node test runner.

## WHERE TO LOOK

| Task | Path |
|---|---|
| Handshake, auth, dispatch | `src/server.ts` |
| Session runtime lifecycle | `src/sessions.ts`, `src/types.ts` |
| Server snapshot fanout | `src/snapshots.ts` |
| Add a transport | `src/listener.ts`, `src/connection.ts`, `src/transports/unix/` as template |
| Unix socket specifics (stale sockets) | `src/transports/unix/listener.ts`, `test/unix.test.ts`, `test/fixtures/stale-socket-server.mjs` |
| Test harness/backend fakes | `src/testing/` |
| Protocol conformance | `test/conformance.test.ts`, `test/protocol.test.ts` |

## LEGACY (`src/legacy/`)

- Daemon entry `serve.ts`, JSONL IPC under `ipc/`, child RPC in `rpc-process.ts` + `supervisor.ts`, Radius in `radius.ts`, plus `config.ts`, `storage.ts`, `cli.ts`.
- Preserve newline-delimited JSON framing and per-connection write serialization; interleaved bytes corrupt the protocol.
- Supervisor owns spawned children; clean up on stop, error, and partial startup.
- Radius handles heartbeat retry backoff and re-registration after repeated 404s; credentials via `readStoredCredential("radius")`, fallback `SENPI_RADIUS_API_KEY`.
- Never log credentials, tokens, raw auth headers, or secret-bearing environments.

## VALIDATION

- `npm test` (Vitest) from this package; root `npm run check` after code changes.
- Add lifecycle tests for handshake timeout, disconnect mid-operation, duplicate close, and stale-socket takeover.
- Inspect logs and fixtures for secret safety before committing.
