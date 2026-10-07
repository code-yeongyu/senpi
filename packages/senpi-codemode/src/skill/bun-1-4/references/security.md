# Bun 1.4 Security Tightening

Blog: [#security](https://bun.com/blog/bun-v1.4#security)

1.4 tightened TLS/parsing defaults. **A connection that worked on 1.3 can now fail with a verification error — that is usually the fix working, not a bug.** Diagnose before loosening.

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

- Registry credentials stay scoped to their configured host: never sent cross-origin, never downgraded to `http://`, never printed in errors/verbose output.
- `tls.createServer({ requestCert: true })` now rejects unverified client certs by default; only a literal `rejectUnauthorized: false` disables verification (`null` no longer counts).
- Full list: [Security hardening](https://bun.com/blog/bun-v1.4#security-hardening) in the changelog; advisories at <https://github.com/oven-sh/bun/security/advisories>.
