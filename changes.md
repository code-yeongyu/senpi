# changes — senpi-monorepo root

Root tracker for repository-level divergence from upstream `badlogic/pi-mono`.
Owns every audited production path whose nearest tracker is the repository root.

## Release dependency refresh (2026-08-24)

### What changed

- `package.json`: `@biomejs/biome` 2.5.9 -> 2.5.10.
- `packages/agent/package.json`: `typebox` 1.3.16 -> 1.3.18.
- `packages/ai/package.json`: `typebox` 1.3.16 -> 1.3.18.
- `packages/coding-agent/package.json`: `typebox` 1.3.16 -> 1.3.18.
- `packages/protocol/package.json`: `typebox` 1.3.16 -> 1.3.18.
- `packages/senpi-codemode/package.json`: `typebox` 1.3.16 -> 1.3.18.
- `packages/{ai,coding-agent}/package.json`: `@aws-sdk/client-bedrock-runtime` 3.1115.0 -> 3.1116.0.
- `packages/coding-agent/package.json`: `@anthropic-ai/claude-agent-sdk` 0.3.238 -> 0.3.241.
- Root and generated release locks were regenerated from those exact pins.

### Why

- These are the repository-audited patch-level or same-line upgrades available for the 2026.8.24 release. TypeBox must remain single-instanced across the shared protocol/runtime packages, and the Bedrock pin must remain identical in `ai` and `coding-agent`. The Claude Agent SDK update also requires regenerating its platform lock and the published/install dependency closures.
- `@anthropic-ai/sdk` remains at 0.91.1 because the minimum peer-compatible 0.93.0 still introduces browser-breaking credential-chain imports, while 0.120.0 is likewise unsafe. Deliberate breaking holds remain unchanged for `openai` 6.26.0 and `signal-exit` 3.0.7.

### Why an extension could not handle it

- Dependency resolution, exact pins, generated release locks, and platform-package selection happen before the runtime and extension system load.

### Expected merge conflict zones

- HIGH: root and coding-agent dependency blocks and generated lock artifacts.
- MEDIUM: the shared TypeBox pins across five package manifests.

## Dependency pin refresh, unused-dependency removal, and lock regeneration (2026-08-20)

### What changed

- `package.json`: root devDependencies bumped `esbuild` 0.28.1 -> 0.28.2 and `tsx` 4.23.1 -> 4.23.12; declared `concurrently` 10.0.5 (the root `dev` script invoked it while it was undeclared and absent from the lock); dropped the unused `@anthropic-ai/sandbox-runtime` and `jiti` devDependencies and the unused `get-east-asian-width` dependency. Overrides bumped `@hono/node-server` 2.0.10 -> 2.1.1, `postcss` 8.5.18 -> 8.5.26, `brace-expansion` 5.0.8 -> 5.0.9, `esbuild` 0.28.1 -> 0.28.2, `rimraf` 6.1.2 -> 6.1.3 (including the nested `gaxios.rimraf` pin), `shell-quote` 1.9.0 -> 1.10.0, `vite` 8.0.16 -> 8.2.2, and `ws` 8.21.1 -> 8.21.3, while `fast-uri` stays on 3.x and `protobufjs` on 7.x and `@anthropic-ai/sdk` stays pinned at 0.91.1.
- `.npmrc`: rewrote the `min-release-age` exemption list as package-name patterns (`@hono/node-server`, `@anthropic-ai/claude-agent-sdk`, `@aws-sdk/*`, `@google/genai`, `@smithy/*`, `typebox`, `vite`) so the freshly published target versions resolve under the repository's two-day supply-chain window.
- `packages/agent/package.json`, `packages/protocol/package.json`: `typebox` moved to 1.3.16 (from 1.3.8 and from the inconsistent 1.3.7).
- `packages/telemetry/package.json`: `@types/node` 24.12.4 -> 26.2.0, matching the rest of the repository.
- `packages/tui/package.json`: `marked` 18.0.7 -> 18.0.10.
- `crates/senpi-pty/Cargo.toml`, `crates/senpi-pty/package.json`, and the workspace `Cargo.toml` pins: `libc` =0.2.174 -> =0.2.189, `napi` =3.10.3 -> =3.12.1, `napi-derive` =3.5.9 -> =3.6.3, `napi-build` =2.3.2 -> =2.4.1, `@napi-rs/cli` 3.7.2 -> 3.8.6.
- `scripts/rolldown-platform-lock.test.mjs`: the asserted Rolldown binding version tracks 1.0.3 -> 1.2.4, which is what `vite` 8.2.2 resolves.

### Why

- These pins had drifted behind their current releases while the repository enforces exact pins through `npm run check:pinned-deps`, so refreshing them in one pass keeps every workspace on one resolved version and keeps the shared `typebox` identity single-instanced. The removals delete manifest entries with zero source references, and declaring `concurrently` makes the root manifest truthful about what `npm run dev` actually needs. `@anthropic-ai/sdk` is deliberately held at 0.91.1 because 0.120.0 adds credential-chain modules whose `node:fs` and `node:path` imports break the browser-bundle invariant enforced by `scripts/check-browser-smoke.mjs`. The `.npmrc` rewrite fixes an exemption list that could never match: npm compares these patterns against the package name only, so the previous `name@version` string was inert.

### Why an extension could not handle it

- Dependency resolution, override pinning, the supply-chain age gate, and Cargo pin selection are all performed by the package managers before any runtime exists, so no extension can influence which versions get installed or locked.

### Expected merge conflict zones

- HIGH: the `overrides` and `devDependencies` blocks in `package.json`, which upstream edits on nearly every release.
- MEDIUM: the per-package `typebox`/`@types/node` pins and the workspace `Cargo.toml` dependency table.
- LOW: `.npmrc` and the Rolldown binding version constant.

## Repository-wide upstream divergence audit (2026-08-17)

### What changed

Canonical backfill seeded from the pre-backfill audit report under
`local-ignore/qa-evidence/20260817-changes-md-audit/pre-backfill-audit.json`
(upstream pin `badlogic/pi-mono` `v0.84.2`, `914cf1472e715297caa30db4b9535d534a9eb718`).
Every remaining audited production path with no nearer tracker than the root:

- `.npmrc`: adds `min-release-age-exclude=@hono/node-server@2.0.10` on top of the upstream
  min-release-age supply-chain policy.
- `biome.json`: biome schema `2.3.5` -> `2.5.5`, `recommended: true` migrated to
  `preset: "recommended"`, and extended ignore sets for generated and tool-owned trees
  (`!**/api/cursor-agent/gen`, `!!**/.codegraph`).
- `package.json`: monorepo renamed `pi-monorepo` -> `senpi-monorepo`, `packages/pty` joined the
  workspace, chained-`cd` build scripts replaced by `scripts/build-all.mjs` with
  `build:npm`/`build:bun`/`build:pnpm` entry points, root `check` swapped `tsgo --noEmit` for
  `tsc --noEmit` and added `check:claude-sdk-platform-lock` plus script-based browser smoke, and
  fork-only `verify:pms` orchestration was added.
- `pnpm-workspace.yaml`: mirrors the root npm workspace's nested
  `packages/session-backends/*` glob so the pnpm parity build installs and links the sqlite
  session backend's workspace dependencies before `scripts/build-all.mjs` builds it.
- `tsconfig.base.json`: `target`/`lib` raised from `ES2022` to `ES2024`.
- `tsconfig.json`: reformatted to the fork's biome multi-line layout; workspace path mappings are
  semantically unchanged.
- `vitest.base.ts`: added the workspace source alias mapping `@earendil-works/pi-ai/utils/*` to
  `packages/ai/src/utils/*` so shared test configs resolve utils from source.
- `packages/agent/package.json`: private CalVer `2026.8.16`, `tsgo` -> `tsc` build/typecheck,
  fork dependency pins (`@earendil-works/pi-ai`/`pi-telemetry` `^2026.8.16`, `diff` `9.0.0`,
  `ignore` `7.0.6`).
- `packages/client/package.json`: CalVer `2026.8.16`, `tsgo` -> `tsc`,
  `@earendil-works/pi-protocol` pinned exactly to `2026.8.16`.
- `packages/client/src/unix.ts`: typed the socket `data` callback chunk as `Buffer`.
- `packages/protocol/package.json`: CalVer `2026.8.16`, `tsgo` -> `tsc`.
- `packages/session-backends/sqlite-node/package.json`: renamed
  `@earendil-works/pi-session-backend-sqlite-node` ->
  `@earendil-works/pi-storage-sqlite-node`, made private and independently versioned at
  `0.83.0`, `tsgo` -> `tsc`, and keeps its runtime `pi-agent-core` / `pi-ai` dependencies on
  lockstep semver ranges so npm, Bun, and pnpm all link the live workspace packages.
- `packages/session-backends/sqlite-node/src/sqlite/repo.ts`: optional-chaining refactor of the
  message-target guard.
- `packages/telemetry/package.json`: private CalVer `2026.8.16`.
- `packages/telemetry/src/index.ts`: type-layout reformat under the fork's biome/TypeScript
  settings; no contract change.
- `packages/tui/package.json`: private CalVer `2026.8.16`, `tsgo` -> `tsc`, tests run under
  `tsx` with `test/setup-multiplexer-env.mjs`, added `bench:frame-cost`, Node engine
  `>=24.0.0`, pinned bumps (`marked` `18.0.7`).
- `.pi/extensions/prompt-url-widget.ts`: deleted; relocated into global builtins (see the
  focused section below).
- `.pi/extensions/tps.ts`: deleted; relocated into global builtins (see the focused section
  below).

### Why

- Senpi is a fork with its own identity, CalVer release trains, and an npm/bun/pnpm install
  matrix; root manifests, compiler settings, and lint configuration carry that policy, so they
  intentionally diverge from the upstream npm-only `0.x` layout.
- Non-published support packages (`agent`, `telemetry`, `tui`, sqlite storage backend) are
  private and lockstep-versioned or independently pinned per AGENTS dependency policy, which
  shows up as manifest-level divergence with no deeper tracker of its own.
- The two deleted `.pi/extensions/*` files were repository-local development extensions that
  the fork promoted into shipped product behavior; the deletion itself is the audited
  divergence and is recorded here because `.pi/` has no tracker of its own.

### Why an extension could not handle it

- Every path in this section is repository, build, toolchain, or non-coding-agent package
  metadata that executes before any Senpi session, extension loader, or runtime exists.
  Extensions load inside a coding-agent session and cannot rename a monorepo, retarget
  compilers, reshape git hooks, reversion packages, or alter dependency policy.

### Expected merge conflict zones

- HIGH: root `package.json` scripts/workspaces and `packages/*/package.json` version blocks on
  every upstream sync; upstream `0.x` bumps must be reconciled into CalVer deliberately.
- MEDIUM: `biome.json`, `tsconfig.base.json`, `tsconfig.json`, and `vitest.base.ts` whenever
  upstream bumps toolchain majors or adds workspaces.
- MEDIUM: `.pi/extensions/prompt-url-widget.ts` and `.pi/extensions/tps.ts` — upstream still
  owns these files, so syncs will propose edits to deleted paths; resolve to the deletion and
  re-port any upstream improvement into the builtin copies.

## Deleted repo-local .pi extensions, relocated into global builtins (2026-04-27)

### What changed

- Deleted `.pi/extensions/prompt-url-widget.ts` and `.pi/extensions/tps.ts`, which the upstream
  pin still ships as repository-local dev extensions.
- Relocated their functionality into always-on global builtins at
  `packages/coding-agent/src/core/extensions/builtin/prompt-url-widget.ts` and
  `packages/coding-agent/src/core/extensions/builtin/tps.ts`, registered with the other fork
  builtins and covered by `packages/coding-agent/src/core/extensions/builtin/changes.md`.
- Subsequent fork releases hardened the TPS builtin (monotonic timing in `7f6097bf3`, cache-hit
  notice in `c7874fda3`) with regression coverage in
  `packages/coding-agent/test/suite/tps-extension.test.ts`.
- Context: sibling `.pi/extensions/import-repro.ts` and `.pi/extensions/redraws.ts` moved the
  same way and are rename-tracked under the builtin tracker, so they do not appear in the
  canonical audit list above.

### Why

- Repository-local `.pi/extensions` only load for sessions started inside this clone and
  require per-repo wiring. Senpi ships the URL prompt widget and tokens-per-second notice as
  product affordances for every user and session, versioned, registered, and tested together
  with the coding agent instead of living in an unaudied dot-directory.

### Why an extension could not handle it

- Remaining a repo-local extension is exactly what this change removed: an extension cannot
  distribute itself to other clones or sessions. Promoting the behavior into the builtin set
  is the mechanism; there is no extension-side equivalent of "ship enabled-by-default for all
  users".

### Expected merge conflict zones

- Upstream-side edits to the deleted `.pi/extensions/prompt-url-widget.ts` and
  `.pi/extensions/tps.ts` on every sync (resolve to deletion, re-port improvements).
- Builtin registration and widget internals under
  `packages/coding-agent/src/core/extensions/builtin/` if upstream reworks extension loading
  or adds overlapping notices.

## Pnpm parity for the nested SQLite session backend (2026-08-19)

### What changed

- `pnpm-workspace.yaml` now includes `packages/session-backends/*`, matching the root npm
  workspace and the package set explicitly built by `scripts/build-all.mjs`.
- `packages/session-backends/sqlite-node/package.json` declares its shipped
  `pi-agent-core` / `pi-ai` imports as lockstep runtime dependencies instead of packed
  `file:` dev dependencies.
- `scripts/sync-versions.js` keeps the backend's own `0.83.0` version independent while
  synchronizing those lockstep dependency ranges during Senpi releases.

### Why

- The release pre-commit gate verifies npm, Bun, and pnpm. Pnpm previously excluded the
  nested backend from its workspace and then, once included, packed its `file:` dependencies
  before their declarations were built. The ordered build therefore reached the backend with
  unresolved `pi-agent-core` / `pi-ai` types even though npm and Bun passed.

### Why an extension could not handle it

- This is package-manager workspace topology and release-version synchronization. Runtime
  extensions load only after packages install and build, so they cannot repair missing
  workspace membership, dependency links, or manifest pins.

### Expected merge conflict zones

- Upstream changes to the SQLite backend's dependency placement or independent-version policy.
- Future workspace additions under nested `packages/*/*` paths, which must remain aligned
  across root npm workspaces, `pnpm-workspace.yaml`, and `scripts/build-all.mjs`.
