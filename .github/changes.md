# changes

## 2026-09-26 - Windows interactive-desktop QA workflow for the desktop engine (senpi#2128)

### What changed

- `.github/workflows/desktop-windows-qa.yml`: new `windows-desktop-qa` job on `windows-latest` (path-filtered to the desktop crates/packages and the QA scripts; `pull_request` runs for any base so stacked desktop PRs are covered). It gates on `scripts/ci/windows-interactive-desktop-smoke.ps1`, builds `senpi-desktop-engine` for `x86_64-pc-windows-msvc`, runs `cargo test -p senpi-desktop-backend-win32 -- --include-ignored --test-threads=1`, runs `bun scripts/qa-desktop-windows.ts --all --json`, proves the sabotage path (`--sabotage invalid-chord` must fail `hotkey-latches` with reason `InvalidKey`, checked by `scripts/ci/desktop-windows-qa/expect-sabotage.ts`), and uploads both JSONL files as the `desktop-windows-qa-jsonl` artifact.
- `scripts/qa-desktop-windows.ts` + `scripts/ci/desktop-windows-qa/`: the Windows QA driver. Scenarios `capture-primary`, `foreground-type-notepad-restores-front`, `background-post-message-notepad`, `background-post-message-wpf`, `elevated-window-refused` (a Low-integrity copy of the engine made with `icacls /setintegritylevel Low`), `uia-snapshot-notepad`, `hotkey-latches`; one JSONL line per scenario with facts from an independent PowerShell observer (`observer.ps1`: `GetForegroundWindow`, `Cursor.Position`, UI Automation text, `whoami /groups`, process integrity RID), teardown receipts (`procs 0`, `dir REMOVED`) as the last lines, exit 0 iff every scenario passed and the teardown was clean.

### Why

- The win32 backend's capture, input delivery, UIPI refusal, UI Automation, and RegisterHotKey stop path can only be proven on a real Windows desktop; the hosted runner has one, so every desktop PR gets that proof with facts no engine report can fake.

### Why an extension could not handle it

- CI workflow configuration and a repository QA script.

### Expected merge conflict zones

- NONE: fork-only workflow and scripts.

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
