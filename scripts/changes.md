## 2026-09-25 - The published tarball leaves out never-published workspaces nothing shipped reaches (senpi#2141)

### What changed

- `scripts/registry-packages.mjs`: `isUnpublishedForkPackage(name)` is true for a `@code-yeongyu/` package outside `registryPackageNames` (the publish set), which the registry can never serve.
- `scripts/unpublished-bundled-workspaces.mjs` (new): `unpublishedBundledWorkspaces(repoRoot, workspaces)` returns those bundled workspaces, measured against the BUILT `packages/coding-agent/dist` (any quoted specifier of the package in a shipped `.js`/`.mjs`/`.cjs`) and against the manifests that ship (the CLI's and every published bundled workspace's `dependencies`/`optionalDependencies`/`peerDependencies`). If anything shipped reaches one, it throws and names the importer or declarer, so a release can never publish an uninstallable CLI.
- `scripts/prepare-senpi-bundled-workspaces.mjs`: `prepareSenpiBundledWorkspaces` skips those workspaces and removes any stale staged copy, so `stagePublishManifest` never declares them. `assertSenpiPackedWorkspaceFiles` skips their required-file checks and throws when the packed manifest's runtime or bundled dependencies name one.
- Tests: `unpublished-bundled-workspaces.test.mjs` (the rule, an import from `dist/bundle`, declarations by the CLI and by a published workspace); `prepare-senpi-bundled-workspaces-pack.test.mjs` replaces the "desktop engine loader required" case with the guard and the leave-out case. `prepare-senpi-bundled-workspaces.prepare.test.mjs` replaces "stages the desktop engine's host executable" with the leave-out case (a stale staged copy is removed, nothing desktop is declared) and a staging failure when the built dist imports the engine, and its manifest case no longer expects the desktop names.

### Why

`@code-yeongyu/senpi@2026.9.25` declared the five private desktop workspaces (`2026.9.24-2`) as dependencies because `stagePublishManifest` declares every bundled package. npm installs from the bundle, but bun resolves every declared dependency from the registry even when it is bundled (as in #1632), so `bun add` failed and omo could not adopt the release. Nothing in the shipped `dist/` imports them yet (#2128 PR-0 has no user-visible tool). When the chain ships the engine as an external native sidecar, it joins the publish set and this guard is what forces that step.

### Why an extension could not handle it

This is release tooling.

### Expected merge conflict zones

- The workspace loop of `prepareSenpiBundledWorkspaces` and the check loop of `assertSenpiPackedWorkspaceFiles`.
- `registryPackageNames` in `scripts/registry-packages.mjs`, when a desktop package joins the publish set.

## 2026-09-24 - The five desktop packages join every enumerating build and publish script (senpi#2128)

### What changed

- `scripts/build-all.mjs`: `BUILD_PHASES` builds `packages/desktop-protocol` and `-prelude` beside tui, `-engine` beside ai, `-service` beside agent, and `-tool` beside sqlite-node, all before coding-agent. `build-all.test.mjs` pins the order and proves each desktop package builds after the workspace packages it depends on.
- `scripts/prepare-senpi-bundled-workspaces.mjs`: the five desktop packages are bundled workspaces. `-engine` has `nativePrebuild: true`. `nativePrebuildFile(target, packageName)` takes a per-package file pattern (`senpi_pty.<target>.node` for pi-pty, `senpi-desktop-engine[.exe]` for the engine), and `bundledWorkspacePackageChecks` reports each package's own `prebuildFiles`. A missing host prebuild still only warns.
- `scripts/release-packages.mjs`: `BUNDLED_INTERNAL_WORKSPACES` lists the five desktop manifests. They are private, never published, and stay off the CalVer stamp. `scripts/registry-packages.mjs` is deliberately unchanged, because a registry entry would make `publish.mjs` publish them.
- `scripts/build-coding-agent-bundle.mjs`: `@code-yeongyu/senpi-desktop-engine` is external and allowed, like `@earendil-works/pi-pty`. `commonBuildOptions` and `validateExternalImports` are exported, and the build runs only when the file is executed directly, so `build-coding-agent-bundle.test.mjs` can bundle a probe with the real options.
- `scripts/check-entry-graphs.mjs`: the desktop packages are followed as workspace sources and each `.` entry has a budget that forbids agent, ai, tui, coding-agent, and codemode.
- `scripts/changes-md-policy.mjs`: `CRATES_SOURCE_PATTERN` matches `crates/senpi-desktop-*/` beside `crates/senpi-pty/`.
- `scripts/local-release.mjs`: builds and packs the desktop packages in dependency order. `scripts/generate-coding-agent-shrinkwrap.mjs`: `@code-yeongyu/senpi-desktop-` is an internal prefix.
- `scripts/desktop-package-boundaries.test.mjs` (new): enforces the import direction. Codemode imports no desktop package. Coding-agent imports only `-tool` and `-service`. `-engine` may import `-protocol`; `-service` may import `-protocol`, `-engine`, and `-prelude`; `-tool` may import those plus `-service`. `-protocol` and `-prelude` import no workspace package. No desktop package imports agent, ai, or tui, and exactly five desktop packages exist.

### Why

- Desktop computer use (senpi#2128) adds five flat TS packages. Every script that enumerates workspaces has to agree on them before any of them gains behavior, or publish staging and the bundle break late.

### Why an extension could not handle it

- Build, bundle, publish, and changelog tooling runs before any extension loads.

### Expected merge conflict zones

- MEDIUM: `BUILD_PHASES` in `build-all.mjs`, the `bundledWorkspaces` table and `nativePrebuildFile` in `prepare-senpi-bundled-workspaces.mjs`, the external lists and the new `buildBundle` wrapper in `build-coding-agent-bundle.mjs`, and the `packages` list in `local-release.mjs`.
- LOW: `WORKSPACE`/`BUDGETS` in `check-entry-graphs.mjs`, `BUNDLED_INTERNAL_WORKSPACES`, `CRATES_SOURCE_PATTERN`, and `internalPackagePrefixes`.

## 2026-09-23 - Claude Code model-support report in the release and nightly gates (senpi#2053)

### What changed

- `scripts/check-claude-code-model-support.mjs` (new): lists Anthropic catalog Claude ids the pinned bundled Claude Code binary does not embed (`--strict` exits 1); `--sdk-currency` exits 1 when `@anthropic-ai/claude-agent-sdk` trails the newest published release.
- `scripts/release-artifacts.mjs`: `runClaudeCodeModelSupportReport` runs the report (non-strict); `scripts/release.mjs` calls it right after `runGenerateModels`.
- `.github/workflows/releasability.yml`: `model-catalog-regen` runs the report `--strict` after regeneration; new `claude-sdk-currency` job, wired into `report-failure`. `.github/workflows/ci.yml`: new `claude-executable-windows` job in the `Check and test` fan-in.

### Why

- The release regenerates the catalog from the network after PR CI ran, so a new Claude id can enter there; the log and the nightly gate must say when the pinned Claude Code does not know it (oh-my-openagent#8700).

### Why an extension could not handle it

- Release and CI tooling, not runtime behavior.

### Expected merge conflict zones

- LOW: the import list and the artifact-step sequence in `scripts/release.mjs`; `scripts/release-artifacts.mjs` beside `runGenerateImageModels`; the job lists of `ci.yml` and `releasability.yml`.

## 2026-09-22 - point the bundle oauth module map at the renamed provider module (senpi#1989)

### What changed

- `scripts/build-coding-agent-bundle.mjs`: the bundled OAuth module map key and its dist path follow the provider rename (`openai-codex` -> `chatgpt-subscription`), matching the renamed `packages/ai/src/auth/oauth/chatgpt-subscription.ts`.

### Why

The bundle resolves OAuth modules by provider id. Leaving the map keyed by the old id while the module file moved would break OAuth module resolution in the bundled binary only - the workspace build would still pass, so the failure would surface after packaging rather than in CI.

### Why an extension could not handle it

The bundle script runs at build time, outside the extension runtime entirely.

### Expected merge conflict zones

- `scripts/build-coding-agent-bundle.mjs` oauth module map, against any other bundled OAuth provider.

# changes

## 2026-09-22 - Compiled loader probe pins one module generation per source version (senpi#1948)

### What changed

- `compiled-extension-fixtures.ts`: the compiled loader probe now asserts that two `loadExtensions` calls over unchanged source share one module generation (same `moduleToken`, `factoryRuns` [1, 2]), that a second session cwd does not fork it, and that editing an imported source recompiles it (new token, `factoryRuns` back to 1). It no longer calls `clearExtensionCache`, so the freshness leg proves automatic invalidation inside a shipped binary.

### Why

- The probe pinned the previous contract, where every `loadExtensions` call built a new generation. That is the defect senpi#1948 fixes: a module registry cannot evict, so a per-load generation leaked the whole extension graph per session on a shared host.

### Why an extension could not handle it

- The probe runs the compiled loader itself; no extension can observe the generation the host compiles it under.

### Expected merge conflict zones

- The assertion block at the end of `compiledLoaderProbeSource`, whenever upstream changes loader caching.

## 2026-09-21 - Reject changes to released changelog sections (#1884)

### What changed

- `scripts/check-pr-changelog.mjs` compares committed CHANGELOG sections against the PR merge base, rejecting released additions, edits and deletions with their path, line and section.

### Why

- `scripts/check-pr-changelog.mjs` previously accepted any changed changelog filename, including entries that could never appear in a future release. Only the existing Unreleased block's release stamp may introduce a new released section.

### Why an extension could not handle it

- `scripts/check-pr-changelog.mjs` runs in CI, outside the agent runtime.

### Expected merge conflict zones

- LOW: `scripts/check-pr-changelog.mjs` fact collection and verdict composition.

## 2026-09-21 - run-workspaces gains --parallel with prefixed lanes and shared signal forwarding (senpi#1895)

### What changed

- `scripts/run-workspaces.mjs`: parses `--parallel`; in that mode every selected workspace's script starts at once through `runInParallel`, results keep the selection order, and the exit code is still the first failing lane's.
- `scripts/package-manager.mjs`: `spawnPackageManager` accepts `prefix` (pipes stdout/stderr and tags every line `[<workspace dir>]`, flushing a trailing partial line) and `fanout`; `createSignalFanout` installs one handler set that forwards SIGINT/SIGTERM/SIGHUP to every attached child's process group and hands the signal back so the driver re-raises it only after every lane closed. Without either option the sequential path is unchanged.
- `scripts/run-workspaces.parallel.test.mjs`: overlap proven with a file rendezvous (each lane waits for the other's start marker), prefixed output, first-failure exit code, and a two-lane SIGTERM test; `scripts/run-workspaces.test.mjs` now uses `--sequential` as its unknown-flag sample and expects `parallel: false` from `parseArguments`.

### Why

- The root `dev` script used `concurrently`, the one root script that did not go through the package-manager-agnostic driver; running lanes inside the driver keeps `npm run dev` / `bun run dev` / `pnpm run dev` identical and lets the existing process-group signal forwarding cover both lanes (senpi#1895).

### Why an extension could not handle it

- Root scripts run before the engine or any extension is loaded.

### Expected merge conflict zones

- `parseArguments` and the run loop in `run-workspaces.mjs`; the `spawnPackageManager` signature in `package-manager.mjs`.

## 2026-09-21 - Real-session multi-job eval QA (senpi#1908)

### What changed

- `scripts/qa/eval-multi-job.ts` drives sequential eval calls through an AgentSession and real JS/Python kernels, using externally released files instead of timing barriers. It captures request/response pairs, completion notifications, typed reset refusal, queued cancellation and verified teardown.
- A read-only `--codemode-root` selects the pre-adoption implementation for the expected busy-error baseline; `--out` selects the evidence file.

### Why

- Unit admission tests cannot prove that queued cells, cross-language work and session notification wiring agree in a live kernel.

### Why an extension could not handle it

- This is repository-owned verification of the shipped extension.

### Expected merge conflict zones

- LOW: the new QA driver.

## 2026-09-21 - Queued eval admission QA (senpi#1908)

### What changed

- `scripts/qa/omp-item8.ts` asserts queued admission and targeted dequeue instead of the removed per-language busy error.
- `scripts/qa/omp-item8-fixture.ts` observes per-run callbacks and forwards cell ids when instrumenting interrupts. Its foreground bridge result assertion now narrows run details explicitly, since list controls return cross-language cell metadata instead.

### Why

- The steering QA must exercise the same queue and callback contract as the shipped eval tool.

### Why an extension could not handle it

- These are repository-owned executable QA scenarios, not extension behavior.

### Expected merge conflict zones

- LOW: the steering QA scenario and its fixture.

## 2026-09-21 - The lock generators allowlist the bumped @google/genai (senpi#1895)

### What changed

- `scripts/generate-coding-agent-shrinkwrap.mjs` and `scripts/generate-coding-agent-install-lock.mjs`: the install-script allowlist entry moves from `@google/genai@2.21.0` to `@google/genai@2.23.0`.

### Why

- Both generators refuse a release dependency whose install scripts are not reviewed, and the allowlist is keyed by exact `name@version`, so bumping the dependency without the allowlist entry fails `npm run check` at `check:shrinkwrap`. The reviewed fact is unchanged: the package's `preinstall` is a no-op in the published tarball.

### Why an extension could not handle it

- The allowlist gates what the publish pipeline is permitted to bundle; it runs long before any extension exists.

### Expected merge conflict zones

- LOW: the `allowedInstallScriptPackages` map in both generators, whenever a release dependency with install scripts is bumped.

## 2026-09-19 - A bundled build can start its host again

### What changed

- `scripts/build-coding-agent-bundle.mjs` adds `host-lifecycle` to the lazy entry list, so the
  bundle emits `chunks/host-lifecycle.js` - the name `supervisor-route`'s deferred import
  actually resolves.

### Why

- `session-worker` is bundled there with splitting off, and it transitively pulls
  `supervisor-route`, whose `import("./host-lifecycle.js")` therefore stays a relative
  specifier resolved beside the emitted file. Only the content-hashed copy existed, so a
  published install answered `Module not found .../chunks/host-lifecycle.js` and could not
  start a daemon at all.

### Why an extension could not handle it

- The bundle layout is produced by this script; nothing outside the build can decide which
  modules are emitted as their own entries.

### Expected merge conflict zones

- The `entryPoints` map of the second (`lazyResult`) build, whenever another
  variable-specifier module is added to it.

## 2026-09-18 - Seed B.AI credentials in development setup

### What changed

- `scripts/devenv-setup.mjs` recognizes `BAI_API_KEY` when seeding the local development environment.

### Why

- The native B.AI provider should work in a fresh development checkout without storing credentials in tracked
  files.

### Why an extension could not handle it

- Development environment bootstrapping runs before Senpi or its extensions.

### Expected merge conflict zones

- LOW: one entry in the provider-key array.

## 2026-09-18 - Emit the Devin and Cursor lazy modules beside the bundle (senpi#1810)

### What changed

- `build-coding-agent-bundle.mjs`: the second esbuild pass that writes one self-contained file per variable-specifier import now also emits `devin.js`, `cursor.js` (OAuth flows) and `devin-agent.js`, `cursor-agent.js` (provider streams).

### Why

- `packages/ai` reaches its Node-only modules through computed relative imports (`importOAuthModule("./devin.ts")`, `importNodeOnlyApi("./devin-agent.ts")`) so bundlers cannot follow them into browser-reachable code. The bundle compensates by emitting each target as a sibling file next to the chunk that imports it. Four targets were added to the loaders after that list was written, so `dist/bundle/chunks/devin.js` never existed and every Devin or Cursor login died with `Cannot find module`. The other seven OAuth flows and Bedrock were on the list and worked.

### Why an extension could not handle it

- The failure is inside the release bundler's own output layout; nothing at runtime can create a missing chunk.

### Expected merge conflict zones

- LOW: the `entryPoints` map of the `lazyResult` build in `build-coding-agent-bundle.mjs`.

## 2026-09-18 - Guard worker_threads.markAsUncloneable in the bundle prologue (senpi#1806)

### What changed

- `build-coding-agent-bundle.mjs`: the esbuild banner every emitted file starts with now reads `node:worker_threads` and installs a no-op `markAsUncloneable` when the runtime has none.

### Why

- `undici@8.10.2` instantiates `CacheStorage` at module init, and that constructor calls `webidl.util.markAsUncloneable(this)` — bound unconditionally from `worker_threads.markAsUncloneable`, a Node >= 23 API. Bun 1.3.x has no such export, so the first `require("undici")` threw and every published senpi from `2026.9.17-3` failed to boot there, TUI and headless alike. senpi never uses `caches`; the crash was undici's own init. The banner is the one place guaranteed to run before any bundled module in every chunk, including `session-worker.js`.

### Why an extension could not handle it

- Extensions load after the engine has already imported undici. Only the bundle prologue runs early enough.

### Expected merge conflict zones

- LOW: the `banner` constant in `build-coding-agent-bundle.mjs`.

## 2026-09-17 - Compiled binaries carry the build epoch and short sha (#1782)

### What changed

- `build-binaries.sh`: every `bun build --compile` invocation gets `--define SENPI_BUILD_EPOCH=<unix(commit date)>` and `--define SENPI_BUILD_SHA7=<sha[:7]>`, derived from the commit being built.

### Why

Two hosts that speak the same protocol still need a way to say which one is NEWER, and a CalVer string cannot separate two builds of the same day. The epoch is that ordinal: a successor hands off only when its epoch is strictly greater and the launch profile matches. A binary built without the defines reports no ordinal at all, which reads as "uncomparable" - it attaches, and it never initiates a handoff.

### Why an extension could not handle it

An extension runs inside a session; both of these are process-level surfaces that exist before any session does - the module barrel a client imports to decide what to do with a host it found, and the compile step that stamps the binary. Neither is reachable from extension code.

### Expected merge conflict zones

Upstream edits to the same export list, and upstream edits to the `bun build --compile` argument list in the release script.



### What changed

`scripts/build-binaries.sh` passes `--define SENPI_BUILD_EPOCH=<unix(commit date)>` and `--define SENPI_BUILD_SHA7=<sha[:7]>` to every `bun build --compile` invocation, derived from the commit being built.

### Why

Two hosts that speak the same protocol still need a way to say which is NEWER, and a CalVer version string cannot answer that for two builds of the same day. The epoch is that ordinal: a successor hands off only when its epoch is strictly greater and the launch profile matches. A binary built without the defines reports no ordinal at all, which reads as "uncomparable" - it attaches, and it never initiates a handoff.

## 2026-09-17 - Keep ws's native accelerators out of the bundle

### What changed

- `build-coding-agent-bundle.mjs`: `bufferutil` and `utf-8-validate` are esbuild externals and members of `allowedExternalPackages`.

### Why

- `ws` requires those two when they are present. Their loader is `node-gyp-build`, which resolves its binding through a computed require that esbuild cannot follow; the import survives as an external named `<runtime>` and `validateExternalImports` rejects the build. They are optional accelerators with a pure-JS fallback, so they belong outside the bundle next to the other native dependencies.

### Why an extension could not handle it

- This is the release bundler's own external policy. Nothing outside the build script decides which packages esbuild may leave unresolved.

### Expected merge conflict zones

- LOW: the `external` array and the `allowedExternalPackages` set in `build-coding-agent-bundle.mjs`.

## 2026-09-17 - Publish a bundled workspace's assets (senpi#1800)

### What changed

- `prepare-senpi-bundled-workspaces.mjs`: `shouldCopyWorkspaceFile` now copies `assets` and `assets/**` alongside `dist` and `native`; `@earendil-works/pi-agent-core` declares its two tree-sitter grammars in `requiredFiles`, so `assertSenpiPackedWorkspaceFiles` fails the release when they are missing.

### Why

- `pi-agent-core`'s `grammar-assets.js` embeds `import("../../../../../assets/tree-sitter/<name>.wasm", { with: { type: "file" } })`, which Bun's compiler must resolve at compile time. The staged copy omitted `assets/`, so the published tarball pointed outside itself and every `publish-platform` build in the consuming repo failed with `Could not resolve`.

### Expected merge conflict zones

- LOW: the `bundledWorkspaces` entry for pi-agent-core and the `shouldCopyWorkspaceFile` allowlist.

## 2026-09-17 - Keep the Bun-only reaper bindings out of the release bundle (senpi#1782)

### What changed

- `scripts/build-coding-agent-bundle.mjs`: `bun:ffi` joins `bun:sqlite` in `external` and in `allowedExternalPackages`, so esbuild leaves the specifier unresolved instead of failing the build, and the external-import audit still refuses any specifier that is not on that list.

### Why

- The socket host's child reaper loads its `waitid`/`waitpid` bindings through `await import("bun:ffi")` behind a runtime gate (`loadChildReaperSyscalls` returns undefined on Node and win32 before the specifier is reached). The bundler cannot resolve a Bun builtin, so the shipped bundle build failed the moment the reaper landed beside it; externalizing the specifier is the same treatment the runtime-guarded `bun:sqlite` lock adapter already gets.

### Why an extension could not handle it

- Bundling runs in the build, before any runtime or extension exists.

### Expected merge conflict zones

- LOW: the `allowedExternalPackages` set and the `external` array in `build-coding-agent-bundle.mjs`.

## 2026-09-17 - Smoke the bundled entry under custom exec arguments (senpi#1781)

### What changed

- `scripts/node-bundle-smoke.test.ts`: a scenario per runtime launches the bundle with a profiler flag and asserts the agent ran (it rejects the unknown model) instead of failing to resolve its own entry.

### Why

- The bundle inlines `cli-main`, so the sibling the respawn path used to resolve does not exist; nothing covered that path until it broke.

### Why an extension could not handle it

- Packaging and process-structure coverage runs before any runtime exists.

### Expected merge conflict zones

- LOW: the scenario list in `node-bundle-smoke.test.ts`.

## 2026-09-17 - Smoke the shipped bundle under both runtimes (senpi#1781)

### What changed

- `scripts/node-bundle-smoke.test.ts` runs as a runtime matrix (node and bun) over the bundle it builds: `--version` equals the package version, `--help` exits 0, an external TypeScript extension in a temp directory is loaded with `--extension` and its flag appears in help, and an RPC `--multi-session` host opens, reports state for, and closes a session.
- `scripts/AGENTS.md` documents `build-coding-agent-bundle.mjs` as a build entry point and its ordering rule.

### Why

- The bundle is now produced by the package build and shipped, so its runtime behavior needs coverage on both runtimes rather than a single node smoke.

### Why an extension could not handle it

- Build and packaging scripts run before any runtime or extension exists.

### Expected merge conflict zones

- LOW: the scenario list in `node-bundle-smoke.test.ts`.

## 2026-09-16 - Verify and externalize the grammar engine's assets (#1685)

### What changed

- `scripts/prepare-bun-compile-assets.mjs`: `verifyTreeSitterGrammarAssets` checks every artifact named by the vendored provenance file against its recorded SHA-256 and fails asset preparation with a machine code when one is missing or drifted; `main` runs it alongside the imagegen skill staging.
- `scripts/check-browser-smoke.mjs`: the browser bundles externalize the single lazy dynamic import of the Node-only grammar engine and fail if that module still enters the treeshake graph.
- `scripts/qa/omp-item1.ts`: the compiled-parity and packaging runners now require the gate receipt's WASM answer and its declared candidate dependencies to agree, instead of asserting the pre-decision heuristic-only selection.

### Why

- The compiled binary embeds the grammar through a file import, so a missing or drifted artifact must fail the build rather than ship a binary that silently falls back to the heuristic scan. The browser smoke would otherwise hard-error on the engine's `node:fs`/`node:module` reads, which no browser bundle ever executes.

### Why an extension could not handle it

- Asset preparation and bundle guards run in the build, before any runtime exists.

### Expected merge conflict zones

- LOW: `main()` in `scripts/prepare-bun-compile-assets.mjs` and the plugin list in `scripts/check-browser-smoke.mjs`.

## 2026-09-16 - Type-check the qa scripts

### What changed

- `scripts/tsconfig.json` extends the root config and includes `qa/**/*.ts` (plus `packages/**/*.d.ts` so ambient modules the qa import graph needs stay in program).
- `scripts/qa/read-summary-build.d.mts`, `scripts/qa/read-summary-packaging.d.mts`, `scripts/qa/read-summary-parity.d.mts`, and `scripts/qa/omp-item2-plugin.d.mts` type the local `.mjs` modules those runners import.

### Why

- Untyped `.mjs` imports were TS7016, and a scripts-only program dropped coding-agent ambient declarations (`*.md`, `bun:sqlite`, turndown), so qa type errors never failed `tsc`.

### Why an extension could not handle it

- Script tsconfig membership and `.d.mts` shims are compile-time inputs; extensions cannot enroll files in `tsc`.

### Expected merge conflict zones

- LOW: `scripts/tsconfig.json` include list; the four `scripts/qa/*.d.mts` shims if those `.mjs` export surfaces change.

## 2026-09-15 - Follow the current publishing compile recipe (#1639)

### What changed

- `scripts/read-summary-release-contract.test.mjs` still binds QA to the workflow's `build-binaries.sh` compile argv, including `--compile-autoload-package-json` now present on both publishing platforms after origin/main.

### Why

- The previous negative autoload assertion described an older publishing recipe. After merging origin/main the recipe includes that flag on both platforms; forbidding it made the contract test fail against its own authority.

### Why an extension could not handle it

- Compile argv is fixed before startup.

### Expected merge conflict zones

- LOW: `scripts/read-summary-release-contract.test.mjs` publishing argv equality. Keep the workflow shell recipe as the authority.

## 2026-09-15 - Do not fold fields-only class bodies (#1639)

### What changed

- The production brace scanner no longer folds a class body wholesale when the body contains only fields, static blocks or accessors; initializer and static-block interiors remain foldable.
- Adversarial grammar and the 143-line fields-only class regression cover that hole. Enumeration is 1440 programs with 0 counterexamples.

### Why

- Member declarations must stay visible. The project's own oracle does not certify `ClassBody` ranges, and widening the oracle would bless hiding fields.

### Why an extension could not handle it

- Fold ranges are produced below either reader and before any extension can rewrite output.

### Expected merge conflict zones

- LOW: tracker-only. Keep the class-body exclusion in the scanner; do not add `ClassBody` to the oracle whitelist.

## 2026-09-14 - Exercise the selected compiled parser failure (#1639)

### What changed

- `scripts/qa/read-summary-packaging.mjs` feeds malformed selected JSON through the actual relocated reader alongside the unsupported-language control, retaining the rebuilt missing-theme initialization failure.
- The redundant self-derived release-argv comparison is removed; the independent workflow/shell contract and quoted-argv fixture remain the release authority.

### Why

- An excluded JavaScript file cannot reach the shipped JSON parser and therefore cannot establish compiled parse-failure fallback.

### Why an extension could not handle it

- `scripts/qa/read-summary-packaging.mjs` tests the real compiled reader and initialization behavior, not an extension-provided replacement.

### Expected merge conflict zones

- LOW: `scripts/qa/read-summary-packaging.mjs` malformed-source fixture and raw-result assertions; preserve the missing-theme and byte-budget negatives.

## 2026-09-14 - Bind read QA to publishing compile behavior (#1639)

### What changed

- `scripts/qa/read-summary-build.mjs` parses both compile commands from `scripts/build-binaries.sh`, requires their platform-neutral flags and entries to agree, and relocates only target/output arguments.
- `scripts/qa/read-summary-{parity,smoke}.mjs` exercise the requalified JSON default and explicit JavaScript raw control through source and relocated executables.

### Why

- The publishing workflow invokes the shell recipe without runtime package.json autoload. QA must measure and execute those shipping flags rather than the separate package convenience recipe.

### Why an extension could not handle it

- Compile entrypoints and autoload flags are fixed before startup; runtime extensions cannot establish binary parity.

### Expected merge conflict zones

- MEDIUM: `scripts/qa/read-summary-build.mjs` release argv extraction. Keep `scripts/build-binaries.sh` as the authority reached by `.github/workflows/build-binaries.yml`.

## 2026-09-13 - Reconcile read QA with the release graph (#1639)

### What changed

- `scripts/prepare-bun-compile-assets.mjs` removes the self-declared empty read asset accessor/output; transitive feature bundle inputs now establish dependency isolation.
- `scripts/qa/read-summary-build.mjs` originally derived compile argv from the package convenience script; the 2026-09-14 correction above now consumes the publishing shell recipe.
- `scripts/qa/omp-item1.ts` runs the production folder/view bake-off, recording potential candidate output separately from the actual selected default-read output. The raw comparator explicitly omits a folder.
- `scripts/qa/read-summary-smoke.mjs` records final-HEAD JS/TS raw and JSON summary behavior on the source and relocated binary. The real rebuilt missing-theme binary remains the initialization-failure proof.
- `scripts/qa/read-summary-rpc.mjs` awaits the exact source-process exit with a 60-second kill fence, avoiding a timing-luck failure on loaded CI filesystems without polling.

### Why

- `scripts/prepare-bun-compile-assets.mjs` must not claim dependency isolation from a constant unrelated to the compiler's input graph. Release-graph parity must include every actual worker and flag.

### Why an extension could not handle it

- `scripts/prepare-bun-compile-assets.mjs` is build-time packaging; runtime extensions cannot select or verify the shipped entry graph.

### Expected merge conflict zones

- `scripts/prepare-bun-compile-assets.mjs`: removal of read-only reporting; existing asset preparation and binary budget validation remain intact.

## 2026-09-13 - Size-gated standalone read parity (#1639)

### What changed

- `scripts/prepare-bun-compile-assets.mjs` reports the immutable empty read-parser asset set and exposes the inclusive incremental-byte budget check. No parser assets or dependencies are installed.
- `scripts/qa/omp-item1.ts` adds compiled/source parity and missing-asset/budget cases. The read-summary QA modules compile identical-flags baseline/candidate binaries for all six release targets and use a provider-only extension to invoke the actual registered read tool over frozen corpus bytes.
- `scripts/qa/read-summary-smoke.mjs` supplies the same real-session check to the cross-platform PR workflow. Runtime directories carry only the relocated executable, existing package/theme data, fixture and corpus copies, never a workspace node_modules or grammar tree.

### Why

- `scripts/prepare-bun-compile-assets.mjs` makes the heuristic-only selection explicit rather than allowing an installed parser to change output.
- `scripts/qa/omp-item1.ts` verifies output bytes, folder identity, omitted coordinates and range rereads instead of counting help/version or metadata as read proof. It deliberately rebuilds a negative binary from a corrupted generated required-theme lookup, requires initialization failure, then distinguishes malformed source's normal raw fallback.

### Why an extension could not handle it

- `scripts/prepare-bun-compile-assets.mjs` and `scripts/qa/omp-item1.ts` own build-time packaging and artifact validation. The QA extension supplies deterministic provider events only; it neither implements nor replaces read.

### Expected merge conflict zones

- `scripts/prepare-bun-compile-assets.mjs`: compile preparation reporting. `scripts/qa/omp-item1.ts`: enumerated QA cases. Existing reader, truncation and native fallback implementations are untouched.

## 2026-09-13 - Read-summary measurement gate (#1639)

### What changed

- `scripts/qa/omp-item1.ts`: adds actual-read bake-off and invalid-measurement entry points backed by test-only adapters in `packages/agent/test/harness/fixtures/read-summary/`. Candidate-only reruns validate frozen raw/omp captures and oracle hashes, cite the OQ1 receipt, and report actual balanced-brace/indent folding separately from per-file fallbacks.

### Why

- `scripts/qa/omp-item1.ts` records source identity, independent boundary checks, exact token savings and prototype binary deltas before any production read-engine selection.

### Why an extension could not handle it

- `scripts/qa/omp-item1.ts` is offline QA orchestration, not a runtime feature. It deliberately makes no production reader or dependency changes.

### Expected merge conflict zones

- `scripts/qa/omp-item1.ts` is a new fork-only measurement script. Existing build and reader code is unchanged.

## 2026-09-15 - Retry the Windows release-directory rename on transient sharing violations

### What changed

- `scripts/rename-sync-retry.mjs` (new) owns `renameSyncRetry`: `renameSync` retried only on `EPERM`/`EBUSY`/`ENOTEMPTY` with capped exponential backoff until a hard deadline, then a loud `RenameSyncRetryError` carrying the original errno as `cause`/`code`. Clock, sleep and rename are injectable so the unit tests never wait on wall time.
- `scripts/compiled-extension-load.test.ts` renames the freshly built release directory through that helper and surfaces `spawnSync` launch errors instead of only the exit status.

### Why

- `Compiled extensions (Windows)` intermittently failed with `EPERM: operation not permitted, rename '...\release\windows-x64' -> '...\relocated # % binary'` right after the build finished, on `main` and on pure `main` merges alike: Windows still held a handle on the just-written tree for a short window, so the immediate `renameSync` raced the OS (Fixes #1725).

### Why an extension could not handle it

- The rename happens inside the repository's own release-relocation test harness before any extension loads.

### Expected merge conflict zones

- `scripts/compiled-extension-load.test.ts`: the `beforeAll` build-and-relocate block.

## 2026-09-14 - Restore the Node worker bundle builder

### What changed

- `scripts/build-coding-agent-bundle.mjs` externalizes runtime-guarded Bun SQLite, optional canvas, and the package-relative native PTY loader; an esbuild plugin emits file-attributed assets. The Bun runtime-module stub and lazy Node jiti boundary remain intact.
- Node bundle smoke coverage runs the CLI version command and a real shared-session worker lifecycle under Node.

### Why

- `scripts/build-coding-agent-bundle.mjs` could not reach the provider SDK isolation assertion because esbuild rejected Bun SQLite, file attributes, and native canvas. Bundling the PTY loader also relocated its manifest/prebuild lookup incorrectly (Refs #1656).

### Why an extension could not handle it

- `scripts/build-coding-agent-bundle.mjs` defines the distribution graph before runtime extensions load.

### Expected merge conflict zones

- `scripts/build-coding-agent-bundle.mjs`: external allowlist and common esbuild plugins.

## 2026-09-14 - Publish staging mirrors the dependency manifest exactly

### What changed

- `scripts/prepare-senpi-publish-placements.mjs` (new) owns `resolvePublishPlacements`: every `node_modules/...` entry of `publish-deps.lock.json`, top-level and nested, maps to its staged path; npm's workspace-local placements (`packages/coding-agent/node_modules/<pkg>`) are the staged tree's own `node_modules/<pkg>`, and when the root lock placed another version of the same package at the root, the workspace-local copy keeps the top-level slot while the root copy is re-nested under each staged dependent npm resolved to it (recursively), so npm's resolution survives the flattening without evaluating ranges.
- `scripts/prepare-senpi-publish-dependencies.mjs` (new) owns `stagePublishDependencies`: each placement is staged from a version-matched installed copy (same nesting under the root install, hoisted at the root, already staged in place, or nested under another dependent), copied without whatever the installer nested inside it, and staged packages the manifest does not place are pruned at every nesting level.
- `scripts/prepare-senpi-bundled-workspaces.mjs` `copyPublishDependencies` delegates to that module with the internal workspace set; the bundled and vendored workspace staging is unchanged.

### Why

- The manifest keeps the root lock's two-level placements while the staged tree has one level, and the developer's install may be bun-hoisted. The old top-level-only copy also let root placements overwrite npm's workspace-local ones, so the published 2026.9.13-2 tarball shipped `zod@3.25.76`, `https-proxy-agent@7.0.6` and `agent-base@7.1.4` next to a manifest declaring `zod@4.4.3` / `https-proxy-agent@9.1.0` and an `http-proxy-agent@9.1.0` that pins `agent-base@9.0.0`. After the linkedom migration the only `entities` entry is nested under `htmlparser2` (7.0.1); bun hoists it to the root, the old top-level-only copy never staged it, and a stale `entities@8`/`parse5` from the previous graph rode into the tarball, where `htmlparser2` resolved `entities/decode` without `fromCodePoint` and the packed engine failed to compile (#1677).

### Why an extension could not handle it

- `scripts/prepare-senpi-publish-placements.mjs`, `scripts/prepare-senpi-publish-dependencies.mjs` and `scripts/prepare-senpi-bundled-workspaces.mjs` build the tarball's dependency tree before any runtime extension loads.

### Expected merge conflict zones

- LOW: `copyPublishDependencies` in `scripts/prepare-senpi-bundled-workspaces.mjs` (now a one-line delegate) and its `scripts/prepare-senpi-bundled-workspaces-copy.test.mjs` nested-entry assertion.

## 2026-09-14 - Ship standalone codemode once

### What changed

- `scripts/copy-codemode-sidecar.mjs` carries codemode's JS parser dependency beside its source tree; host API dependencies remain supplied by the extension importer.
- `scripts/build-binaries.sh` enables package-json autoload in both release compile commands, matching the package's binary build so Bun can resolve the on-disk parser manifest. Dotenv and bunfig autoload remain disabled.
- `scripts/smoke-standalone-binary.mjs` bounds child processes and reports explicit codemode loading diagnostics before checking the exactly-one-enabled inventory contract.
- A sibling release-graph regression rejects positive codemode contributions, including workspace-relative metafile paths. It rebuilds workspace entries and compile assets on direct invocation, and CI runs it followed by the existing exclusions graph before script suites can invalidate `dist`.
- Workflow coverage checks sidecar staging precedes smoke in the release command list; bundle contents are tested through actual Bun metadata rather than removed source spellings. Copier and inventory tests cover required skill/parser files, stale payload replacement, duplicates, and disabled entries.

### Why

- `scripts/copy-codemode-sidecar.mjs` must make the on-disk extension runnable without the removed bundled factory. `scripts/smoke-standalone-binary.mjs` must distinguish missing payloads from successful relocation (Refs #1656).
- `scripts/build-binaries.sh` needs runtime package metadata for the native importer to resolve external dependencies; shipping their files alone is insufficient when package-json autoload is disabled.

### Why an extension could not handle it

- `scripts/copy-codemode-sidecar.mjs` stages release files before startup; `scripts/smoke-standalone-binary.mjs` verifies the standalone artifact externally. `scripts/build-binaries.sh` sets compiler options that loaded extensions cannot change.

### Expected merge conflict zones

- Payload copying in `scripts/copy-codemode-sidecar.mjs`, RPC validation in `scripts/smoke-standalone-binary.mjs`, and compile flags in `scripts/build-binaries.sh`.

## 2026-09-13 - Retire webfetch compile-asset workarounds

### What changed

- `scripts/build-binaries.sh` removes jsdom's XHR worker from both split compile commands and uses the retained image-resize worker for relocation smoke testing.
- `scripts/prepare-bun-compile-assets.mjs` retains imagegen skill staging and removes CSS dictionary inlining and jsdom stylesheet/XHR patching.
- `scripts/prepare-senpi-bundled-workspaces.mjs` copies runtime dependencies without the retired css-tree source rewrite.
- Release graph and worker tests reject retired DOM contributions while retaining provider, imagegen, and session-worker coverage.

### Why

- `scripts/build-binaries.sh`, `scripts/prepare-bun-compile-assets.mjs`, and `scripts/prepare-senpi-bundled-workspaces.mjs` must not reference or patch the dependencies removed by the linkedom migration (Refs #1656).

### Why an extension could not handle it

- `scripts/build-binaries.sh`, `scripts/prepare-bun-compile-assets.mjs`, and `scripts/prepare-senpi-bundled-workspaces.mjs` select and stage distribution assets before runtime extension loading.

### Expected merge conflict zones

- Compile and smoke argv in `scripts/build-binaries.sh`; asset staging in `scripts/prepare-bun-compile-assets.mjs`; dependency copying in `scripts/prepare-senpi-bundled-workspaces.mjs`.

## 2026-09-13 - Report entry-graph sizes on success

### What changed

- `scripts/check-entry-graphs.mjs` prints each declared entry's file count on success so a green run still reports the `./harness/session` size.

### Why

- The session budget is a cost contract. A silent pass hid the 132-file AI-barrel regression until the script was run by hand.

### Why an extension could not handle it

- Entry-graph walking is a commit-time source import check. Extensions cannot change which modules the checker walks.

### Expected merge conflict zones

- LOW: the success `console.log` in `scripts/check-entry-graphs.mjs`.

## 2026-09-13 - Share compiled standalone entry graphs

### What changed

- `scripts/build-binaries.sh` adds `--splitting` immediately after `--compile` in both platform branches, retaining minification, names, autoload isolation and all four explicit entries.
- `scripts/build-binaries-flags.test.mjs` checks parsed release/package argv. `scripts/session-worker-compile.test.ts` characterizes split and unsplit relocated production clients with two live workers, shared-memory acknowledgments and native exits.

### Why

- `scripts/build-binaries.sh` previously embedded duplicate copies of the shared session-worker graph. Splitting shares those bytes without changing the runtime worker-entry contract (Refs #1656).

### Why an extension could not handle it

- `scripts/build-binaries.sh` selects embedded entry graphs at compile time, before runtime extensions exist.

### Expected merge conflict zones

- The Windows and non-Windows compile argv in `scripts/build-binaries.sh`.

## 2026-09-13 - Keep jiti out of the native Bun extension graph

### What changed

- `scripts/build-coding-agent-bundle.mjs` removes the obsolete lazy-jiti transform plugin and its external allowlist entry; the loader itself now owns the variable-specifier Node-only import. The Bun runtime-module stub remains unchanged.
- `scripts/compiled-extension-load.test.ts` verifies relocated classic/shared-session extension loading after forced GC, helper reload, host identity, direct/per-cwd cached factory behavior and zero positive-output jiti inputs under the release graph flags. Windows uses legal special-character paths, `windows-*` build targets and `.exe` names through `scripts/compiled-extension-platform.ts`. The child summary reports only observed helper output, not prescribed counter constants.

### Why

- `scripts/build-coding-agent-bundle.mjs` no longer needs to replace a static jiti import. Native compiled extensions use Bun's module loader, while jiti remains an installed Node runtime dependency.

### Why an extension could not handle it

- `scripts/build-coding-agent-bundle.mjs` determines the distribution graph before an extension can run.

### Expected merge conflict zones

- `scripts/build-coding-agent-bundle.mjs`: plugin list and external package allowlist; preserve the separate Bun runtime-module stub.

## 2026-09-13 - Keep Bun provider registration outside Node bundles

### What changed

- `scripts/build-coding-agent-bundle.mjs` resolves literal `bun/runtime-modules` imports to an empty module only in its Node esbuild graph.
- Bundle coverage tests require positive implementation bytes reachable from both compiled entries; relocated binary probes consume terminal assistant errors in classic and shared RPC.

### Why

- esbuild follows literal imports even inside the worker's `isBunBinary` branch and would otherwise inline all three Node-only provider modules and the AWS SDK into its unsplit Node worker.

### Why an extension could not handle it

- `scripts/build-coding-agent-bundle.mjs` establishes distribution bundle membership at build time, before extension execution.

### Expected merge conflict zones

- `scripts/build-coding-agent-bundle.mjs` plugin list and Bun-only import resolver.

## 2026-09-12 - Chord keeps upstream's release identity instead of the fork CalVer

### What changed

- `scripts/registry-packages.mjs`: chord is deliberately absent from the owned-alias map, so the fork does not publish a `@code-yeongyu/senpi-chord` package and chord's declared edges resolve to upstream's published version.
- `scripts/release-packages.mjs`: `packages/chord` is removed from `WORKSPACE_PACKAGES` so the CalVer stamp no longer overwrites chord's version, and a new `BUNDLED_INTERNAL_WORKSPACES` export lists chord as a bundled runtime workspace that is internal to the install-lock but not lockstep-versioned.
- `scripts/generate-coding-agent-install-lock.mjs`: the install-lock classifies `WORKSPACE_PACKAGES` ∪ `BUNDLED_INTERNAL_WORKSPACES` as internal, so chord's closure resolves from the local workspace manifest (its `esbuild@0.28.2` dep) instead of fetching upstream `@earendil-works/chord@0.85.1` metadata (which pins `esbuild@0.28.1`). The lockstep CalVer version check still applies only to `WORKSPACE_PACKAGES`.
- `scripts/install-lock-validation.mjs`: the registry-metadata exemption now covers every internal name (not only the CalVer-locked ones), so a bundled-internal workspace staged with a registry tarball URL and no integrity is accepted.
- `packages/chord/package.json`: version returns to upstream's `0.85.1` (no CalVer stamp).
- `packages/{agent,client,coding-agent,protocol,server}/package.json`: the `@earendil-works/chord` dependency is pinned to the exact upstream `0.85.1` it resolves to.

### Why

- `@code-yeongyu/senpi@2026.9.12-3` could not be installed with bun: chord had been CalVer-stamped, so the packaged manifest and the published `@code-yeongyu/senpi-agent-core` manifest declared `@earendil-works/chord@^2026.9.12-3`, a version no registry package provides (only upstream's 0.85.x exists), and bun resolves those declared edges from the registry (issue #1632). npm's OIDC trusted publishing cannot create the first version of a brand-new package name, so publishing a `@code-yeongyu/senpi-chord` alias is not viable without a manual bootstrap; chord is byte-for-byte upstream apart from packaging metadata, so it keeps upstream's own `0.85.1` identity and its edges pin that exact published version. Keeping chord classified internal for the install-lock (`packages/chord/package.json`, `scripts/generate-coding-agent-install-lock.mjs`, `scripts/install-lock-validation.mjs`) keeps the installer closure resolving the bundled fork copy's `esbuild@0.28.2` rather than dragging upstream chord's `esbuild@0.28.1` into the lock. `scripts/release-packages.mjs` and `scripts/registry-packages.mjs` are where the fork records which workspaces ride the CalVer lockstep and which are published, so both had to drop chord from those roles.

### Why an extension could not handle it

- Version stamping, publish-target selection, registry-alias mapping and install-lock generation all run in the release scripts before publication, outside the runtime extension system: `scripts/registry-packages.mjs`, `scripts/release-packages.mjs`, `scripts/generate-coding-agent-install-lock.mjs` and `scripts/install-lock-validation.mjs` execute in the release pipeline, never inside a running agent session, and the `packages/*/package.json` edges are static manifest data.

### Expected merge conflict zones

- `scripts/registry-packages.mjs` owned-alias map; `scripts/release-packages.mjs` workspace lists; `scripts/generate-coding-agent-install-lock.mjs` internal-name construction; `scripts/install-lock-validation.mjs` exemption predicate; the `@earendil-works/chord` dependency range in `packages/{agent,chord,client,coding-agent,protocol,server}/package.json`.

## 2026-09-12 - Registry planning and concurrent-main release recovery

### What changed

- `scripts/publish.mjs` selects its ordered publish targets from the shared owned-registry mapping and uses `scripts/npm-registry.mjs` for registry lookups. `scripts/calver.mjs` uses the same names and treats first-publish 404 responses as an empty baseline. Private-only server, chord, and sqlite workspaces remain excluded; explicitly rewritten source-private packages retain their fork registry names.
- `scripts/release.mjs` throws command failures to its caller and handles fatal errors at the CLI boundary, allowing `syncRemoteMainBeforePush` to recover from a non-ancestor result instead of exiting before its merge.

### Why

- Release 34688541952 completed its tests but failed when main advanced during preparation: the ancestry probe exited before the existing merge recovery could run. The planner also queried private senpi-server and stale upstream names rather than the fork publish set.

### Why an extension could not handle it

- `scripts/publish.mjs` and `scripts/release.mjs` run before publication, outside the runtime extension system.

### Expected merge conflict zones

- `scripts/publish.mjs` package selection and registry query helper; `scripts/release.mjs` command error handling and CLI entry point.

## 2026-09-12 - Binary build script drops the `--min-release-age=0` native install clause

### What changed

- `scripts/build-binaries.sh`: the `--min-release-age=0` native install step listed in the 2026-08-25 entry below is gone; it guarded the cross-platform `@mariozechner/clipboard` install, which D-E/C25 delete along with `--skip-deps`. Every other fork-owned behavior in that entry (jsdom xhr sync worker embedding, codemode sidecar, PTY prebuilds, TUI native helpers, darwin codesign, host smoke test) still holds for the resolved script.

### Why

- The clipboard package the clause installed no longer exists in the fork; the native clipboard now ships as tui prebuilds.

### Why an extension could not handle it

- Release packaging is build tooling, not runtime.

### Expected merge conflict zones

- The dependency-install section of `scripts/build-binaries.sh`.

## 2026-09-10 - Publish a Bun-compile-safe css-tree

### What changed

- `scripts/prepare-bun-compile-assets.mjs` splits into a module plus CLI entry and exports the single portable inliner `inlineCssTreeCompileData(nodeModulesRoot)` next to `patchJsdomBinaryLookups` and `stageImageGenSkill`; the entry check compares real paths because macOS `TMPDIR` is a symlink.
- `scripts/prepare-senpi-bundled-workspaces.mjs`: `copyPublishDependencies` runs that inliner on the staged `packages/coding-agent/node_modules`, so `publish.mjs` and `local-release.mjs` share one compile-safe staging step and the installed source tree is never rewritten.

### Why

- css-tree resolves `data/patch.json`, the mdn-data dictionaries and its own `package.json` through `createRequire` at module scope, which Bun's compiled filesystem cannot serve, so any binary compiled from the published tarball died on the first webfetch HTML conversion. The inlining previously ran only in `build:binary`, and `publish.mjs` packs with `--ignore-scripts`, so the tarball shipped un-inlined. The jsdom rewrites stay binary-only: their worker path is correct only inside the standalone layout.

### Why an extension could not handle it

- Dependency bytes are fixed at publish time; no runtime extension can rewrite a module whose module-scope require already failed inside the compiled filesystem.

### Expected merge conflict zones

- LOW: `scripts/prepare-bun-compile-assets.mjs` asset lists and the `copyPublishDependencies` tail in `scripts/prepare-senpi-bundled-workspaces.mjs`.

## 2026-09-08 - Package the shared RPC session worker

### What changed

- `scripts/build-binaries.sh` includes the session worker as an explicit Bun compile entrypoint.
- `scripts/build-coding-agent-bundle.mjs` emits the Node session worker beside the lazy runtime chunks.

### Why

- Worker URLs alone are not followed by standalone bundlers. A host that can launch but cannot start its session worker is not a usable shared RPC binary.

### Why an extension could not handle it

- Binary entrypoint discovery and Node bundle layout in `scripts/build-binaries.sh` and `scripts/build-coding-agent-bundle.mjs` are packaging responsibilities before extensions run.

### Expected merge conflict zones

- LOW: `scripts/build-binaries.sh` compile argument lists and `scripts/build-coding-agent-bundle.mjs` lazy worker entrypoints.

## Root workspace fan-out moves into a package-manager-agnostic runner (2026-09-07)

### What changed

- `scripts/package-manager.mjs` (new): npm/bun/pnpm detection (user agent first, then the `npm_execpath` basename, so a pnpm installed under `~/.bun/bin` is pnpm), pnpm-only `npm_config_*` scrubbing, execpath-aware spawning that forwards SIGINT/SIGTERM/SIGHUP to the child and re-raises the signal once the child exits, and `runScriptArguments` (npm and bun take `-- <args>`; pnpm 10 forwards every token after the script name verbatim, separator included).
- `scripts/run-workspaces.mjs` (new): `node scripts/run-workspaces.mjs [--if-present] [--workspace <name|path>]... <script> [-- <args>]` resolves the root `workspaces` field (exact paths and `*` segments), runs `<pm> run <script>` per workspace sequentially in path order with the invoking manager, never re-enters the root, keeps going after a failure, prints a PASS / SKIP / FAIL summary, and exits with the first failing workspace's code (1 for a missing script without `--if-present`, 2 for usage errors).
- `scripts/build-all.mjs`: imports the shared helpers instead of inlining them.
- `scripts/root-workspace-scripts.test.mjs`: the guard forbids any package-manager workspace flag (`--workspaces`, `--workspace`, `--prefix`, `--filter`, `-r`, ...) or `cd` in a root script, quoted lanes included, instead of matching the two known recursion shapes.
- Tests: `scripts/run-workspaces.test.mjs`, `scripts/run-workspaces.signals.test.mjs` (shared fixture in `scripts/run-workspaces.test-support.mjs`), `scripts/package-manager.test.mjs`.

### Why

- The root manifest reached into workspaces in npm's dialect; under bun that worked only through bun's `npm run` rewrite (and `--workspaces` then fanned out in parallel), while `--prefix` / `--workspace=` / `cd` lanes always ran real npm. One runner that uses the invoking manager makes `bun run <script>`, `npm run <script>`, and `pnpm run <script>` behave the same, and a guard that enforces the invariant replaces one that only knew two bad shapes.

### Why an extension could not handle it

- These scripts run underneath the package manager, before any Senpi runtime or extension exists.

### Expected merge conflict zones

- LOW: none of the new files exist upstream; the import block of `scripts/build-all.mjs` on sync.

## Browser-smoke exempts @anthropic-ai/sdk-internal Node builtins (2026-08-26)

### What changed

- `scripts/check-browser-smoke.mjs` gains an esbuild plugin that marks `node:*` specifiers external ONLY when the importer path sits inside `node_modules/@anthropic-ai/sdk/`; senpi-owned browser code keeps failing loudly on Node builtins (mutation-verified).

### Why

- `@anthropic-ai/sdk>=0.93.0` (forced by the claude-agent-sdk peer floor) ships a credentials subsystem behind runtime-guarded dynamic `import('node:fs')` calls that never execute in browsers, but esbuild's browser platform hard-errors on the unresolvable specifiers.

### Why this lives in the fork

- The browser-smoke guardrail is a fork-only check with no upstream counterpart.

### Expected merge conflict zones

- LOW: `scripts/check-browser-smoke.mjs` plugin block during guardrail changes.

## Binary build script re-diverges from upstream dcd4619 (2026-08-25)

### What changed

- `scripts/build-binaries.sh` keeps the fork release build: trusted native-dep rebuilds
  (`npm rebuild canvas`), `prepare-bun-compile-assets.mjs`, minified `--keep-names` bun compiles with
  the jsdom xhr sync worker embedded, `--min-release-age=0` native installs, and darwin codesign
  stripping.

### Why

These are fork-owned product surfaces (senpi branding, provider wire behavior, fork runtime features) that upstream does not carry; the sync must re-assert them on top of upstream's tree.

### Why this lives in the fork

The divergence lives in core wiring, package identity, or build plumbing that executes before any extension loads, so no extension hook can express it.

### Expected merge conflict zones

- The per-platform `bun build --compile` invocation lines in `scripts/build-binaries.sh`.

## Install-script allowlist follows the @google/genai bump (2026-08-20)

### What changed

- `scripts/generate-coding-agent-shrinkwrap.mjs` and `scripts/generate-coding-agent-install-lock.mjs`: the allowed-install-script entry moved from `@google/genai@2.13.0` to `@google/genai@2.18.0`. The `protobufjs@7.6.5` entry is unchanged because the protobufjs major was not taken.

### Why

- Both generators refuse to emit a lock that contains an unreviewed lifecycle script, and the allowlist is keyed by exact `name@version`. Bumping `@google/genai` without moving the allowlist string would fail generation even though the package's `preinstall` is still the same no-op that was reviewed.

### Why an extension could not handle it

- These generators run as repository tooling to produce committed lock artifacts before anything is published or installed, so no extension participates in their execution.

### Expected merge conflict zones

- LOW: the `allowedInstallScriptPackages` map in each generator, which only changes when a lifecycle-script dependency is bumped.

## Reviewer-cited tracker parser, collector, and CI hardening (2026-08-17)

### What changed

- `scripts/changes-md-policy.mjs` now parses date-first `## YYYY-MM-DD` headings as well as `## Title (YYYY-MM-DD)`, maps established Why / extension-why / conflict heading dialects onto the four canonical sections, excludes every `*.generated.ts` (and `.mts`/`.cts`/`.js`) catalog-style source from production and CHANGELOG runtime classification, and exports `restrictTrackerEntriesToAddedLines` so a PR only gets credit for bullets it actually added.
- Split git/filesystem collectors into `scripts/changes-md-git.mjs`. `listTrackerFiles` skips symlink `changes.md` files. `validateGitRevision` rejects option-like or metacharacter-bearing `--base` values before they reach git.
- `scripts/check-pr-changelog.mjs` uses the added-line restrictor instead of the stale `entryTouchesDiff` path-substring bypass, exports `parseArgs` so labels can come from `CHANGELOG_GATE_LABELS` / `CHANGELOG_GATE_BASE`, and validates `--base` through `validateGitRevision`.
- `.github/workflows/changelog-gate.yml` passes base SHA and labels through those env vars instead of interpolating label names into the shell command.
- Added `scripts/changes-md-reviewer-fixes.test.mjs` for the date-first, dialect, generated, symlink, added-line, revision, and env-label contracts.

### Why

- Review of the first implementation found that date-first trackers and established heading aliases were treated as uncovered, stale full-file entries could satisfy a PR, symlink trackers and `*.generated.ts` files were misclassified, and workflow label interpolation plus unvalidated `--base` were injection surfaces.

### Why an extension could not handle it

- These are repository CI and audit-script contracts. They run in the changelog-gate workflow and local Node CLIs before any Senpi runtime or extension loader exists.

### Expected merge conflict zones

- LOW: heading-split regex and `SECTION_ALIASES` in `scripts/changes-md-policy.mjs`.
- LOW: `parseArgs` / added-line collection in `scripts/check-pr-changelog.mjs`.
- NONE: `scripts/changes-md-git.mjs` and `scripts/changes-md-reviewer-fixes.test.mjs` are fork-owned additions.


## Repository-wide changes.md audit backfill for validation and transcript tooling (2026-08-17)

### What changed

- Backfill from the repository-wide changes.md audit (pin 914cf147, tag v0.84.2): records the fork deltas on upstream-owned utility scripts. The binary, release, pinning, and publish pipeline deltas remain recorded in the entries below.
- `scripts/check-pinned-deps.mjs`: `isInternalWorkspaceDependency()` now also recognizes `@code-yeongyu/*` names, so fork-scoped workspace and alias dependencies are exempt from the exact-version pinning rule exactly like `@earendil-works/pi-*`.
- `scripts/check-ts-relative-imports.mjs`: imports the TypeScript API from `@typescript/typescript6` because TypeScript 7 removed the classic programmatic JS API, and skips the generated `evidence/` and `local-ignore/` QA trees when collecting TypeScript files.
- `scripts/session-transcripts.ts`: the shebang is now `npx tsx` so the TypeScript source runs directly, and the `--analyze` subagent mode was removed with the delegated execution runtime - the pi JSON-event spawn machinery, readline parsing, truncation helpers, and the AGENTS.md pattern-mining prompt are gone; only cwd-scoped transcript extraction and context-sized splitting remain.
- `scripts/tool-stats.ts`: hardened tool-call accounting with an `isRecord` guard for bash arguments and destructured `id`/`name` string checks instead of `"name" in block` probes, keeping the script type-safe under the typed Message shape without `any`.

### Why

- Fork-scoped package identities, the TypeScript 7 toolchain split, the removal of the delegated execution runtime, and the typed message shape each changed an assumption these utility scripts were written against; an untracked divergence would hide the exact reason the fork cannot take upstream's version verbatim on the next sync.

### Why an extension could not handle it

- These are repository validation and analysis scripts executed outside any Senpi runtime or extension loader.

### Expected merge conflict zones

- LOW: the internal-name predicate in `scripts/check-pinned-deps.mjs`, the import and ignore list in `scripts/check-ts-relative-imports.mjs`, the shebang and mode surface of `scripts/session-transcripts.ts`, and the narrowing guards in `scripts/tool-stats.ts`.

## Changes.md tracker policy enforced by the changelog gate and a repository audit (2026-08-17)

### What changed

- `scripts/check-pr-changelog.mjs` (modified upstream file) now audits changes.md tracker coverage in addition to the release `CHANGELOG.md` requirement: every upstream-owned production change in a PR must be covered by an entry with all four canonical sections in its exact nearest `changes.md` tracker. The `no-changelog` label still bypasses only the `CHANGELOG.md` requirement, never the tracker policy.
- Added `scripts/changes-md-policy.mjs`, the shared policy module: production-path classification (docs, tests, fixtures, examples, generated catalogs, lockfiles, trackers, and `.github/upstream.json` are excluded), exact nearest-ancestor tracker resolution, canonical-section coverage checks, rename/delete auditing rules, and fail-closed upstream-pin validation plus the git/filesystem collectors both tools share.
- Added `scripts/audit-changes-md.mjs`, a repository-wide audit CLI (`--upstream <path>`, `--format json|markdown`, `--help`) that compares HEAD against the pinned upstream SHA, exempts fork-only paths absent from the pin tree, and reports covered/uncovered paths with their nearest tracker and a reason, exiting 1 when anything is uncovered.
- The PR CLI now parses rename-aware `git diff --name-status -M base...HEAD`, reads `.github/upstream.json`, verifies the pinned commit exists, distinguishes fork-only from upstream-owned paths via the pin tree, and audits only integration repairs (`divergentFiles`) on pin-changing syncs. `--help` was added to both CLIs.
- Added failing-first suites `scripts/check-pr-changes-md.test.mjs` and `scripts/audit-changes-md.test.mjs` that pin the seam contract (`trackerPolicy` input, ordered `uncovered` output).

### Why

- AGENTS.md already required every upstream-owned production edit to update the nearest `changes.md` in the same increment, but nothing verified it, so stale entries accumulated silently and misled the next upstream sync.
- The existing gate only checked for any `CHANGELOG.md` edit, which a package-unrelated changelog could satisfy; coverage must be exact-nearest-tracker and must name the audited path.

### Why an extension could not handle it

- The rule is repository and CI policy: it must run in the changelog-gate workflow and in local audit tooling before any Senpi runtime or extension loader exists, so only repository scripts under `scripts/` can enforce it.

### Expected merge conflict zones

- LOW: `scripts/check-pr-changelog.mjs` `checkPrChangelog` verdict wiring and CLI argument parsing; upstream may add gate flags.
- LOW: `scripts/changes-md-policy.mjs` classifier patterns and canonical-section aliases; upstream has no equivalent file.
- NONE: `scripts/audit-changes-md.mjs` and both test files are fork-owned additions.

## Require provenance-backed npm release publication (2026-08-13)

### What changed

- Release publication now refuses to build an npm publish command outside
  GitHub Actions.
- All seven registry package source manifests are private; the canonical
  publisher creates temporary public manifests only inside its validated
  release flow.
- Lockstep validation and release-announcement enumeration now use one explicit
  source-to-registry package map instead of inferring publication from
  `private`.
- Root `publish` and `publish:dry` scripts now route through the guarded
  publisher instead of calling npm workspaces directly.
- The trusted workflow continues to publish every package with
  `--provenance`; dry-run validation remains available locally because it
  exits before publication.
- Added regression coverage for both the rejected local release path and the
  attested GitHub Actions path.

### Why

- The first telemetry package creation required a one-time local recovery, and
  the remaining release packages were then published without npm provenance
  because the local command silently omitted `--provenance`.
- The root workspace publish command was a second bypass because forwarded npm
  arguments could override its literal provenance flag.
- The coding-agent and codemode source packages were also directly publishable
  through native npm workspace/package commands, bypassing both the provenance
  guard and canonical bundle validation.
- npm package versions are immutable, so the safe invariant is to reject future
  local release publication and require the trusted OIDC workflow.

### Why an extension could not handle it

- npm publication runs in repository release tooling before the Senpi runtime
  or extension loader exists.

### Expected merge conflict zones

- LOW: source package privacy, registry alias enumeration, root publish scripts,
  `buildPublishArgs` in `publish-command.mjs`, and their focused tests.

## Parse npm pack JSON after warning output (2026-08-13)

### What changed

- Added a parser that scans `npm pack --json` output for the final valid JSON
  array instead of parsing the entire stdout stream directly, including when npm
  emits warnings after the JSON payload.
- Added regression coverage using the workspace/config warnings emitted during
  the failed first Senpi telemetry publication.
- Publish staging now materializes any missing optional runtime package directly
  from the exact tarball URL and integrity recorded in the root lock before
  preparing the bundled Senpi package.
- Final tarball validation now requires the publish manifest's actual
  `bundleDependencies`, excluding platform-constrained optional packages that
  intentionally remain registry-resolved on the installing machine.
- Portable hoisted transitive packages are promoted to exact temporary
  dependencies in the staged publish manifest so npm includes every declared
  bundle member in the final Senpi tarball.

### Why

- npm can print warnings before its JSON payload. The publish workflow prepared
  the package successfully but failed before `npm publish` because the warning
  prefix made raw `JSON.parse` reject the output.
- Cross-platform native packages are intentionally present in the lock but npm
  installs only the current host variant. Senpi bundles those platform binaries,
  so publish staging must reify the missing locked variants without changing
  manifests or lockfiles.

### Why an extension could not handle it

- Package packing and npm publication run in release tooling before any Senpi
  runtime or extension is loaded.

### Expected merge conflict zones

- LOW: `validatePack` in `publish.mjs` and `parseNpmPackJson` in `npm-pack-json.mjs`.

## Merge concurrent main updates before release push (2026-08-13)

### What changed

- Release preparation now fetches `origin/main` after creating the verified
  release tag and next-cycle commit.
- If remote main advanced during the long release test transaction, the release
  branch creates a normal merge commit before pushing `main`.
- Added focused tests for advanced, already-contained, and dry-run paths.

### Why

- The release workflow can run for several minutes while other verified PRs
  merge. A non-fast-forward main push previously failed after all release build
  and test work had completed.
- The release tag remains anchored to the already verified release commit;
  only the post-release next-cycle branch absorbs concurrent main history.

### Why an extension could not handle it

- Git synchronization and tag/branch publication happen before any Senpi
  runtime or extension is loaded.

### Expected merge conflict zones

- MEDIUM: the final tag/next-cycle/push sequence in `release.mjs`.

## Lock every Rolldown platform binding (2026-08-13)

### What changed

- Added a root-lock regression that requires every native optional declared by
  Rolldown to carry its exact version, registry URL, integrity hash, and
  `optional` marker.
- Recorded the cross-platform lock restoration merged in PR #849.

### Why

- The upstream sync left only the host Darwin ARM64 binding in
  `package-lock.json`. Linux and Windows Vitest processes failed at startup
  before executing tests because their Rolldown native package was absent.

### Why an extension could not handle it

- Vitest loads Rolldown before tests or the Senpi runtime can start.

### Expected merge conflict zones

- MEDIUM: root `package-lock.json` optional dependency entries.

## Reconcile native optionals after release lock refresh (2026-08-13)

### What changed

- Release preparation now runs a no-script install immediately after the
  package-lock-only refresh.
- Added a release-artifact regression covering both executed and dry-run command
  sequences.

### Why

- npm refreshes optional dependencies for the current host in the lock, but a
  package-lock-only operation does not update `node_modules`. Linux release
  tests could therefore retain the old dependency tree and miss Rolldown's
  `@rolldown/binding-linux-x64-gnu` native package.
- Reconciliation is no-script and network-auditing disabled; it only makes the
  installed tree match the freshly generated host lock before clean/build/test.

### Why an extension could not handle it

- Native package installation and release lock refresh happen before the Senpi
  runtime or extension loader exists.

### Expected merge conflict zones

- LOW: `runPackageLockRefresh` in `release-artifacts.mjs`.

## Build telemetry before its consumers (2026-08-13)

### What changed

- Moved AI into the build phase after telemetry, and agent into the following
  phase after AI.
- Strengthened the build-order regression so direct workspace dependencies must
  be in strictly later phases instead of merely the same phase.
- Kept the flattened phase-order expectation synchronized with the executable
  phase list so the serial release test gate verifies the new order.

### Why

- Release preparation runs `npm run clean` before its second workspace build.
  With telemetry and AI in the same parallel phase, AI could resolve telemetry
  before `dist/index.d.ts` existed and fail deterministically on a clean runner.

### Why an extension could not handle it

- Workspace compilation order is release/build tooling that runs before the
  Senpi runtime or extension loader exists.

### Expected merge conflict zones

- LOW: `BUILD_PHASES` and its dependency-order assertions.

## Install the compiler used by workspace builds (2026-08-13)

### What changed

- Pointed the root `@typescript/native` alias at
  `@typescript/native-preview`, the package that actually provides the `tsgo`
  binary invoked by workspace build scripts.
- Added a dependency-contract test covering the manifest alias, lockfile
  package identity, pinned native compiler version, and installed `tsgo` bin.

### Why

- Clean release runners do not have a globally installed `tsgo`; telemetry must
  build before coding-agent can consume its generated declarations.

### Why an extension could not handle it

- Compiler installation and workspace build ordering happen before any Senpi
  runtime or extension is loaded.

### Expected merge conflict zones

- LOW: root development dependencies in `package.json` and `package-lock.json`.

## Registry-complete locks and owned telemetry publishing (2026-08-13)

### What changed

- Root-lock refresh now hydrates exact npm tarball URLs and integrity hashes before generating the coding-agent
  publish and installer locks; all external registry entries are validated for complete provenance.
- Publish-lock dependency traversal resolves from each source workspace and rebases nested packages into the
  staged bundle tree, so clean non-hoisted npm locks remain deterministic.
- Cross-platform optional packages absent from the host lock are resolved from exact registry versions for both
  publish and installer locks.
- Telemetry joined the fork-owned CalVer alias, release, and bundled-workspace sets as
  `@code-yeongyu/senpi-telemetry`; pack tests require its real package and runtime entrypoint.
- The SQLite backend remains private and independently versioned, with test-only local workspace dependencies so
  root installs never fetch upstream AI or agent artifacts.

### Why

- The upstream merge produced topology-valid but provenance-incomplete locks, which could not prove what npm
  tarballs a release would install and omitted non-host native optionals.
- Telemetry is imported at runtime by AI and agent packages. Leaving it outside the owned alias set split
  standalone installs from the bundled CLI and could copy a dangling workspace symlink into the publish tree.
- SQLite is not reachable from the shipped coding-agent graph, so publishing or lockstep-versioning it would add
  release surface without a consumer.

### Why an extension could not handle it

- Dependency locks, package aliases, workspace staging, and npm tarball composition are release-time behavior
  executed before the coding-agent runtime or extension loader exists.

### Expected merge conflict zones

- HIGH: `generate-coding-agent-shrinkwrap.mjs`, `generate-coding-agent-install-lock.mjs`, and
  `install-lock-validation.mjs` around source-path resolution and registry metadata validation.
- HIGH: `prepare-senpi-publish-manifest.mjs`, `prepare-senpi-bundled-workspaces.mjs`, and `publish.mjs` around
  owned aliases and bundled workspace inventories.
- MEDIUM: `release-packages.mjs`, `sync-versions.js`, and workspace package manifests around telemetry/SQLite
  version policy.

## Durable upstream merge guidance (2026-08-13)

### What changed

- Replaced stale references to a nonexistent upstream-merge workflow with the actual worktree-based two-parent
  merge process and `.github/upstream.json` baseline.
- Documented that released CalVer changelog sections are immutable, `[Unreleased]` must remain singular, upstream
  SemVer headings must be translated rather than copied, and generated lock provenance must be deterministic.

### Why

- Incorrect rebase/workflow guidance would erase upstream ancestry or send maintainers to automation that does
  not exist. The missing changelog and lock rules allowed this merge's two release-integrity regressions.

### Why an extension could not handle it

- These are repository maintenance and release invariants outside runtime behavior.

### Expected merge conflict zones

- LOW: `README.md` and `CONTRIBUTING.md` fork-sync wording.
- MEDIUM: `.github/agent/merge-driver.md` general conflict-resolution rules.

## Fork release and publish pipeline (2026-08-13)

### What changed

- Preserved CalVer release orchestration, nine-package lockstep versioning, and
  fork-scoped publish manifest rewriting.
- Installer-lock generation derives bundled internal workspaces from the
  release-managed package list, so telemetry follows the fork's CalVer alias
  policy while independently versioned sqlite remains registry-backed.
- Combined upstream native dependency isolation, baseline binary targets, and
  Bun bunfig-autoload protection with Senpi's binary assets and codesigning.
- Preserved local-release and publish behavior for fork package identities while
  adopting the session-backend directory rename and telemetry build order.

### Why

- Senpi publishes a different package set, version scheme, standalone binary,
  and bundled extension graph from upstream.
- Upstream build fixes remain necessary for deterministic cross-platform
  artifacts.

### Why an extension could not handle it

- Release, packaging, lock generation, and binary compilation happen outside
  the runtime extension system.

### Expected merge conflict zones

- HIGH: `release.mjs` and `release-packages.mjs`, around CalVer stamping and
  release-managed workspace lists.
- HIGH: `publish.mjs`, around manifest rewriting, source-only packages, and
  bundled workspace dependencies.
- MEDIUM: `local-release.mjs`, around package order and private package policy.
- HIGH: `build-binaries.sh`, around native dependency installation, Bun compile
  flags, embedded assets, target selection, and Darwin codesigning.
# Claude Agent SDK native platform lock coverage

## What changed

- Added `generate-claude-agent-sdk-platform-lock.mjs` to materialize every native optional package declared by
  the locked `@anthropic-ai/claude-agent-sdk` version into the root `package-lock.json`.
- Added a platform-matrix regression that derives the required package names and exact versions from the SDK's
  own lock entry instead of maintaining a second hard-coded list.
- Wired the generator's offline `--check` mode into the root static-validation command.

## Why

- CI installs dependencies on each runner platform with lifecycle scripts disabled. The root lock contained only
  the locally generated Darwin ARM64 SDK package, so Linux and Windows runners omitted the SDK's native Claude
  executable and six OAuth suites bypassed their injected query boundary with `Native CLI binary ... not found`.
- Keeping every SDK-declared optional in the lock lets npm select the matching binary on each runner without
  enabling arbitrary dependency lifecycle scripts.

## Why not an extension

- Dependency resolution happens before Senpi or any extension can start. Only the repository lock generator and
  CI validation can guarantee that npm has the platform package available during installation.

## Expected conflict zones

- `package-lock.json` entries for `@anthropic-ai/claude-agent-sdk-*`.
- Root `package.json` static-check scripts.
- Release/dependency lock tests under `scripts/`.

## Independent workspace dependency synchronization (2026-08-19)

### What changed

- `scripts/sync-versions.js` now visits independently versioned private workspaces when it
  synchronizes dependencies, while still excluding their own package versions from the Senpi
  CalVer lockstep invariant.
- `scripts/sync-versions.test.mjs` covers the SQLite backend retaining version `0.83.0` while
  its `pi-agent-core` and `pi-ai` dependency ranges advance to the current lockstep version.

### Why

- The nested SQLite backend ships imports from the lockstep agent and AI packages. Keeping its
  own upstream version independent must not leave those runtime dependency ranges stale during
  a Senpi release.

### Why an extension could not handle it

- Version synchronization mutates package manifests before build, commit, tag, and publication.
  Extensions run only after installation and cannot participate in release-time manifest
  generation.

### Expected conflict zones

- Future changes to the independent-package allowlist in `scripts/sync-versions.js`.
- Upstream changes that add more independently versioned workspaces with lockstep runtime
  dependencies.


## Upstream sync (upstream/main@71dca871) integration repairs (2026-09-12)

### What changed

- `scripts/build-coding-agent-bundle.mjs`: the fork bundle inputs add `dist/client/index.js` and the RPC `session-worker` entry to upstream's esbuild configuration.
- `scripts/check-pinned-deps.mjs`: internal-package detection also matches the `@code-yeongyu/` scope so fork workspaces are checked as lockstep packages.
- `scripts/generate-coding-agent-install-lock.mjs`: generates `@code-yeongyu/senpi-install`, derives lockstep internal names from `WORKSPACE_PACKAGES` (incl. chord), uses the shared `install-lock-validation.mjs`, `install-lock-utils.mjs` and `publish-lock-optional-registry.mjs` helpers instead of upstream's in-file copies.
- `scripts/generate-coding-agent-shrinkwrap.mjs`: writes `packages/coding-agent/publish-deps.lock.json` (never `npm-shrinkwrap.json`, which npm would force-pack and break bundled installs), treats `@earendil-works/chord`, `@earendil-works/pi-*` and `@code-yeongyu/senpi-codemode` as internal, and resolves optional registry packages.
- `scripts/local-release.mjs`: fork local release flow (`senpi` CLI shim, `prepareSenpiBundledWorkspaces` staging, `local-release-runner.mjs` helpers, npm 11.6+ pack output handling) in place of upstream's `coding-agent-consumer.mjs` driven flow.
- `scripts/release-packages.mjs`: exports `WORKSPACE_PACKAGES` (with `packages/chord` in the CalVer lockstep), `applyWorkspaceVersions` and `runSyncVersions`, and resolves registry packages through `registry-packages.mjs`.

### Why

- The fork releases a self-contained `senpi` tarball with bundled workspaces under CalVer, so lock generation, pin checking, bundling and local release must know the fork scopes, the chord workspace and the no-shrinkwrap contract.

### Why an extension could not handle it

- Release and lock tooling runs outside the product process.

### Expected merge conflict zones

- HIGH: `scripts/generate-coding-agent-install-lock.mjs` and `scripts/generate-coding-agent-shrinkwrap.mjs` whenever upstream changes lock generation; `scripts/local-release.mjs` flow.
- MEDIUM: `scripts/release-packages.mjs` workspace list.
- LOW: `scripts/check-pinned-deps.mjs` internal-name predicate; `scripts/build-coding-agent-bundle.mjs` entry list.

## 2026-09-12 - Sync CI repair: upstream release tooling against the fork manifest and typescript-Go layouts

### What changed

- `scripts/release-packages.mjs`: `getRuntimeDepsCheckPackages()` (new) returns the public-by-flag workspaces union the fork registry sources; `getPublicWorkspacePackages()` keeps its 7-package registry contract for publishing.
- `scripts/check-runtime-deps.mjs`: the classic TypeScript API is imported from `@typescript/typescript6` (root `typescript` is typescript-Go 7.0.2 with no classic entry), config reads fall back to plain fs, and a file excluded from a package build is only a violation when a runtime import edge from a build root reaches it (the fork's generated app-server protocol tree is excluded on purpose and is no longer flagged).
- `scripts/local-release.mjs` / `scripts/local-release.test.mjs`: the pty build/pack step resolves the fork's pi-pty packaging (native/index.js + platform prebuild), and the release-package list materializes the chord workspace; fixture arithmetic carries a provenance comment.

### Why

- Upstream's new release tooling assumed upstream's manifest layout (all pi-* public, registry-resolvable sources); the fork keeps pi-* private in source, publishes under @code-yeongyu, excludes generated trees from the build, and installs typescript-Go — so the tooling crashed or misflagged instead of checking.

### Why an extension could not handle it

- Manifest/private/publish naming and the toolchain layout are repo-wide invariants, not runtime behavior.

### Expected merge conflict zones

- LOW: the public-package lists and the classic-API import in these three scripts; upstream edits them only for new release tooling.

## fix(rpc): a bundled build can start its daemon again

### Why

A published install could not start a host at all. `senpi host ensure` answered
`RPC socket host exited with code 0 before answering get_protocol_info`, and the
daemon's stderr log was empty because it is truncated on each generation start.

### What

- `packages/coding-agent/src/modes/rpc/host-launch.ts`: bundled builds re-enter the CLI
  through `--internal-rpc-host-supervisor` instead of spawning the neighbour named
  host-lifecycle, which is an emitted chunk in that layout and returns without listening.
- `packages/coding-agent/src/modes/rpc/host-lifecycle.ts`: `resolveCliMainPath()` takes the
  entry from the package's declared `bin` rather than counting `..`, which reaches the
  package root once this module is bundled.
- `packages/coding-agent/test/rpc-host-ensure.test.ts`: regression covering the bundled
  layout; the pinned unbundled contract is unchanged.

### Verification

Unbundled 36/36. Bundled: ensure -> `start` (socket present), ensure -> `reuse` (same
pid), stop -> `stopped` (socket removed).

## fix(bundle): file-attribute imports resolve to absolute paths (senpi#2028)

### What changed

- `scripts/bundle-file-attribute-plugin.mjs` (new, moved out of `scripts/build-coding-agent-bundle.mjs`): each `import(..., { with: { type: "file" } })` becomes a wrapper module that imports the esbuild-emitted asset path and exports `fileURLToPath(new URL(emittedPath, import.meta.url))`.
- `scripts/bundle-file-attribute-plugin.test.mjs`: builds a fixture in both release layouts (split main bundle, unsplit sibling build) and runs it on Node and Bun from an unrelated cwd.
- `scripts/node-bundle-smoke.test.ts`: the bundled CLI lists the `gpt-image-gen` skill with an existing path and prints no missing-skill notice, and the bundle keeps exactly the two `claudeCodeVersion="X.Y.Z"` declarations (the `anthropic-messages-*` chunk and `session-worker.js`) that a downstream installer rewrites in place.

### Why

- esbuild's `file` loader inlines a path relative to the output file that contains it (`"../SKILL-<hash>.md"`), while Bun's native import returns an absolute path. Consumers `existsSync` the value, which resolved against `process.cwd()`, so every published install printed `[imagegen] bundled skill not found` and dropped the skill.

### Why an extension could not handle it

- Release bundling is build tooling, not runtime behavior.

### Expected merge conflict zones

- NONE: fork-only scripts.
