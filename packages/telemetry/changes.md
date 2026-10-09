## 2026-09-30 - Sync with upstream v0.99.1 (6a4af07d6): paths divergent from the new pin

### What changed

- `packages/telemetry/src/index.ts`: same types as the pinned upstream file; the schema span/event conditional types are laid out the way the fork's formatter prints them.

### Why

The fork runs biome with its own formatter over every package (`npm run check` fails on warnings). No behavior differs from upstream.

### Why an extension could not handle it

Source formatting of package files is enforced by the repository check, not by any runtime surface.

### Expected merge conflict zones

- LOW: upstream edits to the `TelemetrySchemaSpanEvent*` conditional types; take upstream's content and re-format.

## 2026-09-30 - Sync with upstream v0.99.1 (6a4af07d6): chord, client, protocol, server, telemetry, sqlite-node

### What changed

- `packages/telemetry/package.json`: resolved by L11 against upstream v0.99.1 (6a4af07d6): upstream constructs adopted, fork behavior kept.

### Why

Upstream v0.99.1 (6a4af07d6) changed these paths while the fork carries its own behavior; chord/client/protocol/server/telemetry/sqlite-node take upstream versions with fork exact pins (plan D-12).

### Why an extension could not handle it

Package manifests and wire-protocol packages are shared infrastructure below the extension layer.

### Expected merge conflict zones

Every path listed above conflicts again where upstream edits the hunks named in its line; the fork-kept constructs named there are the anchors to preserve.

## 2026-09-29 - Published tarball excludes sourcemaps (senpi#2362)

### What changed

- `packages/telemetry/package.json`: `files` excludes `dist/**/*.map`.

### Why

- The maps point at `src/`, which is not published, so they cannot resolve for consumers and only add install size.

### Why an extension could not handle it

- Package publish metadata.

### Expected merge conflict zones

- LOW: the `files` list in `package.json`.

# changes

## 2026-09-21 - Migrate the test runner to Vitest 5 (senpi#1895)

### What changed

- `packages/telemetry/package.json`: Updated the test runner to Vitest 5.0.1.

### Why

- Run this workspace on the pinned Vitest 5 release.

### Why an extension could not handle it

- The package manager resolves development tools before extensions load.

### Expected merge conflict zones

- The development dependency pins in `packages/telemetry/package.json`.
