# W6 Slop / Code Review

Scope reviewed: W6 bundling delta from `ebf53f81f^..HEAD`, with emphasis on packaging, release, generated artifact, and test quality risks. Review commands and transcripts are in this directory.

## Result

Recommendation: APPROVE after the behavior-test replacement in this change.

Blocking findings addressed:

- `scripts/local-release.test.mjs` no longer regex-matches `scripts/local-release.mjs` source text. It now runs the real local-release entrypoint against a temp monorepo fixture with fake `npm`, then asserts `packages/pty` was actually built, packed, and emitted as a tarball.
- `scripts/release.test.mjs` no longer checks only `WORKSPACE_PACKAGES.includes(...)`. It now applies a lockstep release version to temp package fixtures and asserts the `packages/pty/package.json` version is actually mutated and logged.

## Checklist Coverage

- Excessive/useless tests: The two implementation-mirroring tests were excessive relative to their signal. Replaced with behavior assertions. Existing `prepare-senpi-bundled-workspaces*` tests cover tarball metadata, copy behavior, missing native loader/prebuild failures, and all supported native target checks.
- Deletion-only tests / removal-only tests: No remaining W6 test is deletion-only. The `scripts/check-pty-prebuild-fresh.test.mjs` delta only removes obsolete `skipBuild` fixture options while preserving missing, stale, and fresh behavior assertions.
- Tautologies / implementation mirroring: The old `local-release` regex and old `WORKSPACE_PACKAGES.includes` checks are captured as weak in `old-test-weakness.mjs` and replaced. A follow-up scan found no remaining `readFileSync(...local-release.mjs)` or `WORKSPACE_PACKAGES.includes` mirror in the two blocker tests.
- Unnecessary extraction / parsing / normalization: The new fixtures use minimal JSON helpers and fake `npm` logging only where needed to drive child-process behavior. No production parser/extraction changes were introduced for the gate fix.
- Generated artifact freshness: W6 carries generated/package artifacts including `package-lock.json`, `packages/coding-agent/npm-shrinkwrap.json`, `packages/coding-agent/install-lock/package-lock.json`, and the `packages/pty/native/prebuilds/darwin-arm64` binary. Required freshness checks are covered by `npm run check`, `npm run check:prebuild --workspace @earendil-works/pi-pty`, and existing pack/prebuild tests.
- Package / shrinkwrap risks: The pty package is covered in local release packing, release version sync, bundled workspace copy checks, senpi tarball required-file assertions, shrinkwrap/install-lock diffs, and prebuild freshness validation. Residual risk is cross-platform native artifact availability outside this darwin-arm64 host; W6 mitigates via the supported target list and native-prebuild workflow, but only CI can prove every platform artifact.

## Findings

CRITICAL: none.

HIGH: none after this change.

MEDIUM: none remaining in W6 gate scope.

LOW:

- The local-release behavior test uses a fake `npm` binary to avoid a full package build and install. This is intentional for unit scope; the broader local-release smoke remains responsible for real tarball contents.

## Evidence Links

- Old-test weakness demo: `01-old-test-weakness.log`
- Focused local release test: `04-local-release-test-rerun.log`
- Focused release test: `03-release-test-initial.log`
- Final full verification logs are recorded separately in this directory after the final run.
