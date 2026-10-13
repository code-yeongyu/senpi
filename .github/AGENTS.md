# .github/

CI, release, and issue automation for the senpi fork, plus the committed agent guidance
the merge/release workflows execute. Score 12: 25 files, distinct automation domain —
prescriptive rules here are load-bearing for agents running in Actions.

## STRUCTURE

```text
workflows/     13 workflows (CI, build-binaries, native-prebuilds, publish-npm,
               publish-model-catalog, changelog-gate, releasability, npm-audit,
               perf-trend, issue-analysis, issue-triage-labels, remove-inprogress-on-close)
agent/         Merge/release agent drivers, /cl command, committed skills
ISSUE_TEMPLATE/ bug.yml, contribution.yml, package-report.yml
upstream.json  Accepted upstream baseline recorded by merges (read by scripts)
```

## WHERE TO LOOK

| Task | Path |
|---|---|
| CI parity for local checks | `workflows/ci.yml` (Node 24, `npm ci --ignore-scripts`, bun 1.4.2 pinned through `oven-sh/setup-bun` in the jobs that run bun, fan-in job named exactly `Check and test`) |
| npm publish path | `workflows/publish-npm.yml` (the ONLY publisher; triggered after release tag) |
| Binary/native builds | `workflows/build-binaries.yml`, `workflows/native-prebuilds.yml` |
| PR changelog gate | `workflows/changelog-gate.yml` (drives `scripts/check-pr-changelog.mjs`) |
| Merge agent procedure | `agent/README.md`, `agent/merge-driver.md`, `agent/skills/merge-upstream/` |
| Release audit agent | `agent/release-driver.md`, `agent/skills/release-publish/` |
| Changelog audit command | `agent/commands/cl.md` |

## CONVENTIONS

- GitHub Actions are pinned by full commit SHA (e.g. `actions/checkout@df4cb1c0...`); never reference floating tags.
- Workflows install with `npm ci --ignore-scripts` and run the root scripts through npm (`npm run check`, `npm run build`, `npm run test:scripts`); `test-workspaces` also runs `bun run test:scripts` under pinned bun 1.4.2 to prove the bun path of the root scripts and runs the workspace suites through `scripts/run-workspaces.mjs`; `rpc-windows` runs its suites through `bunx vitest`.
- The release driver emits a final stdout status line: `RELEASE_DECISION: RELEASE | SKIP | FAILED`.
  The merge agent emits `MERGE_RESULT: CLEAN_PR_READY | NO_RELEASE_NEEDED | CONFLICTS | QA_FAILED | AGENT_FAILED`.
- Release runs only after the upstream PR is merge-committed into `main`, a fresh `/cl`
  audit passes on that tip, and `scripts/upstream-release-worthy.mjs` finds `## [Unreleased]`
  package changelog entries.

## MERGE QUEUE

The workflows behind every check that branch protection requires on `main` also run on `merge_group`
(`types: [checks_requested]`), under the same job names. `.github/required-checks.json` lists those
checks and their jobs, and `scripts/merge-queue-workflows.test.mjs` fails when a listed workflow loses
its `merge_group` trigger, a job name drifts from the required context, or an event filter would skip
the job on the queue. Keep that file equal to the branch-protection setting.

- `Check and test` (`ci.yml`) runs the full CI on the queue's merge commit.
- `Changelog gate` (`changelog-gate.yml`) runs only the whole-tree `changes.md` audit there; the per-PR
  check needs the PR's base, head and labels, which a merge group does not carry, and it already passed on the PR.
- `Review claim gate` (`review-claims.yml`) re-reads the queued PR's claim labels (PR number from the
  `gh-readonly-queue/<base>/pr-<n>-<sha>` head ref) and fails closed when it cannot tell which PR it is for.

Until a maintainer enables the queue, nothing changes for PRs or pushes.

Queue runs execute the queued PR's own workflow files in this repository's context, with its secrets and
with whatever `permissions:` those files ask for. Queuing a PR therefore runs its workflow changes with
secrets before it merges, even if the queue then rejects it. Before enabling the queue, the `main` rule must
require at least one approval, code-owner review for `.github/**`, and approval of the most recent push, so a
workflow change cannot reach the queue unreviewed.

To enable it: Settings > Branches > `main` rule (or a ruleset) > Require merge queue, keep the same three
required checks, merge method "merge commit". Once enabled, a PR is ready when its own checks are green and it
is approved; the queue re-tests it on top of the latest `main`, so nobody updates branches by hand. With merge
groups larger than one, the claim gate checks the newest PR in the group; keep the group size at 1 or rely on
each PR's own gate run.

## ANTI-PATTERNS

- NEVER rebase, force-push, or rewrite history; never bypass hooks (`--no-verify`).
- NEVER publish npm packages from the binary workflow — npm publishing belongs to `publish-npm.yml` only.
- NEVER edit already-released changelog sections; released sections are immutable.
- NEVER rerun a release after a tag exists; verify npm versions after a PUT 404 before
  retrying or declaring failure.
- Credentials stay local to the runner; never copy them into reports, PRs, or committed files.

---
Generated: 2026-08-24 | Commit `baf15a54d`
