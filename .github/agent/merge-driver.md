# Upstream merge + changelog driver

You are running headless inside GitHub Actions on the `senpi` fork
(`code-yeongyu/senpi`). Your job: integrate the latest upstream release from
`badlogic/pi-mono`, audit the changelog, and QA the result so the workflow can cut a
release. Work only in the current repository checkout. Do not contact any external service
other than git remotes and GitHub via `gh`.

The remotes `origin` (this fork) and `upstream` (`badlogic/pi-mono`) are already configured,
and `upstream` has been fetched. The current branch is `main`.

## Procedure

### 1. Merge upstream

Use the **merge-upstream** skill to sync `main` with `upstream/main` via a history-preserving
merge (`git merge --no-ff`). Honor every skill invariant: NO rebase, NO force-push, NO
`--no-verify`, NO history rewrite. Do **not** push and do **not** run the release here — the
workflow handles release after QA.

### 2. Resolve conflicts (fork-aware)

Resolve conflicts using these fork rules plus semantic judgement. For files that are
intentionally fork-modified, read the nearest `changes.md` in that directory first to learn
what the fork preserves and why.

| Path / pattern | Resolution |
|---|---|
| `package-lock.json` | take **upstream** (`--theirs`), then regenerate with `npm install` |
| `bun.lock` | remove it, regenerate with `bun install` (or take upstream if bun is unavailable) |
| `**/changes.md` | keep **ours** (fork notes) |
| other `*.md` (docs, READMEs) | take **upstream** unless the fork intentionally diverged |
| `packages/coding-agent/src/core/extensions/builtin/**` | fork-only directory — prefer **ours** unless upstream improves the same path |

Known fork-modified source files — these are NOT auto-resolvable; read their `changes.md`
and merge semantically, preserving fork behavior while adopting upstream improvements:

- `packages/agent/src/agent-loop.ts`
- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/model-registry.ts`
- `packages/coding-agent/src/core/settings-manager.ts`
- `packages/coding-agent/src/core/resource-loader.ts`
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- `packages/tui/src/tui.ts`

If a conflict is genuinely ambiguous and you cannot resolve it with confidence, STOP: abort
the merge (`git merge --abort`), write a report to `.github/agent/last-merge-report.md`
describing the unresolved files and your analysis, print `MERGE_RESULT: CONFLICTS`, and exit.
Do not guess on semantic conflicts.

### 3. Update the upstream pin

After a clean merge, update `.github/upstream.json` to record the merged upstream state:
set `tag` to the latest upstream release tag, `sha` to the merged `upstream/main` commit, and
`synced_at` to the current UTC time (`YYYY-MM-DDTHH:MM:SSZ`). Stage and amend it into the
merge commit, or add a follow-up commit `sync: record upstream pin <short-sha>`.

### 4. Audit the changelog

Run the `/cl` command to audit changelogs for every commit the merge introduced. Add any
missing `## [Unreleased]` entries to the affected packages' `CHANGELOG.md` per the format in
the command. Commit the changelog updates (`docs(changelog): audit upstream <short-sha>`).

### 5. Hands-on QA

Verify the merged tree actually works — do not trust the merge blindly:

```bash
npm run build
npm run check
npm test
```

If any gate fails, attempt a focused fix (the fix must stay faithful to both fork and
upstream intent — never delete functionality to silence a type error). Re-run until green. If
you cannot get a green tree, write `.github/agent/last-merge-report.md`, print
`MERGE_RESULT: QA_FAILED`, and exit without leaving a broken tree staged for release.

Then smoke-test the CLI from the built workspace:

```bash
node packages/coding-agent/dist/cli/index.js --version
node packages/coding-agent/dist/cli/index.js --help
```

(Use the actual built entrypoint if the path differs — locate it under
`packages/coding-agent/dist`.)

### 6. Finish

Leave `main` with the merge commit, pin update, and changelog commits in place — committed
but NOT pushed. Write a concise summary to `.github/agent/last-merge-report.md` (upstream tag
merged, fork commits preserved, conflicts resolved and how, changelog entries added, QA
results). Print `MERGE_RESULT: CLEAN` as the final line so the workflow proceeds to release.

## Hard rules

- Never `git push`, `git rebase`, `git push --force`, or `git reset --hard origin/*`.
- Never bypass hooks/signing (`--no-verify`, `--no-gpg-sign`).
- Never edit already-released changelog version sections.
- Never edit `packages/ai/src/models.generated.ts` or `image-models.generated.ts` by hand.
- The final stdout line MUST be exactly one of:
  `MERGE_RESULT: CLEAN`, `MERGE_RESULT: CONFLICTS`, or `MERGE_RESULT: QA_FAILED`.
