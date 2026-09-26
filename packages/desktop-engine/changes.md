# senpi-desktop-engine fork changes

## 2026-09-26 - Bunshin capability descriptor for the detachable engine (senpi#2128)

### What changed

- `packages/desktop-engine/bunshin/descriptor.mjs` (new): builds the bunshin sidecar descriptor from `crates/senpi-desktop-core/schema/engine.schema.json`. Every public engine method becomes a `desktop.<method>` op with its effect (`exec` becomes `mutate`) and its params schema. Host-only and test-only methods are left out, apart from `desktop.stop` and `desktop.stopPath.status`, which are both `read`, so stopping never needs a capability token. The sidecar runs `senpi-desktop-engine --oneshot` over `json-rpc-stdio`.
- `packages/desktop-engine/bunshin/desktop.capability.json` (new): the shipped template, with the host-specific fields as placeholders.
- `packages/desktop-engine/test/bunshin-descriptor.test.ts` (new): validates the descriptor against bunshin's `DescriptorSchema` (copied from bunshin `packages/machine-sdk/src/handlers-sidecar.ts` at 0a21e2c1). It also checks that every op has an effect and a schema, that no host-only method is exposed, and that the shipped template matches the generator. `zod` 4.6.5 is a pinned devDependency.

### Why

- The engine can run as a bunshin capability without a senpi host (plan todo 47). The descriptor is derived rather than hand-written so it cannot drift from the engine's method table.

### Why an extension could not handle it

- The descriptor describes the engine binary's own `--oneshot` bridge, which is outside any senpi session.

### Expected merge conflict zones

- None: new files, plus one devDependency line.

## 2026-09-24 - Desktop package wired into the workspace (senpi#2128)

### What changed

- `packages/desktop-engine/`: locator and ABI handshake for the `senpi-desktop-engine` binary, with the vendored host prebuild. Wired into the workspace, the build phases, the entry-graph budgets, the bundled-workspace staging (`nativePrebuild`, file `senpi-desktop-engine[.exe]`), and the coding-agent bundle externals.

### Why

- Desktop computer use (senpi#2128) ships as five flat TS packages. Every enumerating script has to know about all five before any of them gains behavior, or publish staging breaks.

### Why an extension could not handle it

- This package is fork-only. The wiring lives in root build and publish scripts that run before any extension loads.

### Expected merge conflict zones

- None in this package: it does not exist upstream.
