# Bun 1.4 HTTP & Networking

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

Static routes and `Bun.file()` bodies handle `Range` (206), `If-None-Match`/`If-Modified-Since` (304), `If-Match`/`If-Unmodified-Since` (412). Video seeking and resumable downloads work out of the box.

## HTTP/3 in Bun.serve() — EXPERIMENTAL [v1.3.14, improved v1.4.0]

Docs: <https://bun.com/docs/runtime/http/server> · Blog: [#http-3-in-bun-serve-experimental](https://bun.com/blog/bun-v1.4#http-3-in-bun-serve-experimental)

```ts
Bun.serve({
  port: 443,
  tls: { /* cert, key */ },
  http3: true,      // also listen on UDP/443
  // h1: false,     // optional: HTTP/3 only
  fetch(req) { return new Response("hi"); },
});
```

- HTTP/1.1 keeps working over TCP; `Alt-Svc` header advertises H3 so browsers upgrade themselves. 2.7x faster than HTTPS/1.1 on static routes.
- **Do not ship `http3: true` to production yet**: 0-RTT resumption disabled, `server.upgrade()` returns `false` over H3, `unix:` sockets skip the H3 listener.

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

## fetch() proxy headers [v1.3.4]

Blog: [#fetch-proxy-headers](https://bun.com/blog/bun-v1.4#fetch-proxy-headers)

```ts
await fetch(url, {
  proxy: {
    url: "http://proxy.example.com:8080",
    headers: { "Proxy-Authorization": "Bearer token" },
  },
});
```

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

## Server lifecycle changes worth knowing (v1.4)

- `server.stop()` now closes idle keep-alive connections immediately, waits for in-flight responses, and resolves when the last connection closes. `server.stop(true)` force-closes stalled ones.
- `server.publish()` / `ws.publish()` return `0` (dropped/no subscribers) or `-1` (backpressure) instead of always the byte count.
- Per-method route objects (`{ GET }`) answer `HEAD` with the GET handler automatically.
