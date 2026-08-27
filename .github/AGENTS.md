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
| CI parity for local checks | `workflows/ci.yml` (Node 24, `npm ci --ignore-scripts`, fan-in job named exactly `Check and test`) |
| npm publish path | `workflows/publish-npm.yml` (the ONLY publisher; triggered after release tag) |
| Binary/native builds | `workflows/build-binaries.yml`, `workflows/native-prebuilds.yml` |
| PR changelog gate | `workflows/changelog-gate.yml` (drives `scripts/check-pr-changelog.mjs`) |
| Merge agent procedure | `agent/README.md`, `agent/merge-driver.md`, `agent/skills/merge-upstream/` |
| Release audit agent | `agent/release-driver.md`, `agent/skills/release-publish/` |
| Changelog audit command | `agent/commands/cl.md` |

## CONVENTIONS

- GitHub Actions are pinned by full commit SHA (e.g. `actions/checkout@df4cb1c0...`); never reference floating tags.
- Workflows install with `npm ci --ignore-scripts` and run root `npm run check`/`npm test`.
- The release driver emits a final stdout status line: `RELEASE_DECISION: RELEASE | SKIP | FAILED`.
  The merge agent emits `MERGE_RESULT: CLEAN_PR_READY | NO_RELEASE_NEEDED | CONFLICTS | QA_FAILED | AGENT_FAILED`.
- Release runs only after the upstream PR is merge-committed into `main`, a fresh `/cl`
  audit passes on that tip, and `scripts/upstream-release-worthy.mjs` finds `## [Unreleased]`
  package changelog entries.

## ANTI-PATTERNS

- NEVER rebase, force-push, or rewrite history; never bypass hooks (`--no-verify`).
- NEVER publish npm packages from the binary workflow — npm publishing belongs to `publish-npm.yml` only.
- NEVER edit already-released changelog sections; released sections are immutable.
- NEVER rerun a release after a tag exists; verify npm versions after a PUT 404 before
  retrying or declaring failure.
- Credentials stay local to the runner; never copy them into reports, PRs, or committed files.

---
Generated: 2026-08-24 | Commit `baf15a54d`
