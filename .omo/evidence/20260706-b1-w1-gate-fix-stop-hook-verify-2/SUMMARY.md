# W1 Gate Fix Stop-Hook Verification 2

Verdict: PASS.

## Target

- Worktree: `/Users/yeongyu/local-workspaces/senpi-wt/persistent-terminal-b1`
- Branch: `feat/persistent-terminal-runtime`
- W1 implementation commit: `04e55140e fix(pty): split native session helpers`
- Prior W1 verification commit: `82a7da186 docs(pty): record W1 gate fix stop-hook verification`

## Evidence

| Criterion | Invocation | Result | Evidence |
|---|---|---|---|
| Current state and committed W1 artifacts | `git log -3 --oneline`; `git status --short`; `git show --name-status --oneline --summary 04e55140e`; `git show --name-status --oneline --summary 82a7da186` | W1 implementation and prior verification commits are present; unrelated untracked evidence remains in the shared worktree | `01-state-and-commits.txt` |
| Pure LOC ceiling | `awk` pure LOC check for `crates/senpi-pty/src/*.rs` | `session.rs` = 243, `session_threads.rs` = 39, all files <= 250 pure LOC | `02-loc-check.txt` |
| Required W1 evidence presence | `test -s` and `git ls-tree` checks | W1 matrix, slop review, cleanup receipt, and prior verification summary are present and tracked | `03-evidence-presence.txt` |
| Rust tests | `cargo test -p senpi-pty --locked` | Passed: 12 unit tests, 1 manual QA test, doc tests | `04-cargo-test-senpi-pty-locked.txt` |
| Rust lint | `cargo clippy -p senpi-pty --all-targets --locked -- -D warnings` | Passed | `05-cargo-clippy-senpi-pty-all-targets.txt` |
| Package tests | `npm test --workspace @earendil-works/pi-pty` | Passed: 5 files, 31 tests | `06-npm-test-pi-pty.txt` |
| Prebuild freshness | `npm run check:prebuild --workspace @earendil-works/pi-pty` | Passed: fresh native prebuild for `darwin-arm64` | `07-npm-check-prebuild-pi-pty.txt` |
| Repo check | `npm run check` | Passed | `08-npm-run-check.txt` |
| Raw native lifecycle | `node scripts/probe-native-pty-lifecycle.mjs packages/pty/native/prebuilds/darwin-arm64/senpi_pty.darwin-arm64.node` | Exports/methods present; output includes `senpi-native-probe`; exit is cancelled and not timed out | `09-node-raw-native-lifecycle.txt` |
| Public wrapper lifecycle | `npx tsx /tmp/w1-stop-hook-public-pty-probe-2.mts` | `backend: native`; output includes `senpi-stop-hook-native-probe-2`; kill ok; exit cancelled and not timed out | `10-node-public-create-terminal-session.txt` |
| Cleanup | Remove temp probe and scan W1 QA process names | Temp probe removed; no matching W1 QA processes remain; no tmux/browser sessions started | `11-cleanup-receipt.txt` |

## Judgment

The W1 gate-fix claim is verified again from the current checkout. The native-core file split satisfies the pure LOC ceiling, the native prebuild is fresh, package and repo checks pass, and both raw native and public terminal-session lifecycles work through CLI stdout probes.
