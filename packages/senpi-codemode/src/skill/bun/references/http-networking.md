# Bun 1.4.x HTTP & Networking

## Serve files & folders (replaces express.static, serve-static, sirv) [v1.4.0]

Docs: <https://bun.com/docs/runtime/http/routing> · Blog: [#serve-files-folders](https://bun.com/blog/bun-v1.4#serve-files-folders)

```ts
Bun.serve({
  routes: {
    "/static/*": { dir: "./public" },
  },
});
```

- Files stream with `sendfile`; `Content-Type`, `ETag`, `Last-Modified`, `304`, and `Range` handled automatically; `index.html` served for directories.
- Path traversal is blocked: paths normalized, and on Linux files open with `openat2` + `O_RESOLVE_BENEATH` so symlinks can't escape the directory.

## Range and conditional requests [v1.3.13, improved v1.4.0]

Blog: [#range-and-conditional-requests](https://bun.com/blog/bun-v1.4#range-and-conditional-requests)

```ts
Bun.serve({
  routes: { "/video.mp4": new Response(Bun.file("./video.mp4")) },
});
// curl -H 'Range: bytes=0-1023' → 206 Partial Content
// curl -H 'If-None-Match: "..."' → 304 Not Modified
```

Static routes and `Bun.file()` bodies handle `Range` (206), `If-None-Match`/`If-Modified-Since` (304), `If-Match`/`If-Unmodified-Since` (412), and `If-Range` (206 only if unchanged, else 200 with the full body) [v1.4.3]. Video seeking and resumable downloads work out of the box.

## HTTP/2 [v1.4.1] and HTTP/3 (EXPERIMENTAL) in Bun.serve()

Docs: <https://bun.com/docs/runtime/http/server> · Blog: [1.4.1 #bun-serve-supports-http-2](https://bun.com/blog/bun-v1.4.1), [#http-3-in-bun-serve-experimental](https://bun.com/blog/bun-v1.4#http-3-in-bun-serve-experimental)

```ts
Bun.serve({
  port: 443,
  tls: { /* cert, key */ },
  http2: true,      // same port as HTTP/1.1; ALPN over TLS, h2c preface on cleartext; http1: false to refuse HTTP/1.x
  http3: true,      // also listen on UDP/443
  fetch(req) { return new Response("hi"); },   // same routes/fetch for every protocol
});
```

- HTTP/2: 6.8x the requests/s of `node:http2` on hello-world; WebSockets and response trailers are not yet supported over H2.
- HTTP/3: `Alt-Svc` advertises H3 so browsers upgrade themselves; 2.7x faster than HTTPS/1.1 on static routes. **Do not ship `http3: true` to production yet**: 0-RTT resumption disabled, `server.upgrade()` returns `false` over H3, `unix:` sockets skip the H3 listener.

## HTTP/2 & HTTP/3 in fetch() — EXPERIMENTAL [v1.3.14, improved v1.4.0]

Blog: [#http-2-http-3-in-fetch-experimental](https://bun.com/blog/bun-v1.4#http-2-http-3-in-fetch-experimental)

```ts
const [a, b] = await Promise.all([
  fetch(url1, { protocol: "http2" }),  // concurrent same-origin requests share one connection
  fetch(url2, { protocol: "http2" }),
]);
const res = await fetch(url3, { protocol: "http3" });
```

- Redirects, decompression, streaming behave as over HTTP/1.1.
- Global opt-in: `BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP2_CLIENT=1` or `--experimental-http3-fetch` (Bun remembers per-origin H3 support).

## fetch() request compression [v1.4.0]

Blog: [#fetch-request-compression](https://bun.com/blog/bun-v1.4#fetch-request-compression)

```ts
await fetch(url, {
  method: "POST",
  body: largeJsonString,
  compress: "gzip", // or true, "deflate", "br", "zstd", { encoding, level }
});
```

Buffered bodies (string, ArrayBuffer, TypedArray, Blob) are compressed and `Content-Encoding`/`Content-Length` set automatically; streaming bodies pass through unchanged.

## fetch() proxies [v1.3.4, env support v1.4.3, proxy.tls v1.4.4]

Blog: [#fetch-proxy-headers](https://bun.com/blog/bun-v1.4#fetch-proxy-headers), [1.4.3 #better-proxy-environment-support](https://bun.com/blog/bun-v1.4.3)

```ts
await fetch(url, {
  proxy: {
    url: "https://proxy.example.com:8443",
    headers: { "Proxy-Authorization": "Bearer token" },
    tls: { ca: Bun.file("./proxy-ca.pem") },   // proxy-only TLS options; `tls` stays for the origin [v1.4.4]
  },
});
await fetch(url, { proxy: false });   // ignore HTTP(S)_PROXY / ALL_PROXY for one request
```

- `NO_PROXY` accepts wildcards, CIDR blocks, bare IPv6 and `host:port`; `ALL_PROXY` is used when `HTTP_PROXY`/`HTTPS_PROXY` are unset; each redirect hop picks its proxy by its own URL.
- A proxy that refuses `CONNECT` rejects with `ERR_PROXY_TUNNEL` carrying the proxy's `status` and `headers` (before 1.4.3 the proxy's reply resolved as if from the origin).

## Bun.FetchSession — per-client TLS, proxy and connection pool [v1.4.3]

```ts
using session = new Bun.FetchSession({
  tls: { ca: await Bun.file("corp-ca.pem").text() },
  proxy: { url: "http://proxy.internal:8080" },
  keepAlive: { idleTimeout: 30, maxIdleSockets: 8 },
});
const client = new SomeSdk({ fetch: session.fetch });   // bound; drop-in for any `fetch`-accepting client
await fetch("https://example.com", { session });        // same thing
```

Sessions never share connections with each other or with plain `fetch()`; per-request options override the session's; `tls.checkServerIdentity` runs once per connection. Replaces undici `Agent` / `dispatcher` plumbing.

## Bun.write(path, response) streams to disk [v1.4.1]

```ts
await Bun.write("./big.tar.gz", await fetch(url));   // => bytes written; 128 MiB download adds 13 MB RSS (was 161 MB)
await Bun.write("./out.txt", readableStream);          // was "[object ReadableStream]"
```

`fetch()` and S3 downloads pause when 256 KiB of body is unread; a `Response` discarded unread closes its connection. `fetch()` over `{ unix }` sockets now reuses connections, and `localhost` / `*.localhost` resolve to loopback without the system resolver (works in IPv4-only containers) [v1.4.1]. `BUN_CONFIG_VERBOSE_FETCH=curl` prints each request as a `curl` line (see [session-recipes](session-recipes.md)).

## TLS session resumption + connection reuse [v1.3.10-v1.4.0]

Blog: [#tls-session-resumption](https://bun.com/blog/bun-v1.4#tls-session-resumption), [#connection-reuse](https://bun.com/blog/bun-v1.4#connection-reuse)

- Second cold connection to an origin resumes at 1 RTT (32-entry per-origin LRU of BoringSSL client sessions).
- `fetch()` reuses connections through HTTPS proxies and for requests with custom TLS options (client cert, custom CA). No code change needed.

## HTML routes: sourcemaps off in production [v1.4.0]

Blog: [#html-routes-sourcemaps-disabled-in-production](https://bun.com/blog/bun-v1.4#html-routes-sourcemaps-disabled-in-production)

Production `Bun.serve` no longer serves sourcemaps for HTML routes (dev mode still does). Override in `bunfig.toml`:

```toml
[serve.static]
sourcemap = "linked"
```

## WebSocket: backpressure and close semantics [v1.4.1, v1.4.4]

```ts
socket.pause(); socket.isPaused; socket.resume();   // client WebSocket [v1.4.1] and Bun.serve `ws` [v1.4.4]: stop reading, peer sees TCP backpressure
socket.bufferedAmount;                               // bytes still queued to send (was always 0)
```

- The client `close` event now fires after the closing handshake with the server's code (`1005` when its Close frame had none, `1006` after 30 s / `BUN_CONFIG_WS_CLOSE_TIMEOUT`); a script ending with `ws.close()` takes one extra round trip to exit; `ws.terminate()` closes at once [v1.4.4].
- A failed connection fires `error` (`event.error.code`: `ECONNREFUSED`, `ERR_TLS_CERT_ALTNAME_INVALID`, `WS_ERR_INVALID_UTF8` …) then `close` with `1006` [v1.4.4].
- `import "ws"` is a port of ws 8.22.0 on Bun's native sockets [v1.4.4]: `createWebSocketStream`, `agent`/SOCKS, `handshakeTimeout`, `maxPayload` all work; an `'error'` event without a listener is an uncaught exception, as in Node — add one to every socket. `ws` servers have no idle timeout or ping by default (Bun.serve's 120 s / 104 s no longer apply).
- `Bun.serve` `websocket.error(error, ws)` now receives the socket; every handler including `message` is optional [v1.4.4].

## Server lifecycle worth knowing

- `idleTimeout` defaults to **10 s** of no bytes in either direction — a handler that computes for 11 s before writing gets its connection reset. Raise it (max 255, `0` disables) or per request: `server.timeout(req, 60)`.
- `server.reload({ fetch, routes, websocket, error })` swaps handlers without restarting; `server.requestIP(req)`; `server.pendingRequests` / `pendingWebSockets` / `subscriberCount(topic)` for health checks.
- `server.stop()` closes idle keep-alive connections immediately, waits for in-flight responses, and resolves when the last connection closes; `server.stop(true)` force-closes (WebSockets get `1001 "Server closed"` [v1.4.4]).
- `server.publish()` / `ws.publish()` return `0` (dropped/no subscribers) or `-1` (backpressure) instead of always the byte count.
- Per-method route objects (`{ GET }`) answer `HEAD` with the GET handler automatically.
- `Bun.serve({ unix: "/tmp/app.sock" })` and `fetch(url, { unix })` for local IPC; `reusePort: true` runs a cluster of processes on one port.
- **Test servers bind `hostname: "127.0.0.1"`.** `Bun.serve({ port: 0 })` binds the wildcard address, so another process's loopback listener on the same port wins and requests cross-talk (1 in ~20 on a busy host, 2026-10-08). A 10 s `idleTimeout` also cut an SSE proxy's upstream streams mid-response (2026-10-02).
