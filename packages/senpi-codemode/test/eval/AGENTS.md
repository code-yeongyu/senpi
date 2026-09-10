# test/eval

## OVERVIEW

Shared eval fakes and real JavaScript worker harnesses; score 9 for a distinct test-support boundary imported by dozens of contract suites.

## WHERE TO LOOK

| Task | Path |
| --- | --- |
| Fake kernel/manager, context, result frames | `fakes.ts` |
| Deferred acquisition, reset, interrupt | `fakes.ts` (`DelayedKernelManager`, `DelayedResetKernel`, `PendingInterruptKernel`) |
| Real JavaScript runs and captured frames | `js-kernel-harness.ts` |
| Worker restart counts and blocked readiness | `js-worker-spawn-log.ts` |
| Bun shell fixture | `fake-bun-shell.ts` |
| Renderer-specific builders | `../eval-render-fixtures.ts` (outside this helper directory) |

## CONVENTIONS

- `FakeKernel.deferNextRun()` returns the run-start signal; arm it before
  execution, then settle the held run with `completeDeferredRun`.
- `FakeManager.getKernel` rebinds the selected kernel's `onMessage` callback.
  Tests can emit bridge messages separately from the final result frame.
- `FakeKernel.interrupt` records the reason and settles a deferred active run;
  `stateRetainedOnInterrupt` controls that interrupt's retained-state outcome.
- Acquisition, reset, and interrupt fixtures expose separate started/released
  promises so a race can be held at its actual ownership boundary.
- `fakeExtensionContext` defaults to print mode with in-memory session settings;
  interactive detach tests must deliberately select the mode they exercise.
- `withJavaScriptKernel` closes the real kernel in `finally`; `runJavaScriptCell`
  collects protocol messages alongside the result, and parsing rejects failed runs.
- Spawn-log entries run the real `createWorkerCore`; `blockFirstReady` emits a
  `readiness-blocked` phase and suppresses only the first initialization.
  Worker-core paths resolve from package cwd; call `removeWorkerEntry` after use.

## ANTI-PATTERNS

- Do not replace worker-core execution with a fake when asserting VM replacement:
  the spawn log must observe the runtime lifecycle being tested.
- Do not resolve a held interrupt before the assertion that depends on ownership.
- Do not use `KernelOwnedTimeoutKernel` as a generic scheduling delay; it exists
  to exercise a kernel-owned deadline, with timers controlled by that test.
