---
name: bun-1-4
description: "MUST READ before your first js eval cell: this session's eval js kernel runs Bun 1.4+ (this skill is present only when it does). Also read before any bun -e, script, server, CLI, test, bundle, or package-management work. Bun 1.4 ships builtins that replace 15+ npm deps — check here BEFORE installing sharp, puppeteer/playwright (scraping), marked, node-cron, node-pty, concurrently, serve-static, tar, json5, fast-xml-parser, string-width. Triggers: eval js, bun, Bun.serve, bun test, bun build, bun install, bun run, image resize, headless browser, markdown render, cron, PTY."
---

# Bun 1.4 — Use the Builtins First

Bun 1.4 (2026) ships builtins that replace most utility npm packages. **Before adding a dependency or writing a workaround, check the capability map below — if Bun ships it, use the builtin.** This skill is loaded because this session's `eval` js kernel runs Bun >= 1.4; on other machines or pinned projects, confirm with `bun --version` ([v1.3.x]/[v1.4.0] tags in the references give exact minimums). Release post: <https://bun.com/blog/bun-v1.4>

## Capability map — what you can do now

| You want to... | Use | Replaces | Ref = `references/<name>.md` |
|---|---|---|---|
| Resize/convert/rotate images | `Bun.file(p).image().resize().webp().write()` | sharp | runtime-apis |
| Headless browser: navigate, click, screenshot, evaluate, CDP | `new Bun.WebView()` | puppeteer, playwright (scraping) | runtime-apis |
| Markdown → HTML / React / ANSI | `Bun.markdown.html() / .react() / .render()` | marked, react-markdown | runtime-apis |
| Schedule cron jobs | `Bun.cron()` | node-cron | runtime-apis |
| Drive a PTY (bash, vim, TUIs) from JS | `Bun.spawn([...], { terminal })` | node-pty | runtime-apis |
| Run package scripts concurrently, glob-matched | `bun run --parallel "build:*"` | concurrently, npm-run-all | runtime-apis |
| Parse JSON5 / JSONL / JSONC / XML / TOML; tarballs | `Bun.JSON5/.JSONL/.JSONC/.XML/.TOML`, `Bun.Archive` | json5, ndjson, jsonc-parser, fast-xml-parser, @iarna/toml, tar | runtime-apis |
| ANSI-aware terminal text: width, slice, wrap | `Bun.stringWidth()`, `Bun.sliceAnsi()`, `Bun.wrapAnsi()` | string-width, slice-ansi, wrap-ansi | runtime-apis |
| Call C libraries 3x faster, plain strings back | `bun:ffi` (`buffer_length`, `cstring`) | — | runtime-apis |
| Serve a static dir (ETag/Range/304 handled) | `Bun.serve({ routes: { "/x/*": { dir } } })` | express.static, serve-static, sirv | http-networking |
| HTTP/3 server; `fetch` protocol/compress/proxy | `http3: true`, `fetch(url, { protocol, compress, proxy })` | — | http-networking |
| Tests across CPU workers / CI shards / changed files / flaky retry | `bun test --parallel --shard=1/3 --changed=main --retry` | jest/vitest infra | test |
| Kill "passes alone, fails in suite" bugs | `bun test --isolate` | vitest default behavior | test |
| React Compiler auto-memoization | `bun build --react-compiler` | babel-plugin-react-compiler | build |
| Embed assets/dirs into a single-file executable | `bun build --compile --asset ./public` | pkg hacks | build |
| Compile-time feature flags, in-memory bundling, metafile | `bun:bundle feature()`, `files:{}`, `metafile: true` | esbuild define/plugins | build |
| Diff package versions, fix vulns, dedupe/prune, license audit | `bun pm diff`, `bun audit fix`, `bun dedupe`, `bun prune`, `bun pm licenses` | npm-diff, npm audit fix | install |
| 7x faster CI installs (global virtual store) | `linker = "isolated"` in bunfig.toml | pnpm store | install |
| Profile CPU/heap/bundle as grep-able Markdown | `bun --cpu-prof-md`, `--heap-prof-md`, `bun build --metafile-md` | Chrome DevTools round-trip | dev-tooling |
| Native REPL; render Markdown in terminal | `bun repl`, `bun ./README.md` | node repl, glow | runtime-apis |
| Run Playwright, vitest, Next.js 16, OpenTelemetry, dd-trace | they now just work | Node.js | node-compat-platforms |

Free wins (no code change): 2x lower CPU, 13-48% less server memory, 2-2.5x faster startup — full numbers in [performance](references/performance.md).

## Operating rules

1. **Eval-first.** The `eval` js kernel runs on Bun (that is why this skill is present): call `Bun.*` APIs directly inside js cells. Reach for `bash` or a spawned `bun <file>` / `bun -e` only for CLI surfaces (`bun test`, `bun build`, `bun pm`) or work that needs a separate process.
2. **Builtin-first.** The Replaces column above is a ban list for new dependencies, in production code, test helpers, and one-off scripts alike.
3. **Read the matching reference before using an unfamiliar API** — signatures and caveats (e.g. `Bun.markdown` HTML is unsanitized, HTTP/3 is experimental) live there, not here.
4. **Upgrading a project to 1.4 or debugging behavior that changed?** Read [breaking-changes](references/breaking-changes.md) first — YAML/TOML strictness, `.xml`/`.css` import semantics, `Bun.$` globbing, fetch header combining, and WebSocket close timing all changed.
5. **TLS errors after upgrade are usually intentional** — 1.4 tightened certificate verification across `fetch`, `tls.connect`, `Bun.connect`, `RedisClient`. See [security](references/security.md) before loosening anything.
