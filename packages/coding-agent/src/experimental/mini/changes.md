# changes

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
