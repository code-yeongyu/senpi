# changes

## Merge concurrent main updates before release push (2026-08-13)

### What changed

- Release preparation now fetches `origin/main` after creating the verified
  release tag and next-cycle commit.
- If remote main advanced during the long release test transaction, the release
  branch creates a normal merge commit before pushing `main`.
- Added focused tests for advanced, already-contained, and dry-run paths.

### Why

- The release workflow can run for several minutes while other verified PRs
  merge. A non-fast-forward main push previously failed after all release build
  and test work had completed.
- The release tag remains anchored to the already verified release commit;
  only the post-release next-cycle branch absorbs concurrent main history.

### Why an extension could not handle it

- Git synchronization and tag/branch publication happen before any Senpi
  runtime or extension is loaded.

### Expected merge conflict zones

- MEDIUM: the final tag/next-cycle/push sequence in `release.mjs`.

## Lock every Rolldown platform binding (2026-08-13)

### What changed

- Added a root-lock regression that requires every native optional declared by
  Rolldown to carry its exact version, registry URL, integrity hash, and
  `optional` marker.
- Recorded the cross-platform lock restoration merged in PR #849.

### Why

- The upstream sync left only the host Darwin ARM64 binding in
  `package-lock.json`. Linux and Windows Vitest processes failed at startup
  before executing tests because their Rolldown native package was absent.

### Why an extension could not handle it

- Vitest loads Rolldown before tests or the Senpi runtime can start.

### Expected merge conflict zones

- MEDIUM: root `package-lock.json` optional dependency entries.

## Reconcile native optionals after release lock refresh (2026-08-13)

### What changed

- Release preparation now runs a no-script install immediately after the
  package-lock-only refresh.
- Added a release-artifact regression covering both executed and dry-run command
  sequences.

### Why

- npm refreshes optional dependencies for the current host in the lock, but a
  package-lock-only operation does not update `node_modules`. Linux release
  tests could therefore retain the old dependency tree and miss Rolldown's
  `@rolldown/binding-linux-x64-gnu` native package.
- Reconciliation is no-script and network-auditing disabled; it only makes the
  installed tree match the freshly generated host lock before clean/build/test.

### Why an extension could not handle it

- Native package installation and release lock refresh happen before the Senpi
  runtime or extension loader exists.

### Expected merge conflict zones

- LOW: `runPackageLockRefresh` in `release-artifacts.mjs`.

## Build telemetry before its consumers (2026-08-13)

### What changed

- Moved AI into the build phase after telemetry, and agent into the following
  phase after AI.
- Strengthened the build-order regression so direct workspace dependencies must
  be in strictly later phases instead of merely the same phase.
- Kept the flattened phase-order expectation synchronized with the executable
  phase list so the serial release test gate verifies the new order.

### Why

- Release preparation runs `npm run clean` before its second workspace build.
  With telemetry and AI in the same parallel phase, AI could resolve telemetry
  before `dist/index.d.ts` existed and fail deterministically on a clean runner.

### Why an extension could not handle it

- Workspace compilation order is release/build tooling that runs before the
  Senpi runtime or extension loader exists.

### Expected merge conflict zones

- LOW: `BUILD_PHASES` and its dependency-order assertions.

## Install the compiler used by workspace builds (2026-08-13)

### What changed

- Pointed the root `@typescript/native` alias at
  `@typescript/native-preview`, the package that actually provides the `tsgo`
  binary invoked by workspace build scripts.
- Added a dependency-contract test covering the manifest alias, lockfile
  package identity, pinned native compiler version, and installed `tsgo` bin.

### Why

- Clean release runners do not have a globally installed `tsgo`; telemetry must
  build before coding-agent can consume its generated declarations.

### Why an extension could not handle it

- Compiler installation and workspace build ordering happen before any Senpi
  runtime or extension is loaded.

### Expected merge conflict zones

- LOW: root development dependencies in `package.json` and `package-lock.json`.

## Registry-complete locks and owned telemetry publishing (2026-08-13)

### What changed

- Root-lock refresh now hydrates exact npm tarball URLs and integrity hashes before generating the coding-agent
  publish and installer locks; all external registry entries are validated for complete provenance.
- Publish-lock dependency traversal resolves from each source workspace and rebases nested packages into the
  staged bundle tree, so clean non-hoisted npm locks remain deterministic.
- Cross-platform optional packages absent from the host lock are resolved from exact registry versions for both
  publish and installer locks.
- Telemetry joined the fork-owned CalVer alias, release, and bundled-workspace sets as
  `@code-yeongyu/senpi-telemetry`; pack tests require its real package and runtime entrypoint.
- The SQLite backend remains private and independently versioned, with test-only local workspace dependencies so
  root installs never fetch upstream AI or agent artifacts.

### Why

- The upstream merge produced topology-valid but provenance-incomplete locks, which could not prove what npm
  tarballs a release would install and omitted non-host native optionals.
- Telemetry is imported at runtime by AI and agent packages. Leaving it outside the owned alias set split
  standalone installs from the bundled CLI and could copy a dangling workspace symlink into the publish tree.
- SQLite is not reachable from the shipped coding-agent graph, so publishing or lockstep-versioning it would add
  release surface without a consumer.

### Why an extension could not handle it

- Dependency locks, package aliases, workspace staging, and npm tarball composition are release-time behavior
  executed before the coding-agent runtime or extension loader exists.

### Expected merge conflict zones

- HIGH: `generate-coding-agent-shrinkwrap.mjs`, `generate-coding-agent-install-lock.mjs`, and
  `install-lock-validation.mjs` around source-path resolution and registry metadata validation.
- HIGH: `prepare-senpi-publish-manifest.mjs`, `prepare-senpi-bundled-workspaces.mjs`, and `publish.mjs` around
  owned aliases and bundled workspace inventories.
- MEDIUM: `release-packages.mjs`, `sync-versions.js`, and workspace package manifests around telemetry/SQLite
  version policy.

## Durable upstream merge guidance (2026-08-13)

### What changed

- Replaced stale references to a nonexistent upstream-merge workflow with the actual worktree-based two-parent
  merge process and `.github/upstream.json` baseline.
- Documented that released CalVer changelog sections are immutable, `[Unreleased]` must remain singular, upstream
  SemVer headings must be translated rather than copied, and generated lock provenance must be deterministic.

### Why

- Incorrect rebase/workflow guidance would erase upstream ancestry or send maintainers to automation that does
  not exist. The missing changelog and lock rules allowed this merge's two release-integrity regressions.

### Why an extension could not handle it

- These are repository maintenance and release invariants outside runtime behavior.

### Expected merge conflict zones

- LOW: `README.md` and `CONTRIBUTING.md` fork-sync wording.
- MEDIUM: `.github/agent/merge-driver.md` general conflict-resolution rules.

## Fork release and publish pipeline (2026-08-13)

### What changed

- Preserved CalVer release orchestration, nine-package lockstep versioning, and
  fork-scoped publish manifest rewriting.
- Installer-lock generation derives bundled internal workspaces from the
  release-managed package list, so telemetry follows the fork's CalVer alias
  policy while independently versioned sqlite remains registry-backed.
- Combined upstream native dependency isolation, baseline binary targets, and
  Bun bunfig-autoload protection with Senpi's binary assets and codesigning.
- Preserved local-release and publish behavior for fork package identities while
  adopting the session-backend directory rename and telemetry build order.

### Why

- Senpi publishes a different package set, version scheme, standalone binary,
  and bundled extension graph from upstream.
- Upstream build fixes remain necessary for deterministic cross-platform
  artifacts.

### Why an extension could not handle it

- Release, packaging, lock generation, and binary compilation happen outside
  the runtime extension system.

### Expected merge conflict zones

- HIGH: `release.mjs` and `release-packages.mjs`, around CalVer stamping and
  release-managed workspace lists.
- HIGH: `publish.mjs`, around manifest rewriting, source-only packages, and
  bundled workspace dependencies.
- MEDIUM: `local-release.mjs`, around package order and private package policy.
- HIGH: `build-binaries.sh`, around native dependency installation, Bun compile
  flags, embedded assets, target selection, and Darwin codesigning.
# Claude Agent SDK native platform lock coverage

## What changed

- Added `generate-claude-agent-sdk-platform-lock.mjs` to materialize every native optional package declared by
  the locked `@anthropic-ai/claude-agent-sdk` version into the root `package-lock.json`.
- Added a platform-matrix regression that derives the required package names and exact versions from the SDK's
  own lock entry instead of maintaining a second hard-coded list.
- Wired the generator's offline `--check` mode into the root static-validation command.

## Why

- CI installs dependencies on each runner platform with lifecycle scripts disabled. The root lock contained only
  the locally generated Darwin ARM64 SDK package, so Linux and Windows runners omitted the SDK's native Claude
  executable and six OAuth suites bypassed their injected query boundary with `Native CLI binary ... not found`.
- Keeping every SDK-declared optional in the lock lets npm select the matching binary on each runner without
  enabling arbitrary dependency lifecycle scripts.

## Why not an extension

- Dependency resolution happens before Senpi or any extension can start. Only the repository lock generator and
  CI validation can guarantee that npm has the platform package available during installation.

## Expected conflict zones

- `package-lock.json` entries for `@anthropic-ai/claude-agent-sdk-*`.
- Root `package.json` static-check scripts.
- Release/dependency lock tests under `scripts/`.
# Complete the bundled publish manifest dependency closure

## What changed

- The Senpi publish manifest now declares every portable staged transitive package at its exact staged version,
  in addition to listing it in `bundleDependencies`.
- The focused bundled-workspace test now pins both halves of npm's contract: the transitive package must be
  staged and bundled, and it must also have a manifest dependency edge so `npm pack` includes it.

## Why

- npm ignores a copied `node_modules/<package>` directory when the package appears only in
  `bundleDependencies` and has no matching `dependencies` or `optionalDependencies` entry.
- The `v2026.8.13` publish-only workflow therefore copied the full lock closure but packed only direct runtime
  packages; tarball validation correctly rejected 33 missing Google auth/protobuf transitive dependencies.

## Why not an extension

- npm decides tarball membership before Senpi or an extension can execute. The staged publish manifest is the
  only boundary that can make the copied closure part of the package.

## Expected conflict zones

- `prepare-senpi-publish-manifest.mjs` staged dependency generation.
- `prepare-senpi-bundled-workspaces.prepare.test.mjs` publish-manifest expectations.


