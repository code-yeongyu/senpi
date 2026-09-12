# changes

## 2026-09-10 - Use native TypeScript builds for omob performance

### What changed

- packages/agent/package.json: build uses tsgo for the emitted workspace build.

### Why

- The native compiler reduces omob build time without changing runtime JavaScript.

### Why this lives in the fork

- The package build manifest owns the compiler used by the fork's release pipeline.

### Expected merge conflict zones

- The `build` script in packages/agent/package.json.

## 2026-09-12 - Upstream sync (upstream/main@71dca871) integration repairs

### What changed

- `packages/agent/package.json`: keeps the fork CalVer version `2026.9.12` and `^2026.9.12` ranges for `@earendil-works/chord`, `@earendil-works/pi-ai` and `@earendil-works/pi-telemetry`, the Node `>=24.0.0` floor, `diff 9.0.0`, `@types/node 26.2.0`, `typescript 7.0.2`, `vitest`/`@vitest/coverage-v8 4.1.11` and `private: true`; upstream's new Chord runtime dependency and bench scripts were adopted.

### Why

- Every `@earendil-works/pi-*` workspace rides the fork's CalVer lockstep so the install lock can treat them as internal packages, and the fork's held tool pins must stay single-instanced across manifests.

### Why an extension could not handle it

- Package version and dependency ranges are resolved by the package manager before any code runs.

### Expected merge conflict zones

- LOW: `version`, `dependencies` and `devDependencies` lines on every upstream release bump.
