# changes

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
