# changes

## 2026-09-10 - Use native TypeScript builds for omob performance

### What changed

- packages/tui/package.json: build uses tsgo for the emitted workspace build.

### Why

- The native compiler reduces omob build time without changing runtime JavaScript.

### Why this lives in the fork

- The package build manifest owns the compiler used by the fork's release pipeline.

### Expected merge conflict zones

- The `build` script in packages/tui/package.json.
