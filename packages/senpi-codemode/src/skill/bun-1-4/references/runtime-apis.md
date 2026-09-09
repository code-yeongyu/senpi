# Bun 1.4 Runtime Builtins

Every API here ships inside the Bun binary: no install step, no native build, no lockfile entry. Version tags mark the minimum Bun version.

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
- Clicks/scrolls are trusted user input (`event.isTrusted === true`).
- Extends `EventTarget`; screenshots are `Blob`s; `.cdp(method, params?)` escape hatch for raw Chrome DevTools Protocol.

## Bun.markdown — Markdown parser (replaces marked) [v1.3.8, improved v1.4.0]

Docs: <https://bun.com/docs/runtime/markdown> · Blog: [#bun-markdown](https://bun.com/blog/bun-v1.4#bun-markdown)

```ts
const html = Bun.markdown.html("# Hello **world**");   // HTML string
const el = Bun.markdown.react(readme);                  // React elements; swap components per tag
const ansi = Bun.markdown.render("# Hi\n\n**bold**", {  // callback per element (terminal output etc.)
  heading: (children) => `\x1b[1;4m${children}\x1b[0m\n`,
  paragraph: (children) => children + "\n",
  strong: (children) => `\x1b[1m${children}\x1b[22m`,
});
```

- GFM tables, strikethrough, task lists, autolinks. `.md` is a bundler loader. Linear time on adversarial input.
- **HTML output is NOT sanitized** — raw HTML, event handlers, `javascript:` hrefs pass through. Sanitize before serving user content.
- Bonus: `bun ./README.md` renders Markdown to the terminal (replaces glow).

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

- Drive bash/vim/htop with colored output; resize; works on Linux, macOS, Windows.
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
| `Bun.YAML.parse()` | — | YAML 1.2: `yes/no/on/off` are strings, not booleans |
| `Bun.Archive` | tar | create/extract tarballs off the main thread — docs <https://bun.com/docs/runtime/archive> |

## Terminal text utilities (replaces string-width, slice-ansi, cli-truncate, wrap-ansi)

Docs: <https://bun.com/docs/runtime/utils>

```ts
Bun.stringWidth("\x1b[32mgreen\x1b[0m e\u0301"); // terminal columns, ANSI + grapheme aware
Bun.sliceAnsi(str, 0, 20);        // slice by columns, preserving ANSI codes
Bun.wrapAnsi(str, 80);            // wrap by columns
```

## Everything else new in the runtime

- **`URLPattern`**: the Web API, 408 WPT passing. Replaces path-to-regexp.
- **`CompressionStream` / `DecompressionStream`**: gzip, deflate, deflate-raw + brotli and zstd.
- **`Response.textStream()`**: `ReadableStream<string>` of the body decoded as UTF-8.
- **`process.on("memoryPressure")`**: OS low-memory notification on macOS/Linux/Windows.
- **ML-DSA and ML-KEM**: NIST post-quantum signatures/KEM in `crypto.subtle` and `node:crypto`.
- **`Bun.spawn({ cgroup })`**: place a child in a cgroup before it starts (Linux). Docs: <https://bun.com/docs/runtime/child-process#resource-limits-with-cgroups-linux>
- **`bun repl`** [native]: highlighting, history, tab completion, `-e`/`-p`. Docs: <https://bun.com/docs/runtime/repl>
- **`Temporal`** is defined by default (JSC implementation). `BUN_JSC_useTemporal=0` disables.
