# Upgrading to Bun 1.4.x — Behavior Changes

Blog: [#upgrading-to-1-4](https://bun.com/blog/bun-v1.4#upgrading-to-1-4), then the 1.4.1-1.4.4 posts. Most code is unaffected. Scan the Top 5, then the 1.4.1-1.4.4 table, then the 1.4.0 tables for whatever subsystem you touched.

## 1.4.1 → 1.4.4 — changes that bit our repos

| Change | Version | Migration |
|---|---|---|
| `Bun.Glob`: `?( )`, `*( )`, `+( )`, `@( )`, `!( )` and `{1..3}` are extglob/ranges (were literal); applies to `--filter`, `workspaces`, `files`, `sideEffects` | 1.4.4 | a pattern with `*(1).txt` now means "zero or more 1"; escape as `*[(]1).txt`. An 11-group `{a,b}` allowlist that 1.4.3 refused matched on 1.4.4 — re-test auth boundaries after a Bun bump (2026-10-25) |
| `bun check` / `bun fmt` run a same-named package.json script first | 1.4.3 / 1.4.4 | `--no-script` for the builtin; probe features in an empty directory, since `bun lint --help` exits 0 via a script on a Bun with no linter (2026-10-22) |
| `bun install` rejects unknown flags (was: silently ran) | 1.4.4 | fix the typo; npm/Yarn/pnpm spellings are translated |
| Linux installs skip the other libc's native builds; `file:` folders are hardlinked (were per-file symlinks) | 1.4.4 | tools that filter optional deps by os/cpu must also filter `libc` (desktop stage-lock broke); "no links" checks see hardlinks |
| WebSocket client `close` waits for the closing handshake: `1005` not `1000` without a code, `1006` after 30 s; failed connects fire `error` then `close(1006)` | 1.4.4 | await the `close` event; `BUN_CONFIG_WS_CLOSE_TIMEOUT`; `ws.terminate()` to skip |
| `ws` is a port of ws 8.22: an `'error'` without a listener is an uncaught exception; `close` reason is a `Buffer`; no default idle timeout/ping on `ws` servers; `maxPayload` 100 MiB | 1.4.4 | add `'error'` listeners everywhere |
| Servers request a client certificate only with `requestCert: true` (`ca` alone no longer does) | 1.4.4 | set both for mTLS |
| `Bun.hash()`/`CryptoHasher`/`crypto.hash()` of a `Bun.file`/S3 file throw `TypeError` (was: hash of empty input) | 1.4.4 | read the bytes first |
| `Bun.SQL` ignores `PASSWORD`; `affectedRows` is a number on PG/SQLite (was `null`); `sql.array([...])` no longer casts to `JSON[]` | 1.4.4 | `PGPASSWORD` / URL / option |
| `fetch()` TLS name comes from the URL, not a custom `Host` header | 1.4.1 | `tls.servername` for IP + name |
| `fs.rmdir(p, { recursive: true })` works again (1.4.0 threw) | 1.4.1 | — |
| `--disallow-code-generation-from-strings=strict` also blocks plugins returning source, macros, and on-disk `.ts/.js` inside compiled binaries | 1.4.4 | return exports objects from plugins |
| Coverage counts skipped branches/`await` continuations/implicit constructors as uncovered | 1.4.4 | `% Lines`/`% Funcs` drop; re-check thresholds |
| PID 1 in a container exits `128 + signal` on Ctrl+C / `docker stop` | 1.4.4 | match on the new code |
| `bun add -E react@18` writes the installed exact version (was `18`) | 1.4.4 | — |
| `bun.lock` gains `hasInstallScript` / `libc`; older Bun drops them on save | 1.4.4 | pin one Bun per repo (CI `bun-version`) |
| Windows: `expect(p).rejects` after a socket close segfaulted the runner in 1.4.3 (upstream fix reverted) | fixed 1.4.4 | stay on 1.4.4+ on Windows CI |
| Still open on 1.4.4: `fs.rm` ignores `maxRetries`/`retryDelay` (bun#41480); `expect(p).rejects` after a Worker reply deadlocks (bun#37189) | — | explicit retry helper; capture rejections with `.then()` |

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
- Full exhaustive lists: [1.4.0 Other behavior changes](https://bun.com/blog/bun-v1.4#other-behavior-changes) and the Bugfixes sections of the [1.4.1](https://bun.com/blog/bun-v1.4.1), [1.4.3](https://bun.com/blog/bun-v1.4.3) and [1.4.4](https://bun.com/blog/bun-v1.4.4) posts.
