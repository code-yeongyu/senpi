# W0 stop-hook verification 3

## Verdict

PASS. This is a third fresh verification run after the stop-hook challenge. All command outputs and judgement markers are recorded in this directory. No unsuccessful probe artifacts are used for the completion claim in this run.

## Direct Verification

- State and commits:
  - Invocation: `git branch --show-current`, `git log -8 --oneline`, `git show --name-only --format=fuller HEAD`, commit existence checks for `9bedfb2b8`, `f2cae3281`, and `957e11fae`.
  - Observable: current branch is `feat/persistent-terminal-runtime`; expected commits exist; previous evidence DoneClaim is non-empty.
  - Artifact: `.omo/evidence/20260706-b1-w0-stop-hook-verify-3/00-state.log`

- Native prebuild freshness:
  - Invocation: `npm run check:prebuild --workspace @earendil-works/pi-pty`.
  - Observable: `fresh native prebuild for darwin-arm64` and `exit=0`.
  - Artifact: `.omo/evidence/20260706-b1-w0-stop-hook-verify-3/01-check-prebuild.log`

- Public Node loader probe:
  - Invocation: `node --input-type=module -e <import loadPtyNative from ./packages/pty/dist/index.js>`.
  - Observable: `exit=0`; loaded native exports include `PtySession`, `__senpiPtyV2026_7_5`, `startPtySession`, and `version`.
  - Artifact: `.omo/evidence/20260706-b1-w0-stop-hook-verify-3/02-node-public-loadPtyNative.log`

- Public Bun loader probe:
  - Invocation: `bun --eval <import loadPtyNative from ./packages/pty/dist/index.js>` if Bun is available.
  - Observable: `exit=0`; loaded native exports include `PtySession`, `__senpiPtyV2026_7_5`, `startPtySession`, and `version`.
  - Artifact: `.omo/evidence/20260706-b1-w0-stop-hook-verify-3/03-bun-public-loadPtyNative.log`

- Package dry-run includes shipped native layout:
  - Invocation: `npm pack --dry-run --workspace @earendil-works/pi-pty --json` plus grep for the prebuild path.
  - Observable: `exit=0`; package file list includes `native/prebuilds/darwin-arm64/senpi_pty.darwin-arm64.node`.
  - Artifacts:
    - `.omo/evidence/20260706-b1-w0-stop-hook-verify-3/04-npm-pack-dry-run.log`
    - `.omo/evidence/20260706-b1-w0-stop-hook-verify-3/04a-pack-native-path.log`

- Rust clippy:
  - Invocation: `cargo clippy --workspace --all-targets -- -D warnings`.
  - Observable: `exit=0`.
  - Artifact: `.omo/evidence/20260706-b1-w0-stop-hook-verify-3/05-cargo-clippy.log`

- Rust pty tests:
  - Invocation: `cargo test -p senpi-pty`.
  - Observable: `exit=0`; native pty tests pass.
  - Artifact: `.omo/evidence/20260706-b1-w0-stop-hook-verify-3/06-cargo-test-senpi-pty.log`

- Package tests:
  - Invocation: `npm test --workspace @earendil-works/pi-pty`.
  - Observable: `exit=0`; `5` test files and `31` tests pass.
  - Artifact: `.omo/evidence/20260706-b1-w0-stop-hook-verify-3/07-npm-test-pty.log`

- Package build:
  - Invocation: `npm run build --workspace @earendil-works/pi-pty`.
  - Observable: `exit=0`.
  - Artifact: `.omo/evidence/20260706-b1-w0-stop-hook-verify-3/08-npm-build-pty.log`

- Root check:
  - Invocation: `npm run check`.
  - Observable: `exit=0`; `check:neo: packages/neo build+vet+test passed`.
  - Artifact: `.omo/evidence/20260706-b1-w0-stop-hook-verify-3/09-npm-run-check.log`

- Fresh-copy locked native build:
  - Invocation: `git archive HEAD` into a temp directory, then `cargo build -p senpi-pty --locked`.
  - Observable: `cargo_build_locked_exit=0` and `tmp_removed_exit=0`.
  - Artifact: `.omo/evidence/20260706-b1-w0-stop-hook-verify-3/10-fresh-copy-cargo-build-locked.log`

- Final artifact audit:
  - Invocation: non-empty file check plus exact-grep checks for every required success marker.
  - Observable: every named check ends in `=0` and `artifact_audit_completed=1`.
  - Artifact: `.omo/evidence/20260706-b1-w0-stop-hook-verify-3/11-final-artifact-audit.log`
