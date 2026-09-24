# @code-yeongyu/senpi-desktop-service

Runs one `senpi-desktop-engine` child process per agent session and talks JSON-RPC to it over stdio. It will also host the `computer.run` runtime (todo 20 of the computer-use plan).

## `DesktopService`

- The child starts lazily. `open(params)` spawns it, sends `engine.hello` (the ABI must match, otherwise it throws `DesktopEngineAbiMismatchError`), then sends `session.open`, forwarding `params` unchanged. The `resumeToken` in the reply stays inside the service. Only `resume()` sends it back, as `stopPath.resume {token}`.
- `ensureStopPath(chord)` sends `stopPath.start {chord}` once per chord. Asking again for the same chord only reads `stopPath.status`. `stop()` sends `stopPath.stop {source: "host-relay"}`.
- `call(method, params, {signal, timeoutMs})` multiplexes requests by id, so replies may arrive in any order. An abort or an expired timeout sends `$/cancel {id}`. If the engine has not answered `GRACE_MS` (750 ms) later, the service kills the child and rejects with `desktop engine restarted; captures and ax refs were reset` (`engineRestarted: true`). The next call starts a fresh child and replays `session.open`, the armed chord, and any stop latch.
- While a session is open, `stopPath.heartbeat` goes out every `HEARTBEAT_MS` (500 ms). When the child exits, every pending call rejects with `DesktopServiceError` code `Closed`.
- `open` and `close` run one at a time. Calls run concurrently because the engine serializes mutations itself. `close()` sends `session.close`, ends stdin, and kills the child if it has not exited within `CLOSE_TIMEOUT_MS` (1.5 s). Starting times out after `START_TIMEOUT_MS` (10 s) with `Timed out starting desktop engine`.
- Notifications: `onAudit(cb)` receives `audit` and `onStopPathChange(cb)` receives `stopPath.changed`. `onError(cb)` receives heartbeat failures and malformed notifications. The engine persists audit records and enforces every policy (capture budget, stop policy). The service only forwards them.
- Tests inject a `ChildFactory` that runs `test/fake-engine.mjs` through `node`.

## Engine spawn contract

- `@code-yeongyu/senpi-desktop-engine` locates the binary. In development that is `target/release/senpi-desktop-engine` or the vendored `native/prebuilds/<host>/senpi-desktop-engine[.exe]`. In a compiled senpi binary it is the sidecar copy at `<execDir>/native/prebuilds/<host>/senpi-desktop-engine[.exe]`.
- The service spawns that binary with the single argument `--stdio` and piped stdin, stdout, and stderr.
- The child inherits `SENPI_DESKTOP_BACKEND` (tests use it to select the fake backend). On Linux it also inherits `DISPLAY`, `WAYLAND_DISPLAY`, `DBUS_SESSION_BUS_ADDRESS`, and `XDG_RUNTIME_DIR`.
- The engine is an asset, not a bundled entry. It adds no senpi compile entry and no argv discriminator, and it does not change `session-worker-compile`.

## Settings

None yet.

## Import direction

`scripts/desktop-package-boundaries.test.mjs` enforces these edges, in both `package.json` and `src/`:

- `@code-yeongyu/senpi-desktop-protocol` and `@code-yeongyu/senpi-desktop-prelude` import no workspace package.
- `@code-yeongyu/senpi-desktop-engine` may import `-protocol`.
- `@code-yeongyu/senpi-desktop-service` may import `-protocol`, `-engine`, and `-prelude`.
- `@code-yeongyu/senpi-desktop-tool` may import `-protocol`, `-engine`, `-prelude`, and `-service`.
- `@code-yeongyu/senpi` (coding-agent) may import only `-tool` and `-service`. `@code-yeongyu/senpi-codemode` imports none of them.
- No desktop package imports `pi-agent-core`, `pi-ai`, or `pi-tui`. There is no shared utils package: the five desktop packages are the whole set.

The Rust side runs the other way: `senpi-desktop-core` <- `-safety` <- `-session` <- backends <- `senpi-desktop-engine` (the binary). The TS packages reach it only through the engine's stdio JSON-RPC.
