# bun test in 1.4

Composable CI recipe:

```bash
bun test --changed=main                                   # only what your branch touches
bun test --parallel --timings=timings.json --update-timings
bun test --parallel --shard=1/3 --timings=timings.json    # in CI, per machine
```

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

Between files, Bun creates a new `globalThis`, clears ESM/CJS module registries, closes leaked servers/sockets/watchers/subprocesses, cancels timers, restores fake timers, and re-runs `--preload`. Transpiled source/bytecode stay cached process-wide, so only top-level code re-runs. This is how Jest/Vitest behave by default — use it to kill "passes alone, fails in the full suite" bugs. v1.4 fixed the 1.3.13 stability issues (fake-timer leaks, module-scope subprocess leaks, `process.chdir` bleed, N-API across files, debugger breakpoints).

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

`bun test --retry <N>` sets a suite-wide default. NOTE: prefer fixing the flake; retry is a containment tool.

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

## Behavior changes in 1.4 (test-related)

- `jest.resetAllMocks()` now drops implementations too (matches Jest); use `clearAllMocks()` for history-only.
- `expect().toContain()` compares with `===` not `Object.is` (`[NaN]` no longer contains `NaN`).
- `toEqual()` compares `Temporal` objects by value.
