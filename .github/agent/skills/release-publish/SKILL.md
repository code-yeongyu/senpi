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

The `publish-npm` job dispatches `publish-npm.yml` in publish-only mode (passing `build_run_id`), prints the dispatched run URL and ends; no runner waits for the publish (senpi#6851). There is no environment approval gate on the publish path — the old `npm-publish` environment subject is exactly what npm's trusted-publisher registration rejects.

The release finishes in whichever half ends last. Build Binaries' `finalize-release` job runs after the smoke and staging, and the publish run's `finalize-github-release` job runs after its `release` job. Both run `scripts/release-finalize.mjs`. The first to see both halves done does one of three things: publishes the draft, opens the smoke rollback issue, or runs the draft cleanup. The other job only logs `-> wait`. So a Build Binaries run can end green while npm is still publishing: watch the publish run too, and look for a failure in either run's finalize job.

Do not dispatch `publish-npm.yml` by hand while the pipeline's own dispatched run is still alive: the second run fails with npm `E409 Cannot publish over previously staged version` (seen on v2026.11.19-5, a manual dispatch 11 seconds after the pipeline's). Dispatch by hand only to recover after that run has failed.

Never consider the release done before the GitHub Release is non-draft and npm shows the version. If the publish run fails, recover with `gh workflow run publish-npm.yml -f version=<v> -f publish-only=true -f build_run_id=<Build Binaries run id>` (the id lets it finish the GitHub Release; without it, publish the draft by hand after `npm view` shows the version), never by rerunning `release.mjs`.

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
- A failed npm publish (or a failed dispatch) makes the finalize step run the draft-cleanup path instead of publishing; check `gh release view v<version>` before recovering — the release may already be live. Recover only through the existing tag workflow, never by rerunning `release.mjs`.
- Since senpi#6627 the npm publish no longer waits for the binary smoke. A failed smoke therefore leaves npm published with neither a draft nor a GitHub Release. A failed or cancelled `stage-github-release` can leave an incomplete draft next to a published npm version. In both states, never publish an existing draft. Re-run the failed jobs of the Build Binaries run, or re-stage from its `release-assets-v<tag>` artifact as `release-draft-cleanup.sh` prints, then publish.
- If the main checkout has foreign state, use a clean dedicated clone/worktree. Never clean or stash someone else's work.

## Release notes provenance

- Extract notes only from `packages/coding-agent/CHANGELOG.md` via `scripts/release-notes.mjs`.
- Keep changelog entries product-facing.
- Run the cl.md audit before release.
- Skip housekeeping, upstream-sync, and generated-catalog-only changes.
- Duplicate user-facing ai, agent, and tui changes into the coding-agent changelog so the release notes stay complete.

## Post-release verification checklist

- [ ] `build-binaries` is complete, and its `finalize-release` job succeeded.
- [ ] The dispatched publish-only `publish-npm.yml` run is complete (it starts right after `build`, in parallel with the binary smoke), and its `finalize-github-release` job succeeded.
- [ ] `stage-github-release` is complete (it waits for the full binary smoke matrix).
- [ ] The npm registry resolves the published version.
- [ ] The GitHub Release is published and non-draft.

## Notes

- The canonical release path is `scripts/release.mjs` from clean `main`.
- The approval checkpoint is mandatory for the normal tag-driven release.
- Publishing today goes through the `publish-npm.yml` publish-only dispatch (see the known-broken note above), NOT the tag pipeline's environment-gated job.
- If the tag pipeline's `publish-npm` fails after `stage-github-release` succeeded, the cleanup path deletes the draft release; the build assets survive as the run's `release-assets-v<tag>` artifact — re-create the release with `gh release create <tag> --verify-tag --draft --title <tag> --notes-file RELEASE_NOTES.md <assets>` and publish with `gh release edit <tag> --draft=false` after verifying `npm view` shows every package.
