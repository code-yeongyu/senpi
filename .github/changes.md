## 2026-10-30 - Pull-request CI runs only for PRs labelled run-full-ci (senpi#4968)

### What changed

- `.github/workflows/ci.yml`: no `pull_request` trigger. `push` (main) and `workflow_call` are unchanged. On a pull request the workflow runs only when `ci-full-label.yml` calls it.

### Why

- senpi#4968: merges are decided on a local whole-suite receipt at the exact head plus a review, so a hosted run on every PR push only held the account's shared runners, and a release job waited over an hour for one. Without a job-level gate, the required `Check and test` context stays expected on an unlabelled PR instead of passing as skipped.

### Why an extension could not handle it

- CI workflows run outside the agent runtime.

### Expected merge conflict zones

- LOW: the `on:` block and the comment above `concurrency` in `ci.yml`.

## 2026-10-30 - Install Bun for the RPC supervisor exit job (senpi#4852, part of #4845)

### What changed

- `.github/workflows/ci.yml`: the `rpc-owner-lifetime` job installs the repository's pinned Bun (1.4.4) before running the owner-lifetime regressions.

### Why

- The owner-lifetime regression now covers a Bun owner killed with SIGKILL; it spawns `bun`, which the Node-only job did not provide.

### Why an extension could not handle it

- GitHub Actions provisions the runner before the agent runtime starts.

### Expected merge conflict zones

- LOW: the setup steps of the `rpc-owner-lifetime` job in `ci.yml`.

## 2026-10-29 - Exercise all four Bun-certified suites in CI (senpi#4763)

### What changed

- `.github/workflows/ci.yml`: add client, protocol and telemetry to the workspace test selection beside server. The job already installs Bun 1.4.4.

### Why

- Root test commands discover these packages, but CI's explicit selection previously omitted three of them.

### Why an extension could not handle it

- GitHub Actions selects workspace suites outside the extension runtime.

### Expected merge conflict zones

- `.github/workflows/ci.yml`: the `test-workspaces` job's workspace selection.

## 2026-10-29 - Use Bun in direct CI type checks (senpi#4770)

### What changed

- `.github/workflows/ci.yml` and `.github/workflows/read-summary-binary-parity.yml` use `bun check --no-script --all -p` with their existing gate-harness and root projects.

### Why

- CI and the root validation script should use the same checker without invoking package scripts.

### Why an extension could not handle it

- GitHub Actions runs these commands before the agent runtime starts.

### Expected merge conflict zones

- LOW: the direct type-check steps in `ci.yml` and `read-summary-binary-parity.yml`.

## 2026-10-28 - Knip export coverage falls back to a bounded fetch of the PR head (senpi#4714)

### What changed

- `.github/workflows/ci.yml`: in the `check` job (`Static checks`), the `Knip export coverage` step still fetches a pull request's own commits with `--shallow-exclude=refs/heads/<base>` first. When that fetch fails, it now logs the fallback and fetches `refs/pull/<n>/head` with `--depth=500` into the same `origin/pr-head` ref, so `KNIP_COVERAGE_HISTORY` stays `origin/pr-head`.

### Why

- For a stacked PR whose base PR has just merged into `main`, the server refuses the `--shallow-exclude` fetch (`fatal: error processing shallow info: 4`, exit 128). Static checks then failed with no code problem (senpi#4714).

### Why an extension could not handle it

- CI workflow configuration, not runtime behavior.

### Expected merge conflict zones

- LOW: the `Knip export coverage` step in `.github/workflows/ci.yml`. Upstream pi-mono has no knip step, so on a sync keep this one.

## 2026-10-28 - CI runs the fused-path equivalence harness (senpi#4639)

### What changed

- `.github/workflows/ci.yml`: a new `fused-equivalence` job (ubuntu-latest) runs the EQ normalizer unit tests, `fused-equivalence-qa.mjs --compare --pipeline legacy --placement fused` against the linux-x64 B0 goldens (cases E01-E20), and `node-smoke-qa.mjs --compare --runtimes node,bun`; the `Check and test` fan-in needs it and lists it in its summary.

### Why

- The planned execution-pipeline work must keep today's fused-path behavior: a change to what a provider, an RPC client or the session store observes has to fail the PR that makes it (senpi#4628).

### Why an extension could not handle it

- CI workflow configuration, not runtime behavior.

### Expected merge conflict zones

- LOW: the job list and the `check-and-test` `needs` list in `ci.yml`.

## 2026-10-28 - CI builds the workspace once for the four coding-agent shards (senpi#4612)

### What changed

- `.github/workflows/ci.yml`: added the `build-coding-agent` job, which runs `npm ci --ignore-scripts`
  and `npm run build` once and uploads every `packages/**/dist` directory as a single tarball artifact
  (`workspace-dist`). The four `test-coding-agent` shards now `needs:` that job, download and untar the
  artifact, and no longer run `npm run build` themselves. Their test command, shard count (`N/4`) and
  `timeout-minutes` values are unchanged, so the set of tests that run is identical.

### Why

- Each shard rebuilt the same workspace: four identical builds per run, measured at 33-37 s each on a
  recent `main` run, on a runner pool that is congested (senpi#4610). The build is a pure function of the
  checked-out tree, so producing it once and fanning it out removes ~105 s of duplicated work per run.

### Why an extension could not handle it

- This is GitHub Actions workflow wiring; it has no runtime surface an extension could reach.

### Expected merge conflict zones

- LOW: `.github/workflows/ci.yml` around the `test-coding-agent` job. Upstream edits to that job's step
  list (install, build, test shard) would collide with the removed build step and the added
  download/restore steps.

## 2026-10-28 - Superseded pull-request runs are cancelled in two workflows (senpi#4611)

### What changed

- `.github/workflows/automation-branch-guard.yml`: a workflow-level `concurrency` group keyed by the pull request number, with `cancel-in-progress: true`. `pull_request` is the only trigger, so a newer head always replaces the older verdict.
- `.github/workflows/publish-model-catalog.yml`: a workflow-level `concurrency` group of `pr-<number>` for `pull_request` events and `run-<run_id>` for every other event, with `cancel-in-progress` evaluating to true only for `pull_request`. `workflow_run`, `schedule` and `workflow_dispatch` runs therefore each get their own group and are never cancelled; the `publish` job keeps its own R2 group.

### Why

- Every push to a PR branch left the previous head's run of these workflows executing, holding runners for a result no merge decision can use while the newest head waited behind a long queue (senpi#4609).

### Why an extension could not handle it

- CI workflow configuration, not runtime behavior.

### Expected merge conflict zones

- LOW: the block between `on:` and `permissions:` in both workflow files.

## 2026-10-27 - Windows check that the bundled Claude CLI runs a .cmd BROWSER helper (senpi#4437)

### What changed

- `.github/workflows/ci.yml`: the `claude-executable-windows` job gains a step that runs `test/anthropic-subscription-claude-cli-auth-windows.test.ts` and fails when that test did not pass (a skip counts as failure).

### Why

- The senpi#4436 design leaves open whether the bundled CLI can run a `.cmd` helper given as `BROWSER` on Windows; only a real Windows runner can say, and the answer picks the Windows default sign-in method.

### Why an extension could not handle it

- CI workflows run outside the agent runtime.

### Expected merge conflict zones

- LOW: the step list of `claude-executable-windows` in `ci.yml`.

## 2026-10-27 - CI runs the knip dead-code check (senpi#4421)

### What changed

- `.github/workflows/ci.yml`: the `check` job (`Static checks`) runs `npm run knip:check` right after `npm run check`, then fetches the base branch (and, for a pull request, its own commits) and runs `scripts/check-knip-export-coverage.mjs`.

### Why

- New dead code should fail the PR that adds it (senpi#4419), and a config change must never quietly stop knip from checking a file it checked before.

### Why an extension could not handle it

- CI workflow configuration, not runtime behavior.

### Expected merge conflict zones

- LOW: the step list of the `check` job in `ci.yml`.

## 2026-10-25 - Exercise the attachment presentation on Windows (senpi#4269)

### What changed

- `.github/workflows/ci.yml`: runs `attach.test.ts` in the Windows RPC named-pipe job and requires its assertions to execute and pass.

### Why

- `.github/workflows/ci.yml`: local socket tests alone cannot prove the native Windows pipe transport.

### Why an extension could not handle it

- `.github/workflows/ci.yml`: runner selection and test-result verification belong to CI.

### Expected merge conflict zones

- `.github/workflows/ci.yml`: the terminal endpoint test command and executed-test guard.

## 2026-10-26 - Junction and ReFS receipts for the socket-secret adapter (senpi#4375)

### What changed

- `.github/workflows/ci.yml`: job `socket-secret-native-windows` also creates two NTFS directory junctions on the fixed volume (to the WinFsp `M:` volume and to the VHDX `V:` volume) and a ReFS-formatted VHDX (`R:`), and exports `RECEIPT_JUNCTION_WINFSP`, `RECEIPT_JUNCTION_VHDX` and `RECEIPT_REFS_VHDX`. If the image cannot format ReFS, the step exports `RECEIPT_REFS_UNAVAILABLE` with diskpart's exit instead of failing the job.

### Why

- senpi#4354: the classifying handle follows reparse points, but no native receipt proved it, and the ReFS-local rule had only fake coverage.

### Why an extension could not handle it

- CI workflows run outside the agent runtime.

### Expected merge conflict zones

- LOW: the `Mount receipt fixtures` step of `socket-secret-native-windows` in `ci.yml`, if another fixture lands beside it.

## 2026-10-26 - Windows native receipts for the socket-secret adapter (senpi#4302)

### What changed

- `.github/workflows/ci.yml`: new job `socket-secret-native-windows` on `windows-latest`, gated on the platform scope and added to the `Check and test` fan-in. It installs WinFsp 2.1 and Dokany 2.3.1 from their release assets, mounts a WinFsp disk volume reporting NTFS, a WinFsp network volume, a Dokany mirror, a local SMB share (mapped and UNC) and a VHDX-mounted NTFS volume, runs `cargo test -p senpi-socket-secret` and then the ignored native receipts, and writes every `RECEIPT_` line to the job summary.

### Why

- sisyphuslabs/omo-desktop-app#4199 design receipts 27 (PID-4 kernel-session identity) and 28 (`FileFsDriverPathInformation` locality) need a real Windows kernel; fakes cannot supply them, and no VM is used.

### Why an extension could not handle it

- CI workflows run outside the agent runtime.

### Expected merge conflict zones

- LOW: the job list and the `Check and test` needs list in `ci.yml`, if another Windows job lands beside it.

## 2026-10-26 - publish-model-catalog requires a same-repository push for workflow_run runs (senpi#4344)

### What changed

- `.github/workflows/publish-model-catalog.yml`: for the `workflow_run` trigger, the `generate` job now also requires `github.event.workflow_run.head_repository.full_name == github.repository` and `github.event.workflow_run.event == 'push'`, on top of `conclusion == 'success'` and `head_branch == 'main'`; the `publish` job's `workflow_run` path requires the same two checks.

### Why

- `generate` checks out `workflow_run.head_sha`, and the branch name alone does not say which repository the triggering run belongs to (senpi#4342).

### Why an extension could not handle it

- CI workflow configuration, not runtime behavior.

### Expected merge conflict zones

- LOW: the `if:` lines of the `generate` and `publish` jobs in `publish-model-catalog.yml`.

## 2026-10-25 - Build Binaries outwaits a queued publish-only run and keeps a draft npm already shipped (senpi#4244)

### What changed

- `.github/workflows/build-binaries.yml`: the `publish-npm` job waits for the dispatched `publish-npm.yml` run through `scripts/await-dispatched-run.sh` instead of `timeout 3600 gh run watch`. The job gets `timeout-minutes: 360`, `AWAIT_MAX_SECONDS: "19800"`, `contents: read` and a sparse checkout of `scripts/`. The wait keeps going while the child is queued or in progress, prints its status each poll, and fails only when the child completes with a non-success conclusion or the ceiling passes.
- `.github/workflows/build-binaries.yml`: `publish-npm` finds the dispatched run in its own step and exposes its id as the job output `run_id`. `cleanup-draft-github-release` gets `actions: read`, checks out `scripts/` and runs `scripts/release-draft-cleanup.sh` with that run id and the `publish-npm` job result. The script asks npm for `@code-yeongyu/senpi@<version>` and keeps the draft, prints the recovery commands and exits non-zero when npm has the version or cannot be asked. When npm does not have it (E404 or an empty `npm view` result), the script still keeps the draft while the dispatched publish run is queued or in progress, succeeded, or cannot be read; without a run id it keeps the draft while any `publish-npm.yml` dispatch run has not completed or the runs cannot be listed. It deletes the draft only when no publish run was dispatched or the publish run completed without success.

### Why

On 2026.10.24-1 the dispatched publish-only run sat queued for hosted runners past the 60 minute wait, then succeeded and put all seven packages on npm. The parent had already failed, so the release publish was skipped and the cleanup deleted the staged draft. The version was on npm with no GitHub release, and recovery needed a full rebuild (senpi#4173). A parent that gives up or is cancelled while the child is still queued must not delete the draft either, because the child can still publish.

### Why an extension could not handle it

Release orchestration is repository workflow configuration, not runtime behavior an extension can reach.

### Expected merge conflict zones

- LOW: the `publish-npm` and `cleanup-draft-github-release` jobs in `build-binaries.yml`, if upstream changes how its release workflow waits on npm publishing or cleans up drafts.

## 2026-10-25 - The Windows RPC job drives a terminal control endpoint over a pipe (senpi#4267)

### What changed

- `.github/workflows/ci.yml`: the `RPC named pipes (Windows)` job's TUI step now runs the terminal endpoint suite that registers, lists, attaches and drives a terminal over a named pipe, plus the terminal socket wrong-secret suite.

### Why

- Terminal control endpoints now register on win32; the job proves it end to end instead of proving the old refusal.

### Why an extension could not handle it

- CI workflow configuration, not runtime behavior.

### Expected merge conflict zones

- LOW: the `rpc-windows` job's TUI step and its comment.

## 2026-10-25 - CI and release workflows pin Bun 1.4.4 (senpi#4223)

### What changed

- `.github/workflows/build-binaries.yml`: the `oven-sh/setup-bun` step installs Bun `1.4.4` instead of `1.4.3`, so the shipped binaries compile on 1.4.4.
- `.github/workflows/ci.yml`, `publish-npm.yml`, `releasability.yml`, `read-summary-binary-parity.yml` and `session-worker-compile.yml`: every `oven-sh/setup-bun` step installs Bun `1.4.4` instead of `1.4.3`.

### Why

CI and the release binaries must build and test on the Bun release users get. The 1.4.4 patch release needs no runtime code change here; `MIN_BUN_VERSION` and the version-gated workarounds stay as they are. The source-install security tests explicitly plant stale links after a real install instead of depending on Bun's old per-file symlink behavior. Deleted-source coverage retains both the installer's own failure and our dangling-link refusal, with the previous revision unchanged in both cases.

### Why an extension could not handle it

The toolchain version CI installs is repository workflow configuration.

### Expected merge conflict zones

- LOW: the `bun-version` lines in the six workflows above, if upstream changes its Bun pin.

## 2026-10-23 - Four coding-agent CI shards leave timeout headroom (senpi#4131)

### What changed

- `.github/workflows/ci.yml`: schedule four coding-agent test shards and use `/4` in the Vitest command, job name, and summary. Keep the required `Check and test` fan-in and the existing job and test-step timeouts. Give all four system-dependency steps a five-minute cap and use `scripts/install-ci-system-deps.sh` to bound package transfers and retry once against a different mirror, rewriting both the mirror+file list and direct sources before the retry.

### Why

- `.github/workflows/ci.yml`: three-shard jobs reached 26-30 minutes against the 30-minute job limit. Five successful runs had up to 58.8 minutes of combined test-step time; four equal shares predict 14.7 minutes per shard before setup, rather than 19.6 minutes with three. This estimate assumes equal test cost; the PR's own CI validates actual wall times.
- `.github/workflows/ci.yml`: run 40020066230 spent about 13 minutes downloading system packages from a slow Azure Ubuntu mirror. A 60-second transfer attempt and one 150-second archive.ubuntu.com retry prevent setup from consuming most of the shard budget; installation runs offline after downloads finish so a transfer timeout cannot interrupt dpkg.

### Why an extension could not handle it

- `.github/workflows/ci.yml`: CI runner partitioning is workflow configuration, outside runtime extension points.

### Expected merge conflict zones

- `.github/workflows/ci.yml`: the coding-agent shard matrix, command, name, summary, and system-dependency steps.

## 2026-10-23 - The model catalog publish keeps the last good OpenGateway catalog (senpi#4067)

### What changed

- `.github/workflows/publish-model-catalog.yml`: the `Generate model catalog JSON` step forwards `--keep-last-good-opengateway` to `generate-model-catalog`.

### Why

- `.github/workflows/publish-model-catalog.yml`: a long OpenGateway outage would otherwise turn every publish red; the dedicated OpenGateway catalog refresh workflow is the one job that fails on it.

### Why an extension could not handle it

- `.github/workflows/publish-model-catalog.yml`: workflow configuration is outside runtime extension points.

### Expected merge conflict zones

- `.github/workflows/publish-model-catalog.yml`: the `Generate model catalog JSON` step.

## 2026-10-22 - Static checks have a bounded compiler heap (senpi#4022)

### What changed

- `.github/workflows/ci.yml`: only the `Static checks` job's `Check` step sets `NODE_OPTIONS=--max-old-space-size=10240`.

### Why

- The public GitHub-hosted `ubuntu-latest` runner has 16 GB RAM. A 10 GiB old-space cap leaves 6 GiB for the OS, runner and native allocations while allowing the root compiler to exceed its exhausted default heap. The two compiler commands run sequentially.

### Why an extension could not handle it

- Runner memory limits are workflow configuration, outside runtime extension points.

### Expected merge conflict zones

- `.github/workflows/ci.yml`: the `Static checks` job's `Check` step.

## 2026-10-22 - The release job builds the senpi-grep addon before its tests (senpi#3978 follow-up)

### What changed

- `.github/workflows/publish-npm.yml`: the `release` job runs the same `Setup Rust`, `Cache Rust` and `Build native grep addon` steps as `ci.yml`'s `test-workspaces`, before `Run release`. The addon path reaches the release's `npm test` through `SENPI_GREP_NATIVE_PATH` in `$GITHUB_ENV`. The steps are skipped in `publish-only` mode, which runs no tests.

### Why

- Since #3978, `scripts/probe-native-grep.test.mjs` refuses to build the addon inside a test hook when `CI` is set, and fails with a message naming the missing `Build native grep addon` step. `ci.yml` gained that step, but the release job did not. The 2026.10.21-3 release run (39840619411) therefore failed its `npm test` with six probe-native-grep failures before tagging anything.

### Why an extension could not handle it

- Workflow steps are repository CI configuration; no runtime extension point reaches them.

### Expected merge conflict zones

- The `release` job's step list in `publish-npm.yml`, around `Run release`.

## 2026-10-22 - macOS/Windows CI jobs run on pull requests only for platform-specific diffs (senpi#3957)

### What changed

- `.github/workflows/ci.yml`: a `platform-scope` job runs `scripts/ci-platform-scope.mjs` on the PR's changed files and labels. The macOS and Windows-only jobs need it and run only when it outputs `full=true`; the ubuntu+windows matrices keep their Linux leg and add Windows only then. `Check and test` verifies its needs through the same script, which accepts `skipped` only for those jobs and only when the scope said `full=false`. The workflow is also callable (`workflow_call`), and its concurrency group is a fixed per-file prefix plus the workflow name, so a called run never cancels the PR's own run or another called workflow.
- `.github/workflows/read-summary-binary-parity.yml`, `.github/workflows/session-worker-compile.yml`: the same scope job decides the macOS/Windows matrix legs; both also run on pushes to main with their PR paths, and are callable. Their concurrency groups use their own fixed prefix plus the workflow name; main pushes get one group per commit and are never cancelled.
- The classifier also counts `packages/coding-agent/src/modes/rpc/**` and every file a macOS/Windows job of the classified workflow names in its steps (the suites it runs), read from the workflow file itself, so editing a Windows-tested suite still runs Windows.
- `.github/workflows/session-worker-compile.yml` also gets a per-PR concurrency group (workflow + PR number, cancel in progress for PRs) so a new push cancels the superseded run.
- `.github/workflows/ci-full-label.yml`: the `run-full-ci` label calls the three workflows in full on the labelled PR.

### Why

- Hosted macOS and Windows runners have little concurrency, and every PR ran about a dozen jobs on them, so PRs queued behind each other on platform runners even when they changed no platform code. Pushes to main still run the full set, so a platform regression surfaces right after merge.

### Why an extension could not handle it

- Workflow triggers and job conditions are repository CI configuration; no runtime extension point reaches them.

### Expected merge conflict zones

- The `on:` and `concurrency:` blocks of `ci.yml`, the `needs`/`if` lines of its macOS/Windows jobs and matrices, and the `Check and test` verify step.

## 2026-10-21 - The combined macOS job keeps base per-step caps (senpi#3939)

### What changed

- `.github/workflows/ci.yml`: in `macos-combined`, the process-kernel and WebView suite steps go back to their base `timeout-minutes: 12` (from 20). The job cap drops from 115 to 99, the sum of the suite step caps plus 10 minutes of setup margin. The "Require the WebView suites to have executed" step runs only when the WebView suite step passed, as it did on base.

### Why

- `.github/workflows/ci.yml`: with 20-minute caps, a hung process-kernel suite held the scarce hosted macOS runner 8 minutes longer than before #3910. After a failed WebView suite, the executed check only added a second red step or a JSON read error.

### Why an extension could not handle it

- `.github/workflows/ci.yml`: step timeouts and conditions are repository CI configuration.

### Expected merge conflict zones

- `.github/workflows/ci.yml`: the `macos-combined` job's `timeout-minutes` lines and the WebView executed-check condition.

## 2026-10-22 - Script tests get the senpi-grep addon from one CI build step (senpi#3978)

### What changed

- `.github/workflows/ci.yml`: `test-workspaces` sets up Rust with the Rust cache and builds the senpi-grep N-API addon once ("Build native grep addon"), exporting `SENPI_GREP_NATIVE_PATH` through `$GITHUB_ENV` before both script-test steps.

### Why

- `.github/workflows/ci.yml`: the script tests built the addon inside a test hook (a cold release Rust build with a 300 s timeout) on every run. On a slow runner it timed out and turned main red at 69396c732a (`spawnSync npm ETIMEDOUT`).

### Why an extension could not handle it

- `.github/workflows/ci.yml`: CI steps are repository configuration.

### Expected merge conflict zones

- None expected: the change is local to this repository's CI and test scripts.

## 2026-10-21 - One macOS runner executes all five CI suites (senpi#3130)

### What changed

- `.github/workflows/ci.yml`: `macos-combined` replaces the macOS legs of WebView, process kernel, RPC supervisor exit, terminal tools and Inspector handoff. One pinned checkout/toolchain setup, install and workspace build serve independent suite steps with their own temp snapshots/checks, execution assertions, diagnostics and timeouts. The required `Check and test` fan-in includes the combined job; Linux and Windows matrix legs stay unchanged.

### Why

- `.github/workflows/ci.yml`: five macOS jobs per head saturate the hosted runner quota. Combining them reduces the CI workflow to one macOS job without skipping coverage. Process kernel, terminal tools and Inspector handoff on macOS intentionally become required through the combined job; their remaining matrix legs are not added to the fan-in. WebView runs last because stopped/killed Chrome tests can wedge hosted macOS runners (#2290).

### Why an extension could not handle it

- `.github/workflows/ci.yml`: runner allocation and required-status wiring are repository CI configuration.

### Expected merge conflict zones

- `.github/workflows/ci.yml`: the five OS matrices, combined job and `check-and-test` needs/summary lists.

## 2026-10-19 - CI runs the tool child's Job Object containment tests on Windows (senpi#3566)

### What changed

- `.github/workflows/ci.yml`: a `tool-child-windows` job (`Tool child Job Object (Windows)`, `windows-latest`, Bun `1.4.3`) runs the tool child's Windows containment tests (`windows-job.win32.test.ts`, `launch-barrier.win32.test.ts`, `child-containment.test.ts`, `windows-breakaway.test.ts`, `windows-command-line.test.ts`) under Bun between the OS-temp snapshot and check steps. A follow-up step fails the job unless both real-kernel files executed and every test in them passed, because a suite that skips itself exits 0. The job is listed in the `Check and test` fan-in.

### Why

- The tool child holds every command it launches in a Windows Job Object through `bun:ffi` calls into kernel32. Those tests skip themselves under Node and on other platforms, so no existing job ran them against the real kernel.

### Why an extension could not handle it

- CI jobs are repository workflow configuration.

### Expected merge conflict zones

- LOW: the new job block and the `Check and test` `needs` list.

## 2026-10-18 - CI runs the main-screen wheel and ask-user hint tests on Windows (senpi#3604)

### What changed

- `.github/workflows/ci.yml`: a `tui-mouse-windows` job (`TUI mouse wheel and hint (Windows)`, `windows-latest`) runs `packages/tui/test/tui-main-screen-mouse.test.ts` and `packages/coding-agent/test/suite/ask-user-widget-mouse.test.ts` between the OS-temp snapshot and check steps, and is listed in the `Check and test` fan-in.

### Why

- Main-screen mouse tracking is gated on `WT_SESSION` on win32, and the reporter of #3604 was on Windows Terminal. The wheel-yield state machine and the Shift selection hint need a Windows run, which no other job covered.

### Why an extension could not handle it

- CI jobs are repository workflow configuration.

### Expected merge conflict zones

- LOW: the new job block and the `Check and test` `needs` list.

## 2026-10-17 - CI and release workflows pin Bun 1.4.3

### What changed

- `.github/workflows/build-binaries.yml`: the `oven-sh/setup-bun` step installs Bun `1.4.3` instead of `1.4.2`.
- `.github/workflows/ci.yml`, `publish-npm.yml`, `releasability.yml`, `read-summary-binary-parity.yml` and `session-worker-compile.yml`: every `oven-sh/setup-bun` step installs Bun `1.4.3` instead of `1.4.2` (senpi#3078).

### Why

Bun 1.4.3 carries the idle-GC fixes oven-sh/bun#43681 and oven-sh/bun#43174: idle JS threads, Workers included, now run their own full collections. CI and the release binaries must build and test on the runtime users get. The codemode kernel's own idle collection (#2261) already gates itself to Bun `<1.4.3` and Node, so on 1.4.3 it no longer runs.

### Why an extension could not handle it

The toolchain version CI installs is repository workflow configuration.

### Expected merge conflict zones

- LOW: the `bun-version` lines in the six workflows above, if upstream changes its Bun pin.


## 2026-10-13 - Catalog refresh branches regenerate on main data changes and refuse hand commits (#3243)

### What changed

- `.github/workflows/opengateway-catalog-refresh.yml`: also runs on a push to `main` that touches `packages/ai/src/providers/data/**`, so the refresh branch is regenerated on top of the new main (or its PR closed when main already matches the gateway).
- `.github/workflows/automation-branch-guard.yml` (new): on a pull request from `automation/opengateway-catalog-refresh`, `scripts/check-bot-branch-commits.mjs` fails when any commit between base and head was not written by the bot (`actions@github.com`), including a hand merge of main.
- Review delta (Opus on a73f822521): the guard refuses a PR whose head repository is not this one (a fork can reuse the branch name), and runs the checker from the base commit, not the branch under review. The checker compares real file URLs to decide it was started directly, because a hand-built `file://` URL missed paths with spaces or symlinks and then exited 0 without checking. It requires both the author and committer email to be the bot's and passes `--end-of-options` before the range. `scripts/check-bot-branch-commits.test.mjs` adds two cases, a person-committed bot commit and a start through a symlinked path with a space, and both fail on the reviewed script.
- Delta review nits (Opus on 393e302e74): the workflow comments now say that running the checker from the base commit protects the script, not the workflow file. A pull request can still edit or delete the workflow, because GitHub reads it from the PR's merge ref, so the guard stops accidents, not forgery, and only a required check makes a missing guard fail.

### Why

- `.github/workflows/opengateway-catalog-refresh.yml`: #3243 was opened at 01:55Z; #3248 and #3256 then refreshed the catalog on main, and a hand merge of main into the bot branch kept the branch's older manifest and `opengateway.json` over the newer data. That left a manifest `check:model-data` rejects and put `maxTokens` 943718 back to 393216, under a title that still read as a routine refresh. Regenerating on main data changes keeps the branch current without hand edits; the guard keeps a hand-edited branch from merging.

### Why an extension could not handle it

- CI workflow configuration, not runtime behavior.

### Expected merge conflict zones

- The `on:` block of `.github/workflows/opengateway-catalog-refresh.yml`.

## 2026-10-13 - Catalog drift is advisory in the releasability gate

### What changed

- `.github/workflows/releasability.yml`: the `Model catalog regeneration` job reports generated drift as a warning (`Report generated drift`) instead of failing the job; the warning step prints the catalog diff (first 400 lines) and the step summary says the drift is advisory, with the changed files in a details block. Regeneration, the Claude-id check, static checks, build and both test suites against the regenerated catalog still fail the job.

### Why

- `.github/workflows/releasability.yml`: provider listings and prices move within hours, so the committed catalog went stale between the regeneration commit and the end of the gate's ~50 min test step repeatedly on 2026-10-13: three data-only PRs and two blocked release cuts, each needing another gate run. `scripts/release.mjs` already regenerates the catalog, commits any change to main and waits for that commit's green CI before tagging, so drift never ships; the gate only needs to prove the regenerated catalog builds and passes tests.

### Why an extension could not handle it

- CI workflow configuration, not runtime behavior.

### Expected merge conflict zones

- The drift steps of the `model-catalog-regen` job in `.github/workflows/releasability.yml`.

## 2026-10-12 - Retire Codex app-server compatibility (senpi#3167)

### What changed

Replace the retired app-server daemon job target with the shared process identity suite on Windows.

- `.github/workflows/ci.yml`

### Why

The executable Codex compatibility layer is being removed. Shared Native runtime behavior and historical records must remain independent of that layer.

### Why an extension could not handle it

These host contracts, import paths and build or verification targets belong to the repository; an extension cannot retire them.

### Expected merge conflict zones

The listed paths, especially command dispatch, mode unions and process identity imports. Keep the supported runtime branches and the shared utility behavior.

## 2026-10-12 - The Windows zip install fails in its own step when Chocolatey is down (senpi#3088)

### What changed

- `.github/workflows/ci.yml`: the `Install archive tool` step of the `Compiled extensions (Windows)` job retries `choco install zip` up to four times with a short backoff and fails the step unless `zip` is on PATH afterwards, naming the likely cause.

### Why

- `.github/workflows/ci.yml`: when the Chocolatey community feed returns 503, `choco install` reports "installed 0/0 packages" and exits 0, so the job continued until `scripts/build-binaries.sh` failed with `zip: command not found` (exit 127) inside an unrelated test, sending reviewers to the PR's code.

### Why an extension could not handle it

- `.github/workflows/ci.yml`: CI tool installation is repository configuration.

### Expected merge conflict zones

- `.github/workflows/ci.yml`: the `Install archive tool` step of the `compiled-extensions-windows` job.

## 2026-10-10 - Test-run temporary storage has an owner (senpi#3064)

### What changed

- `.github/workflows/ci.yml`, `.github/workflows/releasability.yml`: test invocations use scripts/run-tests.mjs so TMPDIR/TEMP/TMP are scoped before the test runtime starts and cleaned after exit.
- `.github/workflows/ci.yml`, `.github/workflows/releasability.yml`: every test job snapshots the OS temp directory before its first test step and runs final teardown/check with `always()` when that snapshot succeeded. Unowned leftovers fail the job and are named; snapshots live under gitignored local-ignore.
- `.github/workflows/ci.yml`, `.github/workflows/releasability.yml`: snapshot setup explicitly exports a creator-owned cleanup journal. Final teardown retires only recorded run roots before checking for unowned residue, including a run root recreated by late Windows child activity.
- `.github/workflows/ci.yml`, `.github/workflows/releasability.yml`: exported TMPDIR/TEMP/TMP make the job's count an exclusive measurement, not a count of unrelated host daemons. Final teardown removes its own job parent and restores the host temp environment before post-job actions.
- `.github/workflows/ci.yml`: the real CLI recovery self-test added on main also runs inside the temp owner, between snapshot setup and an always-run final count, before the workspace build.

### Why

- Vitest SSR copies and interrupted fixture writes must not accumulate in the OS temp directory.

### Why an extension could not handle it

- Test-process bootstrap is repository tooling, before runtime extensions load.

### Expected merge conflict zones

- Test command arguments and runtime selection; preserve existing reporters, shards and test filters.

## 2026-10-11 - Require the real CLI text-tool recovery self-test (senpi#3109)

### What changed

- `.github/workflows/ci.yml`: the Ubuntu `Static checks` job runs the 22-assertion Anthropic real-CLI mock-loop self-test with a five-minute timeout. The existing required `Check and test` fan-in includes this job; the step has no skip condition or failure tolerance.

### Why

- `.github/workflows/ci.yml`: the leaked-call scenario stopped declaring its scripted shell tool after eval-only routing became the default, but no CI step ran it. The scenario now selects the direct `bash` tool surface explicitly. This required self-test covers complete and truncated leaked calls, the Anthropic API round-trip, credential isolation, sandbox cleanup, and command dispatch.

### Why an extension could not handle it

- `.github/workflows/ci.yml`: required checks and their failure propagation are repository CI configuration.

### Expected merge conflict zones

- `.github/workflows/ci.yml`: the `check` job's steps between static validation and the workspace build.

## 2026-10-10 - A failing WebView suite prints its vitest output (senpi#3092)

### What changed

- `.github/workflows/ci.yml`: the `Run eval kernel WebView suites (Bun)` step captures the background suite's exit status with `wait "$suite" || status=$?` instead of a bare `wait` followed by `status=$?`, then prints the vitest output and exits with that status.

### Why

- `.github/workflows/ci.yml`: the step runs under `bash -eo pipefail` (GitHub `shell: bash` default), so a failing `wait` ended the step before `cat "$out"`. A failing suite showed no test output at all (seen on PR #3091), only the hang path printed it.

### Why an extension could not handle it

- `.github/workflows/ci.yml`: CI step scripting is repository configuration.

### Expected merge conflict zones

- `.github/workflows/ci.yml`: the WebView step's `run` script in the eval-kernel WebView job.

## 2026-10-10 - Bash-tool grandchildren stay console-free on Windows, and a known upstream window is documented (omo#7691)

### What changed

- `.github/workflows/ci.yml`: a new job, `bash-grandchild-console-windows` (`Bash grandchild consoles (Windows)`), runs `test/bash-grandchild-console-windows.test.ts` on `windows-latest` with the JSON reporter. A following step fails unless all 12 cases ran, and prints the raw console-probe measurements. The required `Check and test` fan-in includes the job.

### Why

- `.github/workflows/ci.yml`: omo#7691 reported focus-stealing console windows from bash-tool commands. The suite proves on a real Windows runner that a bash command's node and its children stay console-free in every common launch shape, with a no-windowsHide control that must show a window. It also documents firebase-tools' detached shell spawn (firebase/firebase-tools#11261), which opens a window that no flag on senpi's spawn can reach. Only a Windows runner can measure console windows.

### Why an extension could not handle it

- `.github/workflows/ci.yml`: runner selection and required-status fan-in are repository CI configuration.

### Expected merge conflict zones

- `.github/workflows/ci.yml`: job definitions, the `check-and-test.needs` array and its summary list.

## 2026-10-10 - POSIX supervisor exit tests run on Linux and macOS (senpi#3054)

### What changed

- `.github/workflows/ci.yml`: the `rpc-owner-lifetime` matrix runs the owner-lifetime, owner-review, child-exit, missing-compiler and legacy-drain regressions on `ubuntu-latest` and `macos-latest`. A compiler preflight fails explicitly when `cc` is absent; tests compile the native exit waiter on demand. The required `Check and test` fan-in includes this matrix. Windows is excluded from this POSIX job.

### Why

- `.github/workflows/ci.yml`: the normal coding-agent shards cover Linux only. The kqueue branch also needs macOS coverage, and a missing C compiler must fail rather than silently skipping exit observation.

### Why an extension could not handle it

- `.github/workflows/ci.yml`: runner selection, compiler availability and required-status fan-in are repository CI configuration.

### Expected merge conflict zones

- `.github/workflows/ci.yml`: job definitions, the `check-and-test.needs` array and its summary list.

## 2026-10-09 - The changelog gate audits the whole tree against the upstream pin (senpi#3006)

### What changed

- `.github/workflows/changelog-gate.yml`: a new step, "Audit changes.md coverage against the upstream pin", runs `node scripts/audit-changes-md.mjs` after the per-PR gate in the same job. The job already checks out the PR head with `fetch-depth: 0`, so the pinned upstream commit is present; the audit exits 1 when any upstream-owned production path is uncovered by its exact nearest changes.md tracker.

### Why

The per-PR gate (`scripts/check-pr-changelog.mjs`) sees only the PR's own diff, so it cannot catch a newly added nearest changes.md tracker that shadows coverage a parent tracker already provided — the senpi#2895 shape that left 43 paths uncovered (senpi#3006). The repository-wide audit sees exactly that state; running it on every pull request keeps the next shadowing tracker from merging.

### Why an extension could not handle it

CI job composition is repository workflow configuration.

### Expected merge conflict zones

- LOW: the changelog-gate steps list, if upstream ever grows an equivalent job.

## 2026-10-08 - Every main commit gets its own CI run, never cancelled or replaced by a later merge (senpi#2960)

### What changed

- `.github/workflows/ci.yml`: the concurrency group is `ci-${{ github.event_name == 'pull_request' && github.ref || github.sha }}` (was `ci-${{ github.ref }}`), and `cancel-in-progress` is `${{ github.event_name == 'pull_request' }}` (was `true`). A pull request keeps one group per ref, so a newer push or restack still cancels the run it supersedes. Each `main` push gets a group of its own, so its run starts at once and is never cancelled, queued or replaced by a later merge. `scripts/ci-concurrency.test.mjs` evaluates the group and the cancel flag for two `main` commits and two pushes to one pull request.

### Why

Since senpi#2945 the release's test evidence is the release commit's green "Check and test" run. With one group for `main`, a merge during a release cancelled that run, or, with cancel-in-progress off, left it waiting behind the previous run and let a later merge replace it before it started. Either way the release lost its evidence and timed out; two merges in one window made the release miss its 40-minute window twice.

### Why an extension could not handle it

The CI concurrency policy is repository workflow configuration.

### Expected merge conflict zones

- The `concurrency:` block at the top of `ci.yml`.

## 2026-10-05 - The process-mode kernel suite runs on Linux and macOS (codemode plan node 17)

### What changed

- `.github/workflows/ci.yml`: a new job, `process-kernel` (`Eval kernel process isolation (ubuntu-latest)` and `(macos-latest)`), runs `test/js-process-kernel.test.ts` with the JSON reporter on both platforms. A following step fails unless the suite ran (at least 30 passed, none failed, and on macOS only the Linux-only subreaper case skipped) and no `process-entry.js` child was left behind with ppid 1.

### Why

- Process mode could not start on Linux at all (a spawn's stdout is a socket there, and the entry reopened it by path), and no CI run caught it: the suite never ran on macOS, and the PR that added it was stacked, so it got no test workflow (#2759). A platform where the kernel child cannot start must fail a check instead of shipping.

### Why an extension could not handle it

- This is CI configuration.

### Expected merge conflict zones

- LOW: the job list in `ci.yml`, where the new job sits before `python-kernel-windows`.

## 2026-10-05 - CI runs on pull requests to any branch (senpi#2759)

### What changed

- `.github/workflows/ci.yml`: the `pull_request` trigger no longer filters on `branches: [main]`, so a pull request stacked on another feature branch runs the same CI as one that targets `main`. The existing concurrency group (`ci-${{ github.ref }}`, which is `refs/pull/<n>/merge` for a pull request) with `cancel-in-progress` keeps one run per pull request.

### Why

- A stacked pull request ran no test workflow, so its code could look reviewed while it had never run in CI. The process-mode kernel in #2706 could not start on Linux and nothing caught it.

### Why an extension could not handle it

- This is CI configuration.

### Expected merge conflict zones

- LOW: the `on:` block at the top of `ci.yml`.

## 2026-10-04 - The Windows Python job checks that environment installs stay inside the revision (codemode plan node 14)

### What changed

- `.github/workflows/ci.yml` (`python-kernel-windows`): a new step runs the environment tests for pip's config file and staged revisions with the JSON reporter, and fails unless the pip-config test actually ran and passed.

### Why

- pip skips every config file only when `PIP_CONFIG_FILE` equals Python's `os.devnull`, which is `nul` on Windows. A string check on another OS can't prove that, and a skipped test must not count as a pass.

### Why an extension could not handle it

- This is CI configuration.

### Expected merge conflict zones

- LOW: the `python-kernel-windows` job's step list.

## 2026-10-04 - The Windows Python job runs the kernel-tool suites (codemode plan node 11)

### What changed

- `.github/workflows/ci.yml` (`python-kernel-windows`): a new step runs `test/py-kernel-tools.test.ts`, `test/kernel-tools-registry.test.ts` and `test/kernel-tools-reentrancy.test.ts` with the JSON reporter, and the next step fails unless they all ran: no failures, no skips, and at least 15 Python kernel-tool cases passed.

### Why

- Python kernel tools serve callbacks on threads beside a runner whose interrupt is SIGTERM-only on Windows; the plan requires those suites to run on Windows, and a skipped suite must not count as a pass.

### Why an extension could not handle it

- This is CI configuration.

### Expected merge conflict zones

- LOW: the `python-kernel-windows` job's step list.

## 2026-10-03 - codemode-gate checks out full history to review baseline changes (senpi#2452)

### What changed

- `.github/workflows/ci.yml`: the `codemode-gate` job's checkout step sets `fetch-depth: 0`.

### Why

- The eval gate now reads `packages/senpi-codemode/test/gate/baseline.json` at the pull request's merge base and requires every baseline cell the PR edits or removes to be listed with a reason. A shallow checkout cannot resolve the merge base, and the gate fails closed when it cannot, so the job needs full history.

### Why an extension could not handle it

- Checkout depth is CI workflow configuration evaluated before any Senpi runtime or extension loader exists.

### Expected merge conflict zones

- LOW: the `codemode-gate` job's checkout step in `.github/workflows/ci.yml`.

## 2026-10-03 - The release body includes every published package's notes (senpi#2585)

### What changed

- `.github/workflows/build-binaries.yml`: the `release-notes.mjs extract` step passes `--published`, so `RELEASE_NOTES.md` holds the section of every published package (the workspace packages in `scripts/registry-packages.mjs`), coding-agent first, each under its published name (`scripts/changes.md` records the extractor change). A newly published package is included without editing the workflow.

### Why

- The step named no changelog, so the extractor's coding-agent default was the whole release body and the other packages' notes and contributor credits were dropped.

### Why an extension could not handle it

- The release body is produced by the tag workflow, outside any runtime.

### Expected merge conflict zones

- LOW: the `release-notes.mjs extract` command in the `build-binaries.yml` release-assets step.

## 2026-10-02 - The WebView job runs the readiness regression and prints the readiness log (senpi#2353)

### What changed

- `.github/workflows/ci.yml` (`webview-kernel`): the Vitest step adds `test/js-kernel-webview-readiness.test.ts` (a Chrome launch whose CDP attach never completes fails fast or is relaunched, with no Chrome left), sets `SENPI_WEBVIEW_READINESS_LOG`, runs it under a 9-minute watchdog inside the step (the suite's partial verbose output, the live Chrome/Bun process list and the readiness log are printed before the step fails) plus a 12-minute step timeout, with the `verbose` and `hanging-process` reporters; a new always-run step prints the readiness log, one line per Chrome launch with its attach time or the stalled phase.

### Why

- The intermittent Windows WebView failure was silent about where a launch stuck, and a hung suite ran into the job timeout, whose cancellation discards the job log; the job now fails the step instead, keeps its log, shows the readiness of every launch on every OS, and runs the regression for the stalled attach where a real Chrome is available.

### Why an extension could not handle it

- Which suites the WebView runners execute, and what they print, belong to the workflow.

### Expected merge conflict zones

- LOW: the `webview-kernel` Vitest file list and its step list.

## 2026-10-01 - Session gateway Windows parity suites run, by name, in `rpc-windows` (senpi#2328)

### What changed

- `.github/workflows/ci.yml` (`rpc-windows`): every vitest step runs with `--reporter=verbose`, and two steps are added: `test/suite/rpc-endpoint-registry.test.ts` (endpoint.json `registry_version`/`endpoint_kind` read back on Windows paths) and `test/suite/interactive-session-control-win32.test.ts` (an interactive TUI on win32 starts, its endpoint request answers `unsupported_platform`, and nothing is registered). The socket-transport and win32 TUI steps also write a JSON report, and a final step fails the job unless both files executed with every test passed, so the win32-only named-pipe wrong-secret case and the TUI suite cannot pass by being skipped.

### Why

- The session gateway is POSIX-only, so its Windows contract is refusal plus registry compatibility. Those suites never ran on Windows, and the default dot reporter printed only per-file counts, so a Windows-only case could not be shown to have run rather than been counted.

### Why an extension could not handle it

- Which suites the Windows runner executes, and how it reports them, belong to the workflow.

### Expected merge conflict zones

- LOW: the `rpc-windows` step list.

## 2026-10-01 - Windows Python bootstrap is a required CI gate (senpi#2452)

### What changed

- `.github/workflows/ci.yml` adds the `python-kernel-windows` job with slow/hung startup regressions and a compiled Python host exercising cold and warm cells on `windows-latest`. The `Check and test` fan-in requires that job and includes its result in the workflow summary.

### Why

- A healthy cold packaged interpreter can exceed the previous five-second readiness deadline. Linux-only runtime coverage cannot detect Windows bootstrap and sidecar failures.

### Why an extension could not handle it

- Required Windows runner coverage and the repository's CI fan-in belong to the workflow.

### Expected merge conflict zones

- LOW: the Python bootstrap job near `webview-kernel` and the `Check and test` needs list.

## 2026-10-01 - CI fails when the build rewrites a committed dist file (senpi#2484)

### What changed

- `.github/workflows/ci.yml` (Static checks): after `npm run build`, `git diff --exit-code` over every tracked `packages/*/dist/*` file.

### Why

- `packages/ai/dist/cli.js` and `packages/coding-agent/dist/cli.js` are committed bin stubs that the build overwrites. The upstream sync changed `packages/ai/src/cli.ts` without refreshing its stub, and the publish workflow's release step then aborted on the dirty tree. The new step reports that drift on the PR instead.

### Why an extension could not handle it

- CI workflow.

### Expected merge conflict zones

- LOW: the Static checks job steps after `Build workspace package entries`.

## 2026-09-30 - Drop the duplicate Rust manual PTY QA step (senpi#2447)

### What changed

- `.github/workflows/native-prebuilds.yml`: the "Rust manual PTY QA" step is removed.

### Why

- The preceding `cargo test -p senpi-pty --locked` step already runs `crates/senpi-pty/tests/manual_qa.rs`, because it is an integration test of the crate, so CI ran it twice.
- The file stays as the manual QA harness `crates/senpi-pty/AGENTS.md` names.

### Why an extension could not handle it

- Repository scripts, CI and native crate test code.

### Expected merge conflict zones

- LOW: the senpi-pty steps of `native-prebuilds.yml`.

# changes

## 2026-09-30 - Nightly Check job installs Bun for check:bun-lock (senpi#752)

### What changed

- `.github/workflows/releasability.yml`: the `Check (main, no autofix)` job gains the `Setup Bun` step (bun 1.4.2, the SHA-pinned `oven-sh/setup-bun` ci.yml uses) between `Install dependencies` and `Check`.

### Why

- `npm run check` runs `check:bun-lock` since senpi#2352, which needs bun to regenerate `bun.lock`; ci.yml's `Static checks` installs Bun, the nightly job did not, so it failed with `bun is required to regenerate bun.lock: spawnSync bun ENOENT` on every run from 2026-09-30.

## 2026-09-30 - Node bundle CI step runs the Bun provider-coverage and compiled provider-probe files (senpi#2447)

### What changed

- `.github/workflows/ci.yml`: the `Node bundle isolation and RPC smoke` step also runs `scripts/bun-bundle-provider-coverage.test.ts` and `scripts/compiled-provider-probe.test.ts`.

### Why

- Both files carry real provider-reachability and compiled-binary auth assertions, but no job, package script or doc ran them: they are Bun `.ts` files outside the `scripts/*.test.mjs` glob behind `npm run test:scripts`. The coverage file needs the canvas rebuild that this job already does before the step.

### Why an extension could not handle it

- CI workflow.

### Expected merge conflict zones

- LOW: the steps between `Install dependencies` and `Check` in `releasability.yml`.

- LOW: the `Node bundle isolation and RPC smoke` step in `ci.yml`.

## 2026-09-30 - Sync with upstream v0.99.1 (6a4af07d6): manifests, build and check scripts

### What changed

- `.github/workflows/publish-model-catalog.yml`: `.github/workflows/publish-model-catalog.yml`: adopted the `scripts/model-catalog-protocol.ts` path trigger.

### Why

- The fork builds through `scripts/build-all.mjs` and runs sources with tsx (D-11); upstream's plain-node source execution and TypeScript-7 script rewrites are mechanism changes the fork already covers.
- Upstream codemode, MCP, tool-search and durable are excluded (D-2, D-7), so their workspace packages, dependencies, build phases, tsconfig/vitest aliases and smoke checks stay out.
- The `openai` 6.26.0 hold had no failing check behind it and the adopted upstream OpenAI adapters target 7.19.0 (D-10).
- chord follows upstream 0.99.1 with exact pins (D-12, check:pinned-deps).

### Why an extension could not handle it

Workspace manifests, tsconfig and build/check scripts are repository build infrastructure, outside any runtime extension.

### Expected merge conflict zones

Every path listed above conflicts again where upstream edits the hunks named in its line; the fork-kept constructs named there are the anchors to preserve.

## 2026-09-30 - Codemode behavior regression gate (senpi#2452)

### What changed

- `.github/workflows/ci.yml`: add the `codemode-gate` job with all five required runtime legs, a frozen behavior baseline, package contracts, harness typechecking, and a JSON report artifact. Its build wrapper records input hashes, including the source file set, so a deleted source cannot be measured against stale workspace output.

### Why

- Codemode changes need exact checks for legacy prompt, schema, helper, lifecycle, and import behavior without relying on wall-clock timings. The import census is scoped through measured parent edges and the loader's virtual module tables; host-only imports do not turn the codemode job red.

### Why an extension could not handle it

- CI workflow.

### Expected merge conflict zones

- LOW: the new `codemode-gate` job in `ci.yml`.

## 2026-09-29 - Model catalog publish runs only in the upstream repository (senpi#1522)

### What changed

- `.github/workflows/publish-model-catalog.yml`: the `publish` job runs only when `github.repository` is `badlogic/pi-mono`, and a new `Check R2 credentials` step skips the R2 upload with a notice when the access key or secret is empty. The `generate` job still builds and validates the catalog in every repository.

### Why

- The upload targets the upstream pi-artifacts R2 bucket, and this fork has no credentials for it, so every scheduled run inside the publication window failed at `aws s3 cp` with `Unable to locate credentials`.

### Why an extension could not handle it

- CI workflow.

### Expected merge conflict zones

- LOW: the `publish` job `if:` line and the steps before `Publish model catalog to R2` in `publish-model-catalog.yml`.

## 2026-09-29 - Node bundle CI step runs the reinstall regression file (senpi#2358)

### What changed

- `.github/workflows/ci.yml`: the `Node bundle isolation and RPC smoke` step also runs `scripts/node-bundle-reinstall.test.ts`, which replaces the installed package with a different build under a running RPC session and requires the next prompt to succeed under Node and Bun.

### Why

- A session started before a global reinstall died at its next lazy chunk import; the test keeps the runtime snapshot that prevents it from regressing.

### Why an extension could not handle it

- CI workflow.

### Expected merge conflict zones

- LOW: the `Node bundle isolation and RPC smoke` step in `ci.yml`.

## 2026-09-29 - Static checks install Bun for the bun.lock drift gate (senpi#2352)

### What changed

- `.github/workflows/ci.yml`: the `Static checks` job sets up Bun 1.4.2 before `npm run check`, which now runs `check:bun-lock`.

### Why

- `check:bun-lock` resolves bun.lock with Bun in an isolated island and fails when a fresh `bun install` would rewrite it; the job had no Bun.

### Why an extension could not handle it

- CI workflow.

### Expected merge conflict zones

- LOW: the `Static checks` job steps in `ci.yml`.

## 2026-09-29 - Node bundle CI step runs the Cursor exec regression file (senpi#2334)

### What changed

- `.github/workflows/ci.yml`: the `Node bundle isolation and RPC smoke` step also runs `scripts/node-bundle-cursor-exec.test.ts`, which drives the built CLI under Node and Bun with an exec-channel provider and checks the tool call runs once.

### Why

- The double execution only exists in the built bundle, where `chunks/cursor-agent.js` carries its own module copies; source-level tests cannot see it.

### Why an extension could not handle it

- CI workflow.

### Expected merge conflict zones

- LOW: the `Node bundle isolation and RPC smoke` step in `ci.yml`.

## 2026-09-28 - WebView CI step runs the orphaned-launch regression file (senpi#2272)

### What changed

- `.github/workflows/ci.yml`: the `webview-kernel` job's vitest command also lists `test/js-kernel-webview-launch.test.ts`, the real-Chrome regression for a launch whose kernel is released mid-launch.

### Why

- The test lives in its own file so it runs in a process no earlier test has stopped or killed Chrome in: inside the resilience file it wedged GitHub's macOS runners (bisected in #2272; root cause tracked in #2290). The executed-suites check still requires at least 10 passed tests.

### Why an extension could not handle it

- CI workflow.

### Expected merge conflict zones

- LOW: the `Run eval kernel WebView suites (Bun)` step in `ci.yml`.

## 2026-09-28 - Windows CI job for durable scheduled prompts (senpi#2216)

### What changed

- `.github/workflows/ci.yml`: a `schedule-windows` job builds the workspace entries and runs `test/suite/schedule-runner.test.ts`, `schedule-extension.test.ts` and `schedule-cli.test.ts` on windows-latest, and is added to the `Check and test` fan-in and its summary.

### Why

- The coding-agent test job is Linux-only and the POSIX CLI suite is skipped on Windows, so rename claims, runner leases, ungated delivery locks, `taskkill` timeouts and `cmd.exe` `--exec` hooks had no coverage on the platform where they behave differently (the quoted `--exec` bug was found by this job).

### Why an extension could not handle it

- CI workflow.

### Expected merge conflict zones

- LOW: the job list before `rpc-windows` and the `check-and-test` `needs` list and summary in `ci.yml`.

## 2026-09-28 - Cross-OS CI job for eval-kernel Bun.WebView (senpi#2248)

### What changed

- `.github/workflows/ci.yml`: a `webview-kernel` job runs the Bun-only `senpi-codemode` WebView suites (`js-kernel-webview*.test.ts`) under `bunx --bun vitest` on ubuntu-latest, windows-latest and macos-latest, fails when the JSON report shows they were skipped instead of executed (one Windows skip allowed: the `SIGSTOP` case), and is added to the `Check and test` fan-in.

### Why

- Chrome-backed WebViews from eval cells go through the main-thread service; only a Bun run with a real Chrome on each OS proves it, and Windows (the reported platform) has no other coverage.

### Why an extension could not handle it

- CI workflow.

### Expected merge conflict zones

- LOW: the job list before `test-workspaces` and the `check-and-test` `needs` list and summary in `ci.yml`.

## 2026-09-28 - Native prebuilds no longer build the desktop engine (senpi#2128)

### What changed

- `.github/workflows/native-prebuilds.yml`: the desktop engine build, staging assertion, `file_senpi_desktop_engine` manifest line, desktop crate tests, desktop lifecycle probe, Windows interactive-desktop smoke, and the `crates/senpi-desktop-*` / `packages/desktop-*` path filters are removed; the Rust cache key is `native-<target>`. The PTY and grep prebuilds are unchanged.

### Why

- The engine and its CI live in omo (`desktop-engine.yml`, code-yeongyu/oh-my-openagent#8893).

### Why an extension could not handle it

- CI workflow.

### Expected merge conflict zones

- LOW: the build and stage steps of `native-prebuilds.yml`.

## 2026-09-24 - Build and verify the senpi-desktop-engine binary in the native matrix (senpi#2128)

### What changed

- `.github/workflows/native-prebuilds.yml`: every row builds the `senpi-desktop-engine` binary (`cargo zigbuild` on the Linux rows, `cargo build --target` elsewhere) and stages it next to the `.node` files; the Stage step asserts exactly one `senpi-desktop-engine*` file and records `file_senpi_desktop_engine=` in `manifest.txt`; the non-cross rows run the desktop crate tests and a lifecycle probe (`scripts/ci/probe-desktop-engine.mjs`: `--selftest`, `capabilities` reports `fake` / `unavailable`); the win32-x64 row runs `scripts/ci/windows-interactive-desktop-smoke.ps1` (SendInput click + UI Automation read on a WinForms window). Path filters add `crates/senpi-desktop-*/**`, `packages/desktop-*/**`, and `scripts/ci/**`; `Swatinem/rust-cache` keyed per target; `timeout-minutes` 45 -> 75.

### Why

- The desktop engine ships as a per-platform binary; packaging must be exercised on all six targets before any native backend exists, and the Windows desktop QA job needs proof that the hosted runner has an interactive desktop.

### Why an extension could not handle it

- CI workflow configuration.

### Expected merge conflict zones

- LOW: fork-only workflow; the path filters, the build/stage steps, and `manifest.txt` fields of `native-prebuilds.yml`.

## 2026-09-23 - Windows Claude Code executable job and SDK currency gate (senpi#2053)

### What changed

- `.github/workflows/ci.yml`: new `claude-executable-windows` job (windows-latest, Node 24 + Bun 1.4.2) runs the Claude executable path-lookup tests and the real-file npm `claude.cmd` shim test under Node and Bun, then fails if the shim test was skipped instead of passing; it is part of the `Check and test` fan-in.
- `.github/workflows/releasability.yml`: `model-catalog-regen` runs `scripts/check-claude-code-model-support.mjs --strict` after regeneration; new nightly `claude-sdk-currency` job runs it `--sdk-currency` and reports through `report-failure`.

### Why

- The Windows shim resolution only exists on a real Windows host, and no existing Windows job ran the Claude executable tests (oh-my-openagent#8700). A pinned Claude Agent SDK behind the newest release is how new Claude models shipped unusable twice; the nightly gate turns that into a tracked issue without redding PR bases.

### Why an extension could not handle it

- CI workflow configuration.

### Expected merge conflict zones

- LOW: the job list and the `Check and test` needs/summary in `ci.yml`; the `report-failure` needs/env/results in `releasability.yml`.

## 2026-09-17 - Run the `senpi host` named-pipe cell on the Windows RPC job (senpi#1782)

### What changed

- `.github/workflows/ci.yml`: the `rpc-windows` job gains one step, `bunx vitest run test/suite/host-cli-win32.test.ts`, after the socket-transport step. It is the win32 cell of the `senpi host` contract: a second `ensure` reuses the daemon on the named pipe, and `handoff` refuses with `upgrade_unsupported`.

### Why

- Both properties are platform-specific and cannot be observed on POSIX: the endpoint is a pipe derived from the socket path, and a named pipe can be neither renamed nor drained, so the handoff must refuse rather than attempt one. The POSIX suites skip on win32 by construction, so without this step nothing would run that cell.

### Why an extension could not handle it

- CI job definition; it selects which suites run on which runner.

### Expected merge conflict zones

- LOW: the step list of the `rpc-windows` job.

## 2026-09-14 - Exercise Node worker bundles on Linux

### What changed

- `.github/workflows/ci.yml` runs Node bundle SDK isolation and real CLI/shared-session smoke tests serially after workspace build in the Ubuntu Node 24 job.

### Why

- `.github/workflows/ci.yml` previously never invoked the standalone Node bundle builder, leaving unsupported runtime imports and worker startup failures undetected (Refs #1656).

### Why an extension could not handle it

- `.github/workflows/ci.yml` defines test execution before any runtime extensions load.

### Expected merge conflict zones

- `.github/workflows/ci.yml`: workspace build and script-test steps.

## 2026-09-14 - Run the grep contract suite against the native engine on linux

### What changed

- `.github/workflows/ci.yml`: added the `grep-native-contract` job (ubuntu-latest). It reads the toolchain channel from `rust-toolchain.toml`, caches cargo state with `Swatinem/rust-cache`, builds `senpi-grep` with `cargo build --release --locked` plus a `napi build --platform --release` addon, resolves the generated `senpi_grep.*.node` by glob, and runs `test/grep` twice in the same job - once with `SENPI_GREP_ENGINE=native` against that addon and once with `SENPI_GREP_ENGINE=rg`. The native leg writes a vitest JSON report that is asserted to contain the native contract file with every case passed and none skipped. The job joins the `check-and-test` fan-in gate and its summary; the three coding-agent shards and the Windows jobs are unchanged.

### Why

- `.github/workflows/ci.yml`: the shards only ever exercise the ripgrep fallback, so the native engine could regress undetected. Building the addon inside CI and running the shared contract suite under both engines is the only gate that proves engine parity on a clean machine (Refs #1678).

### Why an extension could not handle it

- `.github/workflows/ci.yml`: runner selection, the Rust toolchain, native addon builds and job-level required-status wiring are CI configuration evaluated long before any Senpi runtime or extension loader exists.

### Expected merge conflict zones

- MEDIUM: the `jobs` map and the `check-and-test` `needs` list in `.github/workflows/ci.yml` whenever upstream restructures CI.

## 2026-09-14 - Enforce freshly staged release entry graphs

### What changed

- `.github/workflows/ci.yml` runs the codemode graph followed by the existing exclusions graph in the required workspaces/scripts job, before script suites invalidate generated output. It rebuilds the trusted canvas native binding after the lifecycle-disabled install; the codemode suite rebuilds workspace entries and compile assets itself.

### Why

- `.github/workflows/ci.yml` must execute the real contribution tests instead of leaving the root Bun `.ts` tests outside its Node `.mjs` glob. Native release prerequisites must be present for the graph build (Refs #1656).

### Why an extension could not handle it

- `.github/workflows/ci.yml` establishes build prerequisites and validation order before runtime extensions load.

### Expected merge conflict zones

- The `Fresh release entry graphs (codemode and exclusions)` step in `.github/workflows/ci.yml`.

## 2026-09-13 - Verify split workers with the release compiler

### What changed

- `.github/workflows/session-worker-compile.yml` pins Bun 1.4.2, runs the parsed-argv contracts and both relocation strategies, and watches release scripts, package metadata, Bun/RPC sources and dependency locks. Ubuntu, macOS and Windows remain mandatory matrix legs.

### Why

- `.github/workflows/session-worker-compile.yml` must exercise the compiler version and graph inputs used by standalone releases, including the Windows embedded-worker path contract (Refs #1656).

### Why an extension could not handle it

- `.github/workflows/session-worker-compile.yml` configures CI before any runtime extension exists.

### Expected merge conflict zones

- The path filters, Bun setup and test steps in `.github/workflows/session-worker-compile.yml`.

## Provision Bun for native extension importer tests (2026-09-13)

### What changed

- `.github/workflows/ci.yml` installs pinned Bun 1.4.2 before each coding-agent test shard while retaining Node as the Vitest runtime. A Windows job also executes native importer regressions and the relocated compiled extension suite, and participates in the required fan-in gate.

### Why

- `.github/workflows/ci.yml` must provide the real Bun subprocess used by native extension importer tests; Node-only runners fail with `spawnSync bun ENOENT` (Refs #1656). General Windows test jobs do not prove compiled extension loading, so this surface has an explicit Windows gate.

### Why an extension could not handle it

- `.github/workflows/ci.yml` provisions test dependencies before runtime extensions load.

### Expected merge conflict zones

- The coding-agent shard setup, compiled extension Windows job and required fan-in dependencies in `.github/workflows/ci.yml`.

## Pin Bun CI and release builds to 1.4.2 (2026-09-08)

### What changed

- Updated `.github/workflows/ci.yml`, `.github/workflows/build-binaries.yml`, and `.github/workflows/publish-npm.yml` to pin stable Bun 1.4.2, together with the workflow assertion and current CI guidance.

### Why

- Keep the build and test toolchain on the current stable release with published cross-compilation assets.

### Why an extension could not handle it

- GitHub Actions selects the toolchain before runtime extensions load.

### Expected merge conflict zones

- LOW: Bun setup steps in the three workflows and their version assertion.

## test-workspaces proves the bun path of the root scripts (2026-09-07)

### What changed

- `.github/workflows/ci.yml`: the `test-workspaces` job installs bun 1.4.0 through the same pinned `oven-sh/setup-bun` action as `rpc-windows`, runs `bun run test:scripts` next to `npm run test:scripts`, and runs the "all but coding-agent" workspace suites through `node scripts/run-workspaces.mjs --if-present --workspace ... test` instead of npm's own `--workspace` flags.

### Why

- `scripts/run-workspaces.test.mjs` drives the workspace runner with whichever package manager launched the test process, so the bun step is the CI proof that root `bun run <script>` fans out through bun while the npm step keeps proving npm. Routing the real workspace suites through the runner exercises the code path root `npm run test` and `bun run test` take.

### Why an extension could not handle it

- CI workflow wiring is repository build plumbing evaluated on GitHub's runners; no runtime extension surface can add a step to a GitHub Actions workflow.

### Expected merge conflict zones

- LOW: the `test-workspaces` step list in `.github/workflows/ci.yml` whenever upstream reshapes its test job.

## Windows RPC named-pipe suites gain a real Windows CI job (2026-09-01)

### What changed

- `.github/workflows/ci.yml` adds an `rpc-windows` job (`RPC named pipes (Windows)`, windows-latest, 20-minute timeout) that builds the workspace packages and runs `test/rpc-host-ensure.test.ts`, `test/rpc-host-lifecycle.test.ts`, `test/rpc-socket-transport.test.ts`, and `test/suite/app-server-daemon.test.ts` from `packages/coding-agent` on a real Windows runner.

### Why

- PR #1244 makes the shared RPC host work on Windows through named pipes with authenticated handshakes; the main coding-agent shards run on ubuntu only, so the win32-specific transport, lifecycle, and handshake behavior was untested in CI until this job.

### Why an extension could not handle it

- CI workflow wiring is repository build plumbing evaluated on GitHub's runners; no runtime extension surface can add a job to a GitHub Actions workflow.

### Expected merge conflict zones

- LOW: the job list at the end of `.github/workflows/ci.yml` and the `needs`/gate lists of `Check and test` whenever upstream adds or reorders CI jobs.

## Workflow summary step for the model catalog publisher (2026-09-01)

### What changed

- `.github/workflows/publish-model-catalog.yml` gains the mandatory `$GITHUB_STEP_SUMMARY` step reporting job status, ref, and commit at the end of its final job.

### Why

- Every workflow must render an at-a-glance result on the run page; this workflow was modernized earlier today but still lacked the summary step the repository standard requires.

### Why an extension could not handle it

- GitHub workflow files execute on GitHub's runners; no senpi extension surface can inject a job summary step into a workflow definition.

### Expected merge conflict zones

- `.github/workflows/publish-model-catalog.yml` tail of the final job (upstream has no such workflow; conflict risk is fork-local only).

## Shared GitHub Action pins move to current majors (2026-09-01)

### What changed

- `.github/workflows/ci.yml` and `.github/workflows/build-binaries.yml` and `.github/workflows/npm-audit.yml` and `.github/workflows/publish-model-catalog.yml` unify their shared action pins on the current releases.
- `actions/checkout` moves to `3d3c42e5aac5ba805825da76410c181273ba90b1` (v7.0.1) and `actions/setup-node` to `820762786026740c76f36085b0efc47a31fe5020` (v7.0.0), collapsing the two competing pins each carried.
- `actions/upload-artifact` moves to `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` (v7.0.1) and `actions/download-artifact` to `3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c` (v8.0.1), off the retiring v4 line.
- Only `uses:` lines change. Every pin keeps the repository's full-commit-SHA style with a trailing version
  comment, and the two previously comment-less checkout and setup-node pins gain one.

### Why

- The tree carried two different `actions/checkout` pins and two different `actions/setup-node` pins across
  workflows, so the same step ran on different action majors depending on the file. The artifact actions were
  still on v4, which GitHub is retiring. Unifying on one verified SHA per action removes the drift and keeps
  the supply chain pinned to a reviewed commit rather than a mutable tag.

### Why an extension could not handle it

- Action resolution is GitHub Actions runner plumbing evaluated before any repository code, let alone the
  coding-agent extension loader, is fetched or executed.

### Expected merge conflict zones

- LOW: the `uses:` lines of the shared checkout, setup-node, upload-artifact, and download-artifact steps in `.github/workflows/ci.yml`, `.github/workflows/build-binaries.yml`, `.github/workflows/npm-audit.yml`, and `.github/workflows/publish-model-catalog.yml` whenever upstream bumps the same actions.

## Windows fs.watch regression joins the terminal cross-OS CI job (2026-08-31)

### What changed

- `.github/workflows/ci.yml` appends `test/suite/regressions/issue-1229-win-fswatch-noncanonical-abort.test.ts` to the `terminal-cross-os` job's Vitest invocation so the win32-only regression actually executes on the windows-latest runner.

### Why

- The main coding-agent test shards run on ubuntu only, where the win32-gated regression for the `/resume` fs.watch abort ([#1229](https://github.com/code-yeongyu/senpi/issues/1229)) always skips; the 3-OS terminal job is the only lane with a real Windows runner.

### Why an extension could not handle it

- CI workflow wiring is repository build plumbing; no runtime extension hook can add a test to a GitHub Actions job.

### Expected merge conflict zones

- The `Terminal extension + shell resolution tests` step's file list in `.github/workflows/ci.yml`.

## Hooks trust storage gains focused Windows CI coverage (2026-08-31)

### What changed

- `.github/workflows/ci.yml` adds a `windows-latest` job that installs dependencies and runs only
  `hooks-trust.test.ts`, `hooks-trust-storage-errors.test.ts`, `hooks-trust-storage-release-errors.test.ts`, and
  `hooks-trust-storage-aba.test.ts`; the required `Check and test` fan-in includes this job. The existing Ubuntu
  coding-agent shards continue to run the same tests on POSIX.

### Why

- Same-directory replacement for ordinary same-account application state has Windows-specific behavior, and the
  writer-excluding malformed-read recovery relies on the same exact lock semantics across platforms, but the general
  coding-agent shards run only on Ubuntu. A focused Windows job exercises those contracts without claiming custom DACL
  preservation or duplicating the unrelated coding-agent suite.

### Why an extension could not handle it

- Runner selection and test execution are repository CI policy evaluated before the coding-agent runtime or extension
  loader starts.

### Expected merge conflict zones

- LOW: `.github/workflows/ci.yml` around focused cross-platform regression jobs and the `Check and test` fan-in needs.

## Release workflow re-diverges from upstream dcd4619 (2026-08-25)

### What changed

- `.github/workflows/build-binaries.yml` keeps the fork release pipeline on top of upstream's: the
  `dry_run` input (build/validate without release upload or npm publish dispatch), the fork's
  pinned `actions/checkout` revision, the Bun `1.4.0` compiler pin with the canary-vs-target-artifact
  rationale, and the `Report Bun compiler version` diagnostic step.

### Why

These are fork-owned product surfaces (senpi branding, provider wire behavior, fork runtime features) that upstream does not carry; the sync must re-assert them on top of upstream's tree.

### Why this lives in the fork

The divergence lives in core wiring, package identity, or build plumbing that executes before any extension loads, so no extension hook can express it.

### Expected merge conflict zones

- Any upstream edit to `.github/workflows/build-binaries.yml` job steps or the Bun version pin.

## Changelog-gate labels and base SHA move to env (2026-08-17)

### What changed

- `.github/workflows/changelog-gate.yml` now sets `CHANGELOG_GATE_BASE` and `CHANGELOG_GATE_LABELS` from the pull-request event and invokes `node scripts/check-pr-changelog.mjs` with no interpolated argv. The CLI reads those env vars so label names never enter the shell command line.

### Why

- Interpolating `join(github.event.pull_request.labels.*.name, ',')` into a double-quoted shell argument lets a crafted label break out of the argv string. Env assignment keeps the untrusted label text out of the shell parser.

### Why an extension could not handle it

- GitHub Actions workflow argv construction is repository CI configuration evaluated before any Senpi runtime or extension loader exists.

### Expected merge conflict zones

- LOW: the changelog-gate run step in `.github/workflows/changelog-gate.yml` if upstream ever grows an equivalent job.


## Repository-wide changes.md audit backfill for issue templates and workflows (2026-08-17)

### What changed

- Backfill from the repository-wide changes.md audit (pin 914cf147, tag v0.84.2): records the fork deltas on every upstream-owned `.github` production path. Fork-only additions such as `changelog-gate.yml`, `publish-npm.yml`, `releasability.yml`, `perf-trend.yml`, and `native-prebuilds.yml` are exempt from the audit but share the same conflict zones.
- `.github/ISSUE_TEMPLATE/bug.yml` and `.github/ISSUE_TEMPLATE/contribution.yml`: repointed the CONTRIBUTING.md links from `earendil-works/pi` to `code-yeongyu/senpi` and replaced the upstream auto-close-by-default contributor policy text with the fork policy - issues stay open for maintainer review, and below-quality-bar reports may be closed without extended triage.
- `.github/ISSUE_TEMPLATE/config.yml`: added the senpi repository contact link and relabeled the upstream Discord link as the pi-mono community channel.
- Deleted `.github/workflows/approve-contributor.yml`, `.github/workflows/issue-gate.yml`, and `.github/workflows/pr-gate.yml`: the fork does not operate the upstream approved-contributor regime (lgtm/lgtmi comment approvals into `APPROVED_CONTRIBUTORS`, auto-gating issues and `pull_request_target` PRs from unapproved contributors) that these workflows drive; the fork's templates deliberately keep reports open for maintainer review instead.
- `.github/workflows/ci.yml`: split the single build-check-test job into parallel jobs - a static `check` job, a three-shard `test-coding-agent` vitest matrix, `test-workspaces` for script tests plus every workspace except coding-agent, a `check-and-test` fan-in gate that preserves the required "Check and test" status context, a three-OS `terminal-cross-os` job for the PTY package and terminal/shell suites, and a three-OS `inspector-handoff` job; Node 22 moved to 24, checkout/setup-node pins updated, apt made noninteractive, and per-job timeouts and step summaries added.
- `.github/workflows/build-binaries.yml`: added a `dry_run` input that skips release staging/upload and the npm dispatch; pinned Bun to the exact 1.3.14 release because canary can advance before cross-compilation target executables are published; Node 22 moved to 24; replaced the source-archive rebuild path with a direct `./scripts/build-binaries.sh` run and dropped the source tarball release asset; the `publish-npm` job now dispatches the fork-owned `publish-npm.yml` workflow in publish-only mode (npm trusted publishing is bound to that workflow identity) and awaits it with `gh run watch`; removed the R2-based `announce-pi-dev-release` job.
- `.github/workflows/issue-analysis.yml`: reduced to a read-only single-runner analysis - removed the `#run-on-*` runner selection and per-OS dependency steps, dropped the build step, replaced the `/is <issue-url>` agent invocation with a redacted `.issue-analysis-context.json` written 0600, runs `pi-test.sh` with a read-only permission preset, tools limited to read/grep/find/ls, bash/edit/external-directory denied, redacts token-shaped secrets from the exported session and output before creating the secret gist with `gh gist create`, and checks out with `persist-credentials: false`.
- `.github/workflows/npm-audit.yml` and `.github/workflows/publish-model-catalog.yml`: Node 22 moved to 24 on their setup steps; npm-audit also updates its pinned checkout/setup-node SHAs.

### Why

- The fork renamed the repository, keeps issues open instead of auto-closing new contributors, and publishes npm packages through its own provenance-bound workflow. Keeping upstream's automation would point contributors at the wrong repositories, gate issues and PRs through a contributor-approval regime the fork does not operate, and publish outside the trusted-publishing workflow identity.
- The parallel CI split keeps the required status context stable while cutting wall time on the sharded coding-agent suite, and the read-only issue-analysis rewrite treats untrusted issue text as data, denies mutation, and strips secrets before any artifact leaves the runner.

### Why an extension could not handle it

- Issue templates, workflow definitions, runner matrices, action pins, and trusted-publishing identity are repository and CI configuration evaluated before any Senpi runtime or extension loader exists.

### Expected merge conflict zones

- HIGH: `.github/workflows/ci.yml` and `.github/workflows/build-binaries.yml` job graphs whenever upstream restructures its CI or release pipeline.
- MEDIUM: `.github/workflows/issue-analysis.yml` authorization and analysis steps; the deletions of `.github/workflows/approve-contributor.yml`, `.github/workflows/issue-gate.yml`, and `.github/workflows/pr-gate.yml` resolve to `ours` (keep deleted) on sync.
- LOW: `.github/ISSUE_TEMPLATE/bug.yml`, `.github/ISSUE_TEMPLATE/config.yml`, `.github/ISSUE_TEMPLATE/contribution.yml`, `.github/workflows/npm-audit.yml`, and `.github/workflows/publish-model-catalog.yml` link, policy-text, and Node-version lines.

## Keep npm release installs independent of native build tooling (2026-08-13)

### What changed

- The npm release workflow now installs dependencies with `--ignore-scripts`.
- Added a workflow contract test for the no-script install command.

### Why

- The release workflow builds and tests TypeScript packages; it does not need
  Canvas or other native dependency lifecycle scripts.
- Canvas lacked a compatible prebuild on the current Linux runner and its
  source fallback required system `pangocairo` headers, failing before the
  repository's own build and test gates could run.
- Native artifacts are rebuilt explicitly in the separate binary release
  workflow where their system prerequisites are managed.

### Expected merge conflict zones

- LOW: the dependency-install step in `publish-npm.yml`.
