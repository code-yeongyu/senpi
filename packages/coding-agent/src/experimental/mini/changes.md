# changes

## 2026-11-09 - Hide the console window for mini session server/worker spawns on Windows (senpi#3965)

### What changed

- `packages/coding-agent/src/experimental/mini/server/run.ts`: the worker spawn (`spawn(process.execPath, ...)`) now passes `windowsHide: true`.
- `packages/coding-agent/src/experimental/mini/tui/run.ts`: the server spawn now passes `windowsHide: true` (keeps `detached: true`).

### Why

- Both spawn `process.execPath`, i.e. bun.exe, a console-subsystem exe. The tui server spawn (detached, stdio ignore) flashes an empty "bun" console window without the flag; the server worker spawn inherits the parent console (`stdio: ["pipe", "pipe", "inherit"]`), so the flag hides no new window there and is kept only for uniformity with the other win32 spawns.

### Why an extension could not handle it

- The spawns are the mini session server's own lifecycle code, not an extension surface.

### Expected merge conflict zones

- LOW: one options line each in two mini files.

## 2026-10-08 - Mini hosts inherit runtime options without caller entry modes (senpi#2599)

### What changed

- `packages/coding-agent/src/experimental/mini/tui/run.ts`: filters runtime options before the session-server script.
- `packages/coding-agent/src/experimental/mini/server/run.ts`: filters runtime options before each session-worker script.

### Why

An eval or print caller must not execute again in either child while loaders needed by source TypeScript still reach it.

### Why an extension could not handle it

The presentation and session hosts construct these native commands before agent or extension dispatch.

### Expected merge conflict zones

- LOW: imports and the two child argument arrays.
