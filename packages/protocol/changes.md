# changes

## 2026-09-14 - Align the shared schema pin

### What changed

- `packages/protocol/package.json` pins typebox 1.3.30.

### Why

- `packages/protocol/package.json` must use the same schema implementation as its bundled runtime consumers (Refs #1656).

### Why an extension could not handle it

- `packages/protocol/package.json` controls dependency resolution before the protocol executes.

### Expected merge conflict zones

- The typebox dependency in `packages/protocol/package.json`.

## 2026-09-12 - Pin the chord dependency to upstream's published version

### What changed

- packages/protocol/package.json: `@earendil-works/chord` is pinned to the exact upstream `0.85.1` it resolves to, instead of a fork CalVer range.

### Why

- chord is bundled but kept on upstream's own release identity (issue #1632): the fork does not publish it, so a CalVer range was unresolvable on the registry and broke `bun add @code-yeongyu/senpi`. Pinning the exact published `0.85.1` keeps the declared edge resolvable while the bundled copy shadows it at runtime.

### Why an extension could not handle it

- packages/protocol/package.json is static manifest data consumed by the package manager and the release/publish pipeline, never reachable from the runtime extension system.

### Expected merge conflict zones

- The `@earendil-works/chord` dependency range in packages/protocol/package.json.

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
