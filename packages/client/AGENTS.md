# packages/client

Transport-neutral client for remote pi sessions: `PiClient` exchanges framed CBOR through an injected `ByteTransportFactory`. Sole runtime dependency is `@earendil-works/pi-protocol`; the core stays runtime-neutral (no Node imports).

## STRUCTURE

```text
src/client.ts          PiClient: connection, requests, leases, cleanup reconciliation
src/connection.ts      Transport lifecycle, frame codec, connect/reconnect
src/state.ts           Authoritative snapshots, event and listener fan-out
src/session-handle.ts  SessionLease / PiSessionHandle semantics
src/transport.ts       ByteTransport / ByteTransportFactory contracts
src/errors.ts          PiServerError and client error taxonomy
src/unix.ts            Node Unix-domain transport (separate ./unix subpath)
src/index.ts           Public barrel
test/                  Vitest suites plus support harness
```

## WHERE TO LOOK

| Task | Path |
|---|---|
| Connection lifecycle, reconnect | `src/connection.ts` |
| Session leases, attach/detach, reconciliation | `src/client.ts` |
| Lease modes and invalidation | `src/session-handle.ts` |
| Snapshot vs event state | `src/state.ts` |
| New transports | implement `ByteTransportFactory` per `src/transport.ts` |
| Unix-domain sockets | `src/unix.ts` via `@earendil-works/pi-client/unix` |

## CONVENTIONS

- Node-only code lives in `src/unix.ts`, exported only through the separate `./unix` subpath; the `src/index.ts` barrel must stay runtime-neutral.
- `package.json` exports map is `.`, `./unix`, `./package.json`; `sideEffects: false`. Extend the map rather than adding side-effectful entry points.
- Build and tests resolve `@earendil-works/pi-protocol` via `paths`/vitest alias (`../protocol/dist` for build, `../protocol/src` for tests); keep both in sync when files move.
- Imports carry explicit `.ts` extensions per root `tsconfig.base.json`.
- Engines: Node >=22.19.0 (repo root requires >=24). Published as CalVer `@earendil-works/pi-client`.

## ANTI-PATTERNS

- No auto-reconnect: `PiClient` requires explicit `reconnect()` after disconnection; do not add hidden retry loops.
- Never apply optimistic state mutation from progress events; server snapshots and successful response snapshots are authoritative.
- Do not construct `SessionLease` directly; leases exist only via `acquireSession()`, `createSession()`, or `attachSession()`.
- Do not add Node/builtin imports outside `src/unix.ts`.
- Keep `maxFrameLength` bounded and matching the server; transports must preserve send order and bound queued bytes.
- Disconnection or server removal invalidates every lease for the affected attachment; disposing an invalidated lease is a no-op — preserve that behavior.

## COMMANDS

From the package root, or with `--workspace=@earendil-works/pi-client` from the repo root:

```bash
bun run build        # tsc -p tsconfig.build.json
bun run test             # vitest --run
bun run typecheck    # tsc -p tsconfig.test.json
```
