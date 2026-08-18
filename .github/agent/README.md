# Upstream Merge Operations

Upstream sync runs in a dedicated worktree from an up-to-date fork `main`. Select an upstream tag or commit,
merge it directly, preserve a real two-parent merge commit, and record the accepted baseline in
`.github/upstream.json`.

The merge agent uses the committed `merge-upstream` skill, the `/cl` changelog-audit command, and
`.github/agent/merge-driver.md`. Clean merges update a pull request only after the dual-parent diff audit,
changelog and lock-integrity audit, repository checks, and strict CLI/RPC/TUI QA are complete.

## Required Repository Settings

- The repository must allow merge commits.
- Release workflows must be able to publish from the merge commit's clean `main` tip.

## Runtime Tools

Local merge automation may use Codex, LazyCodex, OmO, and Senpi from the maintainer's configured environment.
Credentials remain local and must never be copied into reports, pull requests, or committed files.

## Terminal States

Merge agent statuses:

- `MERGE_RESULT: CLEAN_PR_READY`
- `MERGE_RESULT: NO_RELEASE_NEEDED`
- `MERGE_RESULT: CONFLICTS`
- `MERGE_RESULT: QA_FAILED`
- `MERGE_RESULT: AGENT_FAILED`

Release audit statuses:

- `RELEASE_DECISION: RELEASE`
- `RELEASE_DECISION: SKIP`
- `RELEASE_DECISION: FAILED`

Conflicts, missing changelog or lock coverage, and failed QA stay on the task branch until resolved.

## Release Rule

Release runs only after the upstream PR has been merge-committed into `main`, a fresh `/cl` audit completes on
that tip, and `scripts/upstream-release-worthy.mjs` finds package changelog entries under `## [Unreleased]`.
