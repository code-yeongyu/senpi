# Bun 1.4.x Dev Tooling & Observability

Blog: [#dev-tooling](https://bun.com/blog/bun-v1.4#dev-tooling), [#observability](https://bun.com/blog/bun-v1.4#observability), [1.4.3 bun check](https://bun.com/blog/bun-v1.4.3), [1.4.4 bun fmt](https://bun.com/blog/bun-v1.4.4)

## bun check — TypeScript type checker (replaces tsc / tsgo) [v1.4.3, 1.4-7.8x faster in v1.4.4]

Docs: <https://bun.com/docs/runtime/check>

```bash
bun check --no-script                 # whole project from the nearest tsconfig.json; every core; no `typescript` install needed
bun check --no-script src/index.ts    # one file and everything it imports
bun check --no-script -b              # follow project references, like tsc -b (shares caches across projects)
bun check --no-script --no-pretty     # one line per error, tsc --pretty false shape (default when piped)
bun run --check src/index.ts          # type-check, then run (also package.json scripts and --watch)
bun test --check  /  bun build --check   # no tests run / nothing is written on a type error; Bun.build({ check: true })
```

- **`bun check` runs the package.json `check` script when one exists** (senpi, omo and the desktop repo all have one), and `bun fmt` likewise runs a `fmt` script. Measured on 1.4.4: `bun check` in such a project printed the script's output and exited 0 with a type error present. `--no-script` reaches the builtin.
- Port of typescript-go: same errors, same codes, same positions as `tsc` 7.0.2 (51,210/51,210 conformance baselines; 0 mismatches across 72 misconfigured OSS repos). A difference from `tsc` is a Bun bug.
- Type-check only: no emit, no `.d.ts`, no language server — LSP diagnostics still come from the editor's TypeScript.
- Any compiler option works as a flag and overrides tsconfig: `bun check --noUncheckedIndexedAccess`.

## bun fmt — Prettier-compatible formatter (replaces prettier, oxfmt, lint-staged) [v1.4.4]

Docs: <https://bun.com/docs/format>

```bash
bun fmt --no-script                   # format the project; reads .prettierrc*, prettier.config.*, .editorconfig, .prettierignore, .oxfmtrc*
bun fmt --no-script --check           # list files that need formatting; exit 1 if any
bun fmt --no-script --changed[=origin/dev]   # only files that differ from the default branch (or a ref)
bun fmt --no-script --staged          # pre-commit: format staged files and re-stage them
bun fmt --doctor                      # how Bun reads your config; which prettier plugins/packages you can uninstall
```

- JS/TS/JSX, CSS/SCSS/Less, HTML/Vue/Svelte/Angular, JSON/JSONC/JSON5, YAML, TOML, Markdown/MDX, GraphQL, Handlebars, plus embedded code. 99.1% byte-identical to Prettier 3.9.9 on its own test suite; 286x faster.
- Built in: import sorting, Tailwind class sorting (uses the project's `tailwindcss`), `package.json` key sorting, Svelte. Unsupported plugins (e.g. `prettier-plugin-jsdoc`) print an error, skip their files, exit 2; Astro-style plugin languages fall back to the project's Prettier.
- `[fmt]` in bunfig.toml takes every Prettier option by the same name (`bun fmt --init`); `--debug-check` fails if formatting changed a file's meaning.

## Markdown profilers — built for terminals and LLMs

```bash
bun --cpu-prof-md ./app.ts     # CPU profile as Markdown: hot functions by self time,
                               # call tree, who-calls-whom. grep it, paste into a bug or an LLM.
bun --heap-prof-md ./app.ts    # heap profile as Markdown: total size, types by retained size,
                               # largest objects, retention chains. Includes grep recipes in the header.
bun build ./src/index.ts --outdir ./dist --metafile-md=./dist/meta.md   # bundle-size analysis as Markdown
```

- `bun --cpu-prof` / `--heap-prof` still write `.cpuprofile` / V8-compatible `.heapsnapshot` for Chrome DevTools / VS Code.
- `BUN_CPU_PROFILE=1` turns on the CPU profiler for a process you cannot pass flags to (e.g. a framework-spawned worker).
- **Agent workflow: when a Bun process is slow or leaking, run the `-md` variants and read the report directly — no DevTools round-trip.**

## Async stack traces [v1.4.0]

Errors from async native APIs (`fs.promises`, `Bun.file()`, S3, DNS, crypto, `fetch`) point at the `await` in your code, not native frames.

Process lifetime (`--no-orphans`), env files, `BUN_OPTIONS`, memory measurement and `BUN_CONFIG_VERBOSE_FETCH=curl` are in [session-recipes](session-recipes.md).

## Watch and hot reload

`bun --watch app.ts` restarts the process on file change (`--watch-kill-signal=SIGTERM` picks the signal, `--no-clear-screen` keeps scrollback); `bun --hot app.ts` swaps modules in place without restarting — `Bun.serve` keeps its port, `Bun.SQL` keeps its connections [v1.4.4], and `import.meta.hot.data` carries state across reloads. `bun test --watch` re-runs affected files.

## APM / tracing works now

- **`node:inspector`**: a `Session` can start/stop CPU profiles while the app runs (`Profiler.start`/`Profiler.stop`).
- **Datadog**: `dd-trace` traces requests; `@datadog/pprof` profiles continuously (required V8 C++ APIs implemented).
- **OpenTelemetry**: `@opentelemetry/instrumentation-http` and `-fs` export spans; `shimmer` and `require-in-the-middle` can patch bundled code.
