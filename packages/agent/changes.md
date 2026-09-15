# changes

## 2026-09-14 - Align shared schema and file-policy pins

### What changed

- `packages/agent/package.json` pins typebox 1.3.30, yaml 2.9.1 and ignore 7.0.9.

### Why

- `packages/agent/package.json` must share schema and file-policy versions with the bundled coding-agent runtime (Refs #1656).

### Why an extension could not handle it

- `packages/agent/package.json` controls installation before extension loading.

### Expected merge conflict zones

- Dependency pins in `packages/agent/package.json`.

## 2026-09-12 - Pin the chord dependency to upstream's published version

### What changed

- packages/agent/package.json: `@earendil-works/chord` is pinned to the exact upstream `0.85.1` it resolves to, instead of a fork CalVer range.

### Why

- chord is bundled but kept on upstream's own release identity (issue #1632): the fork does not publish it, so a CalVer range was unresolvable on the registry and broke `bun add @code-yeongyu/senpi`. Pinning the exact published `0.85.1` keeps the declared edge resolvable while the bundled copy shadows it at runtime.

### Why an extension could not handle it

- packages/agent/package.json is static manifest data consumed by the package manager and the release/publish pipeline, never reachable from the runtime extension system.

### Expected merge conflict zones

- The `@earendil-works/chord` dependency range in packages/agent/package.json.

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
