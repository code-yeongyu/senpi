# changes

## 2026-09-10 - Use native TypeScript builds for omob performance

### What changed

- packages/protocol/package.json: build uses tsgo for the emitted workspace build.

### Why

- The native compiler reduces omob build time without changing runtime JavaScript.

### Why this lives in the fork

- The package build manifest owns the compiler used by the fork's release pipeline.

### Expected merge conflict zones

- The `build` script in packages/protocol/package.json.

## 2026-09-12 - Upstream sync (upstream/main@71dca871) integration repairs

### What changed

- `packages/protocol/package.json`: fork CalVer `2026.9.12`, `@earendil-works/chord` at `^2026.9.12`, `vitest 4.1.11`; upstream's Chord dependency was adopted.

### Why

- The protocol workspace rides the fork's CalVer lockstep and held vitest pin.

### Why an extension could not handle it

- Manifest ranges are consumed by the package manager.

### Expected merge conflict zones

- LOW: `version` and dependency lines on upstream release bumps.
