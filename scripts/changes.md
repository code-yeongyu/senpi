# changes

## Install-script allowlist follows the @google/genai bump (2026-08-20)

### What changed

- `scripts/generate-coding-agent-shrinkwrap.mjs` and `scripts/generate-coding-agent-install-lock.mjs`: the allowed-install-script entry moved from `@google/genai@2.13.0` to `@google/genai@2.18.0`. The `protobufjs@7.6.5` entry is unchanged because the protobufjs major was not taken.

### Why

- Both generators refuse to emit a lock that contains an unreviewed lifecycle script, and the allowlist is keyed by exact `name@version`. Bumping `@google/genai` without moving the allowlist string would fail generation even though the package's `preinstall` is still the same no-op that was reviewed.

### Why an extension could not handle it

- These generators run as repository tooling to produce committed lock artifacts before anything is published or installed, so no extension participates in their execution.

### Expected merge conflict zones

- LOW: the `allowedInstallScriptPackages` map in each generator, which only changes when a lifecycle-script dependency is bumped.

## Reviewer-cited tracker parser, collector, and CI hardening (2026-08-17)

### What changed

- `scripts/changes-md-policy.mjs` now parses date-first `## YYYY-MM-DD` headings as well as `## Title (YYYY-MM-DD)`, maps established Why / extension-why / conflict heading dialects onto the four canonical sections, excludes every `*.generated.ts` (and `.mts`/`.cts`/`.js`) catalog-style source from production and CHANGELOG runtime classification, and exports `restrictTrackerEntriesToAddedLines` so a PR only gets credit for bullets it actually added.
- Split git/filesystem collectors into `scripts/changes-md-git.mjs`. `listTrackerFiles` skips symlink `changes.md` files. `validateGitRevision` rejects option-like or metacharacter-bearing `--base` values before they reach git.
- `scripts/check-pr-changelog.mjs` uses the added-line restrictor instead of the stale `entryTouchesDiff` path-substring bypass, exports `parseArgs` so labels can come from `CHANGELOG_GATE_LABELS` / `CHANGELOG_GATE_BASE`, and validates `--base` through `validateGitRevision`.
- `.github/workflows/changelog-gate.yml` passes base SHA and labels through those env vars instead of interpolating label names into the shell command.
- Added `scripts/changes-md-reviewer-fixes.test.mjs` for the date-first, dialect, generated, symlink, added-line, revision, and env-label contracts.

### Why

- Review of the first implementation found that date-first trackers and established heading aliases were treated as uncovered, stale full-file entries could satisfy a PR, symlink trackers and `*.generated.ts` files were misclassified, and workflow label interpolation plus unvalidated `--base` were injection surfaces.

### Why an extension could not handle it

- These are repository CI and audit-script contracts. They run in the changelog-gate workflow and local Node CLIs before any Senpi runtime or extension loader exists.

### Expected merge conflict zones

- LOW: heading-split regex and `SECTION_ALIASES` in `scripts/changes-md-policy.mjs`.
- LOW: `parseArgs` / added-line collection in `scripts/check-pr-changelog.mjs`.
- NONE: `scripts/changes-md-git.mjs` and `scripts/changes-md-reviewer-fixes.test.mjs` are fork-owned additions.


## Repository-wide changes.md audit backfill for validation and transcript tooling (2026-08-17)

### What changed

- Backfill from the repository-wide changes.md audit (pin 914cf147, tag v0.84.2): records the fork deltas on upstream-owned utility scripts. The binary, release, pinning, and publish pipeline deltas remain recorded in the entries below.
- `scripts/check-pinned-deps.mjs`: `isInternalWorkspaceDependency()` now also recognizes `@code-yeongyu/*` names, so fork-scoped workspace and alias dependencies are exempt from the exact-version pinning rule exactly like `@earendil-works/pi-*`.
- `scripts/check-ts-relative-imports.mjs`: imports the TypeScript API from `@typescript/typescript6` because TypeScript 7 removed the classic programmatic JS API, and skips the generated `evidence/` and `local-ignore/` QA trees when collecting TypeScript files.
- `scripts/session-transcripts.ts`: the shebang is now `npx tsx` so the TypeScript source runs directly, and the `--analyze` subagent mode was removed with the delegated execution runtime - the pi JSON-event spawn machinery, readline parsing, truncation helpers, and the AGENTS.md pattern-mining prompt are gone; only cwd-scoped transcript extraction and context-sized splitting remain.
- `scripts/tool-stats.ts`: hardened tool-call accounting with an `isRecord` guard for bash arguments and destructured `id`/`name` string checks instead of `"name" in block` probes, keeping the script type-safe under the typed Message shape without `any`.

### Why

- Fork-scoped package identities, the TypeScript 7 toolchain split, the removal of the delegated execution runtime, and the typed message shape each changed an assumption these utility scripts were written against; an untracked divergence would hide the exact reason the fork cannot take upstream's version verbatim on the next sync.

### Why an extension could not handle it

- These are repository validation and analysis scripts executed outside any Senpi runtime or extension loader.

### Expected merge conflict zones

- LOW: the internal-name predicate in `scripts/check-pinned-deps.mjs`, the import and ignore list in `scripts/check-ts-relative-imports.mjs`, the shebang and mode surface of `scripts/session-transcripts.ts`, and the narrowing guards in `scripts/tool-stats.ts`.

## Changes.md tracker policy enforced by the changelog gate and a repository audit (2026-08-17)

### What changed

- `scripts/check-pr-changelog.mjs` (modified upstream file) now audits changes.md tracker coverage in addition to the release `CHANGELOG.md` requirement: every upstream-owned production change in a PR must be covered by an entry with all four canonical sections in its exact nearest `changes.md` tracker. The `no-changelog` label still bypasses only the `CHANGELOG.md` requirement, never the tracker policy.
- Added `scripts/changes-md-policy.mjs`, the shared policy module: production-path classification (docs, tests, fixtures, examples, generated catalogs, lockfiles, trackers, and `.github/upstream.json` are excluded), exact nearest-ancestor tracker resolution, canonical-section coverage checks, rename/delete auditing rules, and fail-closed upstream-pin validation plus the git/filesystem collectors both tools share.
- Added `scripts/audit-changes-md.mjs`, a repository-wide audit CLI (`--upstream <path>`, `--format json|markdown`, `--help`) that compares HEAD against the pinned upstream SHA, exempts fork-only paths absent from the pin tree, and reports covered/uncovered paths with their nearest tracker and a reason, exiting 1 when anything is uncovered.
- The PR CLI now parses rename-aware `git diff --name-status -M base...HEAD`, reads `.github/upstream.json`, verifies the pinned commit exists, distinguishes fork-only from upstream-owned paths via the pin tree, and audits only integration repairs (`divergentFiles`) on pin-changing syncs. `--help` was added to both CLIs.
- Added failing-first suites `scripts/check-pr-changes-md.test.mjs` and `scripts/audit-changes-md.test.mjs` that pin the seam contract (`trackerPolicy` input, ordered `uncovered` output).

### Why

- AGENTS.md already required every upstream-owned production edit to update the nearest `changes.md` in the same increment, but nothing verified it, so stale entries accumulated silently and misled the next upstream sync.
- The existing gate only checked for any `CHANGELOG.md` edit, which a package-unrelated changelog could satisfy; coverage must be exact-nearest-tracker and must name the audited path.

### Why an extension could not handle it

- The rule is repository and CI policy: it must run in the changelog-gate workflow and in local audit tooling before any Senpi runtime or extension loader exists, so only repository scripts under `scripts/` can enforce it.

### Expected merge conflict zones

- LOW: `scripts/check-pr-changelog.mjs` `checkPrChangelog` verdict wiring and CLI argument parsing; upstream may add gate flags.
- LOW: `scripts/changes-md-policy.mjs` classifier patterns and canonical-section aliases; upstream has no equivalent file.
- NONE: `scripts/audit-changes-md.mjs` and both test files are fork-owned additions.

## Require provenance-backed npm release publication (2026-08-13)

### What changed

- Release publication now refuses to build an npm publish command outside
  GitHub Actions.
- All seven registry package source manifests are private; the canonical
  publisher creates temporary public manifests only inside its validated
  release flow.
- Lockstep validation and release-announcement enumeration now use one explicit
  source-to-registry package map instead of inferring publication from
  `private`.
- Root `publish` and `publish:dry` scripts now route through the guarded
  publisher instead of calling npm workspaces directly.
- The trusted workflow continues to publish every package with
  `--provenance`; dry-run validation remains available locally because it
  exits before publication.
- Added regression coverage for both the rejected local release path and the
  attested GitHub Actions path.

### Why

- The first telemetry package creation required a one-time local recovery, and
  the remaining release packages were then published without npm provenance
  because the local command silently omitted `--provenance`.
- The root workspace publish command was a second bypass because forwarded npm
  arguments could override its literal provenance flag.
- The coding-agent and codemode source packages were also directly publishable
  through native npm workspace/package commands, bypassing both the provenance
  guard and canonical bundle validation.
- npm package versions are immutable, so the safe invariant is to reject future
  local release publication and require the trusted OIDC workflow.

### Why an extension could not handle it

- npm publication runs in repository release tooling before the Senpi runtime
  or extension loader exists.

### Expected merge conflict zones

- LOW: source package privacy, registry alias enumeration, root publish scripts,
  `buildPublishArgs` in `publish-command.mjs`, and their focused tests.

## Parse npm pack JSON after warning output (2026-08-13)

### What changed

- Added a parser that scans `npm pack --json` output for the final valid JSON
  array instead of parsing the entire stdout stream directly, including when npm
  emits warnings after the JSON payload.
- Added regression coverage using the workspace/config warnings emitted during
  the failed first Senpi telemetry publication.
- Publish staging now materializes any missing optional runtime package directly
  from the exact tarball URL and integrity recorded in the root lock before
  preparing the bundled Senpi package.
- Final tarball validation now requires the publish manifest's actual
  `bundleDependencies`, excluding platform-constrained optional packages that
  intentionally remain registry-resolved on the installing machine.
- Portable hoisted transitive packages are promoted to exact temporary
  dependencies in the staged publish manifest so npm includes every declared
  bundle member in the final Senpi tarball.

### Why

- npm can print warnings before its JSON payload. The publish workflow prepared
  the package successfully but failed before `npm publish` because the warning
  prefix made raw `JSON.parse` reject the output.
- Cross-platform native packages are intentionally present in the lock but npm
  installs only the current host variant. Senpi bundles those platform binaries,
  so publish staging must reify the missing locked variants without changing
  manifests or lockfiles.

### Why an extension could not handle it

- Package packing and npm publication run in release tooling before any Senpi
  runtime or extension is loaded.

### Expected merge conflict zones

- LOW: `validatePack` in `publish.mjs` and `parseNpmPackJson` in `npm-pack-json.mjs`.

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

## Independent workspace dependency synchronization (2026-08-19)

### What changed

- `scripts/sync-versions.js` now visits independently versioned private workspaces when it
  synchronizes dependencies, while still excluding their own package versions from the Senpi
  CalVer lockstep invariant.
- `scripts/sync-versions.test.mjs` covers the SQLite backend retaining version `0.83.0` while
  its `pi-agent-core` and `pi-ai` dependency ranges advance to the current lockstep version.

### Why

- The nested SQLite backend ships imports from the lockstep agent and AI packages. Keeping its
  own upstream version independent must not leave those runtime dependency ranges stale during
  a Senpi release.

### Why an extension could not handle it

- Version synchronization mutates package manifests before build, commit, tag, and publication.
  Extensions run only after installation and cannot participate in release-time manifest
  generation.

### Expected conflict zones

- Future changes to the independent-package allowlist in `scripts/sync-versions.js`.
- Upstream changes that add more independently versioned workspaces with lockstep runtime
  dependencies.

