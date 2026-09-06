# Upgrading to Bun 1.4 — Behavior Changes

Blog: [#upgrading-to-1-4](https://bun.com/blog/bun-v1.4#upgrading-to-1-4). Most code is unaffected. Scan the Top 5, then the table for whatever subsystem you touched.

## Top 5 most likely to bite

1. **Node.js 26**: `NODE_MODULE_VERSION` is 147 (native addons need a 147 build); `res.writeHeader()` removed → use `res.writeHead()`; paused-mode `readable.read()` returns ONE chunk → loop until `null`.
2. **New monorepos default to the isolated linker** (`configVersion: 1`). Existing lockfiles keep hoisted. Opt out: `linker = "hoisted"` in bunfig.toml.
3. **Bun invoked as `node`** (`bun --bun`, `bunx --bun`, node symlink) no longer loads `.env` files. Pass `--env-file` to keep them.
4. **`Bun.YAML` is YAML 1.2**: `yes`/`no`/`on`/`off` are strings. GitHub Actions `on:` parses as `"on"`.
5. **`Bun.TOML` / `bunfig.toml` are strict**: unquoted strings, missing newlines, ints past `MAX_SAFE_INTEGER` → `SyntaxError` at startup. Quote your values.

## Module resolution / loaders

| Change | Migration |
|---|---|
| `.xml` imports return the parsed document (was: file path) | `--loader .xml:file` to keep the path |
| `.css` imports at runtime export `{}` (was: absolute path) | — |
| `import "."` / `".."` resolve as directories (index/main), matching Node | name the sibling file explicitly |
| `"jsx": "react-jsx"` emits `jsx` (was: `jsxDEV` unless production) | use `"react-jsxdev"` for the dev runtime |
| `useDefineForClassFields: false` now honored like tsc | remove the option to keep old output |

## Bun APIs

| Change | Migration |
|---|---|
| `Bun.$` globs only patterns written in the template — `${...}` interpolated globs are literal | write the pattern in the template: `` $`echo **/*` `` |
| `Bun.cron.parse()` / in-process `Bun.cron()` use LOCAL time (was UTC) | pass `{ tz: "UTC" }` |
| `Bun.Socket#setKeepAlive(true, delay)`: `delay` is milliseconds now | pass ms, not seconds |
| `Bun.mmap({ offset })`: view starts at `offset` exactly (was page-rounded) | remove `offset % pageSize` compensation |
| `bun:ffi`: `cstring` values are plain strings; `CString` has no `.ptr` | keep the original pointer to free |
| `Bun.serve({ inspector })` removed | `bun --inspect` |
| `server.publish()`/`ws.publish()` return `0` (dropped) / `-1` (backpressure) | treat 0/-1 specially |
| `server.stop()` waits for in-flight requests, closes idle connections | `stop(true)` to force |
| `Bun.sql`: MySQL `DATETIME`/`TIMESTAMP` decoded as UTC; MariaDB 10.5+ JSON columns parsed to objects | remove offset corrections and `JSON.parse()` calls |
| `Bun.randomUUIDv7()`, `Bun.udpSocket()`, `Bun.password`, `Bun.spawn` timeout/killSignal/argv0 | invalid inputs now throw instead of silently clamping |

## fetch / WebSocket / HTTP

| Change | Migration |
|---|---|
| Duplicate headers combined with `, ` per Fetch spec (was: last wins) | parse combined values |
| `clone()` throws after body read (`Body is disturbed or locked`) | clone BEFORE reading |
| Network errors are `TypeError` (`.code` still set); failed body read sets `bodyUsed` | retry with a NEW fetch() |
| `redirect: "error"` rejects only on 301/302/303/307/308 (304 resolves now) | — |
| global `WebSocket` no longer accepts `agent` (ws module's does) | import from "ws" |
| `WebSocket#close()` queues the close event — `readyState` is CLOSING when it returns | await the `close` event |
| `close()`/`ping()`/`pong()` validate codes/reason/payload sizes | shorten/fix values |
| Handshake fails (1002) when requested subprotocol isn't negotiated | fix server echo or drop `protocols` |

## node: modules

| Change | Migration |
|---|---|
| `fs.rmdir` rejects `{ recursive: true }` | `fs.rm(path, { recursive: true, force: true })` |
| `dns.lookup()` uses the system resolver (getaddrinfo) on Linux — split-DNS/VPN names now resolve | `Bun.dns.lookup(name, { backend: "c-ares" })` for old behavior |
| fs/dns/pbkdf2 callback exceptions are `uncaughtException` (was unhandledRejection) | move the handler |
| `dgram`: second `bind()` and post-`close()` calls throw synchronously | try/catch |
| `tls.createServer({ requestCert: true })` rejects unverified client certs by default | `rejectUnauthorized: false` to admit them |
| `X509Certificate` serial/modulus are UPPERCASE hex | normalize case when pinning |
| `child_process.spawn()` ignores `options.encoding` (always Buffers) | `child.stdout.setEncoding()` |
| `process.title` defaults to `argv[0]`; warnings print as `(node:PID) [CODE] ...` | — |

## bun test

- `jest.resetAllMocks()` drops implementations (matches Jest) — use `clearAllMocks()` for history-only.
- `toContain()` uses `===` (not `Object.is`); `toEqual()` compares Temporal by value.

## Misc

- x64 builds are baseline-only (no more separate haswell build; `-baseline` URLs still work).
- `Temporal` defined by default (`BUN_JSC_useTemporal=0` to disable).
- `bun.lock` is `lockfileVersion: 2`; nested/version-scoped overrides produce v3 (older Bun can't read v3).
- `bun feedback` removed; `Bun.password.hash()` argon2 requires `memoryCost >= 8`.
- Full exhaustive list: [Other behavior changes](https://bun.com/blog/bun-v1.4#other-behavior-changes) and the [Changelog](https://bun.com/blog/bun-v1.4#changelog).
