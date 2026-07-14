# Upstream merge + changelog driver

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
| `package-lock.json` | take **upstream** (`--theirs`), then regenerate with `npm install --package-lock-only --ignore-scripts` |
| `bun.lock` | remove it, regenerate with `bun install --ignore-scripts` (or take upstream if bun is unavailable) |
| `**/changes.md` | keep **ours** (fork notes) |
| other `*.md` (docs, READMEs) | take **upstream** unless the fork intentionally diverged |
| `packages/coding-agent/src/core/extensions/builtin/**` | fork-only directory; prefer **ours** unless upstream improves the same path |

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
