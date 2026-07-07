# W1 Native Core Manual QA Matrix

Verdict: PASS after gate-fix split.

## Scope

- Worktree: `/Users/yeongyu/local-workspaces/senpi-wt/persistent-terminal-b1`
- Branch: `feat/persistent-terminal-runtime`
- W1-owned implementation paths:
  - `crates/senpi-pty/src/session.rs`
  - `crates/senpi-pty/src/session_threads.rs`
  - `crates/senpi-pty/src/lib.rs`
- Evidence directory for this fix: `.omo/evidence/20260706-b1-w1-gate-fix/`
- Prior W1 behavior evidence referenced for continuity:
  `.omo/evidence/20260706-w1-native-audit-stop-hook-verify-3/`

## Criteria Matrix

| W1 criterion | Scenario / invocation | Observable | Evidence |
|---|---|---|---|
| Baseline preserved before refactor | `cargo test -p senpi-pty --locked` before editing | 12 unit tests, 1 manual QA test, and doc tests passed | `.omo/evidence/20260706-b1-w1-gate-fix/01-baseline-cargo-test.txt` |
| `session.rs` under pure LOC ceiling | `awk` pure LOC count for `crates/senpi-pty/src/*.rs` after split | `session.rs` = 243, `session_threads.rs` = 39, every Rust source file <= 250 pure LOC | `.omo/evidence/20260706-b1-w1-gate-fix/06-loc-check-post-split.txt` |
| Native lifecycle still passes package tests | `cargo test -p senpi-pty --locked` after split | 12 unit tests, 1 manual QA test, and doc tests passed | `.omo/evidence/20260706-b1-w1-gate-fix/03-post-split-cargo-test.txt` |
| Manual PTY round trip, resize, kill | `cargo test -p senpi-pty --test manual_qa -- --nocapture` | Transcript includes cat bytes, resize bytes `42 123`, spawned child pid, and killed child not alive | `.omo/evidence/20260706-w1-native-audit-stop-hook-verify-3/06-cargo-test-manual-qa.txt` |
| Raw native `.node` lifecycle | `node scripts/probe-native-pty-lifecycle.mjs packages/pty/native/prebuilds/darwin-arm64/senpi_pty.darwin-arm64.node` | Exports include `PtySession`, `startPtySession`, sentinel, `version`; methods include `write`, `resize`, `kill`, `waitExit`; output includes `senpi-native-probe`; exit cancelled | `.omo/evidence/20260706-b1-w1-gate-fix/12-node-raw-native-lifecycle.txt` |
| Public wrapper native lifecycle | `npx tsx /tmp/w1-public-pty-probe.mts` | `backend: native`; output includes `senpi-public-native-probe-current`; exit cancelled and not timed out | `.omo/evidence/20260706-b1-w1-gate-fix/13-node-public-create-terminal-session-current.txt` |
| Rust formatting clean | `cargo fmt -p senpi-pty --check` after rustfmt | Exit 0 | `.omo/evidence/20260706-b1-w1-gate-fix/05-cargo-fmt-check-after-rustfmt.txt` |
| Required full package validation | `cargo test -p senpi-pty --locked`; `cargo clippy -p senpi-pty --all-targets --locked -- -D warnings`; `npm test --workspace @earendil-works/pi-pty`; `npm run check:prebuild --workspace @earendil-works/pi-pty`; `npm run check` | Exit 0 for each command | `.omo/evidence/20260706-b1-w1-gate-fix/07-*` through `.omo/evidence/20260706-b1-w1-gate-fix/11-*` |
| Native prebuild refreshed | `node packages/pty/native/check-prebuild-fresh.mjs --update`, then `npm run check:prebuild --workspace @earendil-works/pi-pty` | Host prebuild updated, then reported fresh for `darwin-arm64` | `.omo/evidence/20260706-b1-w1-gate-fix/10a-update-native-prebuild.txt`; `.omo/evidence/20260706-b1-w1-gate-fix/10-npm-check-prebuild-pi-pty.txt` |
| Cleanup / no leftover QA processes | `pgrep -af` checks for W1 QA process names plus git status after commit | No matching live QA process remains; status captured | `.omo/evidence/20260706-b1-w1-gate-fix/CLEANUP-RECEIPT.md`; `.omo/evidence/20260706-b1-w1-gate-fix/12-git-status-after-commit.txt` |

## Notes

- The new implementation evidence supersedes the first failed formatting check at
  `.omo/evidence/20260706-b1-w1-gate-fix/02-cargo-fmt-check-post-split.txt`; rustfmt was applied and the passing check is captured separately.
- Fresh raw native and public wrapper lifecycle probes were captured after refreshing the host prebuild. The prior W1 lifecycle transcripts remain useful continuity evidence for the same surfaces before this gate-fix split.
