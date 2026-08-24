# scripts/

Build, validation, release, publish, lockfile, and environment tooling for the senpi monorepo.

## Script anatomy

All `.mjs` files carry `#!/usr/bin/env node` and run as ES modules; `devenv-setup.sh`/
`.ps1` locate Node and delegate to `devenv-setup.mjs` (they own no logic). Colocated
`*.test.mjs` run via root `npm run test:scripts`; root `preinstall` runs
`create-bin-stubs.mjs`. `scripts/qa/` render assertions go through `xterm-render.mjs`'s
cell grid. Prefixes encode role:

| Prefix | Role |
|--------|------|
| `build-*` / `create-*` / `check-*` / `audit-*` / `generate-*` / `hydrate-*` | Build, stubs, gates, lock generation |
| `prepare-*` / `materialize-*` / `sync-*` / `copy-*` | Staging, runtime materialization, sync, sidecars |
| `release-*` / `publish-*` | Release orchestration and npm publish |

## Key entry points

- `build-all.mjs`: PM-agnostic build orchestrator. Detects npm/Bun/pnpm via `npm_execpath`
  and `npm_config_user_agent`; strips pnpm-only `npm_config_*` env keys before spawning.
- `release.mjs`: CalVer release composing `calver.mjs` and
  `release-{packages,artifacts,changelog,git,test-gate}.mjs`. Preflight: on `main`, clean tree
  (dry-run warns), valid CalVer; `--dry-run` previews every command and file write.
- `publish.mjs`: publishes seven fork-owned packages (`senpi-ai`, `senpi-agent-core`, `senpi-tui`,
  `senpi-pty`, `senpi-telemetry`, `senpi-codemode`, `senpi`); sources stay `private`, copied to
  temporary public manifests under the fork scope (`@code-yeongyu/senpi-server` stays excluded).
  Provenance requires GitHub Actions (`publish-command.mjs` throws outside it);
  `local-release.mjs` smoke-tests a release to a temp dir without pushing tags.
  `build-binaries.sh` mirrors `.github/workflows/build-binaries.yml` locally;
  `prepare-bun-compile-assets.mjs` + `smoke-standalone-binary.mjs` cover standalone binaries.
- Lock plumbing: `generate-coding-agent-{shrinkwrap,install-lock}.mjs`,
  `generate-claude-agent-sdk-platform-lock.mjs`, `hydrate-lock-registry-metadata.mjs`,
  `materialize-publish-runtime.mjs`, `npm-pack-json.mjs`, helpers in `install-lock-*.mjs`;
  root `npm run refresh-lock` chains them.
- Gates/catalog: `check-pr-changelog.mjs`, `check-upstream-release.mjs`, `check-pinned-deps.mjs`,
  `check-ts-relative-imports.mjs`, `check-browser-smoke.mjs`, `diff-model-catalog.mjs`,
  `publish-model-catalog.mjs`, `generate-thinking-capabilities.mjs` — `npm run check` chains them.

## changes.md tracker

`scripts/changes.md` is the hand-written change tracker feeding CHANGELOG gates.
`changes-md-policy.mjs` owns policy: canonical sections, path classification, coverage audit,
and the added-line restrictor — a PR only gets credit for tracker bullets its diff added.
`changes-md-git.mjs` owns git/filesystem collection (skips symlinked trackers, rejects option-like
`--base` revisions). `audit-changes-md.mjs` audits coverage; `check-pr-changelog.mjs` gates PRs
via `CHANGELOG_GATE_LABELS` / `CHANGELOG_GATE_BASE` env vars, never shell interpolation; entries
parse `## YYYY-MM-DD` and `## Title (YYYY-MM-DD)` dialects.

## prepare-senpi-bundled-workspaces.mjs

Embeds workspace packages in the published `@code-yeongyu/senpi` tarball. `sourceOnly: false`
ships `dist/index.js` (build before staging); `sourceOnly: true` ships `src/` (only
`senpi-codemode`). Every `requiredFiles` entry is validated; `@earendil-works/pi-pty` also
requires `native/index.js` and a platform prebuild. The tarball is fully self-contained: `copyPublishDependencies` stages the ENTIRE runtime
closure from `publish-deps.lock.json` into `packages/coding-agent/node_modules`, and
`stagePublishManifest` rewrites `bundleDependencies` to every platform-portable staged
package while original `dependencies` keys stay intact, pointing through npm aliases to
fork-owned `@code-yeongyu/senpi-*` packages (npm packs original import paths; Bun resolves
the alias; the old partial bundle made arborist abort reify with ERR_MODULE_NOT_FOUND).
Staging dirties `packages/coding-agent/package.json`; restore with `git checkout --` after it.

## Anti-patterns

- Don't hardcode `npm` as the child process manager. Use the detected PM from `build-all.mjs`.
- Never hand-edit `publish-deps.lock.json` or `coding-agent-install-lock.json`; regenerate
  with the `generate-*` scripts.
- Never run `node scripts/publish.mjs` without a prior build; it checks `dist/` exists, not
  freshness. Never commit `.env` files or print credentials in build logs.
- Lock generators refuse unreviewed install scripts; the allowlist is keyed by exact
  `name@version` — bump the allowlist entry together with the dependency.
- Never bundle packages declaring `os`/`cpu`/`libc` into `bundleDependencies`
  (`isPlatformConstrainedPackage`): npm republishes the bundled set as required deps, so one
  cross-platform artifact fails installs with EBADPLATFORM elsewhere; keep them optional
  registry deps resolved per install target.

---
Generated: 2026-08-24 | Commit `baf15a54d`
