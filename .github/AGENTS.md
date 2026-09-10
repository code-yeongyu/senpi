# .github/

CI, release, and issue automation for the senpi fork, plus committed merge/release agent guidance. Score 8: 28 files, seven descendant directories, own workflow configuration, and dense embedded JavaScript; distinct automation domain.

## STRUCTURE

```text
workflows/     14 workflows: CI, publishing, native builds, issue/review gates,
               model catalog, audit, performance, and compiled-worker proof
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
| Compiled worker relocation | `workflows/session-worker-compile.yml` runs `bun test scripts/session-worker-compile.test.ts` on Linux/macOS/Windows |
| Review-claim automation | `workflows/review-claims.yml`: `Review claim gate`, reviewer requests, hourly stale-claim sweep; label policy lives in root guidance |
| PR changelog gate | `workflows/changelog-gate.yml` (drives `scripts/check-pr-changelog.mjs`) |
| Merge agent procedure | `agent/README.md`, `agent/merge-driver.md`, `agent/skills/merge-upstream/` |
| Release audit agent | `agent/release-driver.md`, `agent/skills/release-publish/` |
| Changelog audit command | `agent/commands/cl.md` |

## CONVENTIONS

- Pin GitHub Actions by full commit SHA. Current exception: `session-worker-compile.yml` still uses `checkout@v7`, `setup-node@v7`, and `setup-bun@v2`; do not copy those floating refs.
- CI installs with `npm ci --ignore-scripts` and runs root checks/build/script tests through npm; `test-workspaces` also runs `bun run test:scripts` under Bun 1.4.2. The standalone compiled-worker workflow pins Bun 1.4.0.
- `test-coding-agent` uses three Vitest shards. `test-workspaces` has an explicit package list, not automatic workspace discovery; client tests are not on that list. `rpc-windows` runs suites in separate `bunx vitest` processes.
- Preserve the exact `Check and test` fan-in name and its `needs` list. Terminal cross-OS and inspector-handoff jobs run separately from that fan-in.
- Native prebuilds declare six targets; lifecycle tests and load probes run only for non-cross-compile targets. Windows arm64 is best-effort.
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
Updated: 2026-09-10 | Commit `2d0fa41c5`
