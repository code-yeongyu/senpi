# Merge upstream v0.84.1 and publish the verified Senpi release

## Objective

History-preserve the latest released upstream `badlogic/pi-mono` tag `v0.84.1`
inside `code-yeongyu/senpi`, retain every documented fork behavior, repair stale
`changes.md` and changelog coverage, land the work through a merge-commit PR,
and publish the resulting canonical CalVer release with exhaustive automated and
manual QA evidence.

## Constraints

- Work only in a dedicated task worktree after this plan and the live todo list exist.
- Merge upstream with `--no-ff`; never rebase, squash, force-push, or hand-rewrite ancestry.
- Merge `v0.84.1` (`53fa77ccd8a279eb87e92294ef3687b03ff80112`), not the
  117 unreleased commits currently on `upstream/main`.
- Preserve fork-owned `**/changes.md`, CalVer release history, package identity,
  builtin extensions, provider middleware, PTY/codemode/web-ui packages, and
  release tooling.
- Treat generated catalogs and lock artifacts as generated; rebuild them with
  canonical scripts rather than hand-merging.
- Runtime changes require focused tests, `npm run check`, `npm run build`,
  `npm test`, LSP diagnostics, and real Senpi QA receipts.
- Do not invoke Momus in this run.
- The PR is unfinished until GitHub reports `MERGED`; the release is unfinished
  until the public tag/artifacts/packages are verified and the worktree is gone.

## Skills and delegation

- `merge-upstream`: history-preserving upstream synchronization.
- `work-with-pr`: dedicated worktree, PR, CI/review loop, merge, cleanup.
- `git-master` and `commit`: topology analysis and atomic commits.
- `ulw-loop` and `start-work`: binding goal, evidence ledger, and continuation.
- `programming`: TDD, strict typing, and LSP for source conflict resolutions.
- `senpi-qa`: real CLI/RPC/mock-loop/TUI evidence.
- `review-work`: five-lane post-implementation review before handoff.
- Completed read-only advisory lanes: architect risk/wave analysis, whole delta
  inventory, and `changes.md`/changelog gap audit.
- The lead owns all overlapping semantic merge edits. Independent validators and
  review agents may fan out after the merge tree is resolved.

## Tier

HEAVY: the change crosses session storage, authentication, provider streaming,
compaction, TUI, generated model catalogs, package topology, and release
infrastructure, and strict review was explicitly requested.

## Success criteria

### History and topology

- RED: `git merge-base --is-ancestor v0.84.1 origin/main` exits 1.
- GREEN: after GitHub merge it exits 0; the PR merge SHA has two parents and its
  upstream ancestry includes `v0.84.1`; `.github/upstream.json` records the exact
  tag and SHA.
- Evidence: `local-ignore/qa-evidence/20260813-upstream-v0.84.1-release/history/`.

### Changelog and fork-change documentation

- RED: current audit proves `5678c2cd9` lacks a coding-agent `[Unreleased]`
  entry, `src/core/changes.md` lacks the image-history setting, app-server has no
  tracker, and merge/upstream-pin documentation is stale.
- GREEN: `node scripts/check-pr-changelog.mjs --base "$(git merge-base HEAD
  origin/main)"` exits 0; every user-facing upstream/fork change is represented
  exactly once in the correct package; released CalVer sections retain their
  pre-merge hashes; nearest touched `changes.md` entries contain what, why,
  why-not-extension, and expected conflict zones.
- Evidence: `local-ignore/qa-evidence/20260813-upstream-v0.84.1-release/changelog/`.

### Runtime semantics

- PIN: before merge, focused agent-loop, provider-streaming, compaction,
  auth/session, settings, extension, TUI, and fork-regression suites pass.
- RED: immediately after the raw merge, focused suites expose unresolved or
  upstream-only semantic resolutions. For protected clean auto-merges, temporarily
  substitute the upstream side at the exact seam and prove the existing assertion
  fails, then restore.
- GREEN: all focused suites, changed-file LSP diagnostics, `npm run check`,
  `npm run build`, and `npm test` pass with no skipped or weakened tests.
- Evidence: `local-ignore/qa-evidence/20260813-upstream-v0.84.1-release/tests/`.

### Real user surfaces

- RED: before merge, `node packages/coding-agent/dist/cli.js auth check --help`
  demonstrates that the upstream command is absent or unsupported.
- GREEN CLI: source-built `--help`, `--version`, `--list-models`, `auth check
  --help`, valid faux-provider `--print`, and malformed invocation produce the
  expected exit/output contract with no load warnings.
- GREEN RPC: `senpi-qa` RPC self-test plus an isolated live JSONL exchange returns
  the expected response and rejects malformed NDJSON.
- GREEN mock loop: deterministic fake-model server completes a tool-capable real
  CLI turn with no credentials/tokens and preserves retry/tool-pair behavior.
- GREEN TUI: `senpi-qa` TUI smoke and
  `node script/qa/web-terminal-visual-qa.mjs --title "Senpi upstream v0.84.1"
  --command "<source CLI command>" --input "{Enter}" --evidence-dir <dir>` show
  correct xterm.js layout, colors, wide glyphs, fullscreen scrolling/selection,
  and no crash.
- Evidence and cleanup receipts:
  `local-ignore/qa-evidence/20260813-upstream-v0.84.1-release/manual/`.

### PR, merge, and release

- RED: before release, the computed CalVer tag is absent from git and GitHub.
- GREEN: required PR checks and review-work pass; GitHub reports a merge-commit
  PR `MERGED`; clean `main` contains `v0.84.1`; canonical `scripts/release.mjs`
  completes once; GitHub reports the computed CalVer release; public artifact
  checksums match downloaded files; npm aliases report the new version; release
  workflows are green or only a repository-permitted documented quota skip remains.
- Evidence: `local-ignore/qa-evidence/20260813-upstream-v0.84.1-release/release/`.

## Execution waves

### Foundation

1. Capture history/changelog/CLI RED evidence and focused pre-merge PIN tests.
2. Prove stale merge worktrees and branches are clean and fully merged; remove
   only those proven safe, then prune.
3. Create a dedicated worktree and task branch from current `origin/main`.
4. Place this plan in the worktree, remove the temporary shared copy, inspect
   commit conventions, commit the plan atomically, push, and open a draft PR.
5. Register the binding goal after the PR exists.

### Merge

6. Run `git merge --no-ff --no-commit v0.84.1`.
7. Inventory every conflict and every dual-modified auto-merge before editing.
8. Resolve fork policy, changelogs, and `changes.md`.
9. Resolve package topology/session backend changes.
10. Resolve manifests, versions, lockfiles, and publish metadata.
11. Resolve AI provider/auth/streaming/retry changes.
12. Resolve agent harness, compaction, and session changes.
13. Resolve coding-agent core, extensions, auth, settings, RPC/app-server, and
    interactive mode.
14. Resolve TUI behavior, tests, examples, docs, workflows, and scripts.
15. Regenerate model catalogs, lockfiles, shrinkwrap/publish locks, and other
    canonical generated artifacts.

### Verification

16. For each semantic group, capture focused RED→GREEN and clean LSP diagnostics,
    then commit an atomic verified increment.
17. Run the exhaustive changelog/`changes.md` audit and released-section hash check.
18. Run `npm run check`, `npm run build`, and `npm test`.
19. Run CLI, RPC, mock-loop, and xterm.js TUI QA with cleanup receipts.
20. Run review-work; verify and fix every criterion-cited blocker.
21. Refresh `origin/main`; merge it into the task branch if necessary; re-run
    affected gates.

### Delivery

22. Push final commits, mark the PR ready, and monitor CI/reviews to terminal state.
23. Merge through GitHub using a merge commit only; verify two-parent topology and
    upstream ancestry.
24. Fast-forward the clean shared `main`.
25. Re-run changelog audit and release-worthiness; compute the CalVer tag and
    capture its pre-release absence.
26. Run the canonical release script exactly once.
27. Monitor build/publish workflows, then verify GitHub release metadata, public
    checksums/smokes, npm aliases, and clean post-release `main`.
28. Remove the task worktree and merged branch, prune metadata, prove all QA
    processes/ports/temp resources are gone, reconcile todos, and complete the goal.

## Stop condition

Stop immediately when GitHub reports the sync PR merged, the canonical CalVer
release is publicly verified, every scenario passes with captured evidence and
cleanup receipts, no todo remains open, the goal completion audit passes, and the
task worktree has been removed.
