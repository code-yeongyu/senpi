# W0 stop-hook verification 2

## Verdict

PASS. This is a fresh verification run after the second stop-hook challenge. The initial loader probe files in this directory show probe mistakes (`02-node-loader.log`, `03-bun-loader.log`, `02b-node-loader-corrected.log`, `03b-bun-loader-corrected.log`); the passing public API probes are `02c-node-public-loadPtyNative.log` and `03c-bun-public-loadPtyNative.log`.

## Direct Verification

- Current branch and commits:
  - Invocation: `git branch --show-current`, `git log -6 --oneline`, `git cat-file -e 9bedfb2b8^{commit}`, `git cat-file -e f2cae3281^{commit}`.
  - Observable: branch is `feat/persistent-terminal-runtime`; commits `9bedfb2b8` and `f2cae3281` exist; prior DoneClaim/current-head check artifacts are non-empty.
  - Artifact: `.omo/evidence/20260706-b1-w0-stop-hook-verify-2/00-state.log`

- Native prebuild freshness:
  - Invocation: `npm run check:prebuild --workspace @earendil-works/pi-pty`.
  - Observable: `fresh native prebuild for darwin-arm64` and `exit=0`.
  - Artifact: `.omo/evidence/20260706-b1-w0-stop-hook-verify-2/01-check-prebuild.log`

- Public Node `loadPtyNative()` probe:
  - Invocation: `node --input-type=module -e <import loadPtyNative from ./packages/pty/dist/index.js>`.
  - Observable: `exit=0`; exports include `PtySession`, `__senpiPtyV2026_7_5`, `startPtySession`, and `version`.
  - Artifact: `.omo/evidence/20260706-b1-w0-stop-hook-verify-2/02c-node-public-loadPtyNative.log`

- Public Bun `loadPtyNative()` probe:
  - Invocation: `bun --eval <import loadPtyNative from ./packages/pty/dist/index.js>`.
  - Observable: `exit=0`; exports include `PtySession`, `__senpiPtyV2026_7_5`, `startPtySession`, and `version`.
  - Artifact: `.omo/evidence/20260706-b1-w0-stop-hook-verify-2/03c-bun-public-loadPtyNative.log`

- Package dry-run includes shipped native layout:
  - Invocation: `npm pack --dry-run --workspace @earendil-works/pi-pty --json`.
  - Observable: `exit=0`; package file list includes `native/prebuilds/darwin-arm64/senpi_pty.darwin-arm64.node`.
  - Artifacts:
    - `.omo/evidence/20260706-b1-w0-stop-hook-verify-2/04-npm-pack-dry-run.log`
    - `.omo/evidence/20260706-b1-w0-stop-hook-verify-2/04a-pack-native-paths.log`

- Rust clippy:
  - Invocation: `cargo clippy --workspace --all-targets -- -D warnings`.
  - Observable: `exit=0`.
  - Artifact: `.omo/evidence/20260706-b1-w0-stop-hook-verify-2/05-cargo-clippy.log`

- Rust pty tests:
  - Invocation: `cargo test -p senpi-pty`.
  - Observable: `exit=0`; native tests pass.
  - Artifact: `.omo/evidence/20260706-b1-w0-stop-hook-verify-2/06-cargo-test-senpi-pty.log`

- Package tests:
  - Invocation: `npm test --workspace @earendil-works/pi-pty`.
  - Observable: `exit=0`; `5` test files and `31` tests pass.
  - Artifact: `.omo/evidence/20260706-b1-w0-stop-hook-verify-2/07-npm-test-pty.log`

- Package build:
  - Invocation: `npm run build --workspace @earendil-works/pi-pty`.
  - Observable: `exit=0`.
  - Artifact: `.omo/evidence/20260706-b1-w0-stop-hook-verify-2/08-npm-build-pty.log`

- Root check:
  - Invocation: `npm run check`.
  - Observable: `exit=0`; `check:neo: packages/neo build+vet+test passed`.
  - Artifact: `.omo/evidence/20260706-b1-w0-stop-hook-verify-2/09-npm-run-check.log`

- Cleanup:
  - Invocation: remove the temporary probe file.
  - Observable: `tmp_probe_removed_exit=0`.
  - Artifact: `.omo/evidence/20260706-b1-w0-stop-hook-verify-2/10-cleanup.log`

- Final artifact audit:
  - Invocation: non-empty file check plus exact-grep checks for all required success markers.
  - Observable: every check line ends in `=0` and `artifact_audit_completed=1`.
  - Artifact: `.omo/evidence/20260706-b1-w0-stop-hook-verify-2/11-final-artifact-audit.log`

## Notes

- The failed probe artifacts are retained intentionally as audit history. They failed due to incorrect probe paths/entrypoints, not native loader behavior.
- Final passing loader evidence is from the public package root API, `loadPtyNative()` exported by `packages/pty/dist/index.js`.
