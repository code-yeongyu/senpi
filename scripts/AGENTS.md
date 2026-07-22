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

- `publish.mjs`: Publishes the standalone packages (`@earendil-works/pi-ai`,
  `@earendil-works/pi-agent-core`, `@earendil-works/pi-tui`, `@code-yeongyu/senpi`).
  `@code-yeongyu/senpi-server` is `private: true` and explicitly excluded.

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

## check-mcp-docs.test.mjs

Reads `config-schema.ts` as raw text and extracts object-literal keys rather than importing
TypeScript. Compares extracted field names against `### \`field\`` headings in `docs/mcp.md`.
Schema drift fails CI with no TS toolchain dependency.

## Anti-patterns

- Don't hardcode `npm` as the child process manager. Use the detected PM from `build-all.mjs`.
- Never hand-edit `publish-deps.lock.json` or `coding-agent-install-lock.json`.
  Regenerate with `generate-coding-agent-shrinkwrap.mjs` / `generate-coding-agent-install-lock.mjs`.
- Never invoke `node scripts/publish.mjs` without a prior build. The script checks for
  `dist/` existence but not for stale output.
- Never commit `.env` files or print credentials in build log output.
