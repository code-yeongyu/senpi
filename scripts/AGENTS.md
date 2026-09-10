# scripts/

Build, validation, release, publish, lockfile, and environment tooling for the senpi monorepo (score 9: distinct tooling domain).

## Script anatomy

Node ESM helpers and CLIs use `.mjs`; shebangs are not universal. `devenv-setup.sh`/
`.ps1` locate Node and delegate to `devenv-setup.mjs`. Root `bun run test:scripts` runs
`node --test scripts/*.test.mjs`; `*.test-support.mjs`, `*.test.ts`, and `qa/` are outside
that glob. Root `preinstall` runs `create-bin-stubs.mjs`. Prefixes encode role:

| Prefix | Role |
|--------|------|
| `build-*` / `create-*` / `check-*` / `audit-*` / `generate-*` / `hydrate-*` | Build, stubs, gates, lock generation |
| `prepare-*` / `materialize-*` / `sync-*` / `copy-*` | Staging, runtime materialization, sync, sidecars |
| `release-*` / `publish-*` | Release orchestration and npm publish |

## Key entry points

- `package-manager.mjs`: shared npm/Bun/pnpm plumbing — detection (`npm_config_user_agent`, then
  the `npm_execpath` basename), pnpm-only `npm_config_*` scrubbing, execpath-aware spawning that
  forwards SIGINT/SIGTERM/SIGHUP to the child, and per-manager forwarded-argument shaping.
- `build-all.mjs`: PM-agnostic build orchestrator in dependency phases, built on `package-manager.mjs`.
- `run-workspaces.mjs`: `node scripts/run-workspaces.mjs [--if-present] [--workspace <name|path>]... <script> [-- <args>]`.
  Resolves root `workspaces`; runs sequentially in path order with the invoking manager;
  never re-enters root; prints PASS / SKIP / FAIL (`root-workspace-scripts.test.mjs` guards delegation).
- `release.mjs`: CalVer release composing `calver.mjs` and `release-{packages,artifacts,changelog,git,test-gate}.mjs`.
  Preflight: on `main`, clean tree (dry-run warns), valid CalVer; `--dry-run` previews commands and writes.
- `publish.mjs`: seven fork-owned packages from `registry-packages.mjs`: `senpi-ai`,
  `senpi-agent-core`, `senpi-tui`, `senpi-pty`, `senpi-telemetry`, `senpi-codemode`, `senpi`.
  Sources stay private; temporary public manifests use the fork scope; server stays excluded.
  `publish-command.mjs` requires GitHub Actions provenance; `local-release.mjs` uses a temp release without pushing tags.
  `build-binaries.sh` mirrors the binary workflow; `prepare-bun-compile-assets.mjs` + `smoke-standalone-binary.mjs` check standalone binaries.
- Lock plumbing: `bun run refresh-lock` refreshes npm/Bun locks, hydrates registry metadata,
  then runs `generate-coding-agent-{shrinkwrap,install-lock}.mjs`; the Claude SDK platform
  lock generator is separate. `materialize-publish-runtime.mjs`, `npm-pack-json.mjs`, `install-lock-*.mjs` support staging/validation.
- `bun run check`: Biome, pinned-deps, TS imports, publish/install/Claude SDK locks, tsc, browser smoke.
  `check-pr-changelog.mjs`, `check-upstream-release.mjs`, `diff-model-catalog.mjs`,
  `publish-model-catalog.mjs`, and `generate-thinking-capabilities.mjs` are separate gates/tools.
- `qa/xterm-render.mjs`: CLI for render/assert/replay/raw-assert/verify-manifest/self-test;
  importing it also starts its CLI. Use `node scripts/qa/xterm-render.mjs self-test` for its fixture checks.
  Visual claims require `.ans`/`.html`/`.json` triplets and parsed-cell assertions; raw-assert checks protocol only.

## changes.md tracker

`scripts/changes.md` feeds CHANGELOG gates. `changes-md-policy.mjs` owns path classification,
canonical sections, coverage audit, and added-line-only tracker credit. `changes-md-git.mjs`
collects git/filesystem facts, skips symlinked trackers, and rejects option-like `--base` revisions.
`audit-changes-md.mjs` audits coverage; `check-pr-changelog.mjs` uses `CHANGELOG_GATE_LABELS` /
`CHANGELOG_GATE_BASE`, never shell interpolation. Entries accept `## YYYY-MM-DD` and `## Title (YYYY-MM-DD)`.

## prepare-senpi-bundled-workspaces.mjs

Embeds built workspace `dist/` in the `@code-yeongyu/senpi` tarball; only `senpi-codemode`
ships `src/`; its Python prelude and nested `node_modules/@babel/parser` must also ship.
PTY loader files (`dist/index.js`, `native/index.js`) are required; missing native prebuilds warn and allow pipe fallback.
`copyPublishDependencies` stages the registry runtime closure from `publish-deps.lock.json`.
Client/protocol are instead copied from their builds into `packages/coding-agent/vendor/pi-{client,protocol}`;
JS/declaration imports become relative, with no resolver-visible client/protocol package under `node_modules`.
`stagePublishManifest` lives in `prepare-senpi-publish-manifest.mjs` (re-exported here):
removes client/protocol dependency edges, bundles portable staged packages, preserves other import keys
through owned npm aliases, and promotes platform optional families to root optional dependencies.
Pack gates reject `npm-shrinkwrap.json`, missing runtime bundles, and missing codemode Babel parser.
Staging changes `packages/coding-agent/package.json` AND emitted imports; use a disposable release checkout,
or restore the checked manifest and rebuild coding-agent before returning to development.

## Anti-patterns

- Use `package-manager.mjs` for manager-neutral child processes and `run-workspaces.mjs` for root delegation;
  the runner tests reject npm workspace/prefix flags and shell `cd` delegation (see root guide).
- Regenerate publish/install locks with `generate-*`; never hand-edit them.
- `publish.mjs` checks `dist/` existence, not freshness: build first. Never commit `.env` or log credentials.
- Install-script allowlists use exact `name@version`; update the reviewed entry with dependency bumps.
- Never bundle packages declaring `os`/`cpu`/`libc`: npm republishes bundles as required deps,
  causing EBADPLATFORM on other hosts. Keep them optional registry deps resolved per target.
- QA visual assertions never inspect raw escape strings; replay must retain positive scrollback,
  and clear/replay protocol tokens must belong to one complete DECSET 2026 frame.

---
Generated: 2026-09-10 | Commit `2d0fa41c5`
