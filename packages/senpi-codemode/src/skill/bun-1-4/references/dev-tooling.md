# Bun 1.4 Dev Tooling & Observability

Blog: [#dev-tooling](https://bun.com/blog/bun-v1.4#dev-tooling), [#observability](https://bun.com/blog/bun-v1.4#observability)

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

## Process lifetime & env flags

```bash
bun --no-orphans app.ts    # exit when parent dies; SIGKILL every descendant on exit (Linux/macOS/Windows)
bun --no-env-file app.ts   # skip automatic .env loading (or env = false in bunfig.toml) — use in prod/CI
```

## APM / tracing works now

- **`node:inspector`**: a `Session` can start/stop CPU profiles while the app runs (`Profiler.start`/`Profiler.stop`).
- **Datadog**: `dd-trace` traces requests; `@datadog/pprof` profiles continuously (required V8 C++ APIs implemented).
- **OpenTelemetry**: `@opentelemetry/instrumentation-http` and `-fs` export spans; `shimmer` and `require-in-the-middle` can patch bundled code.
