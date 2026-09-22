# changes — senpi-monorepo root

## Unify the shared and evals Vitest runners (2026-09-21)

### What changed

- `package.json` pins the root development runner and its V8 coverage provider to 5.0.1 so the hoisted runner can load coverage.
- `.gitignore` excludes the `.vitest/` artifact directory.
- `package-lock.json` and `bun.lock` resolve Vitest and V8 coverage 5.0.1 across every workspace, including evals.
- `package.json` overrides vitest-evals 0.17.0's Vitest peer edge to 5.0.1.
- `bun.lock` retains configuration version 0 and the existing hoisted install layout.

### Why

- PTY and codemode invoke the hoisted runner without declaring it. A root pin makes their shared runner version explicit under both npm and Bun.
- vitest-evals 0.17.0 declares Vitest `>=4 <5`. Its npm peer override makes the single-major installation explicit; runtime tests and TypeScript checks verify compatibility instead of preserving a split runner graph.
- Bun hoists the harness beside the root runner even when a lock entry requests workspace nesting. Keeping every runner on 5.0.1 avoids mixed TaskMeta types without changing the native workflows' root dependency paths.

### Why an extension could not handle it

- Package managers select test runners and resolve peer dependencies before extensions load.

### Expected merge conflict zones

- The root development dependencies and generated dependency locks.

## Run the two dev lanes through run-workspaces --parallel and drop concurrently (2026-09-21)

### What changed

- `package.json`: the root `dev` script is `node scripts/run-workspaces.mjs --parallel --workspace packages/ai --workspace packages/coding-agent dev`; the `concurrently` devDependency is removed and `shell-quote` 1.10.0 is declared as a root devDependency — three repository scripts import it directly but it only reached `node_modules` as `concurrently`'s transitive dependency (its version was already pinned by the root override). `package-lock.json` / `bun.lock` are regenerated the repository way (`bun.lock` stays `configVersion: 0`).

### Why

- `concurrently` was the last root script that bypassed the package-manager-agnostic runner from #1447; `npm run dev`, `bun run dev` and `pnpm run dev` now all start both lanes through the same driver, with prefixed output and one Ctrl-C reaching every lane (senpi#1895).

### Why an extension could not handle it

- Root scripts and the dependency closure are resolved by the package manager before any extension loads.

### Expected merge conflict zones

- The root `scripts.dev` line and the root devDependency block, on every upstream tooling bump.

## Refresh the dependency pins and pin past the reachable advisories (2026-09-21)

### What changed

- `package.json`: the root `overrides` block moves `fast-uri` to 3.1.8, `brace-expansion` to 5.0.12 and `@anthropic-ai/sdk` to 0.127.0, and gains `express-rate-limit` 8.7.0, `hono` 4.13.8, `ip-address` 10.7.2, `qs` 6.16.0 and a nested `@earendil-works/gondolin` > `undici` 6.28.1. `@types/node` moves to 26.6.2, `@biomejs/biome` to 2.5.14 and `tsx` to 4.23.13.
- `biome.json`: the `$schema` URL follows the Biome pin to 2.5.14.
- `packages/telemetry/package.json`: `@types/node` moves to 26.6.2.

### Why

- Every advisory `npm audit` and `bun audit` could reach came in through a transitive edge the fork does not declare: `fast-uri` and `ajv`, and the `@modelcontextprotocol/sdk` subtree that carries `hono`, `qs` and `express-rate-limit` > `ip-address`. `scripts/regenerate-bun-lock-isolated.mjs` seeds its island with the committed `bun.lock`, so re-resolving only the npm lock left Bun on the vulnerable copies; declaring the versions as overrides moves both lockfiles together without drifting the 56 unrelated transitives a from-scratch Bun resolution touched.
- `tsx` stops at 4.23.13 because 4.23.14 and 4.23.15 were both published 2026-09-20, inside the `.npmrc` `min-release-age=2` window npm enforces.

### Why an extension could not handle it

- Dependency resolution and formatter configuration are read by the package manager and the toolchain before any extension is loaded.

### Expected merge conflict zones

- LOW: the `overrides` block and the devDependency versions, on every upstream manifest bump.

## Make B.AI credentials available to development environments (2026-09-18)

### What changed

- `.devcontainer/devcontainer.json` exposes an optional B.AI secret alongside the other provider keys.
- `pi-test.sh`, `pi-test.ps1`, `test.sh`, and
  `packages/coding-agent/scripts/qa-app-server/lib/env.mjs` scrub `BAI_API_KEY` from hermetic test processes.

### Why

- The native B.AI provider should work consistently in local checkouts and dev containers without storing
  credentials in tracked files.

### Why an extension could not handle it

- Development environment bootstrapping and container secret declarations run before Senpi or its extensions.

### Expected merge conflict zones

- LOW: the provider-key arrays in the setup script and devcontainer secret block.

## Root check verifies formatting instead of rewriting it (2026-09-17)

### What changed

- `package.json`: the root `check` script now runs `biome check --error-on-warnings .` (read-only) instead of `biome check --write --error-on-warnings .`, so format drift fails the script rather than being silently repaired. A new `check:fix` script keeps the autofix form (`biome check --write --error-on-warnings . && npm run check`) for local use.
- `.husky/pre-commit`: runs `npm run check:fix`, preserving the hook's existing autofix-then-verify behavior now that `check` no longer writes.
- `.github/workflows/releasability.yml`: drops the hand-inlined read-only biome step plus its verbatim copy of the remaining check sub-scripts and calls `npm run check` directly; that workaround existed only because `check` autofixed, and its copy had already drifted from the real chain (missing `check:entry-graphs` and `check:claude-sdk-platform-lock`).

### Why

- #1443: the CI `Static checks` job runs `npm run check`, whose leading `biome check --write` reformats offending files inside the runner and exits 0. The rewrite is discarded when the runner exits, so a formatting regression could never fail CI while drift accumulated on main. Root `AGENTS.md` also requires the local check and CI to stay in sync; with autofix in the shared script they disagreed by construction.

### Why an extension could not handle it

- The root `package.json` script chain, the Husky hook, and the workflow step are build-time and repository-policy gates that execute before any Senpi runtime loads; no runtime extension participates in them.

### Expected merge conflict zones

- LOW: the `check` script string in root `package.json` and the adjacent `check:fix` entry.
- LOW: the check invocation line in `.husky/pre-commit`.

## claude-sdk-oauth re-login refreshes the slot; stored pool blocks bind to credential revisions (2026-09-17)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/anthropic-subscription/accounts.ts`: new `upsertAccount()` — a same-name slot is replaced in place (fresh token material, block stamps cleared, `displayName` preserved); unknown names still append.
- `packages/coding-agent/src/core/extensions/builtin/anthropic-subscription/oauth-login.ts`: a re-login now targets an existing slot instead of minting `account-N+1` — a lone slot or the pool's one `auth_error`-blocked slot is refreshed in place; anything else stays append-only unless the user types an existing name, so a blank or headless re-login never overwrites the newest working slot in a multi-account pool. The Anthropic import is now a move: accepting it removes the grant from the `anthropic` provider so two stores never refresh one single-use token.
- `packages/coding-agent/src/core/extensions/builtin/anthropic-subscription/index.ts`: wires `removeAnthropicCredential` through the locked auth.json backend.
- `packages/coding-agent/src/core/extensions/builtin/anthropic-subscription/{affinity,guidance,stream-guidance}.ts`: `AllAccountsBlockedError` carries the dominant block reason and the all-blocked guidance names an authentication failure explicitly, so the outer credential-pool classifier maps it to `auth_error` instead of laundering it into a rate-limit cooldown via the generic "(rate limit or auth errors)" wording.
- `packages/coding-agent/src/core/credential-pool/{state-store,rotation-stream}.ts` and `packages/coding-agent/src/core/credential-accounts.ts`: stored-lane sidecar health is bound to a credential revision (HMAC over the installation key and slot material, never raw material) — the stored-lane twin of the env revision rule — so a re-login or token refresh retires the block the old material earned. Legacy rows without a revision are retired on first read.
- Tests: new `test/claude-sdk-oauth-login-refresh.test.ts` (refresh matrix, import move, dominant reason) and `test/credential-pool-stored-revision.test.ts` (legacy/foreign/current revision, revision stamping); `test/credential-error-taxonomy.test.ts` gains the guidance→classifier composition cases; `test/credential-accounts.test.ts` and `test/model-runtime-credential-rotation.test.ts` fixtures now stamp the matching revision for blocks that must apply.

### Why

- omo#7084 (two fresh field reports on 2026.9.16-3): `/login claude-sdk-oauth` never refreshed the existing slot — it appended `account-N+1` or threw on a duplicate name — while `auth_error` blocks were permanent by design ("until login refreshes the slot"), so the documented recovery could never fire and the pool dead-ended at "blocked until re-login". The import path also copied the Anthropic grant into a second store, guaranteeing a later `invalid_grant`.
- omo#8383: the lane's generic all-blocked wording let the outer classifier string-match "rate limit" and stamp a cooldown for what was a 401 revocation, and the stored lane's sidecar had no credential-replacement signal at all, so blocks outlived the credential that earned them.

### Why an extension could not handle it

- The slot store, the OAuth login flow, the failover block policy, and the credential-pool sidecar are engine internals; the recovery contract spans the lane's auth.json stamps and the generic pool's sidecar, which no extension surface reaches.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/builtin/anthropic-subscription/oauth-login.ts` (login naming and the import branch).
- `packages/coding-agent/src/core/credential-pool/rotation-stream.ts` (stored-lane listing and `persistBlock`).

## Type-check the qa scripts (2026-09-16)

### What changed

- `tsconfig.json` includes `scripts/qa/**/*.ts` so root `tsc --noEmit` type-checks the qa runners.
- `package.json`: `npm run check` also runs `tsc --noEmit -p scripts/tsconfig.json` after the root program.

### Why

- `scripts/qa/*.ts` sat outside every tsconfig, so implicit-any import errors there never failed CI.

### Why an extension could not handle it

- Root `tsconfig.json` include globs and the `package.json` `check` script are compile-time gates; no runtime extension can add files to `tsc`.

### Expected merge conflict zones

- LOW: the `include` array in root `tsconfig.json` and the `check` script string in root `package.json`.

## Re-wire check:entry-graphs into the root check chain (2026-09-13)

### What changed

- `package.json`: `npm run check` runs `check:entry-graphs` after `check:ts-imports`, matching the original 5507d76ee gate. `scripts/check-entry-graphs.mjs` prints each entry's file count on success so a green run still reports the harness/session size.
- `packages/agent/src/harness/messages.ts`: session no longer value-imports the AI barrel; see `packages/agent/src/changes.md`.

### Why

- The session subpath is a cost contract (budget 25, no `packages/ai/src/index.ts`). The script existed but was not in `check`, so the barrel regression stayed red until someone ran it by hand.

### Why an extension could not handle it

- Root `package.json` scripts and the source import graph are build-time inputs; no runtime extension can restore either.

### Expected merge conflict zones

- LOW: the `check` script string in root `package.json`.

## Pin the bundled chord workspace to upstream's published version (2026-09-12)

### What changed

- `packages/chord/package.json` returns to upstream's own `0.85.1` version instead of the fork CalVer stamp, so the bundled workspace keeps `@earendil-works/chord`'s published release identity.

### Why

- chord is bundled into the senpi tarball but the fork does not publish it. CalVer-stamping it made the packaged manifests declare `@earendil-works/chord@^<CalVer>`, which no registry version answers, so `bun add @code-yeongyu/senpi` failed (issue #1632). Keeping chord on upstream's `0.85.1` — which exists on the registry and is byte-for-byte our bundled copy apart from packaging metadata — makes every declared edge resolvable while the bundled copy shadows it at runtime.

### Why an extension could not handle it

- `packages/chord/package.json` is static manifest data consumed by the package manager and the release/publish pipeline, never reachable from the runtime extension system.

### Expected merge conflict zones

- The `version` field in `packages/chord/package.json`.

## Scrub VENICE_API_KEY in the hermetic test environments (2026-09-10)

### What changed

- `pi-test.sh` and `pi-test.ps1` add `VENICE_API_KEY` to the provider credentials cleared before the suite runs, alongside the existing `CEREBRAS_API_KEY`/`XAI_API_KEY` entries. `test.sh` and `packages/coding-agent/scripts/qa-app-server/lib/env.mjs` gained the same entry.

### Why

- Venice is now a built-in provider, and several suites key opt-in live behavior off the mere presence of a provider API key. Leaving `VENICE_API_KEY` in the inherited environment would let a developer's real credential change test behavior or reach the network.

### Why an extension could not handle it

- These are the shell entry points that build the test environment before any senpi process starts.

### Expected merge conflict zones

- LOW: the `unset`/credential-name lists in `pi-test.sh` and `pi-test.ps1` when upstream adds providers.

## Root scripts reach workspaces only through scripts/run-workspaces.mjs (2026-09-07)

### What changed

- `package.json`: `test`, `clean`, `eval`, `dev`, `dev:tsc`, `generate:models`, `generate:model-catalog`, `hydrate:model-data`, and `check:model-data` delegate into workspaces through `node scripts/run-workspaces.mjs [--if-present] [--workspace <path>] <script>` instead of `npm run --workspaces --if-present <script>`, `npm --workspace=<name> run`, `npm --prefix <dir> run`, or `cd <dir> && npm run` lanes inside concurrently. `dev` keeps only the `packages/ai` and `packages/coding-agent` lanes, the two workspaces that define a `dev` script. `version:*` keep `npm version --workspaces` (npm's version bookkeeping, not a script delegation); `refresh-lock`, `publish*`, and `release*` are untouched.

### Why

- Under bun the old shapes worked only where bun happened to rewrite `npm run` to `bun run`, and bun's `--workspaces` fans out in parallel while npm runs sequentially; `--prefix`, `--workspace=`, and `cd <dir> && npm run` never reach bun or pnpm and always execute real npm, against the `scripts/AGENTS.md` rule of not hardcoding the child package manager. The runner executes every workspace script with the manager that launched the root script, sequentially and in path order, with one PASS / SKIP / FAIL summary, so `bun run test`, `npm run test`, and `pnpm run test` behave identically. The `packages/agent` and `packages/tui` dev lanes pointed at scripts that do not exist.

### Why an extension could not handle it

- Root manifest scripts run before any Senpi runtime starts; the package manager is the only surface above them.

### Expected merge conflict zones

- LOW: the nine script lines in the root `package.json` `scripts` block. Upstream still spells these in npm's dialect; keep the runner form on sync.

## bun.lock refreshed wherever package-lock.json is refreshed (2026-09-04)

### What changed

- `package.json`: `version:patch`, `version:minor` and `version:major` append `bun install --lockfile-only` after `npm install --package-lock-only --ignore-scripts`.
- `package.json`: `refresh-lock` does the same, so the manual lockfile-refresh path and the release path agree.

### Why

- `bun install --frozen-lockfile` broke on main twice in one day: release `v2026.9.4-2` (`a79aa2080`) rewrote `package-lock.json` while `bun.lock` kept 2026.9.3 workspace versions, and `d052dbb6b` added the `@anthropic-ai/sdk` override without regenerating it (fixed as a one-off in #1364).
- Both incidents share one cause: every script that refreshes a lockfile refreshes only the npm one, and CI installs with `npm ci`, so the drift recurs at each bump with nothing observing it. #1364 cleared the symptom; this closes the source.

### Why an extension could not handle it

- These are the repo's own release and lockfile-maintenance scripts; nothing outside `package.json` decides which lockfiles a version bump rewrites.

### Expected merge conflict zones

- `package.json` `scripts` — the `version:*` and `refresh-lock` lines.


## @anthropic-ai/sdk 0.123.0 pin for the v0.84.4 upstream sync (2026-09-04)

### What changed

- `package.json` pins `@anthropic-ai/sdk` at 0.123.0 (was 0.120.0), the version the 2026-09-03 upstream sync of badlogic/pi-mono v0.84.4 resolved against.
- `.npmrc` adds `min-release-age-exclude[]=@anthropic-ai/sdk` next to the existing excludes, with an in-file note to remove it after 2026-09-05.

### Why

- The fork's `min-release-age=2` supply-chain gate refuses packages younger than two days, so the freshly published 0.123.0 pin would fail installs until 2026-09-05. The exclude is time-boxed by its removal note instead of weakening the policy for every package.

### Why an extension could not handle it

- Root manifest pins and npm install policy execute before any package code, let alone an extension, runs.

### Expected merge conflict zones

- LOW: the `package.json` root dependency overrides block and the `.npmrc` exclude list on future upstream syncs and release bumps.

## Root workspace fan-out scripts no longer recurse under bun (2026-09-02)

### What changed

- `package.json`: the three root scripts that fan out to workspaces stop passing workspace flags after the script name. `test` and `clean` move the flags before the script name (`npm run --workspaces --if-present <script>`), and `eval` moves its flag before `run` (`npm --workspace=@code-yeongyu/senpi-evals run eval --`). npm behavior is unchanged in all three cases.
- `scripts/root-workspace-scripts.test.mjs` (new): parses the root manifest and fails a root script for either recursion-prone shape — a workspace flag after the script name, or a singular `--workspace` on an `npm run` call (which bun ignores, re-entering the root script). Both shipped shapes are covered; a mutation check confirms reverting `eval` to `npm run --workspace=<name> eval` fails the guard.

### Why

- Bun rewrites `npm run <name>` to `bun run <name>` inside script text, and bun appends flags placed after the script name to the script itself instead of parsing them. `npm run test --workspaces --if-present` therefore re-invoked the ROOT script with an ever-growing flag suffix (`bun run test --workspaces --if-present --workspaces --if-present ...`) and spun forever instead of running the workspace suites — it never failed, so it read as a slow suite. `clean` and `eval` had the same defect. Verified in a throwaway fixture: the flag-before form fans out under both npm and bun, while the singular `--workspace=<name>` form still recurses under bun (bun does not recognize it), which is why `eval` needs the flag before `run` so no `npm run` substring remains to rewrite.

### Why an extension could not handle it

- These are root package manifest scripts consumed by the release gate (`scripts/release.mjs`, `scripts/local-release.mjs` run `CI=1 npm test`) and by contributors directly; no extension surface exists above the package manager.

### Expected merge conflict zones

- LOW: the `test`, `clean`, and `eval` lines in the root `package.json` scripts block.

## Shared-host rendering isolation (2026-08-30)

Shared socket clients now register `rendered_components` through additive `set_client_info` capabilities. Factory-rendered component records are filtered per connection, including capability-aware snapshot replay. Capabilities remain connection-wide across sessions and are cleared only on socket release; explicit close removes only the closing width. Shared bindings retain factories while disposing live renderers and footer providers when no capable connection remains, recreating them for later capable joiners.

Root tracker for repository-level divergence from upstream `badlogic/pi-mono`.
Owns every audited production path whose nearest tracker is the repository root.

## CodeGraph reference cleanup (2026-09-02)

### What changed

- `biome.json` drops the `!!**/.codegraph` ignore entry.

### Why

- The omo product removed its CodeGraph integration, so nothing writes a `.codegraph` directory anymore. An ignore entry for a directory that is never created is dead configuration that implies the integration still exists.
- The matching `EXCLUDED_ROOT_PATHS` change in `packages/coding-agent/src/beta/omo-local-update-fingerprint.ts` is recorded in `packages/coding-agent/src/changes.md`, that path's nearest ancestor tracker.

### Why this lives in the fork

- The biome ignore list is fork-owned: it is an omo-specific surface that upstream `badlogic/pi-mono` does not carry.

### Expected merge conflict zones

- LOW: `biome.json` ignore list ordering during upstream syncs.

## @anthropic-ai/sdk peer alignment (2026-08-26)

### What changed

- `package.json` bumps the pinned `@anthropic-ai/sdk` from `0.91.1` to `0.120.0` so the pin satisfies `@anthropic-ai/claude-agent-sdk@0.3.241`'s `>=0.93.0` peer range.

### Why

- Every bun install printed `warn: incorrect peer dependency "@anthropic-ai/sdk@0.91.1"`; the SDK floor moved to 0.93.0 when the agent SDK gained its credentials subsystem.

### Why this lives in the fork

- The root pin set is fork-owned dependency policy; upstream does not pin these packages together.

### Expected merge conflict zones

- LOW: `package.json` root dependency pins during upstream syncs.

## Root config and package identities re-diverge from upstream dcd4619 (2026-08-25)

### What changed

- `biome.json` keeps the fork lint surface: schema `2.5.10`, `preset: "recommended"` syntax, and the
  `**/api/cursor-agent/gen` and `**/.codegraph` exclusions.
- `packages/agent/package.json` keeps the senpi calver (`2026.8.24`), `tsc` build (upstream uses
  `tsgo`), and the fork dependency set (`diff` 9, `typebox` 1.3.18, calver workspace ranges).
- `packages/session-backends/sqlite-node/package.json` keeps the fork package name
  `@earendil-works/pi-storage-sqlite-node`, `tsc` build, and vitest `4.1.11`.
- `packages/telemetry/package.json` keeps calver, `@types/node` 26, vitest `4.1.11`, and `private: true`.
- `packages/tui/package.json` keeps calver, `tsc` build, the `--import tsx` + multiplexer-env test
  loader, node `>=24`, `marked` 18.0.10, and the `bench:frame-cost` script.

### Why

These are fork-owned product surfaces (senpi branding, provider wire behavior, fork runtime features) that upstream does not carry; the sync must re-assert them on top of upstream's tree.

### Why this lives in the fork

The divergence lives in core wiring, package identity, or build plumbing that executes before any extension loads, so no extension hook can express it.

### Expected merge conflict zones

- Version/name/scripts blocks of every listed `package.json` on each upstream release bump; `biome.json`
  whenever upstream migrates Biome versions.

## Vitest source alias for ai auth subpaths (2026-08-25)

### What changed

- `vitest.base.ts`: added a resolve alias mapping `@earendil-works/pi-ai/auth/*` to `packages/ai/src/auth/*.ts` so vitest resolves the new `auth/pool/slots` subpath to source during tests.

### Why

- Workspace tests import `@earendil-works/pi-ai/auth/pool/slots`; without a source alias vitest resolves to the built `dist`, which does not exist for the new module, breaking test runs.

### Why an extension could not handle it

- Test runner aliasing is repository-level tooling configuration.

### Expected merge conflict zones

- LOW: single additive alias line in `vitest.base.ts`.

## Release dependency refresh (2026-08-24)

### What changed

- `package.json`: `@biomejs/biome` 2.5.9 -> 2.5.10.
- `packages/agent/package.json`: `typebox` 1.3.16 -> 1.3.18.
- `packages/ai/package.json`: `typebox` 1.3.16 -> 1.3.18.
- `packages/coding-agent/package.json`: `typebox` 1.3.16 -> 1.3.18.
- `packages/protocol/package.json`: `typebox` 1.3.16 -> 1.3.18.
- `packages/senpi-codemode/package.json`: `typebox` 1.3.16 -> 1.3.18.
- `packages/{ai,coding-agent}/package.json`: `@aws-sdk/client-bedrock-runtime` 3.1115.0 -> 3.1116.0.
- `packages/coding-agent/package.json`: `@anthropic-ai/claude-agent-sdk` 0.3.238 -> 0.3.241.
- Root and generated release locks were regenerated from those exact pins.

### Why

- These are the repository-audited patch-level or same-line upgrades available for the 2026.8.24 release. TypeBox must remain single-instanced across the shared protocol/runtime packages, and the Bedrock pin must remain identical in `ai` and `coding-agent`. The Claude Agent SDK update also requires regenerating its platform lock and the published/install dependency closures.
- `@anthropic-ai/sdk` remains at 0.91.1 because the minimum peer-compatible 0.93.0 still introduces browser-breaking credential-chain imports, while 0.120.0 is likewise unsafe. Deliberate breaking holds remain unchanged for `openai` 6.26.0 and `signal-exit` 3.0.7.

### Why an extension could not handle it

- Dependency resolution, exact pins, generated release locks, and platform-package selection happen before the runtime and extension system load.

### Expected merge conflict zones

- HIGH: root and coding-agent dependency blocks and generated lock artifacts.
- MEDIUM: the shared TypeBox pins across five package manifests.

## Dependency pin refresh, unused-dependency removal, and lock regeneration (2026-08-20)

### What changed

- `package.json`: root devDependencies bumped `esbuild` 0.28.1 -> 0.28.2 and `tsx` 4.23.1 -> 4.23.12; declared `concurrently` 10.0.5 (the root `dev` script invoked it while it was undeclared and absent from the lock); dropped the unused `@anthropic-ai/sandbox-runtime` and `jiti` devDependencies and the unused `get-east-asian-width` dependency. Overrides bumped `@hono/node-server` 2.0.10 -> 2.1.1, `postcss` 8.5.18 -> 8.5.26, `brace-expansion` 5.0.8 -> 5.0.9, `esbuild` 0.28.1 -> 0.28.2, `rimraf` 6.1.2 -> 6.1.3 (including the nested `gaxios.rimraf` pin), `shell-quote` 1.9.0 -> 1.10.0, `vite` 8.0.16 -> 8.2.2, and `ws` 8.21.1 -> 8.21.3, while `fast-uri` stays on 3.x and `protobufjs` on 7.x and `@anthropic-ai/sdk` stays pinned at 0.91.1.
- `.npmrc`: rewrote the `min-release-age` exemption list as package-name patterns (`@hono/node-server`, `@anthropic-ai/claude-agent-sdk`, `@aws-sdk/*`, `@google/genai`, `@smithy/*`, `typebox`, `vite`) so the freshly published target versions resolve under the repository's two-day supply-chain window.
- `packages/agent/package.json`, `packages/protocol/package.json`: `typebox` moved to 1.3.16 (from 1.3.8 and from the inconsistent 1.3.7).
- `packages/telemetry/package.json`: `@types/node` 24.12.4 -> 26.2.0, matching the rest of the repository.
- `packages/tui/package.json`: `marked` 18.0.7 -> 18.0.10.
- `crates/senpi-pty/Cargo.toml`, `crates/senpi-pty/package.json`, and the workspace `Cargo.toml` pins: `libc` =0.2.174 -> =0.2.189, `napi` =3.10.3 -> =3.12.1, `napi-derive` =3.5.9 -> =3.6.3, `napi-build` =2.3.2 -> =2.4.1, `@napi-rs/cli` 3.7.2 -> 3.8.6.
- `scripts/rolldown-platform-lock.test.mjs`: the asserted Rolldown binding version tracks 1.0.3 -> 1.2.4, which is what `vite` 8.2.2 resolves.

### Why

- These pins had drifted behind their current releases while the repository enforces exact pins through `npm run check:pinned-deps`, so refreshing them in one pass keeps every workspace on one resolved version and keeps the shared `typebox` identity single-instanced. The removals delete manifest entries with zero source references, and declaring `concurrently` makes the root manifest truthful about what `npm run dev` actually needs. `@anthropic-ai/sdk` is deliberately held at 0.91.1 because 0.120.0 adds credential-chain modules whose `node:fs` and `node:path` imports break the browser-bundle invariant enforced by `scripts/check-browser-smoke.mjs`. The `.npmrc` rewrite fixes an exemption list that could never match: npm compares these patterns against the package name only, so the previous `name@version` string was inert.

### Why an extension could not handle it

- Dependency resolution, override pinning, the supply-chain age gate, and Cargo pin selection are all performed by the package managers before any runtime exists, so no extension can influence which versions get installed or locked.

### Expected merge conflict zones

- HIGH: the `overrides` and `devDependencies` blocks in `package.json`, which upstream edits on nearly every release.
- MEDIUM: the per-package `typebox`/`@types/node` pins and the workspace `Cargo.toml` dependency table.
- LOW: `.npmrc` and the Rolldown binding version constant.

## Repository-wide upstream divergence audit (2026-08-17)

### What changed

Canonical backfill seeded from the pre-backfill audit report under
`local-ignore/qa-evidence/20260817-changes-md-audit/pre-backfill-audit.json`
(upstream pin `badlogic/pi-mono` `v0.84.2`, `914cf1472e715297caa30db4b9535d534a9eb718`).
Every remaining audited production path with no nearer tracker than the root:

- `.npmrc`: adds `min-release-age-exclude=@hono/node-server@2.0.10` on top of the upstream
  min-release-age supply-chain policy.
- `biome.json`: biome schema `2.3.5` -> `2.5.5`, `recommended: true` migrated to
  `preset: "recommended"`, and extended ignore sets for generated and tool-owned trees
  (`!**/api/cursor-agent/gen`, `!!**/.codegraph`).
- `package.json`: monorepo renamed `pi-monorepo` -> `senpi-monorepo`, `packages/pty` joined the
  workspace, chained-`cd` build scripts replaced by `scripts/build-all.mjs` with
  `build:npm`/`build:bun`/`build:pnpm` entry points, root `check` swapped `tsgo --noEmit` for
  `tsc --noEmit` and added `check:claude-sdk-platform-lock` plus script-based browser smoke, and
  fork-only `verify:pms` orchestration was added.
- `pnpm-workspace.yaml`: mirrors the root npm workspace's nested
  `packages/session-backends/*` glob so the pnpm parity build installs and links the sqlite
  session backend's workspace dependencies before `scripts/build-all.mjs` builds it.
- `tsconfig.base.json`: `target`/`lib` raised from `ES2022` to `ES2024`.
- `tsconfig.json`: reformatted to the fork's biome multi-line layout; workspace path mappings are
  semantically unchanged.
- `vitest.base.ts`: added the workspace source alias mapping `@earendil-works/pi-ai/utils/*` to
  `packages/ai/src/utils/*` so shared test configs resolve utils from source.
- `packages/agent/package.json`: private CalVer `2026.8.16`, `tsgo` -> `tsc` build/typecheck,
  fork dependency pins (`@earendil-works/pi-ai`/`pi-telemetry` `^2026.8.16`, `diff` `9.0.0`,
  `ignore` `7.0.6`).
- `packages/client/package.json`: CalVer `2026.8.16`, `tsgo` -> `tsc`,
  `@earendil-works/pi-protocol` pinned exactly to `2026.8.16`.
- `packages/client/src/unix.ts`: typed the socket `data` callback chunk as `Buffer`.
- `packages/protocol/package.json`: CalVer `2026.8.16`, `tsgo` -> `tsc`.
- `packages/session-backends/sqlite-node/package.json`: renamed
  `@earendil-works/pi-session-backend-sqlite-node` ->
  `@earendil-works/pi-storage-sqlite-node`, made private and independently versioned at
  `0.83.0`, `tsgo` -> `tsc`, and keeps its runtime `pi-agent-core` / `pi-ai` dependencies on
  lockstep semver ranges so npm, Bun, and pnpm all link the live workspace packages.
- `packages/session-backends/sqlite-node/src/sqlite/repo.ts`: optional-chaining refactor of the
  message-target guard.
- `packages/telemetry/package.json`: private CalVer `2026.8.16`.
- `packages/telemetry/src/index.ts`: type-layout reformat under the fork's biome/TypeScript
  settings; no contract change.
- `packages/tui/package.json`: private CalVer `2026.8.16`, `tsgo` -> `tsc`, tests run under
  `tsx` with `test/setup-multiplexer-env.mjs`, added `bench:frame-cost`, Node engine
  `>=24.0.0`, pinned bumps (`marked` `18.0.7`).
- `.pi/extensions/prompt-url-widget.ts`: deleted; relocated into global builtins (see the
  focused section below).
- `.pi/extensions/tps.ts`: deleted; relocated into global builtins (see the focused section
  below).

### Why

- Senpi is a fork with its own identity, CalVer release trains, and an npm/bun/pnpm install
  matrix; root manifests, compiler settings, and lint configuration carry that policy, so they
  intentionally diverge from the upstream npm-only `0.x` layout.
- Non-published support packages (`agent`, `telemetry`, `tui`, sqlite storage backend) are
  private and lockstep-versioned or independently pinned per AGENTS dependency policy, which
  shows up as manifest-level divergence with no deeper tracker of its own.
- The two deleted `.pi/extensions/*` files were repository-local development extensions that
  the fork promoted into shipped product behavior; the deletion itself is the audited
  divergence and is recorded here because `.pi/` has no tracker of its own.

### Why an extension could not handle it

- Every path in this section is repository, build, toolchain, or non-coding-agent package
  metadata that executes before any Senpi session, extension loader, or runtime exists.
  Extensions load inside a coding-agent session and cannot rename a monorepo, retarget
  compilers, reshape git hooks, reversion packages, or alter dependency policy.

### Expected merge conflict zones

- HIGH: root `package.json` scripts/workspaces and `packages/*/package.json` version blocks on
  every upstream sync; upstream `0.x` bumps must be reconciled into CalVer deliberately.
- MEDIUM: `biome.json`, `tsconfig.base.json`, `tsconfig.json`, and `vitest.base.ts` whenever
  upstream bumps toolchain majors or adds workspaces.
- MEDIUM: `.pi/extensions/prompt-url-widget.ts` and `.pi/extensions/tps.ts` — upstream still
  owns these files, so syncs will propose edits to deleted paths; resolve to the deletion and
  re-port any upstream improvement into the builtin copies.

## Deleted repo-local .pi extensions, relocated into global builtins (2026-04-27)

### What changed

- Deleted `.pi/extensions/prompt-url-widget.ts` and `.pi/extensions/tps.ts`, which the upstream
  pin still ships as repository-local dev extensions.
- Relocated their functionality into always-on global builtins at
  `packages/coding-agent/src/core/extensions/builtin/prompt-url-widget.ts` and
  `packages/coding-agent/src/core/extensions/builtin/tps.ts`, registered with the other fork
  builtins and covered by `packages/coding-agent/src/core/extensions/builtin/changes.md`.
- Subsequent fork releases hardened the TPS builtin (monotonic timing in `7f6097bf3`, cache-hit
  notice in `c7874fda3`) with regression coverage in
  `packages/coding-agent/test/suite/tps-extension.test.ts`.
- Context: sibling `.pi/extensions/import-repro.ts` and `.pi/extensions/redraws.ts` moved the
  same way and are rename-tracked under the builtin tracker, so they do not appear in the
  canonical audit list above.

### Why

- Repository-local `.pi/extensions` only load for sessions started inside this clone and
  require per-repo wiring. Senpi ships the URL prompt widget and tokens-per-second notice as
  product affordances for every user and session, versioned, registered, and tested together
  with the coding agent instead of living in an unaudied dot-directory.

### Why an extension could not handle it

- Remaining a repo-local extension is exactly what this change removed: an extension cannot
  distribute itself to other clones or sessions. Promoting the behavior into the builtin set
  is the mechanism; there is no extension-side equivalent of "ship enabled-by-default for all
  users".

### Expected merge conflict zones

- Upstream-side edits to the deleted `.pi/extensions/prompt-url-widget.ts` and
  `.pi/extensions/tps.ts` on every sync (resolve to deletion, re-port improvements).
- Builtin registration and widget internals under
  `packages/coding-agent/src/core/extensions/builtin/` if upstream reworks extension loading
  or adds overlapping notices.

## Pnpm parity for the nested SQLite session backend (2026-08-19)

### What changed

- `pnpm-workspace.yaml` now includes `packages/session-backends/*`, matching the root npm
  workspace and the package set explicitly built by `scripts/build-all.mjs`.
- `packages/session-backends/sqlite-node/package.json` declares its shipped
  `pi-agent-core` / `pi-ai` imports as lockstep runtime dependencies instead of packed
  `file:` dev dependencies.
- `scripts/sync-versions.js` keeps the backend's own `0.83.0` version independent while
  synchronizing those lockstep dependency ranges during Senpi releases.

### Why

- The release pre-commit gate verifies npm, Bun, and pnpm. Pnpm previously excluded the
  nested backend from its workspace and then, once included, packed its `file:` dependencies
  before their declarations were built. The ordered build therefore reached the backend with
  unresolved `pi-agent-core` / `pi-ai` types even though npm and Bun passed.

### Why an extension could not handle it

- This is package-manager workspace topology and release-version synchronization. Runtime
  extensions load only after packages install and build, so they cannot repair missing
  workspace membership, dependency links, or manifest pins.

### Expected merge conflict zones

- Upstream changes to the SQLite backend's dependency placement or independent-version policy.
- Future workspace additions under nested `packages/*/*` paths, which must remain aligned
  across root npm workspaces, `pnpm-workspace.yaml`, and `scripts/build-all.mjs`.

## Upstream sync (upstream/main@71dca871) integration repairs (2026-09-12)

### What changed

- `package.json`: the root manifest stays the fork's `senpi-monorepo` (Node >= 24, `packages/pty` workspace, `build`/`clean`/`test` routed through `scripts/build-all.mjs` and `scripts/run-workspaces.mjs`, the fork `check` chain with `check:claude-sdk-platform-lock` and `tsc --noEmit`, `refresh-lock`, `preinstall` bin stubs, Bun/pnpm `trustedDependencies`/`onlyBuiltDependencies`, and the held overrides such as `protobufjs 7.6.5`, `@anthropic-ai/sdk 0.123.0`, `esbuild 0.28.2`); upstream's `check:runtime-deps`/`check:entry-graphs`/`check:package-install` scripts exist but are not wired into `check`.
- `packages/chord/package.json`: differs from the pin only by version fields: the fork CalVer `2026.9.12` instead of `0.85.1`, `vitest 4.1.11` instead of `4.1.9` so the held pin stays single-instanced, and `private: true` because chord is bundled into the senpi tarball rather than published.
- `packages/chord/src/types.ts`: the same declarations as upstream; the only difference is biome 2.5.10 formatting of the nested conditional types (`JsonRepresentation`, `InvalidJsonPart`, `InvalidRemoteMember`), which the fork's `--error-on-warnings` check rewrites.
- `packages/telemetry/package.json`: version fields only: CalVer `2026.9.12`, `@types/node 26.2.0`, `vitest 4.1.11`, `private: true`.
- `tsconfig.json`: keeps the fork path map (`@code-yeongyu/senpi`, `@code-yeongyu/senpi/hooks`, `@code-yeongyu/senpi-server`, `@earendil-works/pi-pty`, `@earendil-works/pi-agent-core/session/testing`) unioned with upstream's Chord root and subpath entries; the file is expanded one-entry-per-line by the fork formatter.
- `vitest.base.ts`: unions upstream's `aiUtils` alias with the fork `aiAuthPool` alias (`@earendil-works/pi-ai/auth/*` -> `packages/ai/src/auth/*`) beside the Chord aliases upstream added.

### Why

- The fork ships under its own package names, CalVer lockstep, Node 24 floor, mixed npm/Bun/pnpm build orchestration and held dependency pins; the root manifest, TypeScript path map and vitest aliases are where those choices are declared, so the sync cannot take upstream's versions of them verbatim.

### Why an extension could not handle it

- Workspace manifests, compiler path maps and test-runner aliases are build-time inputs read before any runtime code loads; no extension hook can rename packages, change the engine floor or register a module alias.

### Expected merge conflict zones

- HIGH: root `package.json` `scripts`, `devDependencies`, `overrides` and `engines` whenever upstream bumps tooling or adds a `check:*` step.
- MEDIUM: `tsconfig.json` `paths` when upstream adds a workspace or subpath export; `vitest.base.ts` alias list for the same reason.
- LOW: `packages/chord/package.json` and `packages/telemetry/package.json` version lines on every upstream release; `packages/chord/src/types.ts` re-wraps whenever upstream edits those conditional types.
