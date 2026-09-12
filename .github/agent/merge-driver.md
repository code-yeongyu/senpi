# Upstream merge + changelog driver

## Release-history and lock invariants

- Preserve every released fork CalVer section byte-for-byte in package `CHANGELOG.md` files.
- Preserve exactly one top-level `[Unreleased]` section per package. Translate adopted upstream release notes into
  that section; never insert upstream SemVer headings into the fork's released history.
- Treat generated dependency locks as integrity artifacts: every external npm entry must retain its `resolved`
  tarball URL and `integrity` hash, and generators must produce identical hashes on consecutive runs.

You are Codex running headless inside GitHub Actions on the `senpi` fork
(`code-yeongyu/senpi`). Your job is to integrate the latest upstream release from
`badlogic/pi-mono`, audit changelogs, and leave a PR-ready automation branch. Work only in
the current repository checkout. Do not contact external services other than git remotes and
GitHub through `gh`.

The remotes `origin` (this fork) and `upstream` (`badlogic/pi-mono`) are already configured.
The current branch is a bot branch created from `main`.

## Procedure

### 1. Merge upstream

Use the **merge-upstream** skill semantics to sync the current bot branch with
`upstream/main` via a history-preserving merge (`git merge --no-ff`). Honor every skill
invariant: no rebase, no force-push, no `--no-verify`, and no history rewrite. Do not push,
open pull requests, merge pull requests, create tags, or run the release.

Fetch live `upstream/main` and apply the skill's verified-no-op terminal condition before
change-dependent work. For a no-op, report exact refs and full SHAs plus the confirmed
ancestry and empty `HEAD..upstream/main` range, then finish with
`MERGE_RESULT: NO_RELEASE_NEEDED`. Do not update the pin, audit changelogs, run QA, create or
publish a pull request, push, or release.

If the upstream release does not require any source, package, changelog, or pin change after
inspection, write a short report and finish with `MERGE_RESULT: NO_RELEASE_NEEDED`.

### 2. Resolve conflicts (fork-aware)

Resolve conflicts using these fork rules plus semantic judgement. For files that are
intentionally fork-modified, read the nearest `changes.md` in that directory first to learn
what the fork preserves and why.

| Path / pattern | Resolution |
|---|---|
| `package-lock.json` | take **ours** (`--theirs` is wrong here — see “Lock regeneration base” below), then regenerate with `PI_ALLOW_LOCKFILE_CHANGE=1 npm install --package-lock-only --ignore-scripts` followed by `npm run refresh-lock` |
| `bun.lock` | remove it, regenerate with `bun install --ignore-scripts` (or take upstream if bun is unavailable) |
| `**/changes.md` | keep **ours** (fork notes), then run the carry-forward check below — `ours` alone silently deletes entries the other side added |
| other `*.md` (docs, READMEs) | take **upstream** unless the fork intentionally diverged |
| `packages/coding-agent/src/core/extensions/builtin/**` | fork-only directory; prefer **ours** unless upstream improves the same path |

#### Lock regeneration base

Regenerate from **ours**, never from `--theirs`. Both bases avoid a hand-merged lock, but upstream's base
discards deliberate fork resolutions. Regeneration re-resolves from the merged `package.json` set either way, so
upstream's dependency changes are still honored — the fork's base only preserves what the fork pinned on purpose.

After regenerating, verify the hoisted version of every dev tool a type augmentation depends on still matches the
fork's pin, because a hoist change is invisible in the lock diff but breaks compilation:

```bash
node -p "require('./node_modules/vitest/package.json').version"   # must match the fork's pinned major.minor.patch
npx tsc --noEmit                                                   # must stay at zero errors
```

Incident that produced this rule (2026-08-19, upstream `59a71b23`): resolving the root lock with `--theirs` and
regenerating hoisted `vitest` 4.1.9 instead of the fork's 4.1.10. `packages/evals` pins 4.1.10 exactly, so the
fork's `declare module "vitest"` augmentation in `src/vitest-evals/artifacts.ts` and the code importing it bound to
two different module instances, producing five `TaskMeta` type errors (`Property 'harness' does not exist`).
Rebasing the lock on `ours` and regenerating restored the 4.1.10 hoist and cleared all five.

#### changes.md carry-forward check

`ours` is the right base for trackers, but it is not sufficient: when both sides added entries, keeping ours drops
theirs silently, and a dropped entry leaves a production path uncovered for the *next* sync rather than failing now.
After resolving every conflicted tracker, verify no path reference was lost:

```bash
# for each conflicted tracker, compare the repo-relative paths each side references
git show <other-side-sha>:<tracker> | rg -o '(packages|scripts|crates)/[^`) ]+\.(ts|tsx|mjs|json|md)' | sort -u > /tmp/theirs.txt
rg -o '(packages|scripts|crates)/[^`) ]+\.(ts|tsx|mjs|json|md)' <tracker> | sort -u > /tmp/ours.txt
comm -23 /tmp/theirs.txt /tmp/ours.txt   # must be empty; anything listed was dropped
```

Re-add every dropped path as a **self-contained dated `## ` block** carrying all four canonical headings.
`entryCovers` in `scripts/changes-md-policy.mjs` splits trackers into dated `## ` blocks and requires the path *and*
all four sections inside the **same** block — appending the path into a neighbouring block does not count as
coverage even though the text is present in the file.

Authoritative verification is the full-tree audit, run **unpiped** so its exit code survives:

```bash
node scripts/audit-changes-md.mjs --format markdown   # must exit 0; expect "0 uncovered"
```

Never read a gate's status through a pipe (`... | tail`), which reports the pipeline's exit code instead of the
script's. The PR gate `scripts/check-pr-changelog.mjs` is not a substitute: it counts only tracker entries the PR
itself touched, so it can pass while the tree has an uncovered path.

Incident that produced this rule (2026-08-19): merging current `origin/main` into the sync branch conflicted on
three trackers; resolving them to `ours` deleted the entry `origin/main` had just added for
`packages/coding-agent/src/core/footer-data-provider.ts`. The PR gate still passed; only
`audit-changes-md.mjs` caught it, at 238/239 paths covered.

Known fork-modified source files are not auto-resolvable; read their `changes.md` and merge
semantically, preserving fork behavior while adopting upstream improvements:

- `packages/agent/src/agent-loop.ts`
- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/model-registry.ts`
- `packages/coding-agent/src/core/settings-manager.ts`
- `packages/coding-agent/src/core/resource-loader.ts`
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- `packages/tui/src/tui.ts`

If a conflict is genuinely ambiguous and you cannot resolve it with confidence, abort the
merge (`git merge --abort`), write `.github/agent/last-merge-report.md` with the unresolved
files and analysis, print `MERGE_RESULT: CONFLICTS`, and exit. Do not guess on semantic
conflicts.

### 3. Update the upstream pin

After a clean merge, update `.github/upstream.json` to record the merged upstream state:
set `tag` to the latest upstream release tag, `sha` to the merged `upstream/main` commit, and
`synced_at` to the current UTC time (`YYYY-MM-DDTHH:MM:SSZ`). Stage and amend it into the
merge commit, or add a follow-up commit `sync: record upstream pin <short-sha>`.

### 4. Audit the changelog

Run `/cl` by following `.github/agent/commands/cl.md`. Add missing `## [Unreleased]` entries
to the affected packages' `CHANGELOG.md` files. Commit changelog updates as
`docs(changelog): audit upstream <short-sha>`.

### 5. Hands-on QA

Verify the merged tree with the same credential-free gates the workflow treats as
authoritative. Run each command from the repository root:

```bash
npm run build
npm run check
npm test
```

Then smoke-test the CLI from the built workspace:

```bash
node packages/coding-agent/dist/cli/index.js --version
node packages/coding-agent/dist/cli/index.js --help
```

Use the actual built entrypoint if the path differs; locate it under
`packages/coding-agent/dist`.

If `npm run check` reports warnings, treat the tree as not PR-ready. Fix the warnings, rerun
`npm run check`, and commit the focused fix before continuing. Because `npm run check` may
write formatter fixes, run `git status --porcelain` after it and commit any intentional
source changes it produced. Do not leave check-written files unstaged or uncommitted.

If the build or smoke test fails, attempt a focused fix that preserves both fork and upstream
intent. Re-run until green. If you cannot get a building tree, write
`.github/agent/last-merge-report.md`, print `MERGE_RESULT: QA_FAILED`, and exit without
leaving a broken tree staged for release.

When runtime packages changed (`packages/ai`, `packages/agent`, `packages/coding-agent`, or
`packages/tui`), run the matching `.agents/skills/senpi-qa/` channel and capture evidence
under `local-ignore/qa-evidence/`. At minimum, run the same self-tests as the workflow:

```bash
node .agents/skills/senpi-qa/scripts/lib/common.mjs --self-check
node .agents/skills/senpi-qa/scripts/mock-loop.mjs --self-test --evidence upstream-agent-mock-loop
node .agents/skills/senpi-qa/scripts/cli-smoke.mjs --self-test
```

If `tmux` is available, also run:

```bash
node .agents/skills/senpi-qa/scripts/tui-smoke.mjs --self-test --driver tmux --evidence upstream-agent-tui
```

### 6. Finish

Leave the bot branch with committed merge, pin, changelog, and focused fix commits in place.
Write `.github/agent/last-merge-report.md` with the upstream tag, preserved fork commits,
conflicts resolved and how, changelog entries added, and QA results.

The final stdout line MUST be exactly one of:

- `MERGE_RESULT: CLEAN_PR_READY`
- `MERGE_RESULT: NO_RELEASE_NEEDED`
- `MERGE_RESULT: CONFLICTS`
- `MERGE_RESULT: QA_FAILED`
- `MERGE_RESULT: AGENT_FAILED`

## Hard rules

- Never `git push`, `git rebase`, `git push --force`, or `git reset --hard origin/*`.
- Never bypass hooks/signing with `--no-verify` or `--no-gpg-sign`.
- Never create or merge pull requests, create tags, or run `scripts/release.mjs`.
- Never edit already-released changelog version sections.
- Never edit `packages/ai/src/models.generated.ts` or `image-models.generated.ts` by hand.
