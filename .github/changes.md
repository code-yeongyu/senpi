# changes

## Gate the inherited model-catalog publisher behind fork opt-in (2026-08-20)

### What changed

- `.github/workflows/publish-model-catalog.yml` now schedules the `publish` job only when the repository variable `PI_MODEL_CATALOG_PUBLISH` is exactly `true`, in addition to its existing event and manual-publish conditions.

### Why

- This fork inherited upstream's R2 endpoint and bucket without either required `PI_ARTIFACTS_R2_*` secret. Every upload attempt therefore exported empty AWS credentials and failed with `Unable to locate credentials`, while generation and validation stayed green.
- Keeping publishing opt-in makes the fork's default workflow honest: catalog generation still runs and is validated, but the unavailable upstream infrastructure no longer creates recurring default-branch failures. A maintainer can restore uploads after configuring a fork-owned R2 target, both secrets, and the opt-in variable.

### Why an extension could not handle it

- GitHub evaluates the job graph, repository variables, and environment secrets before any Senpi runtime or extension is available.

### Expected merge conflict zones

- MEDIUM: the `publish` job condition in `.github/workflows/publish-model-catalog.yml`, because upstream may continue changing its publication events or credential contract. Preserve the fork opt-in unless the fork owns a working publication target.

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
