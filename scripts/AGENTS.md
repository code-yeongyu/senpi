# scripts/

Build, validation, release, publish, lockfile, and environment tooling for the senpi monorepo.

## Script anatomy

All `.mjs` files carry `#!/usr/bin/env node` and run as ES modules; `devenv-setup.sh`/
`.ps1` locate Node and delegate to `devenv-setup.mjs` (they own no logic). Colocated
`*.test.mjs` run via root `bun run test:scripts` (shared fixtures live in `*.test-support.mjs`,
outside that glob); root `preinstall` runs `create-bin-stubs.mjs`. `scripts/qa/` render assertions go through `xterm-render.mjs`'s
cell grid. Prefixes encode role:

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
- `build-coding-agent-bundle.mjs`: esbuild release bundle of the compiled coding-agent (and the
  `packages/ai` lazy loaders it reaches). `packages/coding-agent`'s `build:bundle` script runs it as
  the last step of that package's `build`, so every root build emits
  `packages/coding-agent/dist/bundle/` — the tree both `bin.pi` and `bin.senpi` resolve to and the
  npm tarball ships. The unbundled `dist/` tree is still published for library consumers, the RPC
  supervisor re-entry and this directory's profiler. It consumes compiled `dist/` output from
  `packages/ai` and `packages/coding-agent`, so it runs after those builds, never before them.
  `node-bundle-smoke.test.ts` rebuilds it and runs the bundled CLI under both Node and Bun.
- `run-workspaces.mjs`: root -> workspace script runner
  (`node scripts/run-workspaces.mjs [--if-present] [--workspace <name|path>]... <script> [-- <args>]`):
  resolves the root `workspaces` field, runs `<pm> run <script>` per workspace sequentially in path
  order with the invoking manager, never re-enters the root, and prints a PASS / SKIP / FAIL summary.
  Every root `package.json` delegation into a workspace goes through it (`root-workspace-scripts.test.mjs`).
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
- Lock plumbing: `generate-coding-agent-install-lock.mjs`,
  `generate-claude-agent-sdk-platform-lock.mjs`, `hydrate-lock-registry-metadata.mjs`,
  `npm-pack-json.mjs`, helpers in `install-lock-*.mjs`;
  root `bun run refresh-lock` chains them.
- Gates/catalog: `check-pr-changelog.mjs`, `check-upstream-release.mjs`, `check-pinned-deps.mjs`,
  `check-ts-relative-imports.mjs`, `check-browser-smoke.mjs`, `diff-model-catalog.mjs`,
  `publish-model-catalog.mjs`, `generate-thinking-capabilities.mjs` — `bun run check` chains them.

## Release entry graph validation

After a lifecycle-disabled install, run `npm rebuild canvas --foreground-scripts`
(as the release builder does) to provide its native binding. Then run
`bun test scripts/release-graph-codemode.test.ts` followed by
`bun test scripts/release-graph-exclusions.test.ts`. The codemode suite rebuilds
all workspace entries and prepares compile assets before measuring real Bun output
contributions, so direct invocation also replaces stale `dist` from another branch.
The CI `Test (workspaces + scripts)` job runs these commands in its
`Fresh release entry graphs (codemode and exclusions)` step, before either script
suite can invalidate generated output. These Bun `.ts` tests are not part of the
Node `.mjs` script-test glob. Run them only in a checkout whose generated outputs
you can rebuild; no source or package manifest is rewritten by this gate.

## changes.md tracker

`scripts/changes.md` is the hand-written change tracker feeding CHANGELOG gates.
`changes-md-policy.mjs` owns policy: canonical sections, path classification, coverage audit,
and the added-line restrictor — a PR only gets credit for tracker bullets its diff added.
`changes-md-git.mjs` owns git/filesystem collection (skips symlinked trackers, rejects option-like
`--base` revisions). `audit-changes-md.mjs` audits coverage; `check-pr-changelog.mjs` gates PRs
via `CHANGELOG_GATE_LABELS` / `CHANGELOG_GATE_BASE` env vars, never shell interpolation; entries
parse `## YYYY-MM-DD` and `## Title (YYYY-MM-DD)` dialects.

## prepare-senpi-bundled-workspaces.mjs

Vendors the never-published `pi-client`/`pi-protocol` build output under `vendor/` in the
`@code-yeongyu/senpi` tarball (emitted imports rewritten to relative paths), then
`stagePublishManifest` (`prepare-senpi-publish-manifest.mjs`) writes the real publish manifest:
the source dependency list minus the vendored packages, with every fork workspace reached through
its published `npm:@code-yeongyu/senpi-*` alias and no `bundleDependencies` (senpi#2360). The
tarball ships no `node_modules`; `senpi-publish-pack-checks.mjs` enforces that contract for the
senpi pack and checks each published alias package for its loader-visible files
(`pi-agent-core` tree-sitter assets, `pi-pty` `native/index.js` plus a warned-optional prebuild,
`senpi-codemode` sources) and rejects any published `*.map`. Staging dirties `packages/coding-agent/package.json`; restore with
`git checkout --` after it.

## Anti-patterns

- Don't hardcode `npm` as the child process manager. Use the detected PM from `package-manager.mjs`,
  and reach workspaces from root scripts only through `run-workspaces.mjs` — never
  `npm run --workspaces`, `npm --workspace=<name> run`, `npm --prefix <dir> run`, or `cd <dir> && npm run`.
- Never hand-edit `packages/coding-agent/install-lock/`; regenerate it with
  `generate-coding-agent-install-lock.mjs`.
- Never run `bun scripts/publish.mjs` without a prior build; it checks `dist/` exists, not
  freshness. Never commit `.env` files or print credentials in build logs.
- Lock generators refuse unreviewed install scripts; the allowlist is keyed by exact
  `name@version` — bump the allowlist entry together with the dependency.
- Never reintroduce `bundleDependencies` in the senpi publish manifest: bun installs every
  declared dependency from the registry and keeps the bundled copy too (a duplicate tree), and
  bundled platform natives fail installs with EBADPLATFORM on every other platform.

---
Generated: 2026-08-24 | Commit `baf15a54d`
