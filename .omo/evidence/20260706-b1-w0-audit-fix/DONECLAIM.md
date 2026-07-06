# W0 audit blocker fix DoneClaim

## Result

W0 audit blockers from `.omo/evidence/20260706-b1-audit-w0-foundations.md` are fixed in the shared worktree.

## Scenarios and evidence

- Scenario: public package loader uses shipped `native/prebuilds/<host>` layout.
  - Invocation: `node --input-type=module -e <public loadPtyNative probe>`.
  - Binary observable: exit `0`; loaded exports include `PtySession`, `__senpiPtyV2026_7_5`, `startPtySession`, and `version`.
  - Artifact: `.omo/evidence/20260706-b1-w0-audit-fix/27-node-public-loader-probe-final3.log`.

- Scenario: Bun public package loader uses the same shipped layout when Bun is available.
  - Invocation: `bun --eval <public loadPtyNative probe>`.
  - Binary observable: exit `0`; loaded exports include `PtySession`, `__senpiPtyV2026_7_5`, `startPtySession`, and `version`.
  - Artifact: `.omo/evidence/20260706-b1-w0-audit-fix/28-bun-public-loader-probe-final3.log`.

- Scenario: loader tests cover the shipped layout and real host prebuild when present.
  - Invocation: `npm test --workspace @earendil-works/pi-pty`.
  - Binary observable: exit `0`; 5 files, 31 tests passed.
  - Artifact: `.omo/evidence/20260706-b1-w0-audit-fix/23-npm-test-pty-final2.log`.

- Scenario: Rust native build path is clippy-clean.
  - Invocation: `cargo clippy --workspace --all-targets -- -D warnings`.
  - Binary observable: exit `0`.
  - Artifact: `.omo/evidence/20260706-b1-w0-audit-fix/21-cargo-clippy-final.log`.

- Scenario: Rust native tests pass.
  - Invocation: `cargo test -p senpi-pty`.
  - Binary observable: exit `0`; 12 unit tests and 1 manual QA test passed.
  - Artifact: `.omo/evidence/20260706-b1-w0-audit-fix/22-cargo-test-final.log`.

- Scenario: root `Cargo.lock` supports locked fresh native builds.
  - Invocation: copy tracked files plus `Cargo.lock` into a temp directory, then `cargo build -p senpi-pty --locked`.
  - Binary observable: exit `0`.
  - Artifact: `.omo/evidence/20260706-b1-w0-audit-fix/30-fresh-copy-cargo-build-locked.log`.

- Scenario: package build succeeds.
  - Invocation: `npm run build --workspace @earendil-works/pi-pty`.
  - Binary observable: exit `0`.
  - Artifact: `.omo/evidence/20260706-b1-w0-audit-fix/24-pty-build-final2.log`.

- Scenario: vendored native prebuild is fresh.
  - Invocation: `npm run check:prebuild --workspace @earendil-works/pi-pty`.
  - Binary observable: exit `0`; reports fresh `darwin-arm64` prebuild.
  - Artifact: `.omo/evidence/20260706-b1-w0-audit-fix/25b-check-prebuild-final3.log`.

- Scenario: package dry-run ships the native prebuild.
  - Invocation: `npm pack --dry-run --workspace @earendil-works/pi-pty --json`.
  - Binary observable: exit `0`; file list includes `native/prebuilds/darwin-arm64/senpi_pty.darwin-arm64.node`.
  - Artifact: `.omo/evidence/20260706-b1-w0-audit-fix/29-npm-pack-dry-run-final3.log`.

- Scenario: full repository check.
  - Invocation: `npm run check`.
  - Binary observable: exit `0`.
  - Artifact: `.omo/evidence/20260706-b1-w0-audit-fix/31-npm-run-check-final.log`.

- Scenario: W0 code-review/slop coverage exists.
  - Invocation: manual review against the W0 audit blockers and loaded slop criteria.
  - Binary observable: non-empty markdown artifact with explicit blocker/slop conclusions.
  - Artifact: `.omo/evidence/20260706-b1-w0-audit-fix/00-code-review-slop-evidence.md`.

- Scenario: referenced plan path exists.
  - Invocation: `shasum -a 256 .omo/plans/persistent-terminal-tool.md /Users/yeongyu/local-workspaces/senpi/.omo/plans/persistent-terminal-tool.md`.
  - Binary observable: matching sha256 `7351122cc06eb1e37f370e4218c40304f48672769fb2f0a93bc1174ecffb2add`.
  - Artifact: command output captured during implementation; plan file is committed at `.omo/plans/persistent-terminal-tool.md`.

## Cleanup and concurrency

- Temporary fresh-copy directory from the locked Cargo build was removed by the verification command.
- The worktree contains concurrent PR-B1 W1/W2/W6 staged and unstaged changes that are not part of the W0 commit. They were left intact.
