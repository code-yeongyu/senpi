# changes

## 2026-10-10 - Test-run temporary storage has an owner (senpi#3064)

### What changed

- `packages/protocol/package.json`: test invocations use scripts/run-tests.mjs so TMPDIR/TEMP/TMP are scoped before the test runtime starts and cleaned after exit.

### Why

- Vitest SSR copies and interrupted fixture writes must not accumulate in the OS temp directory.

### Why an extension could not handle it

- Test-process bootstrap is repository tooling, before runtime extensions load.

### Expected merge conflict zones

- Test command arguments and runtime selection; preserve existing reporters, shards and test filters.

## 2026-09-30 - Sync with upstream v0.99.1 (6a4af07d6): chord, client, protocol, server, telemetry, sqlite-node

### What changed

- `packages/protocol/package.json`: resolved by L11 against upstream v0.99.1 (6a4af07d6): upstream constructs adopted, fork behavior kept.

### Why

Upstream v0.99.1 (6a4af07d6) changed these paths while the fork carries its own behavior; chord/client/protocol/server/telemetry/sqlite-node take upstream versions with fork exact pins (plan D-12).

### Why an extension could not handle it

Package manifests and wire-protocol packages are shared infrastructure below the extension layer.

### Expected merge conflict zones

Every path listed above conflicts again where upstream edits the hunks named in its line; the fork-kept constructs named there are the anchors to preserve.

## 2026-09-21 - Migrate the test runner to Vitest 5 (senpi#1895)

### What changed

- `packages/protocol/package.json`: Updated the test runner to Vitest 5.0.1.

### Why

- Run this workspace on the pinned Vitest 5 release.

### Why an extension could not handle it

- The package manager resolves development tools before extensions load.

### Expected merge conflict zones

- The development dependency pins in `packages/protocol/package.json`.

## 2026-09-21 - Refresh the protocol dependency pins (senpi#1895)

### What changed

- `packages/protocol/package.json`: `typebox` 1.3.27 -> 1.3.34.

### Why

- typebox is the schema runtime this package's wire contracts are built on and is pinned exactly across every workspace that uses it, so the five pins move together to the newest 1.3.x that satisfies `min-release-age=2`.

### Why an extension could not handle it

- Manifest dependency versions are resolved by the package manager before any extension loads.

### Expected merge conflict zones

- LOW: the `typebox` version in packages/protocol/package.json.

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
