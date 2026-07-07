# W0 stop-hook verification

## Verdict

PASS after repair. The first stop-hook `check:prebuild` rerun failed because the vendored `darwin-arm64` prebuild was stale. I refreshed it with the package update command and reran the relevant checks.

## Evidence

- Commit/file inventory:
  - Invocation: `git log -1 --oneline && git show --name-only --format=fuller HEAD`
  - Observable: current W0 commit and committed files listed.
  - Artifact: `.omo/evidence/20260706-b1-w0-stop-hook-verify-1/01-head-commit-and-files.log`

- Node public loader:
  - Invocation: `node --input-type=module -e <loadPtyNative public probe>`
  - Observable: exit `0`; loaded native exports include `PtySession`, `__senpiPtyV2026_7_5`, `startPtySession`, and `version`.
  - Artifact: `.omo/evidence/20260706-b1-w0-stop-hook-verify-1/11-node-public-loader-after-repair.log`

- Bun public loader:
  - Invocation: `bun --eval <loadPtyNative public probe>`
  - Observable: exit `0`; loaded native exports include `PtySession`, `__senpiPtyV2026_7_5`, `startPtySession`, and `version`.
  - Artifact: `.omo/evidence/20260706-b1-w0-stop-hook-verify-1/12-bun-public-loader-after-repair.log`

- Rust clippy:
  - Invocation: `cargo clippy --workspace --all-targets -- -D warnings`
  - Observable: exit `0`.
  - Artifact: `.omo/evidence/20260706-b1-w0-stop-hook-verify-1/04-cargo-clippy.log`

- Rust tests:
  - Invocation: `cargo test -p senpi-pty`
  - Observable: exit `0`.
  - Artifact: `.omo/evidence/20260706-b1-w0-stop-hook-verify-1/05-cargo-test.log`

- Package tests:
  - Invocation: `npm test --workspace @earendil-works/pi-pty`
  - Observable: exit `0`.
  - Artifact: `.omo/evidence/20260706-b1-w0-stop-hook-verify-1/06-npm-test-pty.log`

- Package build:
  - Invocation: `npm run build --workspace @earendil-works/pi-pty`
  - Observable: exit `0`.
  - Artifact: `.omo/evidence/20260706-b1-w0-stop-hook-verify-1/07-npm-build-pty.log`

- Prebuild freshness:
  - Initial invocation: `npm run check:prebuild --workspace @earendil-works/pi-pty`
  - Initial observable: exit `1`; stale `darwin-arm64` prebuild.
  - Repair invocation: `npm run check:prebuild --workspace @earendil-works/pi-pty -- --update`
  - Final invocation: `npm run check:prebuild --workspace @earendil-works/pi-pty`
  - Final observable: exit `0`; fresh `darwin-arm64` prebuild.
  - Artifacts:
    - `.omo/evidence/20260706-b1-w0-stop-hook-verify-1/08-check-prebuild.log`
    - `.omo/evidence/20260706-b1-w0-stop-hook-verify-1/08c-check-prebuild-update-repair.log`
    - `.omo/evidence/20260706-b1-w0-stop-hook-verify-1/08d-check-prebuild-after-repair.log`

- Locked fresh-copy native build:
  - Invocation: copy tracked files plus `Cargo.lock` into a temp directory, then `cargo build -p senpi-pty --locked`.
  - Observable: exit `0`.
  - Artifact: `.omo/evidence/20260706-b1-w0-stop-hook-verify-1/09-fresh-copy-cargo-build-locked.log`

- Package dry-run:
  - Invocation: `npm pack --dry-run --workspace @earendil-works/pi-pty --json`
  - Observable: exit `0`; includes `native/prebuilds/darwin-arm64/senpi_pty.darwin-arm64.node`.
  - Artifact: `.omo/evidence/20260706-b1-w0-stop-hook-verify-1/10-npm-pack-dry-run-after-repair.log`

- Root check:
  - Invocation: `npm run check`
  - Observable: exit `0`.
  - Artifacts:
    - `.omo/evidence/20260706-b1-w0-stop-hook-verify-1/13-npm-run-check-after-repair.log`
    - `.omo/evidence/20260706-b1-w0-stop-hook-verify-1/14-npm-run-check-before-commit.log`

## Notes

- The temp directory from locked fresh-copy verification was removed by the command.
- This evidence directory records the failed stale-prebuild check and the subsequent repair, so the final claim is based on the post-repair artifacts.
- Concurrent W1/W6 commits landed after the repair attempt. The current branch tip was rechecked:
  - `.omo/evidence/20260706-b1-w0-stop-hook-verify-1/15-current-head-after-concurrent-commits.log`
  - `.omo/evidence/20260706-b1-w0-stop-hook-verify-1/16-check-prebuild-current-head.log`
  - `.omo/evidence/20260706-b1-w0-stop-hook-verify-1/17-node-loader-current-head.log`
  - `.omo/evidence/20260706-b1-w0-stop-hook-verify-1/18-bun-loader-current-head.log`
  - `.omo/evidence/20260706-b1-w0-stop-hook-verify-1/19-npm-run-check-current-head.log`
