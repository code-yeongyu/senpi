# W1 Gate Fix Stop-Hook Verification

Verdict: PASS.

## Target

- Worktree: `/Users/yeongyu/local-workspaces/senpi-wt/persistent-terminal-b1`
- Branch: `feat/persistent-terminal-runtime`
- Verified implementation commit: `04e55140e fix(pty): split native session helpers`

## Direct Checks

| Criterion | Invocation | Result | Evidence |
|---|---|---|---|
| Commit and status inspection | `git log -1 --oneline`; `git status --short`; `git show --name-status --oneline --summary HEAD` | `04e55140e` is HEAD; W1 evidence files from the gate-fix commit are tracked; unrelated W6/release-test work is present in the shared index/worktree | `01-state-and-commit.txt` |
| Required evidence presence | `find`; `git ls-tree`; `test -s` over W1 artifacts | Required W1 gate-fix evidence files are present and non-empty; `17-git-status-after-commit.txt` and `18-commit-receipt.txt` are present locally but not tracked in `04e55140e` | `02-evidence-presence.txt` |
| Pure LOC ceiling | `awk` pure LOC check for `crates/senpi-pty/src/*.rs` | `session.rs` = 243, `session_threads.rs` = 39, all files <= 250 pure LOC | `03-loc-check.txt` |
| Rust tests | `cargo test -p senpi-pty --locked` | Passed: 12 unit tests, 1 manual QA test, doc tests | `04-cargo-test-senpi-pty-locked.txt` |
| Rust lint | `cargo clippy -p senpi-pty --all-targets --locked -- -D warnings` | Passed | `05-cargo-clippy-senpi-pty-all-targets.txt` |
| Package tests | `npm test --workspace @earendil-works/pi-pty` | Passed: 5 files, 31 tests | `06-npm-test-pi-pty.txt` |
| Prebuild freshness | `npm run check:prebuild --workspace @earendil-works/pi-pty` | Passed: fresh native prebuild for `darwin-arm64` | `07-npm-check-prebuild-pi-pty.txt` |
| Repo check | `npm run check` | Passed | `08-npm-run-check.txt` |
| Raw native lifecycle | `node scripts/probe-native-pty-lifecycle.mjs packages/pty/native/prebuilds/darwin-arm64/senpi_pty.darwin-arm64.node` | Exports/methods present; output includes `senpi-native-probe`; exit is cancelled and not timed out | `09-node-raw-native-lifecycle.txt` |
| Public wrapper lifecycle | `npx tsx /tmp/w1-stop-hook-public-pty-probe.mts` | `backend: native`; output includes `senpi-stop-hook-native-probe`; kill ok; exit cancelled and not timed out | `10-node-public-create-terminal-session.txt` |
| Cleanup | Remove temp probe and scan W1 QA process names | Temp probe removed; no matching W1 QA processes remain; no tmux/browser sessions started | `11-cleanup-receipt.txt` |
| Final status | `git status --short` | Shows unrelated staged W6/release-test work plus this stop-hook evidence directory; W1 implementation paths are clean after commit | `12-git-status-after-verify.txt` |

## Judgment

The W1 implementation claim is verified against the current checkout. The file-size blocker is fixed by the helper split, required command gates pass, and CLI stdout lifecycle probes exercise both the raw native binding and public `createTerminalSession` surface.

The shared index contains unrelated W6 evidence and release-test changes from another agent. This stop-hook verification does not stage or commit those unrelated paths.
