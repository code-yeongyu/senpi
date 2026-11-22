# changes

## 2026-11-09 - Hide the console window for the detached OMO local update worker on Windows (senpi#3965)

### What changed

- `packages/coding-agent/src/beta/omo-local-update-worker.ts`: `defaultSpawnWorker` now passes `windowsHide: true` to its `spawn(process.execPath, ...)` call (keeps `detached: true`).

### Why

- The worker is spawned from the Bun runtime (`process.execPath` is bun.exe, a console-subsystem exe); without `windowsHide` it flashes an empty "bun" console window on Windows. Its sibling `omo-local-update.ts` already passes `windowsHide: true`.

### Why an extension could not handle it

- The spawn lives in the fork's beta update worker, not in an extension surface.

### Expected merge conflict zones

- LOW: single spawn-options line in a fork-owned beta module.

## 2026-10-08 - Background update workers do not replay an eval caller (senpi#2599)

### What changed

- `packages/coding-agent/src/beta/omo-local-update-worker.ts`: applies the shared runtime argument filter before the worker CLI entry while preserving the compiled-binary launch path and update arguments.

### Why

Forwarding eval or print code into a detached background script can repeat its caller instead of starting the worker.

### Why an extension could not handle it

The detached worker command is constructed before its CLI or extensions start.

### Expected merge conflict zones

- LOW: the source-script branch of `workerCommandArgs()`.
