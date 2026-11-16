---
name: release-publish
description: Release, publish, CalVer tag push, npm publish, 배포, 릴리즈 for senpi. Use for the canonical release flow, GitHub tag/release publication, and npm publishing.
---

# Release Publish

Use this skill when releasing senpi with the canonical CalVer flow, pushing a release tag, publishing the GitHub Release, or publishing packages to npm.

## Canonical release flow

Run `scripts/release.mjs` from a clean `main` checkout.

- [ ] Confirm you are on `main`.
- [ ] Confirm the worktree is clean.
- [ ] Confirm the release version is a valid CalVer.
- [ ] Run the changelog audit before release.
- [ ] Make only product-facing release notes from `packages/coding-agent/CHANGELOG.md` via `scripts/release-notes.mjs`.
- [ ] Skip housekeeping, upstream-sync, and generated-catalog-only entries.
- [ ] Duplicate user-facing ai/agent/tui changes into the coding-agent changelog.
- [ ] Run `npm run check`.
- [ ] Run `npm run build`.
- [ ] Run `CI=1 npm test`.
- [ ] Create the release commit.
- [ ] Create the release tag.
- [ ] Create the next-cycle changelog commit.
- [ ] Push `main` and the tag.

## Pre-flight checklist

- [ ] Read the current release rules in `AGENTS.md` and `scripts/AGENTS.md`.
- [ ] Use a clean dedicated clone if the main checkout has foreign state.
- [ ] Never clean, stash, or otherwise disturb other people's work.
- [ ] Use the protected-main path when needed; `UPSTREAM_AUTOMATION_TOKEN` exists for authenticated protected-main pushes.
- [ ] npm publish is delegated: the tag pipeline's `publish-npm` job no longer publishes — it dispatches `publish-npm.yml` in publish-only mode (the proven route from the v2026.7.28-x and v2026.8.4 recoveries) and gates the public GitHub Release on that run's success. npm's trusted publisher matches the `publish-npm.yml` workflow identity only; never reintroduce a direct publish or an `environment:` on the publish path (the environment subject is what npm rejects).
- [ ] Do not rerun `scripts/release.mjs` after the tag has been pushed.
- [ ] If checks fail before the tag push, fix first, then re-release from the beginning.
- [ ] Treat `E404` noise for `@code-yeongyu/senpi-orchestrator` as non-fatal.
- [ ] Use `node scripts/release-notes.mjs` / the cl.md audit before publishing notes.
- [ ] Keep release notes product-facing only.

## Publish watch

After tag push, watch the `build-binaries` workflow run (find the run id via `gh run list --workflow=build-binaries.yml --branch main --limit 1 --json databaseId -q '.[0].databaseId'`).

The `publish-npm` job dispatches `publish-npm.yml` in publish-only mode, prints the dispatched run URL, waits up to 60 minutes, and fails if the publish run fails. There is no environment approval gate on the publish path — the old `npm-publish` environment subject is exactly what npm's trusted-publisher registration rejects.

Never consider the release done before `publish-npm` and `publish-github-release` complete and the GitHub Release is non-draft. If the publish job fails, recover with `gh workflow run publish-npm.yml -f version=<v> -f publish-only=true`, never by rerunning `release.mjs`.

## Boat runners (senpi#6850)

Off by default. Every job runs on GitHub-hosted runners unless the repository variable `RELEASE_BOAT_ENABLED` is `true` AND a `workflow_dispatch` of `publish-npm.yml` or `build-binaries.yml` passes a non-empty `boat_run_label`. A tag push, a pull request, a push to main and an empty label always keep today's runners.

- What moves: `publish-npm.yml`'s forced-suite jobs (`prepare`, `forced-rest`, the `forced-shard` matrix), `build-binaries.yml`'s `build`, and `native-prebuilds.yml`'s two Linux build rows (only when a target misses the prebuild cache; `publish-npm.yml` forwards its label). They run on `[self-hosted, boat-large, <boat_run_label>]`.
- What never moves: the `release` job (it holds the push token, and npm trusted publishing with provenance supports only cloud-hosted runners), `require-version`, every GitHub Release job, the npm dispatch, the binary smoke, and every macOS/Windows leg.
- Runners: the dispatcher, a tool outside this repository, starts one ephemeral just-in-time self-hosted runner per Boat job in a Boat sandbox, each labelled `self-hosted`, `boat-large` and a label unique to the run, and only then dispatches the workflow with that label. A forced cut needs 2 + the shard count (8) runners. A build-binaries dispatch needs 1. A publish-only run needs 1 per Linux target that misses the cache (0 to 2). No runner registration credential lives in this repository.
- Fallback: each Boat dispatch also starts `boat-watchdog`, a GitHub-hosted job with only `actions: write`. When a Boat job sits queued for 10 minutes because no runner picked it up, the watchdog does three things through `scripts/boat-watchdog.mjs`. It dispatches the same workflow again with the same inputs and an empty `boat_run_label`; an empty `sha` is pinned to the run's commit on main. It then cancels the run, and the hosted run starts once the cancelled one leaves the `concurrency` group. If the watchdog itself cannot run, do the same by hand: cancel the run, then dispatch it again with `boat_run_label=` (empty), or set `RELEASE_BOAT_ENABLED` to `false`.
- A test failure on Boat is not a reason to fall back. Rerun the failing shard on hosted runners to tell an environment failure from a real one first.
- Keep the repository setting that requires approval before workflows from outside contributors run: a self-hosted runner waiting for its job must not be reachable from a fork's workflow.

## Gate disambiguation

These are separate controls and must not be conflated:

- GitHub Environment approval: removed from the publish path (the `npm-publish` environment subject is what npm rejects); the unused environment may remain in repo settings harmlessly.
- npm OIDC trusted publishing: the npm-side trusted publishing path used by the job.
- npm lifecycle-script review: the `npm approve-scripts --allow-scripts-pending` trust review, which is not publish approval.
- Protected-main authorization: the authenticated push path for protected `main`, which is distinct from publish approval.

## Hazards and hard rules

- Protected-main push failures are expected if the token path is wrong; use `UPSTREAM_AUTOMATION_TOKEN` for the authenticated release push path.
- The tag pipeline publishes only through the dispatched `publish-npm.yml` identity (see Pre-flight checklist). If npm-side config changes, re-verify with a `dry_run` dispatch before the next release.
- Never rerun `scripts/release.mjs` after the tag is pushed. If publishing fails, recover from the existing tag workflow.
- If a check or test fails before the tag push, stop and fix the issue, then re-release. Do not try to salvage a bad release by continuing past the failure.
- `E404` noise for `@code-yeongyu/senpi-orchestrator` is not a release failure.
- **An npm PUT 404 during `npm publish` can be a false negative**: the publish may have landed anyway (observed live on 2026-07-28 with `@code-yeongyu/senpi@2026.7.28-2` — the job failed but the version exists). ALWAYS verify with `npm view <pkg> versions --json` before treating a publish error as real, before rerunning anything, and before declaring a release failed.
- A failed `publish-npm` job skips `publish-github-release` and triggers the draft-cleanup path; check `gh release view v<version>` before recovering — the release may already be live. Recover only through the existing tag workflow, never by rerunning `release.mjs`.
- Since senpi#6627 the npm publish no longer waits for the binary smoke. A failed smoke therefore leaves npm published with neither a draft nor a GitHub Release. A failed or cancelled `stage-github-release` can leave an incomplete draft next to a published npm version. In both states, never publish an existing draft. Re-run the failed jobs of the Build Binaries run, or re-stage from its `release-assets-v<tag>` artifact as `release-draft-cleanup.sh` prints, then publish.
- If the main checkout has foreign state, use a clean dedicated clone/worktree. Never clean or stash someone else's work.

## Release notes provenance

- Extract notes only from `packages/coding-agent/CHANGELOG.md` via `scripts/release-notes.mjs`.
- Keep changelog entries product-facing.
- Run the cl.md audit before release.
- Skip housekeeping, upstream-sync, and generated-catalog-only changes.
- Duplicate user-facing ai, agent, and tui changes into the coding-agent changelog so the release notes stay complete.

## Post-release verification checklist

- [ ] `build-binaries` is complete.
- [ ] `publish-npm` is complete (it starts right after `build`, in parallel with the binary smoke).
- [ ] `stage-github-release` is complete (it waits for the full binary smoke matrix).
- [ ] `publish-github-release` is complete.
- [ ] The npm registry resolves the published version.
- [ ] The GitHub Release is published and non-draft.

## Notes

- The canonical release path is `scripts/release.mjs` from clean `main`.
- The approval checkpoint is mandatory for the normal tag-driven release.
- Publishing today goes through the `publish-npm.yml` publish-only dispatch (see the known-broken note above), NOT the tag pipeline's environment-gated job.
- If the tag pipeline's `publish-npm` fails after `stage-github-release` succeeded, the cleanup path deletes the draft release; the build assets survive as the run's `release-assets-v<tag>` artifact — re-create the release with `gh release create <tag> --verify-tag --draft --title <tag> --notes-file RELEASE_NOTES.md <assets>` and publish with `gh release edit <tag> --draft=false` after verifying `npm view` shows every package.
