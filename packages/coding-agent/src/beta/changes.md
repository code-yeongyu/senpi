# changes

## 2026-10-08 - Background update workers do not replay an eval caller (senpi#2599)

### What changed

- `packages/coding-agent/src/beta/omo-local-update-worker.ts`: applies the shared runtime argument filter before the worker CLI entry while preserving the compiled-binary launch path and update arguments.

### Why

Forwarding eval or print code into a detached background script can repeat its caller instead of starting the worker.

### Why an extension could not handle it

The detached worker command is constructed before its CLI or extensions start.

### Expected merge conflict zones

- LOW: the source-script branch of `workerCommandArgs()`.
