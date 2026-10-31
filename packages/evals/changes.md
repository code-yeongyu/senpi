# changes — evals

## 2026-10-10 - Test-run temporary storage has an owner (senpi#3064)

### What changed

- `packages/evals/package.json`: test invocations use scripts/run-tests.mjs so TMPDIR/TEMP/TMP are scoped before the test runtime starts and cleaned after exit.

### Why

- Vitest SSR copies and interrupted fixture writes must not accumulate in the OS temp directory.

### Why an extension could not handle it

- Test-process bootstrap is repository tooling, before runtime extensions load.

### Expected merge conflict zones

- Test command arguments and runtime selection; preserve existing reporters, shards and test filters.

## 2026-09-30 - Sync with upstream v0.99.1 (6a4af07d6): extensions eval layout rename

### What changed

- `packages/evals/src/extensions.eval.ts` -> `packages/evals/evals/extensions.eval.ts`. Upstream layout commit `d7296c063b` deleted the old `src/` suite while introducing `evals/extensions.docs.eval.ts`; the fork comparative host eval was ported to the new `evals/` directory.

### Why

The adopted eval layout keeps runner code under `src/` and executable suites under `evals/`. Retaining the old path would duplicate the extension evaluation outside the configured projects.

### Why an extension could not handle it

Eval discovery and project layout are repository test infrastructure.

### Expected merge conflict zones

- MEDIUM: upstream edits to extension eval discovery or `extensions.docs.eval.ts`; keep the fork host eval beside it under `evals/`.

## 2026-09-30 - Sync with upstream v0.99.1 (6a4af07d6): evals

### What changed

- `packages/evals/docker/Dockerfile`: resolved by L10 against upstream v0.99.1 (6a4af07d6): upstream constructs adopted, fork behavior kept.
- `packages/evals/docker/entrypoint.ts`: Docker runner files target the fork package: `node_modules/@code-yeongyu/senpi` (Dockerfile docs removal, `install-runtime.mjs`, `entrypoint.ts`), no `npm-shrinkwrap.json` requirement (senpi keeps shrinkwrap deleted), internal-dependency doc stripping checked across `@earendil-works` and `@code-yeongyu`; `src/docker.ts` reads the host auth from `SENPI_`/`PI_CODING_AGENT_DIR` or `~/.senpi/agent`.
- `packages/evals/docker/install-runtime.mjs`: Docker runner files target the fork package: `node_modules/@code-yeongyu/senpi` (Dockerfile docs removal, `install-runtime.mjs`, `entrypoint.ts`), no `npm-shrinkwrap.json` requirement (senpi keeps shrinkwrap deleted), internal-dependency doc stripping checked across `@earendil-works` and `@code-yeongyu`; `src/docker.ts` reads the host auth from `SENPI_`/`PI_CODING_AGENT_DIR` or `~/.senpi/agent`.
- `packages/evals/evals/configured-runtime.ts`: Upstream evals adopted as-is apart from the package import: `custom-provider`, `documentation-audit`, `extensions`, `models`, `openai-provider`, `tui` (`*.docs.eval.ts`) and `smoke.eval.ts`, plus fixtures `acme-server.ts`, `configured-runtime.ts` and the upstream unit tests (`acme-server`, `comparison`, `configured-runtime`, `harness`, `plan`, `report`).
- `packages/evals/evals/documentation-audit.eval.ts`: resolved by L10 against upstream v0.99.1 (6a4af07d6): upstream constructs adopted, fork behavior kept.
- `packages/evals/evals/tui.docs.eval.ts`: resolved by L10 against upstream v0.99.1 (6a4af07d6): upstream constructs adopted, fork behavior kept.
- `packages/evals/package.json`: resolved by L10 against upstream v0.99.1 (6a4af07d6): upstream constructs adopted, fork behavior kept.
- `packages/evals/src/docker.ts`: resolved by L10 against upstream v0.99.1 (6a4af07d6): upstream constructs adopted, fork behavior kept.
- `packages/evals/src/harness.ts`: resolved by L10 against upstream v0.99.1 (6a4af07d6): upstream constructs adopted, fork behavior kept.
- `packages/evals/vitest.evals.config.ts`: Upstream layout: eval suites flat under `evals/` (`*.docs.eval.ts` = documentation-lift, other `*.eval.ts` = host), runner code in `src/{cli,docker,harness,plan,report}.ts`, image build in `docker/`, one Vitest config `vitest.evals.config.ts` with projects `docs` and `host`. The fork's `vitest-evals` host harness is ported onto the upstream layout: `src/vitest-evals/{artifacts,harness-table,reporter,setup,summary}.ts` + their unit tests `test/vitest-evals/*.test.ts`, registered in `vitest.evals.config.ts` (`reporters` at root; `setupFiles` on the `host` project only, so container docs arms keep upstream's CLI reporters and are untouched). `artifacts.ts` keeps the `declare module "vitest"` `TestArtifactRegistry` augmentation and now shares upstream's `PI_SESSION_SNAPSHOT_ARTIFACT` constant from `src/report.ts` (one constant, one layout). Package imports use the fork package `@code-yeongyu/senpi` everywhere (harness, evals, fixtures, harness test); both `vitest.evals.config.ts` and `vitest.test.config.ts` alias `@code-yeongyu/senpi` and `@earendil-works/pi-coding-agent` to workspace source. `src/pi-harness.ts` (superseded by `src/harness.ts`; fork deltas ported as above), `test/pi-harness.test.ts` (its `resolveModelSelection` and `excludePiDocumentation` assertions are covered by upstream `test/harness.test.ts` for the sectioned prompt), `vitest.config.ts` (superseded by `vitest.evals.config.ts`).

### Why

Upstream v0.99.1 (6a4af07d6) changed these paths while the fork carries its own behavior; packages/evals adopts the upstream eval layout and ports the fork vitest-evals harness (plan D-13).

### Why an extension could not handle it

The eval harness is repository test infrastructure, not a runtime extension point.

### Expected merge conflict zones

Every path listed above conflicts again where upstream edits the hunks named in its line; the fork-kept constructs named there are the anchors to preserve.

## 2026-09-21 - Migrate the eval harness to Vitest 5 (senpi#1895)

### What changed

- `packages/evals/package.json` uses Vitest and V8 coverage 5.0.1, matching the other workspaces.
- The root manifest overrides vitest-evals 0.17.0's Vitest peer edge to 5.0.1.

### Why

- Bun's hoisted linker resolves Vitest from the harness's root location. Splitting evals onto Vitest 4 while the harness reads Vitest 5 causes incompatible TaskMeta types.
- The explicit npm override accepts the harness's older declared peer range only with runtime and TypeScript compatibility verification. The Bun install layout stays hoisted.

### Why an extension could not handle it

- The package manager resolves development tools before extensions load.

### Expected merge conflict zones

- The development dependency pins in `packages/evals/package.json`.

Tracker for `packages/evals` divergence from upstream `badlogic/pi-mono`.

## Refresh the evals dependency pins (2026-09-21)

### What changed

- `packages/evals/package.json`: `vitest-evals` 0.16.1 -> 0.17.0 and `@types/node` 26.2.0 -> 26.6.2.

### Why

- The eval harness pins are fork-owned and move to the newest release in the same minor that satisfies `min-release-age=2`.

### Why an extension could not handle it

- Manifest dependency versions are resolved by the package manager before any extension loads.

### Expected merge conflict zones

- LOW: the dependency version block, on every upstream release bump.

## Evals manifest re-diverges from upstream dcd4619 (2026-08-25)

### What changed

- `packages/evals/package.json` keeps `@code-yeongyu/senpi-evals`, the senpi dependency, calver
  workspace ranges, `@types/node` 26, and TypeScript 7.

### Why

These are fork-owned product surfaces (senpi branding, provider wire behavior, fork runtime features) that upstream does not carry; the sync must re-assert them on top of upstream's tree.

### Why this lives in the fork

The divergence lives in core wiring, package identity, or build plumbing that executes before any extension loads, so no extension hook can express it.

### Expected merge conflict zones

- The name/version/dependency blocks on every upstream release bump.

## vitest-evals harness bump (2026-08-20)

### What changed

- `packages/evals/package.json`: `vitest-evals` 0.15.0 -> 0.16.1.

### Why

- The pin had drifted behind the current release while the repository enforces exact pins, and the eval harness should track the version the suites are run against.

### Why an extension could not handle it

- The eval harness is a devDependency resolved by npm for this workspace before any runtime loads.

### Expected merge conflict zones

- LOW: the single devDependency pin.

## Repository-wide upstream divergence audit (2026-08-17)

### What changed

Canonical backfill seeded from the pre-backfill audit report under
`local-ignore/qa-evidence/20260817-changes-md-audit/pre-backfill-audit.json`
(upstream pin `badlogic/pi-mono` `v0.84.2`, `914cf1472e715297caa30db4b9535d534a9eb718`):

- `packages/evals/package.json`: workspace renamed `@earendil-works/pi-evals` ->
  `@code-yeongyu/senpi-evals` (private, CalVer `2026.7.25`); the coding-agent devDependency
  retargeted to `@code-yeongyu/senpi` `^2026.8.16` with `@earendil-works/pi-ai` kept at
  `^2026.8.16`; pinned toolchain bumps (`typescript` `7.0.2`, `vitest` `4.1.10`,
  `@types/node` `26.1.1`).
- `packages/evals/src/pi-harness.ts`: harness imports the coding agent from
  `@code-yeongyu/senpi` instead of `@earendil-works/pi-coding-agent`, and applies
  `transformSystemPrompt` by binding and replacing `services.resourceLoader.getSystemPrompt`
  after `createAgentSessionServices` construction rather than passing upstream's
  `resourceLoaderOptions.systemPromptOverride` constructor seam (see the focused section
  below).
- `packages/evals/vitest.config.ts`: resolve alias retargeted from
  `@earendil-works/pi-coding-agent` to `@code-yeongyu/senpi`, still pointing at
  `workspaceSourcePaths.codingAgentIndex` so evals execute against workspace source.

### Why

- Behavioral evals must exercise the exact Senpi coding-agent build the fork ships, resolved
  under its published `@code-yeongyu/senpi` name against workspace source, not the upstream
  registry artifact. The package identity, dependency graph, and vitest alias therefore all
  carry the fork rename together.

### Why an extension could not handle it

- The harness constructs isolated real agent sessions in temp workspaces before any user
  extension exists, and explicitly fails a run whose session starts with extensions loaded.
  Wiring package identity, dependency resolution, or the system-prompt override through the
  extension system would violate the isolation the eval contract asserts.

### Expected merge conflict zones

- HIGH: the import block and services-construction block in
  `packages/evals/src/pi-harness.ts`; upstream still evolves the
  `resourceLoaderOptions.systemPromptOverride` seam that the fork's loader-level override
  replaced.
- MEDIUM: name/version lines in `packages/evals/package.json` on every CalVer bump or upstream
  dependency refresh.
- LOW: the single alias line in `packages/evals/vitest.config.ts`.

## Senpi package rename and resource-loader system-prompt override (2026-08-01)

### What changed

- The comparative Pi eval harness landed 2026-07-27..2026-07-30 (`32f3a9728` and follow-ups)
  and was reconciled onto the Senpi package rename in the 2026-08-01 upstream sync
  (`13a5f8fe4`), producing the current state recorded in the canonical section above.
- System-prompt transformation mechanics: upstream's pin-era harness passed
  `resourceLoaderOptions: { systemPromptOverride: () => transformedSystemPrompt }` into
  `createAgentSessionServices`. Senpi's `DefaultResourceLoaderOptions` carries no
  `systemPromptOverride` seam, so the fork's harness instead captures
  `services.resourceLoader.getSystemPrompt` bound to the loader, replaces it with a closure
  returning the transformed prompt (falling back to the default), and calls
  `session.reload()` after computing the transform from the session's composed default prompt.

### Why

- Senpi's resource loader intentionally does not expose upstream's constructor-level prompt
  override; the loader-method override achieves the same lazy, reload-visible behavior without
  re-adding a fork-unwanted option to the public services factory, while keeping the
  transformation input the fully composed session system prompt.

### Why an extension could not handle it

- The harness enforces extension-free sessions — it throws when
  `getExtensionPaths().length !== 0` — because comparative evals must not depend on ambient
  extension state. A system-prompt transformation delivered as an extension would break the
  very isolation property the harness asserts, so it must act at the services/resource-loader
  layer before the first prompt step.

### Expected merge conflict zones

- The `createAgentSessionServices` call and the `getSystemPrompt` override block whenever
  upstream reshapes resource-loader options or the pin-era `systemPromptOverride` seam.
- Dependency name/version lines shared with `packages/evals/package.json`.

## Upstream sync (upstream/main@71dca871) integration repairs (2026-09-12)

### What changed

- `packages/evals/package.json`: stays `@code-yeongyu/senpi-evals 2026.7.25` depending on `@code-yeongyu/senpi ^2026.9.12` and `@earendil-works/pi-ai ^2026.9.12`, with `@types/node 26.2.0`, `typescript 7.0.2`, `vitest-evals 0.16.1`, `vitest 4.1.11`.
- `packages/evals/src/docs.eval.ts`: `defineTool` imported from `@code-yeongyu/senpi`.
- `packages/evals/src/models.eval.ts`: `ModelRuntime` imported from `@code-yeongyu/senpi`; the local summary type's `input` is `Model<Api>["input"]` because the fork union includes `video`.
- `packages/evals/src/providers.eval.ts`: `AgentSession`/`ModelRuntime` imported from `@code-yeongyu/senpi`; same `Model<Api>["input"]` widening.
- `packages/evals/src/pi-harness.ts`: upstream harness (`SettingsManager.inMemory({ shellCommandPrefix })`, `extensionFactories`) importing from `@code-yeongyu/senpi`, with the `SENPI_*` variables unset ahead of the `PI_*` list in `shellCommandPrefix`.
- `packages/evals/vitest.test.config.ts`: a `@code-yeongyu/senpi` source alias beside the `@earendil-works/pi-coding-agent` one so unit tests resolve the workspace source.

### Why

- The evals package targets the senpi package name and the fork's `envValue` precedence (SENPI_ before PI_); upstream's new eval files had to be retargeted or they would not resolve.

### Why an extension could not handle it

- Import specifiers, manifest ranges and vitest aliases are resolved before any eval code runs.

### Expected merge conflict zones

- MEDIUM: the import line of every `packages/evals/src/*.eval.ts` upstream adds; `shellCommandPrefix` in `pi-harness.ts`.
- LOW: `packages/evals/package.json` dependency lines; `vitest.test.config.ts` alias list.
