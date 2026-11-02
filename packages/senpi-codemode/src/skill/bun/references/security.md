# Bun 1.4.x Security Tightening

Blog: [#security](https://bun.com/blog/bun-v1.4#security), [1.4.3 #security](https://bun.com/blog/bun-v1.4.3), [1.4.4 #security](https://bun.com/blog/bun-v1.4.4)

1.4.x tightened TLS/parsing defaults release by release. **A connection that worked before can now fail with a verification error — that is usually the fix working, not a bug.** Diagnose before loosening.

## Running code you do not fully trust

```bash
bun --disallow-code-generation-from-strings=strict --no-ffi-cc ./script.ts   # [v1.4.1, strict tightened v1.4.4]
bun --config=/path/to/empty.toml --tsconfig-override=/path/to/empty.json ./trusted-gate.ts   # trusted script, untrusted cwd
```

- `=strict` refuses to run any code that is not a Bun builtin or one of the program's own files: `eval`, `new Function`, `node:vm`, `data:` imports, `Worker(code, { eval })`, `module._compile`, plugins that return source text, macros; in a `--compile` binary even `.ts/.js` files on disk, including ones the program just wrote. Workers inherit it; `BUN_OPTIONS` can raise but not lower it. Node's plain flag (no `=strict`) blocks only `eval`/`new Function`.
- `--no-ffi-cc` (also implied by `--no-addons`) makes `cc()` from `bun:ffi` throw `ERR_FFI_CC_DISABLED` — no runtime C compilation from untrusted JS [v1.4.1].
- **An untrusted checkout as cwd hijacks a trusted script**: its `bunfig.toml` `preload` runs first and its `tsconfig.json` `paths` rewrite even the script's relative imports (measured 1.4.4, 2026-10-26). Point `--config` and `--tsconfig-override` at empty files outside the checkout.
- `globalThis.Bun`, `Bun.fetch` and `Bun.plugin` are non-writable; `Bun.fetch(file:URL).blob()` reads a file without going through a replaced `Bun.file` or global `fetch`, so an in-process read guard is not a sandbox — enforce at the OS boundary (2026-10-27). `Bun.Glob` can silently return no-match under folded-wildcard backtracking; a deny matcher built on it must prove fail-closed behaviour (2026-10-20).

## TLS verification got stricter in every 1.4.x [v1.4.1, v1.4.3, v1.4.4]

- `fetch()` verifies the certificate against the **URL host**, not a custom `Host` header (a proxy passing user-controlled `Host` was an insecure default); set `tls.servername` to verify an IP connection against another name [v1.4.1].
- `fetch`, `WebSocket`, `Bun.connect`, `RedisClient` and `Bun.SQL` verify during the handshake, not after; name matching accepts only valid host names and canonical IPs (CVE-2026-48618) [v1.4.3].
- Servers (`Bun.serve`, `Bun.listen`, `node:tls`) request a client certificate only with `requestCert: true`; setting `ca` alone no longer does — for mTLS set both [v1.4.4].
- `Bun.SQL` treats `tls: Bun.file("ca.pem")` as `verify-full`; a `tls.checkServerIdentity` upgrades any weaker `sslmode` to `verify-full` [v1.4.3/1.4.4]. A managed Postgres behind a TLS-terminating proxy reports SSL on the server while the client link is plain — demand TLS on the client with an explicit `tls` option (2026-10-03). `Bun.SQL` no longer reads `PASSWORD`; use `PGPASSWORD`/`MYSQL_PASSWORD` or the URL [v1.4.4].
- `--use-system-ca` / `NODE_USE_SYSTEM_CA=1` imports the OS store into BoringSSL for fetch/WebSocket (also compiled binaries via `--compile-exec-argv` or the env at spawn), but it widens trust unsafely on all three OSes (Windows ignores Disallowed, macOS falls back to BasicX509, Linux sweeps deselected CAs); prefer an explicit `ca` or `NODE_EXTRA_CA_CERTS`, which must be set before the process starts (measured 1.4.4, 2026-10-26).

## checkServerIdentity runs BEFORE fetch() sends [v1.4.0]

```ts
await fetch("https://api.example.com/upload", {
  method: "POST",
  body: secretPayload,
  tls: {
    checkServerIdentity(hostname, cert) {
      if (cert.fingerprint256 !== PINNED) return new Error("pin mismatch");
    },
  },
});
// nothing is sent until the callback returns undefined; re-runs on each redirect hop
```

If you pin a cert and the URL redirects through another host, the callback sees that cert too — accept every hop or use `redirect: "manual"`.

## tls.connect defaults servername to host [v1.3.13]

`tls.connect({ host, port })` without `servername` uses `host` for SNI + identity check (matches Node). Connecting by IP or `localhost` to a cert issued for another name now fails with `ERR_TLS_CERT_ALTNAME_INVALID` — including through drivers like `pg`/`ioredis`. Fix: pass the cert's name as `servername`, or `checkServerIdentity: () => undefined` if trusting by CA alone.

```ts
tls.connect({ host: "10.0.0.12", port: 5432, ca, servername: "db.internal" });
```

## Bun.connect / Bun.listen enforce rejectUnauthorized [v1.4.0]

`Bun.connect({ tls })`, `socket.upgradeTLS()`, and `Bun.listen()` with `requestCert: true` default to `rejectUnauthorized: true`. A self-signed dev server with no `ca` does NOT throw — the `handshake` handler runs with `socket.authorized === false`, writes return `-1`, and the socket closes without data. Pass the CA in `tls`, or `rejectUnauthorized: false` (`NODE_TLS_REJECT_UNAUTHORIZED=0` honored).

## RedisClient verifies TLS hostname [v1.3.14]

`rediss://` checks the server cert against the URL host; first command rejects with `ERR_TLS_CERT_ALTNAME_INVALID` on mismatch. Connect by the certificate's name, or pass `tls: { rejectUnauthorized: false }`.

## HTTP request parsing hardening in Bun.serve [v1.3.4]

More malformed `Content-Length` / `Transfer-Encoding` / chunked bodies get `400` + connection close, without calling your `fetch` handler or logging. Browsers/curl/proxies never send these; if a hand-written client starts seeing 400s, fix its framing headers.

## Tarball extraction hardening [v1.3.6]

`github:`/URL dependencies and `bun create` templates skip tar entries that would land outside the package directory. A post-upgrade `Cannot find module` for such a package usually means the repo has a symlink pointing outside the package — replace it with a real file or relative link.

## Also

- Registry credentials stay scoped to their configured host: never sent cross-origin, never downgraded to `http://`, never printed in errors/verbose output; `bun install` parses registry/tarball URLs strictly before attaching credentials [v1.4.3].
- `tls.createServer({ requestCert: true })` now rejects unverified client certs by default; only a literal `rejectUnauthorized: false` disables verification (`null` no longer counts).
- `fetch()` rejects a `Content-Length` that disagrees with a streamed body, chunked bodies with bare-LF line endings, and `file://host/path` with a non-local host [v1.4.3].
- Secrets in a session: a child spawned without `env` inherits the STARTUP environment including every secret set at startup — pass an explicit minimal `env` to any child that must not see one; `delete process.env.X` does not reach such children (2026-10-20/22). Low file descriptors are not free under Bun: hand a secret to a child over stdin or a documented high fd (2026-10-19). `Bun.secrets` keeps tokens in the OS keychain (see [session-recipes](session-recipes.md)).
- Full list: [Security hardening](https://bun.com/blog/bun-v1.4#security-hardening) in the changelog; advisories at <https://github.com/oven-sh/bun/security/advisories>.
