# bun test in 1.4.x

Composable CI recipe:

```bash
bun test --changed=main                                   # only what your branch touches
bun test --parallel --timings=timings.json --update-timings
bun test --parallel --shard=1/3 --timings=timings.json    # in CI, per machine
bun test --check                                          # type-check test files + imports first; no tests run on a type error [v1.4.3]
```

## Traps — each one cost a past session hours

| Trap | Fact | Fix |
|---|---|---|
| Timeout reaches only the first file | `setDefaultTimeout()` in a preload is file-scoped (first file only); bunfig `[test] timeout` is silently ignored (bun#7789). Only slow hosts push tests past 5 s, so it looks like a Windows flake (2026-10-20) | `bun test --timeout 30000` on the command line, or a per-test third argument (`0` = no limit) |
| Zombie killer takes your DB with it | When a test times out, Bun SIGTERMs every child the test process spawned, including an embedded Postgres started in `beforeAll`; every later test in the file fails with "shutting down" and the failing set changes with host load (2026-10-23) | raise the budget for DB suites, or start the server outside the test process |
| Path without `./` is a name filter | `bun test path/file.test.ts` matches files whose path CONTAINS that string; `bun test ./path/file.test.ts` runs exactly that file | start exact paths with `./` or `/`; `-t <regex>` filters by test name |
| `expect(p).rejects` hangs after a Worker reply | `await expect(p).rejects…` reached from the continuation of an awaited Worker message deadlocks (oven-sh/bun#37189, still on 1.4.3) | `const err = await p.then(() => undefined, (e) => e)` then assert on `err` |
| `mock.module()` reaches every importer | mocking a re-exporting entry replaces the function for modules importing it by relative path too; one file's `mock.module` of a shared logger breaks another file's `spyOn` in the same run (2026-10-26/27) | copy the real namespace first (`{ ...(await import(x)) }`), keep such tests in their own process (`bun test ./x.isolated.test.ts`) or run `--isolate` |
| Preload patch of a builtin is invisible | a preload's `require("node:os").x = …` reaches product `import * as os` only if nothing ESM-imported that builtin before the patch; Bun snapshots the namespace at first ESM import and `module.syncBuiltinESMExports()` does not help (2026-10-29) | patch before any ESM import of the builtin, or use the product's env seam |
| Respawned `"bun"` is not this Bun | PATH can resolve to a mise shim or a stray older `bun` in a global `.bin`; the test's `calls.log` ENOENT hid a `--version` exit 1 (2026-09-28, 10-29) | spawn `process.execPath`; surface the child's stderr when a stub log is missing |
| Env-less child misses runtime env | `Bun.spawn` without `env` gives the child the STARTUP environment | `env: process.env` — see [session-recipes](session-recipes.md) |
| Timed-out test keeps running | the per-test timeout marks the test failed but its body keeps executing; a body awaiting a never-settling promise is not ended at all, and `onTestFinished` runs while it is still awaiting (2026-10-12/16) | own async work in a hook registered before fixture removal; wrap a never-settles RED in an outer `timeout -k 5 <s>` |
| Shared-helper hooks bind once | an `afterEach`/`afterAll` at module scope of a helper several files import binds only to the FIRST importer; 16 files skipped cleanup and left 106 temp dirs (2026-10-10) | register per call with `onTestFinished(() => …)` inside the helper |
| `bun run --cwd pkg test file` runs everything | bun appends your positional AFTER the script's own (`vitest run test/ file`), so the whole suite runs (2026-09-21); `bun test` on a vitest-based package hung 12 h (2026-10-27) | invoke the package's runner directly for one file; check which runner a package uses before `bun test` |
| Root `pathIgnorePatterns` hides a package | a root bunfig pattern silently excluded a workspace's suite; the run was green with 0 of its files (2026-09-27) | run the package's own script or explicit paths and verify the discovered file count |
| Duplicate package.json key | every child prints `Duplicate key` on stderr, failing stderr-asserting tests (2026-10-24) | fix the JSON |

Flake tools: `bun test --rerun-each 20 ./x.test.ts` runs a file N times in one process (order/leak bugs); `--randomize --seed N` reproduces order-dependent failures; `--only-failures` re-runs what failed last time; `test.failing("name", fn)` inverts a known-red test so it alerts when it starts passing; `--bail` stops at the first failure (also stops every `--parallel` worker).

## --parallel: worker processes [v1.3.13, improved v1.4.0]

Blog: [#bun-test-parallel](https://bun.com/blog/bun-v1.4#bun-test-parallel)

```bash
bun test --parallel          # N = CPU count
bun test --parallel=4
```

- Files go to whichever worker frees up next. Coverage and JUnit output merged across workers; `--bail` stops every worker.
- `--parallel` implies `--isolate`; `--no-isolate` opts out.
- Workers expose 1-indexed `JEST_WORKER_ID` / `BUN_TEST_WORKER_ID`, so Jest setups keying DBs/ports off worker id work unchanged.
- Preload scripts with top-level `await` complete before any worker runs tests.

## --isolate: fresh global per file [v1.3.13, hardened v1.4.0]

Blog: [#bun-test-isolate](https://bun.com/blog/bun-v1.4#bun-test-isolate)

```bash
bun test --isolate
```

Between files, Bun creates a new `globalThis`, clears ESM/CJS module registries, closes leaked servers/sockets/watchers/subprocesses, cancels timers, restores fake timers, and re-runs `--preload`. Transpiled source/bytecode stay cached process-wide, so only top-level code re-runs. This is how Jest/Vitest behave by default — use it to kill "passes alone, fails in the full suite" bugs. v1.4.0 fixed the 1.3.13 stability issues (fake-timer leaks, module-scope subprocess leaks, `process.chdir` bleed, N-API across files, debugger breakpoints); v1.4.1 stopped files that call `mock()`, `spyOn()`, `mock.module()` or `Bun.plugin()` from keeping their module graph alive (80 mocked files: 1591 MB → 215 MB) and stopped `TZ`, proxy and TLS settings from leaking into later files.

## --shard: split across CI machines [v1.3.13]

Blog: [#bun-test-shard](https://bun.com/blog/bun-v1.4#bun-test-shard)

```bash
bun test --shard=1/3   # deterministic, round-robin, 1-based (matches Jest/Vitest/Playwright)
```

Works with `--changed` and `--randomize`; an empty shard exits 0.

## --timings: balance by wall time [v1.4.0]

Blog: [#bun-test-timings](https://bun.com/blog/bun-v1.4#bun-test-timings)

```bash
bun test --timings=timings.json --update-timings   # record per-file durations
bun test --shard=1/3 --timings=timings.json        # shards cut by equal time, not file count
bun test --parallel --timings=timings.json         # workers start slowest file first (LPT scheduling)
```

The timings file is written slowest-first, so it doubles as a slow-test report. Files sharing imports stay together (warm module cache).

## --changed: only affected tests [v1.3.13]

Blog: [#bun-test-changed](https://bun.com/blog/bun-v1.4#bun-test-changed)

```bash
bun test --changed             # uncommitted (unstaged + staged + untracked)
bun test --changed=main        # diff against branch/commit/tag
bun test --changed --watch     # re-filters on every restart
```

Bun scans test imports, asks git what changed, walks the import graph backwards. tsconfig `paths` aliases (`@/*`) work. Vitest-compatible flag.

## --retry and repeats [v1.3.3]

Blog: [#bun-test-retry](https://bun.com/blog/bun-v1.4#bun-test-retry)

```ts
test("flaky network call", async () => { await fetch("https://example.com"); }, { retry: 5 });
test("stress", () => { if (Math.random() < 0.1) throw new Error("uh oh!"); }, { repeats: 20 });
```

`bun test --retry <N>` sets a suite-wide default. NOTE: prefer fixing the flake (`--rerun-each`, `--randomize --seed`, `--isolate` find it); retry is a containment tool.

## jest.useFakeTimers() [v1.3.4, improved v1.4.0]

Blog: [#jest-usefaketimers](https://bun.com/blog/bun-v1.4#jest-usefaketimers)

```ts
import { jest, test, expect } from "bun:test";
test("debounce", () => {
  jest.useFakeTimers();
  let called = 0;
  setTimeout(() => called++, 1000);
  jest.advanceTimersByTime(1000);
  expect(called).toBe(1);
  jest.useRealTimers();
});
```

- Controls `setTimeout`, `setInterval`, `Date`. `jest.setSystemTime()` works with `advanceTimersByTime()`.
- `@testing-library/react`'s `waitFor` detects fake timers and advances instead of sleeping. `Bun.cron` schedules can be driven by the fake clock.

## Also in bun:test

- `expectTypeOf<T>()` type assertions (Vitest-compatible); `test.if/skipIf/todoIf(cond)`, `test.each([...])`, `describe.each`; `onTestFinished(fn)` runs after all `afterEach` hooks (serial tests only).
- `bun test --inspect` / `--inspect-brk` attaches the debugger to the runner; `--reporter=junit --reporter-outfile=x.xml`; inside GitHub Actions, failures are emitted as annotations automatically.
- `--coverage-reporter=lcov` implies `--coverage` [v1.4.3]. v1.4.4 stopped counting skipped branches (`||`/`??`/`?.` right sides, code after an `await` that never resumed) and implicit constructors as covered — `% Lines`/`% Funcs` can drop after upgrading, so re-check `coverageThreshold`.
- `--update-snapshots` keeps the old file when a run ends early (`--bail`) [v1.4.4].

## Behavior changes in 1.4.x (test-related)

- `jest.resetAllMocks()` now drops implementations too (matches Jest); use `clearAllMocks()` for history-only.
- `expect().toContain()` compares with `===` not `Object.is` (`[NaN]` no longer contains `NaN`).
- `toEqual()` compares `Temporal` objects by value.
- Coverage percentages are stricter in v1.4.4 (above).
