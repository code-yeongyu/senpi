---
name: bun
description: "Read before a js eval cell that spawns a process, server or PTY, installs a package, or starts a long run, and before any bun -e, script, server, CLI, test, typecheck, format, bundle, or package-management work: this session's eval js kernel runs Bun 1.4+. Bun 1.4.x builtins replace 20+ npm deps and dev tools — check here BEFORE installing or running tsc/tsgo, prettier/oxfmt, sharp, puppeteer/playwright (scraping), cheerio, marked, node-cron, node-pty, execa/zx, concurrently, serve-static, tar, json5, fast-xml-parser, string-width, dotenv, keytar, aws-sdk (S3/R2) — and before writing Bun.$ / Bun.spawn / bun test code: the traps that cost past sessions hours are listed here. Triggers: eval js, bun, Bun.$, Bun.spawn, Bun.serve, bun test, bun check, bun fmt, bun build, bun install, image resize, headless browser, markdown, cron, PTY, secrets."
---

# Bun 1.4.x — Use the Builtins First

Bun 1.4.0 (Aug 2026) through 1.4.4 (Oct 2026) ships builtins and CLIs that replace most utility npm packages and several dev tools. **Before adding a dependency, spawning a tool, or writing a workaround, check the map below — if Bun ships it, use the builtin.** Version tags (`[v1.4.3]`) in the references give exact minimums; dated notes `(2026-10-25)` mark facts measured in our own sessions. Release posts: <https://bun.com/blog/bun-v1.4> … <https://bun.com/blog/bun-v1.4.4>.

## Capability map — what you can do now

| You want to... | Use | Replaces | Ref = `references/<name>.md` |
|---|---|---|---|
| Type-check a TS project: tsc-identical errors, 3-6x faster, no `typescript` install | `bun check --no-script`, `bun run/test/build --check` | tsc, tsgo | dev-tooling |
| Format with your Prettier/oxfmt config | `bun fmt --no-script` (`--check`, `--changed`, `--staged`) | prettier, oxfmt, lint-staged | dev-tooling |
| Run shell commands from JS, no `/bin/sh` | `` Bun.$`...` `` → `.nothrow().quiet().text()/.json()/.lines()` | execa, zx, shelljs | session-recipes |
| Spawn with timeout / PTY / IPC; measure a child | `Bun.spawn({ env: process.env, timeout, killSignal, terminal, ipc })`, `proc.resourceUsage()` | node-pty, tree-kill, pidusage | session-recipes |
| Keep tokens out of files, argv and env dumps | `Bun.secrets.get/set` (OS keychain), `--env-file=/dev/stdin` | keytar, dotenv | session-recipes |
| Resize/convert/rotate images | `Bun.file(p).image().resize().webp().write()` | sharp | runtime-apis |
| Headless browser: navigate, click, screenshot, evaluate, CDP | `new Bun.WebView()` | puppeteer, playwright (scraping) | runtime-apis |
| Scrape or rewrite HTML by CSS selector, streaming | `new HTMLRewriter().on("a[href]", { element })` | cheerio, jsdom (scraping) | runtime-apis |
| Markdown → HTML / React / ANSI | `Bun.markdown.html() / .react() / .ansi()` | marked, react-markdown, glow | runtime-apis |
| Schedule cron jobs | `Bun.cron()` | node-cron | runtime-apis |
| Run package scripts concurrently, glob-matched | `bun run --parallel "build:*"` | concurrently, npm-run-all | runtime-apis |
| Parse JSON5 / JSONL / JSONC / XML / TOML / YAML; tarballs; globs | `Bun.JSON5/.JSONL/.JSONC/.XML/.TOML/.YAML`, `Bun.Archive`, `Bun.Glob` | json5, ndjson, jsonc-parser, fast-xml-parser, @iarna/toml, js-yaml, tar, fast-glob | runtime-apis |
| ANSI-aware terminal text; table rendering | `Bun.stringWidth/sliceAnsi/wrapAnsi/stripANSI()`, `Bun.inspect.table()` | string-width, slice-ansi, wrap-ansi, strip-ansi, cli-table | runtime-apis |
| Hash, UUID v7, semver, deep-equal, gzip/zstd, which | `Bun.hash/CryptoHasher/password`, `randomUUIDv7`, `Bun.semver`, `deepEquals`, `gzipSync/zstdCompressSync`, `Bun.which` | uuid, semver, lodash.isequal, pako, which | runtime-apis |
| Postgres / MySQL / SQLite, Redis, S3-compatible (R2) clients | `Bun.SQL`, `bun:sqlite`, `Bun.RedisClient`, `Bun.S3Client` / `s3://` | pg, mysql2, better-sqlite3, ioredis, aws-sdk | runtime-apis |
| Serve a static dir (ETag/Range/304 handled) | `Bun.serve({ routes: { "/x/*": { dir } } })` | express.static, serve-static, sirv | http-networking |
| HTTP/2 + HTTP/3 server; fetch protocol/compress/proxy; per-client pools | `http2: true`, `http3: true`, `fetch(url, { protocol, compress, proxy })`, `new Bun.FetchSession()` | undici Agent | http-networking |
| Stream a download to disk; replay a request as curl | `Bun.write(path, await fetch(url))`, `BUN_CONFIG_VERBOSE_FETCH=curl` | pipeline + createWriteStream | http-networking |
| Tests across CPU workers / CI shards / changed files / flaky retry | `bun test --parallel --shard=1/3 --changed=main --retry` | jest/vitest infra | test |
| Kill "passes alone, fails in suite" bugs; hunt flakes | `bun test --isolate`, `--rerun-each N`, `--only-failures` | vitest default behavior | test |
| Single-file executables with embedded assets and profile-guided startup; feature flags; in-memory bundling; metafile; React Compiler | `bun build --compile --asset ./public --bytecode-order`, `bun:bundle feature()`, `files:{}`, `metafile: true`, `--react-compiler` | pkg hacks, esbuild define/plugins, babel-plugin-react-compiler | build |
| Diff package versions, fix vulns, dedupe/prune, licenses, explain a dep | `bun pm diff`, `bun audit fix`, `bun dedupe`, `bun prune`, `bun pm licenses`, `bun why` | npm-diff, npm audit fix, npm ls | install |
| Offline / cached installs; Docker layers; CI cache; 7x faster CI | `bun install --offline\|--prefer-offline`, `bun pm fetch`, `bun pm cache pack\|unpack`, `linker = "isolated"` | pnpm store | install |
| Profile CPU/heap/bundle as grep-able Markdown | `bun --cpu-prof-md`, `--heap-prof-md`, `bun build --metafile-md` | Chrome DevTools round-trip | dev-tooling |
| Run untrusted JS without eval / `new Function` / FFI | `--disallow-code-generation-from-strings=strict`, `--no-ffi-cc` | vm2 | security |
| Run Playwright, vitest, Next.js 16, OpenTelemetry, dd-trace; `undici`, `node-fetch`, `ws` | they now just work (the last three load Bun's builtin even when installed) | Node.js | node-compat-platforms |

Free wins (no code change): 2x lower CPU, 13-48% less server memory, 2-2.5x faster startup — numbers in [performance](references/performance.md).

## Operating rules — 2 to 6 are what past sessions paid for

1. **Eval-first, builtin-first.** The `eval` js kernel runs on Bun (that is why this skill is present): call `Bun.*` APIs directly inside js cells and reach for `bash` or a spawned `bun` only for CLI surfaces (`bun test`, `bun build`, `bun pm`) or work that needs a separate process. The Replaces column above is a ban list for new dependencies in production code, test helpers and one-off scripts alike.
2. **Anything that must outlive a cell starts outside it.** The kernel SIGKILLs every `Bun.spawn` child when its cell settles, so browsers, daemons, dev servers, remote `ssh` jobs and slow git hooks start through `tool.monitor({ command })` or `tool.bash({ run_in_background: true })`; a stopped long `Bun.$` cell restarts the kernel and loses every global, so helpers live in an importable file.
3. **`Bun.$` runs one command with array-interpolated args; real shell syntax goes to bash.** `${"a b"}` is ONE argument, `$?`/`$VAR` are literal, `for`/`until`/heredocs are parse errors or silent `command not found` with rc 0, and `VAR=x cmd` is not applied to a binary — each of these produced a false-green gate. Use `` $`cmd ${[args]}`.nothrow().quiet() `` for a command and `Bun.spawn(["bash", "-c", script], { env: process.env, stdin: "ignore" })` for a script.
4. **Every `Bun.spawn` passes `env: process.env`, and re-spawns Bun as `process.execPath`.** An env-less child gets the environment the process STARTED with (runtime HOME/TMPDIR edits never arrive), and `"bun"` from PATH has resolved to three different shims on our machines. Give a child that reads stdin `stdin: "ignore"` or an explicit end, or it waits for EOF forever.
5. **`bun test` gets its timeout on the command line and exact paths with `./`.** `--timeout N` is the only budget that reaches every file (a preload's `setDefaultTimeout` covers the first file, bunfig's is ignored); a timeout SIGTERMs every child the test spawned, so a database started in `beforeAll` dies with it; `bun test path.ts` without `./` is a substring filter. The full table is in [test](references/test.md) — read it before writing or debugging a suite.
6. **Measure with the Bun the work targets.** The kernel's `Bun.version`, the shell's `bun --version` and a repo's pinned Bun (CI `bun-version`, `devDependencies.bun`) differ on one machine and 1.4.2 vs 1.4.3 changed test outcomes, so evidence runs use the pin; probe a feature in an empty directory, because `bun check`/`bun fmt`/`bun lint` otherwise run a same-named package.json script. Installs: `CI=1`, visible output, and after `--ignore-scripts` run `node node_modules/bun/install.js` — [install](references/install.md) lists why.
7. **Read the matching reference before using an unfamiliar API** — signatures and caveats (`Bun.markdown` HTML is unsanitized, HTTP/3 is experimental, `writer({ append: true })` truncated a results file) live there, not here; [session-recipes](references/session-recipes.md) holds the rest of the session-learned traps.
8. **Upgrading a project or debugging behavior that changed?** Read [breaking-changes](references/breaking-changes.md) first — 1.4.0 changed YAML/TOML strictness, `.xml`/`.css` imports, `Bun.$` globbing and fetch headers; 1.4.1-1.4.4 changed `Bun.Glob` parsing, WebSocket close timing and `bun install` flag handling.
9. **TLS errors after upgrade are usually intentional** — 1.4.x tightened certificate verification across `fetch`, `tls.connect`, `Bun.connect`, `RedisClient`, `Bun.SQL`. See [security](references/security.md) before loosening anything.
