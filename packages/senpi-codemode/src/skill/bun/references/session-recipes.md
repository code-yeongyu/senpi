# Session recipes — Bun.$, Bun.spawn, secrets, debugging

Every trap here was paid for by a past agent session (dates are the memory notes). Read the trap, apply the one-line fix.

## Bun.$ — a bash-like shell parsed by Bun, not `/bin/sh`

Docs: <https://bun.com/docs/runtime/shell>

```ts
const { stdout, exitCode } = await $`git status --porcelain`.nothrow().quiet(); // never throws, no echo
const text = await $`ls`.text();   const pr = await $`gh pr view 1 --json state`.json();
for await (const line of $`cat big.log`.lines()) {}
await $`bun run build`.cwd("/repo").env({ ...process.env, CI: "1" });
```

| Trap | What happens | Fix |
|---|---|---|
| `${"a b c"}` | ONE argv entry — vitest reported "No test files found" with rc 0 and the gate looked green (2026-09-21) | pass an array: `${["a", "b", "c"]}` spreads into separate args |
| `$?`, `$VAR`, `for … done`, `$(…)` | `$` is escaped to a literal; unsupported syntax is a PARSE error (nothing runs) or a silent `command not found` with rc 0 (2026-10-10, 10-22) | run real bash: `Bun.spawn(["bash", "-c", script])` or `` $`bash -c ${script}` `` |
| `VAR=x cmd` prefix | not applied to a directly executed binary — `` $`HOME=/x printenv HOME` `` prints the real HOME; only `sh -c` sees it (2026-10-25) | `.env({ ... })`, or `Bun.spawn(cmd, { env })` |
| `ssh host <<'EOF' … EOF` | the heredoc body ran on the LOCAL host (2026-10-23) | `Bun.spawn(["ssh", host, "bash -s"], { stdin: new Blob([script]) })`, or scp a script file |
| Globs in `${...}` | literal since 1.4.0; only patterns written in the template expand | write the pattern in the template |
| NUL byte in an env value | value truncated; `.env()`/`.cwd()` throw `ERR_INVALID_ARG_VALUE` [v1.4.4] | strip NULs |

Builtins (`cd ls rm echo pwd cat touch mkdir which mv seq dirname basename`) run in-process, so `cd` persists across `;` within one template. `$.escape(str)` shell-quotes a string; `$.braces("a{b,c}")` expands braces; `bun run ./script.sh` runs a `.sh` file through this shell on every OS.

## Bun.spawn — the child gets the STARTUP env, not `process.env`

`Bun.spawn`/`spawnSync` without `env` give the child the environment the process started with (documented in bun-types; measured on 1.4.3 and 1.4.4). A `process.env.X = …` set at runtime — hermetic HOME/TMPDIR from a test preload — never reaches an env-less child; `node:child_process` differs (omo#11259, 2026-10-25). Always pass `env: process.env` or an explicit object.

```ts
const proc = Bun.spawn(["bash", "-c", script], {
  env: process.env, cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore",
  timeout: 60_000, killSignal: "SIGKILL",   // the child dies, not the eval cell
  onExit(p, code, signal) {},
});
const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
const code = await proc.exited;
proc.resourceUsage(); // { maxRSS, cpuTime: { user, system } } — measure, do not guess
```

- `stdin: "ignore"` (or write then `.end()` the `FileSink`) for any child that may read stdin: a `bun -e` program reading stdin, or `promisify(execFile)` with `input` (Bun ignores it), waits for EOF forever; under ssh it orphans and blocks later jobs (2026-08-31, 2026-10-30).
- Re-spawning Bun: use `process.execPath`, never `"bun"` from PATH — a mise shim refused a temp HOME, a stray 1.4.0 shim in `~/.bun/install/global/node_modules/.bin` hung rpc tests, and after a reboot PATH resolved `bun` to a vite-plus shim with shim recursion; the `bun test vX.Y.Z` header line is the tell (2026-09-28, 10-26, 10-29). Inside a compiled binary `bun` can be the binary itself — see [build](build.md).
- `proc.signalCode` is set when a signal is SENT, not when the child exits: a child ignoring SIGTERM keeps running while `signalCode === "SIGTERM"`; await `proc.exited` with a deadline, then `proc.kill("SIGKILL")` (2026-10-02).
- **The js eval kernel SIGKILLs every `Bun.spawn` child when its cell settles** — four Chromium launches in a row died 0.05-9 s after the launching cell completed, and a child parked in `globalThis` does not survive (2026-09-16/10-17). Anything that must outlive a cell (browser, daemon, dev server, `ssh` running a remote job, a `git commit` with slow hooks) starts through `tool.monitor({ command })` or `tool.bash({ run_in_background: true })`; keep only its id/pid in `globalThis`. Conversely `bun --no-orphans script.ts` makes a script exit when its parent dies and SIGKILL every descendant on exit. A stopped long `Bun.$` cell restarts the whole kernel and loses every global; keep helpers in an importable file and restore with `Object.assign(globalThis, await import(path))` (2026-10-02).
- PTY: `Bun.spawn(["bash"], { terminal: { cols, rows, data(term, chunk) {} } })` then `proc.terminal.write()/resize()` — replaces node-pty and the macOS `script -q /dev/null` trick.
- `Bun.spawnSync` blocks the kernel thread and cannot be interrupted: never in an eval cell. `maxBuffer` kills a chatty sync child.
- `signal: AbortSignal.timeout(ms)` works for `fetch` and `spawn` alike (`killSignal` picks the signal).

## Secrets and env

- `Bun.secrets.get({ service, name })` / `.set({ service, name, value })` / `.delete()` — macOS Keychain, Linux libsecret, Windows Credential Manager (`persist: "local"` keeps it on one machine [v1.4.3]). A token read this way never sits in a file, argv, or an env dump; `null` when missing. Docs: <https://bun.com/docs/runtime/secrets>
- `bun --env-file=<(op read …) app.ts` or `echo A=1 | bun --env-file=/dev/stdin app.ts` [v1.4.1]: env from a pipe/FIFO, no `.env` on disk. `--no-env-file` (or `env = false` in bunfig) skips automatic `.env` loading in CI/prod; `bun --bun` and a `node` symlink never auto-load `.env`.
- `BUN_OPTIONS="--preload ./shim.ts"` injects flags into every `bun` invocation, including `bun -e`, `bun test` and `--compile` binaries (it can raise but not lower `--disallow-code-generation-from-strings`).
- Corporate CAs: `NODE_EXTRA_CA_CERTS=/path/ca.pem` reaches every fetch/WS/Worker/node:https path when set before the process starts (assigning it from JS does nothing); `--use-system-ca` also works in compiled binaries but widens trust — [security](security.md) has the measured gaps (2026-10-26).

## Debugging and measuring inside a session

- `BUN_CONFIG_VERBOSE_FETCH=curl` prints every `fetch()`/`node:http` request as a copy-pasteable `curl` line plus request/response headers; `fetch(url, { verbose: true })` for one call.
- `process.memoryUsage().rss` on macOS matches Activity Monitor and `process.resourceUsage().maxRSS` its peak [v1.4.3]; `Bun.gc(true)` returns freed memory to the OS before returning, so RSS drops immediately [v1.4.3]; `estimateShallowMemoryUsageOf(obj)` from `bun:jsc` per object; `Bun.generateHeapSnapshot()` for DevTools; `bun --smol` / `new Worker(f, { smol: true })` on memory-constrained hosts.
- `Bun.nanoseconds()` monotonic since process start; `Bun.sleep(ms)`; `Bun.peek(promise)` reads an already-settled promise without a microtick.
- One-liners: `bun -p 'Bun.version'` prints an expression, `bun -e` runs code, `bun exec 'cmd | wc -l'` runs a Bun-shell string, `bun ./README.md` renders Markdown in the terminal.
- Kernel vs shell Bun: senpi bundles its own Bun, so the kernel's `Bun.version` can lag the shell's `bun --version` on one machine (1.4.3 vs 1.4.4 on 2026-10-31) — a newer-only feature such as `Bun.Glob` extglob returned false in the kernel and worked in a spawned `bun`. Check the version of the Bun that will run the code.

## Files, globs, streams

- `Bun.file(p).exists()`, `.size`, `.type`, `.text()/.json()/.bytes()/.stream()`, `file.delete()`; `Bun.write(path, data | Response | ReadableStream | Bun.file(other))` streams to disk (a 128 MiB download adds 13 MB of RSS, not 161 MB [v1.4.1]) and doubles as `cp`.
- **Two writes that destroyed data:** `Bun.file(p).writer({ append: true })` truncated an NDJSON results file at open and overwrote 927 rows (2026-10-20) — append incremental results with `node:fs` `appendFileSync` per batch, or write per-batch part files; `Bun.write(p, prefix + await Bun.file(p).text())` left a 0-byte file because the lazy handle was truncated before it was read (2026-10-30) — read into a variable, then write. Check `wc -c` after any rewrite of a file you will hand to someone else.
- `new Bun.Glob("**/*.ts").scan({ cwd, dot, onlyFiles })` async-iterates matches; `.match(path)`; `!(…)`, `@(…)`, `{1..3}` from 1.4.4 (a pattern containing `(` changed meaning — see breaking-changes).
- `Bun.readableStreamToText/JSON/Array/Blob(stream)`; `for await (const line of console)` reads stdin line by line; `Bun.stdin.stream()`.
- `Bun.resolveSync("pkg", import.meta.dir)`, `import.meta.dir/file/path/main`, `Bun.main` (entrypoint path), `Bun.which("gh")`.
