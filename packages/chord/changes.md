# changes

## 2026-10-10 - Test-run temporary storage has an owner (senpi#3064)

### What changed

- `packages/chord/package.json`: test invocations use scripts/run-tests.mjs so TMPDIR/TEMP/TMP are scoped before the test runtime starts and cleaned after exit.

### Why

- Vitest SSR copies and interrupted fixture writes must not accumulate in the OS temp directory.

### Why an extension could not handle it

- Test-process bootstrap is repository tooling, before runtime extensions load.

### Expected merge conflict zones

- Test command arguments and runtime selection; preserve existing reporters, shards and test filters.

## 2026-09-30 - Sync with upstream v0.99.1 (6a4af07d6): chord, client, protocol, server, telemetry, sqlite-node

### What changed

- `packages/chord/package.json`: resolved by L11 against upstream v0.99.1 (6a4af07d6): upstream constructs adopted, fork behavior kept.
- `packages/chord/src/types.ts`: `packages/chord/src/types.ts` (silent merge, reviewed): upstream type changes kept; the fork's multi-line conditional-type formatting (biome) kept; whitespace-only difference to upstream; biome clean.

### Why

Upstream v0.99.1 (6a4af07d6) changed these paths while the fork carries its own behavior; chord/client/protocol/server/telemetry/sqlite-node take upstream versions with fork exact pins (plan D-12).

### Why an extension could not handle it

Package manifests and wire-protocol packages are shared infrastructure below the extension layer.

### Expected merge conflict zones

Every path listed above conflicts again where upstream edits the hunks named in its line; the fork-kept constructs named there are the anchors to preserve.

## 2026-09-21 - Migrate the test runner to Vitest 5 (senpi#1895)

### What changed

- `packages/chord/package.json`: Updated the test runner to Vitest 5.0.1.

### Why

- Run this workspace on the pinned Vitest 5 release.

### Why an extension could not handle it

- The package manager resolves development tools before extensions load.

### Expected merge conflict zones

- The development dependency pins in `packages/chord/package.json`.

## 2026-10-02 - Adopted upstream chord type surface (upstream v1.0.0 sync)

### What changed

- `packages/chord/src/types.ts`

The upstream chord type change is kept (D-16).

### Why

chord is upstream-owned; the fork takes its source unless the fork modifies it.

### Why an extension could not handle it

Not an extension surface.

### Expected merge conflict zones

Upstream chord type edits at the next sync.
