# changes

## 2026-09-30 - Sync with upstream v0.99.1 (6a4af07d6): chord, client, protocol, server, telemetry, sqlite-node

### What changed

- `packages/client/package.json`: resolved by L11 against upstream v0.99.1 (6a4af07d6): upstream constructs adopted, fork behavior kept.

### Why

Upstream v0.99.1 (6a4af07d6) changed these paths while the fork carries its own behavior; chord/client/protocol/server/telemetry/sqlite-node take upstream versions with fork exact pins (plan D-12).

### Why an extension could not handle it

Package manifests and wire-protocol packages are shared infrastructure below the extension layer.

### Expected merge conflict zones

Every path listed above conflicts again where upstream edits the hunks named in its line; the fork-kept constructs named there are the anchors to preserve.

## 2026-09-21 - Migrate the test runner to Vitest 5 (senpi#1895)

### What changed

- `packages/client/package.json`: Updated the test runner to Vitest 5.0.1.

### Why

- Run this workspace on the pinned Vitest 5 release.

### Why an extension could not handle it

- The package manager resolves development tools before extensions load.

### Expected merge conflict zones

- The development dependency pins in `packages/client/package.json`.

## 2026-09-12 - Pin the chord dependency to upstream's published version

### What changed

- packages/client/package.json: `@earendil-works/chord` is pinned to the exact upstream `0.85.1` it resolves to, instead of a fork CalVer range.

### Why

- chord is bundled but kept on upstream's own release identity (issue #1632): the fork does not publish it, so a CalVer range was unresolvable on the registry and broke `bun add @code-yeongyu/senpi`. Pinning the exact published `0.85.1` keeps the declared edge resolvable while the bundled copy shadows it at runtime.

### Why an extension could not handle it

- packages/client/package.json is static manifest data consumed by the package manager and the release/publish pipeline, never reachable from the runtime extension system.

### Expected merge conflict zones

- The `@earendil-works/chord` dependency range in packages/client/package.json.

## 2026-09-12 - Keep explicit Buffer typing in the Unix socket transport

### What changed

- `packages/client/src/unix.ts`: the `socket.on("data", ...)` handler in `connectUnixSocket` annotates its chunk as `Buffer` before it is re-wrapped as a `Uint8Array`. Upstream's `createUnixTransportFactory` and `discoverUnixServers` are kept unchanged otherwise.

### Why

- The fork compiles this package with its own strict TypeScript settings, where the untyped `data` listener parameter widens to `any` and trips the no-implicit-any gate. The explicit type keeps the workspace build green without changing runtime behavior.

### Why an extension could not handle it

- This is a type annotation inside the client transport source; extensions can't reach into a library package's compile step.

### Expected merge conflict zones

- The `socket.on("data", ...)` listener inside `connectUnixSocket` in `packages/client/src/unix.ts` whenever upstream reshapes the Unix transport (service discovery, bounded runtime paths, or rename of server IDs).

## 2026-09-10 - Use native TypeScript builds for omob performance

### What changed

- packages/client/package.json: build uses tsgo for the emitted workspace build.

### Why

- The native compiler reduces omob build time without changing runtime JavaScript.

### Why this lives in the fork

- The package build manifest owns the compiler used by the fork's release pipeline.

### Expected merge conflict zones

- The `build` script in packages/client/package.json.

## 2026-09-12 - Upstream sync (upstream/main@71dca871) integration repairs

### What changed

- `packages/client/package.json`: fork CalVer `2026.9.12`, `@earendil-works/chord` at `^2026.9.12`, `@earendil-works/pi-protocol` pinned caret-less to `2026.9.12`, `typecheck` via `tsc` instead of `tsgo`, `vitest 4.1.11`; upstream's Chord dependency was adopted.

### Why

- The client publishes in the fork's CalVer lockstep and must resolve the protocol workspace exactly.

### Why an extension could not handle it

- Manifest ranges are consumed by the package manager, not by runtime code.

### Expected merge conflict zones

- LOW: `version`, `dependencies` and `scripts.typecheck` lines on upstream release bumps.
