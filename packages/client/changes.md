# changes

## 2026-10-30 - Shared reconnect generation conformance (RULING-99, part of #4272)

### What changed

- `packages/client/src/materializer-test-kit.ts`: export the reconnect scenario used by engine tests and adapter conformance: commit generation N, reconnect at a greater generation, accept its unit, then reject lower-generation replay.

### Why

- Engine generation persistence must satisfy the existing adapter rather than weakening `stale_generation`.

### Why an extension could not handle it

- `packages/client/src/materializer-test-kit.ts` is the shared cross-implementation conformance surface.

### Expected merge conflict zones

- `packages/client/src/materializer-test-kit.ts` case registration. Adapter implementations remain unchanged.

## 2026-10-30 - Transaction-bound compact materializer contract (S16b, part of #4272)

### What changed

- `packages/client/package.json`: Export the runtime-neutral conformance kit through ./materializer-test-kit.
- `packages/client/src/index.ts`: Publish the materializer consumer, adapter contracts and envelope parser from the public barrel; expose the hook-bearing reference adapter only through ./materializer-test-kit.
- `packages/client/src/materializer.ts`: Add a transport-neutral transaction-bound consumer that deduplicates committed sequences before loading payloads and aborts failed units.
- `packages/client/src/materializer-memory.ts`: Provide a reference adapter with private staged effects, atomic effects/frontier publication, generation reset and committed-memory restart.
- `packages/client/src/materializer-wire.ts`: Parse bounded S16 envelope headers and optional repair seeds while preserving S15a frames and rejecting stray controls.
- `packages/client/src/materializer-test-kit.ts`: Publish shared adapter conformance scenarios for atomicity, replay, single flight, abort, restart, generations and independent sessions.
- `packages/client/src/materializer-test-kit.ts`: Certify fresh frontiers and effects after a committed generation reset, reject session-keyed adapters in the kit regression, and cover S15a b-g goldens including cancellation replies without sessionId.

### Why

- `packages/client/package.json`: Desktop SQL adapters must import the same conformance suite rather than copy its cases.
- `packages/client/src/index.ts`: External consumers need the materializer contract without changing RpcClient's synchronous listener.
- `packages/client/src/materializer.ts`: A unit's effects and accepted-sequence frontier must commit together, with duplicate payloads never loaded.
- `packages/client/src/materializer-memory.ts`: A reference adapter makes transaction ownership and rollback observable without claiming process or disk durability.
- `packages/client/src/materializer-wire.ts`: Consumers need a validated atomic header without decoding the shared event payload or changing S15a behavior.
- `packages/client/src/materializer-test-kit.ts`: RULING-95 requires reference and desktop adapters to run identical conformance cases.

### Why an extension could not handle it

- `packages/client/package.json`: Published package subpaths are controlled by the client export map.
- `packages/client/src/index.ts`: The client package owns its public runtime-neutral API.
- `packages/client/src/materializer.ts`: The adapter contract is consumed outside the coding-agent extension runtime.
- `packages/client/src/materializer-memory.ts`: Reference transaction semantics must implement the published client adapter contract.
- `packages/client/src/materializer-wire.ts`: Client-side protocol parsing must be available independently of host extensions.
- `packages/client/src/materializer-test-kit.ts`: External storage adapters need one importable client-owned conformance suite.

### Expected merge conflict zones

- `packages/client/package.json`: Package export map and materializer-test-kit subpath.
- `packages/client/src/index.ts`: Public materializer exports and runtime-neutral barrel.
- `packages/client/src/materializer.ts`: Transaction interfaces, refusal codes and consumer delivery ordering.
- `packages/client/src/materializer-memory.ts`: Single-flight ownership, generation reset and atomic publication.
- `packages/client/src/materializer-wire.ts`: Envelope shape, header validation and legacy-frame handling.
- `packages/client/src/materializer-test-kit.ts`: Harness contract and shared conformance scenarios.

## 2026-10-28 - Shared-wire recovery repair controller (S14, part of #4272)

### What changed

- `packages/client/src/index.ts`: exports the controller, typed advice error and action union from `packages/client/src/recovery-repair.ts`.
- `packages/client/src/recovery-repair.ts`: optional refused-request context permits one immediate catalog restart for an unknown or released token; a consecutive fresh-token refusal uses bounded backoff, while storage failures retain their change gate (RULING-87).
- `packages/client/src/recovery-repair.ts`: retain at most 64 restarted tokens, evicting the oldest while preserving consecutive-refusal backoff.

### Why

- `packages/client/src/index.ts`: exposes the no-spin repair policy for S15a to drive from the real transport, using server-emitted protocol advice without a parallel schema.
- `packages/client/src/recovery-repair.ts`: gone tokens need a new cut even when no source or storage revision changed; repeated refusals must not create a restart loop.
- `packages/client/src/recovery-repair.ts`: long-lived clients must not retain every historical token indefinitely.

### Why an extension could not handle it

- `packages/client/src/index.ts`: client transport policy belongs to the client package, not a server runtime extension.
- `packages/client/src/recovery-repair.ts`: request-local token identity and refusal handling belong to the controller, below extension delivery.
- `packages/client/src/recovery-repair.ts`: token-history retention is internal controller state.

### Expected merge conflict zones

- `packages/client/src/index.ts`: export list; S15a must add wiring and the blocking test `the in-repo client honours the hint end to end`.
- `packages/client/src/recovery-repair.ts`: the existing two-argument call and shared wire schema are unchanged; S15a supplies the optional request context.
- `packages/client/src/recovery-repair.ts`: bounded restart history and consecutive-gone backoff.

## 2026-10-29 - Run certified Vitest suites on Bun (senpi#4763)

### What changed

- `packages/client/package.json`: launch the existing temp-owning Vitest runner with `bun --bun` instead of Node.

### Why

- The full Node and Vitest-on-Bun controls match at 3 files and 27 passing tests. Bun avoids Node test workers.

### Why an extension could not handle it

- Package test scripts select the runtime before extensions load.

### Expected merge conflict zones

- `packages/client/package.json`: preserve the Bun launcher and forwarded Vitest arguments.

## 2026-10-10 - Test-run temporary storage has an owner (senpi#3064)

### What changed

- `packages/client/package.json`: test invocations use scripts/run-tests.mjs so TMPDIR/TEMP/TMP are scoped before the test runtime starts and cleaned after exit.

### Why

- Vitest SSR copies and interrupted fixture writes must not accumulate in the OS temp directory.

### Why an extension could not handle it

- Test-process bootstrap is repository tooling, before runtime extensions load.

### Expected merge conflict zones

- Test command arguments and runtime selection; preserve existing reporters, shards and test filters.

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
