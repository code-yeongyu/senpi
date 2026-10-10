## 2026-10-10 - Test-run temporary storage has an owner (senpi#3064)

### What changed

- `.github/workflows/ci.yml`, `.github/workflows/releasability.yml`: test invocations use scripts/run-tests.mjs so TMPDIR/TEMP/TMP are scoped before the test runtime starts and cleaned after exit.
- `.github/workflows/ci.yml`, `.github/workflows/releasability.yml`: every test job snapshots the OS temp directory before its first test step and runs final teardown/check with `always()` when that snapshot succeeded. Unowned leftovers fail the job and are named; snapshots live under gitignored local-ignore.
- `.github/workflows/ci.yml`, `.github/workflows/releasability.yml`: snapshot setup explicitly exports a creator-owned cleanup journal. Final teardown retires only recorded run roots before checking for unowned residue, including a run root recreated by late Windows child activity.
- `.github/workflows/ci.yml`, `.github/workflows/releasability.yml`: exported TMPDIR/TEMP/TMP make the job's count an exclusive measurement, not a count of unrelated host daemons. Final teardown removes its own job parent and restores the host temp environment before post-job actions.

### Why

- Vitest SSR copies and interrupted fixture writes must not accumulate in the OS temp directory.

### Why an extension could not handle it

- Test-process bootstrap is repository tooling, before runtime extensions load.

### Expected merge conflict zones

- Test command arguments and runtime selection; preserve existing reporters, shards and test filters.

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
