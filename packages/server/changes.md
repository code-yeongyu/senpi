# changes

## Repository-wide changes.md audit backfill for package manifest and transport typing (2026-08-17)

### What changed

- Backfill from the repository-wide changes.md audit (pin 914cf147, tag v0.84.2): records the remaining fork deltas on upstream-owned server production paths. The protocol-field compatibility deltas in `packages/server/src/protocol.ts` remain tracked by the 2026-08-13 entry below.
- `packages/server/package.json`: renamed to `@code-yeongyu/senpi-server`, marked `private`, moved to CalVer `2026.8.16`, retargeted the description, keywords, and repository URL to senpi, switched the `dev`, `build`, and `typecheck` scripts from `tsgo` to `tsc` with the TypeScript 7 native toolchain, and bumped the workspace dependencies to the `^2026.8.16` lockstep range.
- `packages/server/src/testing/client.ts` and `packages/server/src/transports/unix/listener.ts`: annotated the `socket.on("data")` chunk as `Buffer` so the zero-copy `Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)` view construction typechecks against the upgraded Node type surface; runtime behavior is unchanged.

### Why

- The fork keeps the experimental server private and outside the publish matrix, versions it in lockstep with the CalVer release set, and compiles it with the same `tsc` toolchain as the rest of the workspace, so the manifest deliberately diverges from the upstream `@earendil-works/pi-server` identity, SemVer, and `tsgo` scripts.
- The typed chunks keep the unix transport and its protocol test client compiling under the fork's newer Node type definitions without weakening the byte-view handoff to the connection handler.

### Why an extension could not handle it

- Package identity, versioning, publish privacy, compiler selection, and transport socket typing are package-manifest and type-level contracts evaluated before the server runtime or any extension loads.

### Expected merge conflict zones

- LOW: `packages/server/package.json` name, version, private flag, scripts, and dependency lines whenever upstream re-versions or changes toolchain.
- LOW: the `data` handler annotations in `packages/server/src/testing/client.ts` and `packages/server/src/transports/unix/listener.ts`.

## Protocol compatibility fields (2026-08-13)

### What changed

- Preserved video-modality allowance in protocol exact-key checks.
- Preserved tool-call `incomplete` and `errorMessage` fields alongside upstream
  deferred assistant-message support.

### Why

- Senpi transports incomplete tool-call recovery metadata and video-aware
  messages across the server protocol boundary.

### Why an extension could not handle it

- These are transport schema keys validated before server consumers or
  extensions receive the decoded messages.

### Expected merge conflict zones

- MEDIUM: `src/protocol.ts`, in `ExactKeys` manifests and assistant/tool-call
  conversion switches.
