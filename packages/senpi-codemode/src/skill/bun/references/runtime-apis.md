# Bun 1.4.x Runtime Builtins

Every API here ships inside the Bun binary: no install step, no native build, no lockfile entry. Version tags mark the minimum Bun version. Shell, spawn, secrets, files and the measurement helpers live in [session-recipes](session-recipes.md).

## Bun.Image — image processing (replaces sharp) [v1.3.14]

Docs: <https://bun.com/docs/runtime/image> · Blog: [#bun-image](https://bun.com/blog/bun-v1.4#bun-image)

```ts
await Bun.file("photo.jpg")
  .image()
  .resize(1024, 1024, { fit: "inside" })
  .rotate(90)
  .webp({ quality: 85 })
  .write("thumb.webp");

// Stream straight into a Response
return new Response(new Bun.Image(upload).resize(200).jpeg());
```

- Decode/resize/rotate/encode JPEG, PNG, WebP, GIF, BMP everywhere; HEIC, AVIF, TIFF on macOS and Windows.
- API mirrors sharp; 1.19-1.38x faster than sharp; ICC profiles (Display P3) survive transcoding.

## Bun.WebView — headless browser (replaces puppeteer for scraping/screenshots) [v1.3.12, improved v1.4.0]

Docs: <https://bun.com/docs/runtime/webview> · Blog: [#bun-webview](https://bun.com/blog/bun-v1.4#bun-webview)

```ts
await using view = new Bun.WebView({ width: 800, height: 600 });
await view.navigate("https://bun.sh");
await view.click("a[href='/docs']");
const title = await view.evaluate("document.title");
await Bun.write("page.png", await view.screenshot());
```

- macOS: system WebKit, nothing to install. macOS/Linux/Windows: can drive installed Chrome/Chromium/Edge.
- In the eval js kernel, Chrome-backed views (the default off macOS, or `backend: "chrome"`) are served by the process main thread; the API is the same, a constructor error surfaces on the first awaited call, and `Bun.WebView.closeAll()` closes only this kernel's views. A kernel reset closes every view the kernel left open.
- **One JS thread per process.** The WebKit backend is a process-wide client bound to the first thread that creates a view; a second thread (a Worker, a kernel worker) using it corrupts the JSC heap (omo SIGSEGV, 2026-10-29). The first Chrome-backed navigation (CDP target attach) is what blows a cell deadline, not Chrome startup — size test and cell timeouts so the inner one fires first (2026-09-28).
- Prefer `view.screenshot()` over `chrome --headless --screenshot`, which hung as an orphan on macOS (2026-10-19). Backend choice changes `Secure` cookie behaviour on loopback (2026-10-07). 1.4.1 fixed the hang after 64 WebKit views in one process.
- Clicks/scrolls are trusted user input (`event.isTrusted === true`).
- Extends `EventTarget`; screenshots are `Blob`s; `.cdp(method, params?)` escape hatch for raw Chrome DevTools Protocol.

## Bun.markdown — Markdown parser (replaces marked) [v1.3.8, improved v1.4.0]

Docs: <https://bun.com/docs/runtime/markdown> · Blog: [#bun-markdown](https://bun.com/blog/bun-v1.4#bun-markdown)

```ts
const html = Bun.markdown.html("# Hello **world**");   // HTML string
const el = Bun.markdown.react(readme);                  // React elements; swap components per tag
const ansi = Bun.markdown.ansi("# Hi\n\n**bold**");     // terminal-ready ANSI (what `bun ./README.md` prints)
Bun.markdown.render(src, { heading: (children, { level }) => … });   // callback per element for any other target
```

- GFM tables, strikethrough, task lists, autolinks. `.md` is a bundler loader. Linear time on adversarial input (1.4.3 fixed quadratic `render()` on deep nesting).
- **HTML output is NOT sanitized** — raw HTML, event handlers, `javascript:` hrefs pass through. Sanitize before serving user content.

## Bun.cron() — scheduled jobs (replaces node-cron) [v1.3.11, improved v1.4.0]

Docs: <https://bun.com/docs/runtime/cron> · Blog: [#bun-cron](https://bun.com/blog/bun-v1.4#bun-cron)

```ts
// OS-level job: crontab (Linux), launchd (macOS), Task Scheduler (Windows)
await Bun.cron("./worker.ts", "30 2 * * MON", "weekly-report");
// worker.ts exports: export default { async scheduled(controller) { ... } }  // Cloudflare Workers shape

// In-process job on the event loop, no system cron
using job = Bun.cron("*/5 * * * *", async () => { await cleanupTempFiles(); });
job.unref(); job.stop();  // or let `using` dispose

Bun.cron.parse("*/15 * * * *"); // → next matching Date
```

- 5-field syntax incl. named days and `@daily`. Jobs never overlap.
- **v1.4 change:** `parse()` and in-process schedules use LOCAL time (was UTC). Pass `{ tz: "UTC" }` to keep UTC.

## Bun.Terminal — native PTY (replaces node-pty) [v1.3.5, improved v1.4.0]

Docs: <https://bun.com/docs/runtime/child-process#terminal-pty-support> · Blog: [#bun-terminal](https://bun.com/blog/bun-v1.4#bun-terminal)

```ts
const proc = Bun.spawn(["bash"], {
  terminal: {
    cols: 80, rows: 24,
    data(term, data) { process.stdout.write(data); },
  },
});
proc.terminal.write("echo Hello from PTY!\n");
```

- Drive bash/vim/htop with colored output; resize; works on Linux, macOS, Windows. Replaces node-pty and the `script -q /dev/null` wrapper our PTY test harnesses used.
- `write()` returns full input length (whole input buffered); `drain` fires on POSIX.

## bun run --parallel — concurrent scripts (replaces concurrently, npm-run-all) [v1.3.9, improved v1.4.0]

Blog: [#bun-run-parallel](https://bun.com/blog/bun-v1.4#bun-run-parallel)

```bash
bun run --parallel build test                        # named scripts concurrently
bun run --parallel "build:*"                         # glob-matched
bun run --parallel --filter '*' build                # every workspace package
bun run --parallel --no-exit-on-error --filter '*' test   # keep going past failures
```

- Output lines prefixed with script name (`package:script` under `--filter`); pre/post hooks stay ordered; `--sequential` for one-at-a-time with same prefixing.

## bun:ffi — 3x faster, engine-native [v1.4.0]

Docs: <https://bun.com/docs/runtime/ffi> · Blog: [#3x-faster-bun-ffi](https://bun.com/blog/bun-v1.4#3x-faster-bun-ffi)

```ts
import { dlopen } from "bun:ffi";
const { symbols } = dlopen("libhash.so", {
  hash: { args: ["buffer", "buffer_length"], returns: "cstring" },
});
const digest = symbols.hash(data, data); // typeof digest === "string"
```

- FFI is built into JavaScriptCore (TinyCC removed): no-op call 0.70ns (3x), `CString` 3.8x faster. Hot call sites JIT into direct C calls.
- New `buffer_length` arg type passes a TypedArray's length with its pointer.
- **Breaking:** `cstring` returns are plain strings (`NULL` → `null`); `new CString(ptr)` has no `.ptr` anymore — keep the original pointer to free it. See [breaking-changes](breaking-changes.md).

## Data format parsers

Blog: [#also-built-in](https://bun.com/blog/bun-v1.4#also-built-in)

| API | Replaces | Notes |
|---|---|---|
| `Bun.JSON5.parse()/stringify()` | json5 | `.json5` files importable directly |
| `Bun.JSONL.parse()` / streaming `parseChunk()` | ndjson | newline-delimited JSON |
| `Bun.JSONC.parse()` | jsonc-parser | comments + trailing commas (the tsconfig parser); throws `SyntaxError` on invalid input |
| `Bun.XML.parse()/stringify()` | fast-xml-parser, xml2js | SIMD; `.xml` files importable (v1.4: import returns parsed doc, not path) |
| `Bun.TOML.parse()/stringify()` | @iarna/toml | TOML v1.1.0, 708/708 toml-test; v1.4 is strict — unquoted strings throw `SyntaxError` |
| `Bun.YAML.parse()` | js-yaml | YAML 1.2: `yes/no/on/off` are strings, not booleans |
| `Bun.Archive` | tar | create/extract tarballs off the main thread; `extract()`/`files()` reject on a truncated archive [v1.4.4] — docs <https://bun.com/docs/runtime/archive> |
| `new HTMLRewriter().on("a[href]", { element(el) { el.getAttribute("href") } }).transform(html \| response)` | cheerio, jsdom (scraping) | streaming CSS-selector handlers: `element`, `text`, `comments`, `onDocument`; rewrites `Response` bodies in flight — docs <https://bun.com/docs/runtime/html-rewriter> |
| `new Bun.Glob("**/!(*.test).ts").scan({ cwd })` | fast-glob, minimatch | async iterator of matches; `.match(path)`; extglob and `{1..3}` since 1.4.4 |

## Terminal text utilities (replaces string-width, slice-ansi, cli-truncate, wrap-ansi)

Docs: <https://bun.com/docs/runtime/utils>

```ts
Bun.stringWidth("\x1b[32mgreen\x1b[0m e\u0301"); // terminal columns, ANSI + grapheme aware
Bun.sliceAnsi(str, 0, 20);        // slice by columns, preserving ANSI codes
Bun.wrapAnsi(str, 80);            // wrap by columns
```

## Databases and object storage

Docs: <https://bun.com/docs/runtime/sql>, <https://bun.com/docs/runtime/sqlite>, <https://bun.com/docs/runtime/redis>, <https://bun.com/docs/runtime/s3>

```ts
import { SQL } from "bun";
const sql = new SQL({ transform: SQL.camel });                 // first_name <-> firstName both ways [v1.4.4]
const rows = await sql`SELECT * FROM users WHERE id = ANY(${[1, 2, 3]})`;   // JS arrays bind to PG arrays [v1.4.4]
await Bun.file("users.csv").stream().pipeTo(sql`COPY users FROM STDIN (FORMAT csv)`.writable());   // 255 MiB/s, flat RSS [v1.4.4]
const q = sql`SELECT pg_sleep(30)`.execute(); setTimeout(() => q.cancel(), 100);                  // real server-side cancel [v1.4.4]

import { Database } from "bun:sqlite";
const db = new Database(":memory:");
db.function("add2", (a, b) => a + b);  db.aggregate("sum_all", { start: 0, step: (t, v) => t + v });   // UDFs [v1.4.4]
db.onInsert = (db, table, rowid) => {};   // update hooks [v1.4.4]
db.query("SELECT title FROM movies").as(Movie).all();   // rows as class instances; .serialize()/Database.deserialize() for in-memory copies
```

- `Bun.SQL` speaks PostgreSQL, MySQL/MariaDB and SQLite with one API; 1.4.4 cut client CPU per query 21-48%, added `result.columns`/`result.statement`, `sql.json(value)`, `channelBinding`, libpq URL params, TCP keepalive, and `bun --hot` reuses the pool.
- **Session traps:** `sql.unsafe()` and plain `` sql`` `` queries are lazy — `expect(query).rejects` never starts them and the test hangs (2026-10-13); `await` or `.execute()` first. A Postgres behind a TLS-terminating proxy lies in `pg_stat_ssl`; demand TLS on the client (see [security](security.md)). Bun 1.4.0 `node:sqlite` leaked the file handle after `close()` when `prepare()` was called (Windows EBUSY) — fixed in 1.4.4.
- `Bun.RedisClient` (`redis://`, `rediss://` with hostname verification): strings, hashes, sets, pub/sub, pipelining, auto-reconnect; replaces ioredis for the common path.
- `Bun.S3Client` / `Bun.s3` / `fetch("s3://bucket/key")` / `Bun.file("s3://…")`: AWS S3, Cloudflare R2, GCS, MinIO, Spaces; presigned URLs, streaming multipart writes, static `S3Client.list/stat/delete`. **Measured on our R2 mirror:** `writer().end(error)` COMPLETED a truncated multipart upload on 1.4.2 (oven-sh/bun#43134), a failed GET can end as an empty successful stream, and single-object PUT/DELETE returned `InternalError` where a hand-signed request succeeded (2026-10-08, 10-26) — verify size and hash after every S3 write, and abort on a zero-byte read of a non-empty object. Byte-equal copies can still lose HTTP metadata; copy headers explicitly.

## Everything else new in the runtime

- **`Bun.ModuleGraph`** (experimental) [v1.4.3]: run many instances of one app in one process, each with fresh module state, `require.cache`, timers and I/O; `graph.import()`, `graph.run(fn)`, `graph.dispose()` (closes its servers/sockets/children; not a security sandbox). Bytecode is shared between graphs.
- **`crypto.argon2()` / `argon2Sync()`** [v1.4.1]: argon2d/i/id byte-identical to Node; `Bun.password.hash()` for the high-level API.
- **`URLPattern`**: the Web API, 408 WPT passing. Replaces path-to-regexp.
- **`CompressionStream` / `DecompressionStream`**: gzip, deflate, deflate-raw + brotli and zstd; `new CompressionStream("brotli", { level: 4 })` trades ratio for speed (brotli defaults to 11, which is slow on large dynamic bodies) [v1.4.3].
- **`Response.textStream()`**: `ReadableStream<string>` of the body decoded as UTF-8.
- **`process.on("memoryPressure")`**: OS low-memory notification on macOS/Linux/Windows.
- **ML-DSA and ML-KEM**: NIST post-quantum signatures/KEM in `crypto.subtle` and `node:crypto`.
- **`Bun.spawn({ cgroup })`**: place a child in a cgroup before it starts (Linux). Docs: <https://bun.com/docs/runtime/child-process#resource-limits-with-cgroups-linux>
- **`bun repl`** [native]: highlighting, history, tab completion, `-e`/`-p`. Docs: <https://bun.com/docs/runtime/repl>
- **`Temporal`** is defined by default (JSC implementation). `BUN_JSC_useTemporal=0` disables.
