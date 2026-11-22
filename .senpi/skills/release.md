---
name: release
description: Prepare, publish, verify, and recover senpi releases. Use for release preparation, local release smoke tests, publishing, and failed release CI.
---

# Releasing senpi

Run repository commands from the repo root (two directories above this skill).

**CalVer lockstep**: every release workspace shares one CalVer version (`YYYY.M.D` or `YYYY.M.D-N` for a same-day re-release) and all packages move together. There is no patch/minor distinction and never a SemVer bump. Never run `npm run release:patch` or `npm run release:minor`; those upstream scripts don't exist here.

Releases are two-phase and run in GitHub Actions through `.github/workflows/publish-npm.yml`:

1. **Prepare** (`gh workflow run publish-npm.yml`, optionally `-f version=<CalVer>`): the job runs `scripts/release.mjs`, which writes the version into every release workspace, syncs inter-package deps, regenerates the lock and release artifacts, compiles pending fragments on the release tree, stamps `[Unreleased]` as `[<version>] - <date>`, runs check, build and test, commits, tags, re-inserts a fresh `[Unreleased]` block, and pushes `main` plus the tag. It ships the model catalog the release commit carries and never regenerates it: catalog changes reach `main` only through the refresh workflows' own PRs (`model-catalog-refresh.yml`, `opengateway-catalog-refresh.yml`), whose CI tests them.
2. **Publish-only** (`gh workflow run publish-npm.yml -f version=<CalVer> -f publish-only=true`): publishes the already prepared version through npm trusted publishing (GitHub OIDC). No local `npm publish`, OTP, or `npm whoami`.

Every prepare dispatch starts with the `Release preflight` job (`scripts/release-preflight.mjs`, under a minute): it refuses a non-main live ref, a missing push token, a malformed, already tagged or already published version, a `sha` that is not one of main's own commits, a publish-set name npm does not know, a red macOS/Windows job on main, and a red "Check and test" on the release commit, all at once, before anything is installed, built or tested.

Pass `-f dry_run=true` to either phase to preview without pushing or publishing.

Before preparing, audit the changelogs and pending fragments on `main` using `.github/agent/commands/cl.md` and `.github/agent/release-driver.md`. `scripts/upstream-release-worthy.mjs` checks a read-only compile preview. Only the prepare cut compiles and deletes fragments; with `--sha`, only fragments at that commit ship. Never edit released sections.

For a local smoke test, build an unpublished release and exercise it from outside the repo so it can't resolve workspace files:

```bash
npm run release:local -- --out /tmp/senpi-local-release --force
cd /tmp
/tmp/senpi-local-release/node/senpi --version
/tmp/senpi-local-release/node/senpi -p "Say exactly: ok"
/tmp/senpi-local-release/bun/senpi --version
/tmp/senpi-local-release/bun/senpi -p "Say exactly: ok"
```

Start each binary interactively as well; load [interactive-testing.md](interactive-testing.md) for the tmux workflow and launch from `/tmp`, not the repo root. Startup alone isn't a passing smoke test: submit a prompt and wait for the model reply.

If the publish job fails, inspect it and rerun only the publish-only phase for the same version after fixing the cause. Don't rerun the prepare phase once a tag has been pushed.
