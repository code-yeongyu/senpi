# changes — senpi-monorepo root

Root tracker for repository-level divergence from upstream `badlogic/pi-mono`.
Owns every audited production path whose nearest tracker is the repository root.

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
  `0.83.0`, `tsgo` -> `tsc`, and workspace deps switched to `file:` references.
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
