# scripts/

Build, validation, release, publish, lockfile, and environment tooling for the senpi monorepo.

## Script anatomy

All `.mjs` files carry `#!/usr/bin/env node` and run as ES modules.
Shell wrappers `devenv-setup.sh` and `devenv-setup.ps1` locate Node and delegate to `devenv-setup.mjs`; they own no logic of their own.
Colocated `*.test.mjs` files run via root `npm run test:scripts` (`node --test scripts/*.test.mjs`).

## Naming convention

| Prefix | Role |
|--------|------|
| `build-*` | Compile and bundle steps |
| `check-*` | Validation and gate scripts |
| `generate-*` | Artifact generation (shrinkwrap, install-lock) |
| `prepare-*` | Publish staging |
| `release-*` | Sub-tasks composed by `release.mjs` |
| `publish-*` | npm publish workflows |
| `sync-*` | Version synchronization |

## Key entry points

- `build-all.mjs`: PM-agnostic build orchestrator. Detects npm/Bun/pnpm via `npm_execpath`
  and `npm_config_user_agent`; strips pnpm-only `npm_config_*` env keys before spawning
  children. `BUILD_PHASES` is an exported constant; tests consume it directly.

- `release.mjs`: CalVer release. Composes `calver.mjs`, `release-packages.mjs`,
  `release-artifacts.mjs`, `release-changelog.mjs`. Pre-flight checks run in sequence:
  must be on `main`, working tree must be clean (dry-run only warns), computed version
  must be a valid CalVer string. Accepts `--dry-run` to preview all commands and file
  writes without modifying anything.

- `local-release.mjs`: Smoke-test release to a temp directory. Doesn't push tags.

- `publish.mjs`: Publishes six fork-owned packages in release order:
  `@code-yeongyu/senpi-ai`, `@code-yeongyu/senpi-agent-core`,
  `@code-yeongyu/senpi-tui`, `@code-yeongyu/senpi-pty`,
  `@code-yeongyu/senpi-codemode`, and `@code-yeongyu/senpi`.
  The four upstream-named source packages remain `private`; the publisher copies
  each to a temporary manifest under the fork scope. `@code-yeongyu/senpi-server`
  is `private: true` and explicitly excluded.

- `build-binaries.sh`: Mirrors `.github/workflows/build-binaries.yml` for local
  cross-platform binary builds.

- `devenv-setup.mjs`: Universal, idempotent dev-environment setup. Both shell wrappers
  delegate here after locating Node.

## prepare-senpi-bundled-workspaces.mjs

Manages workspace packages embedded in the published `@code-yeongyu/senpi` tarball.

- `sourceOnly: false`: workspace ships `dist/index.js`; a build is required before staging.
- `sourceOnly: true`: workspace ships `src/` directly without a build step.
  `@code-yeongyu/senpi-codemode` is the only current source-only entry.
- Validates every `requiredFiles` entry exists before staging; aborts with a clear list on failure.
- `@earendil-works/pi-pty` also requires `native/index.js` and a platform prebuild file.

The publish tarball is fully self-contained: `copyPublishDependencies` stages the ENTIRE
runtime closure from `publish-deps.lock.json` (all registry deps + transitives, not just the
workspace closure) into `packages/coding-agent/node_modules`, and `stagePublishManifest`
rewrites the publish manifest so `bundleDependencies` lists every platform-portable staged
package while the original `dependencies` keys stay intact. Their staged specs point
through npm aliases to the matching fork-owned `@code-yeongyu/senpi-*` package: npm still
packs the original import paths, while Bun resolves only the fork-owned alias rather than
fetching unavailable upstream lockstep versions. The previous partial bundle let arborist
abort reify mid-flight and drop arbitrary registry deps (ERR_MODULE_NOT_FOUND).
Staging dirties `packages/coding-agent/package.json`; restore it with `git checkout --`
after packing/publishing.

`bundleDependencies` deliberately excludes packages that declare `os`/`cpu`/`libc`
(`isPlatformConstrainedPackage`). npm resolves those fields against the installing machine, but
the bundle is one artifact shipped to every platform and npm republishes the bundled set as
required `dependencies` in the registry manifest — so bundling the publish runner's own natives
(linux-x64, per `publish-npm.yml`) made `npm install @code-yeongyu/senpi` fail with
EBADPLATFORM everywhere else. They remain optional registry deps, resolved per install target.

## Anti-patterns

- Don't hardcode `npm` as the child process manager. Use the detected PM from `build-all.mjs`.
- Never hand-edit `publish-deps.lock.json` or `coding-agent-install-lock.json`.
  Regenerate with `generate-coding-agent-shrinkwrap.mjs` / `generate-coding-agent-install-lock.mjs`.
- Never invoke `node scripts/publish.mjs` without a prior build. The script checks for
  `dist/` existence but not for stale output.
- Never commit `.env` files or print credentials in build log output.
