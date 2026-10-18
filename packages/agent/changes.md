## 2026-10-10 - Test-run temporary storage has an owner (senpi#3064)

### What changed

- `packages/agent/package.json`: test invocations use scripts/run-tests.mjs so TMPDIR/TEMP/TMP are scoped before the test runtime starts and cleaned after exit.

### Why

- Vitest SSR copies and interrupted fixture writes must not accumulate in the OS temp directory.

### Why an extension could not handle it

- Test-process bootstrap is repository tooling, before runtime extensions load.

### Expected merge conflict zones

- Test command arguments and runtime selection; preserve existing reporters, shards and test filters.

## 2026-09-30 - Keep the docs/ mobile-handoff prototype out of the agent test run (senpi#2447)

### What changed

- `packages/agent/vitest.config.ts`: `exclude` adds `docs/**`, and keeps vitest's defaults through `configDefaults.exclude`.

### Why

- `docs/mobile-handoff/01-harness/01-delta/delta.test.ts` is historical prototype evidence (its `delta.md` says so), not production source.
- It ran 54 tests in every agent CI run. About 40 of them repeat `packages/chord/test/delta.test.ts` word for word, and one contradicts production: the prototype keeps delete-then-set, while chord collapses it.
- The file stays on disk, because `delta.bench.ts` and `delta.examples.ts` import `delta-impl.ts`, and deleting an upstream-owned file would conflict on the next sync.

### Why an extension could not handle it

- Test runner configuration.

### Expected merge conflict zones

- LOW: the `test` block of `packages/agent/vitest.config.ts`.

## 2026-09-30 - Sync with upstream v0.99.1 (6a4af07d6): retired pico handoff

### What changed

- `packages/agent/docs/pico/pico-handoff.md` stays deleted. Upstream commit `4819cc877e` replaced the approved implementation handoff with `pico-simple-handoff.md`, `pico-rendering.md`, and `pico-simple-blockers.md`.

### Why

The old handoff was deleted upstream after its decisions were incorporated into the newer pico documents; restoring it would revive superseded guidance.

### Why an extension could not handle it

This is repository documentation, outside the runtime extension surface.

### Expected merge conflict zones

- LOW: the retired path if a later upstream merge reintroduces it. Keep the newer pico documents as the source of truth.

## 2026-09-30 - Sync with upstream v0.99.1 (6a4af07d6): manifests, build and check scripts

### What changed

- `packages/agent/package.json`: Root `package.json`: fork scripts kept (`build-all.mjs` build, the fork `check` chain with conflict-marker/bun-lock/install-lock/claude-sdk-platform-lock gates, `run-workspaces.mjs` launchers, `refresh-lock`, `preinstall`); devDependencies kept (biome 2.5.14, @types/node 26.6.2, typescript 7.0.2, @typescript/typescript6, tsx 4.23.13, vitest + @vitest/coverage-v8 5.0.1). Adopted from upstream: `generate:models` runs generate-models only (the `generate-image-models` chain dropped for the D-3 image-model unification), and `test:scripts` also runs the adopted upstream `scripts/model-catalog-protocol.test.ts`. Not adopted: codemode/mcp/durable build phases, the tsx removal. `packages/agent/package.json`: `@earendil-works/chord` exact 0.85.1 -> 0.99.1 (D-12, chord moves to upstream 0.99.1); adopted upstream `./experimental/pico3` export and `build: tsc`; bench scripts keep tsx.

### Why

- The fork builds through `scripts/build-all.mjs` and runs sources with tsx (D-11); upstream's plain-node source execution and TypeScript-7 script rewrites are mechanism changes the fork already covers.
- Upstream codemode, MCP, tool-search and durable are excluded (D-2, D-7), so their workspace packages, dependencies, build phases, tsconfig/vitest aliases and smoke checks stay out.
- The `openai` 6.26.0 hold had no failing check behind it and the adopted upstream OpenAI adapters target 7.19.0 (D-10).
- chord follows upstream 0.99.1 with exact pins (D-12, check:pinned-deps).

### Why an extension could not handle it

Workspace manifests, tsconfig and build/check scripts are repository build infrastructure, outside any runtime extension.

### Expected merge conflict zones

Every path listed above conflicts again where upstream edits the hunks named in its line; the fork-kept constructs named there are the anchors to preserve.

## 2026-09-29 - Published tarball excludes sourcemaps (senpi#2362)

### What changed

- `packages/agent/package.json`: `files` excludes `dist/**/*.map`.

### Why

- The maps point at `src/`, which is not published, so they cannot resolve for consumers and only add install size.

### Why an extension could not handle it

- Package publish metadata.

### Expected merge conflict zones

- LOW: the `files` list in `package.json`.

# changes

## 2026-09-21 - Migrate the test runner to Vitest 5 (senpi#1895)

### What changed

- `packages/agent/package.json`: Updated the test runner to Vitest 5.0.1 and V8 coverage to @vitest/coverage-v8 5.0.1.
- `packages/agent/benchmark/session/benchmark.ts`: Register session timing benchmarks through the Vitest 5 test-context fixture and pass the existing iteration and warmup settings to `bench.run`.
- `packages/agent/vitest.benchmark.config.ts`: Move the benchmark reporter to the top-level test reporter setting.

### Why

- Run this workspace on the pinned Vitest 5 release.
- `packages/agent/benchmark/session/benchmark.ts` and `packages/agent/vitest.benchmark.config.ts` use APIs removed by Vitest 5; migrating them keeps the optional session timing command usable.

### Why an extension could not handle it

- The package manager resolves development tools before extensions load.
- `packages/agent/benchmark/session/benchmark.ts` and `packages/agent/vitest.benchmark.config.ts` are consumed by the test runner, not by runtime extensions.

### Expected merge conflict zones

- The development dependency pins in `packages/agent/package.json`.
- Benchmark registration in `packages/agent/benchmark/session/benchmark.ts` and reporter configuration in `packages/agent/vitest.benchmark.config.ts`.

## 2026-09-21 - Refresh the agent dependency pins (senpi#1895)

### What changed

- `packages/agent/package.json`: `typebox` 1.3.27 -> 1.3.34, `ignore` 7.0.8 -> 7.0.9, `yaml` 2.9.0 -> 2.9.1 and `@types/node` 26.2.0 -> 26.6.2.

### Why

- These are the fork's own exact pins, refreshed to the newest release in the same minor that satisfies the repository's `min-release-age=2` window. Upstream carries different ranges, so the versions have to be re-asserted here.

### Why an extension could not handle it

- Manifest dependency versions are resolved by the package manager before any extension loads.

### Expected merge conflict zones

- LOW: the dependency version block, on every upstream release bump.

## 2026-09-16 - Ship the tree-sitter grammar assets with the package (senpi#1685)

### What changed

- `packages/agent/assets/tree-sitter/javascript.wasm` and `packages/agent/assets/tree-sitter/web-tree-sitter.wasm`: the vendored grammar and runtime artifacts the structural read engine loads, recorded with their upstream package, version, license and SHA-256 in `packages/agent/assets/tree-sitter/provenance.json`.
- `packages/agent/package.json`: adds the pinned `web-tree-sitter` runtime dependency, the pinned `@vscode/tree-sitter-wasm` measurement dependency, and `assets` to the published files.
- `packages/agent/tsconfig.build.json`: includes `src/**/*.d.ts` so the packaged asset module declaration is part of the build program.

### Why

- Only a language the frozen selection binds to `wasm` loads a grammar, and that grammar has to exist in both the npm package and the compiled binary. Vendoring exactly the shipped artifacts keeps the binary delta to the measured 0.6 MB instead of installing every grammar the upstream package carries, and the provenance file is what `scripts/prepare-bun-compile-assets.mjs` verifies before a compile.

### Why an extension could not handle it

- Package files and dependencies are resolved before any extension loads; an extension cannot add an artifact to the published tarball or to a compiled binary.

### Expected merge conflict zones

- LOW: the dependency and files lists in `packages/agent/package.json`.

## 2026-09-12 - Pin the chord dependency to upstream's published version

### What changed

- packages/agent/package.json: `@earendil-works/chord` is pinned to the exact upstream `0.85.1` it resolves to, instead of a fork CalVer range.

### Why

- chord is bundled but kept on upstream's own release identity (issue #1632): the fork does not publish it, so a CalVer range was unresolvable on the registry and broke `bun add @code-yeongyu/senpi`. Pinning the exact published `0.85.1` keeps the declared edge resolvable while the bundled copy shadows it at runtime.

### Why an extension could not handle it

- packages/agent/package.json is static manifest data consumed by the package manager and the release/publish pipeline, never reachable from the runtime extension system.

### Expected merge conflict zones

- The `@earendil-works/chord` dependency range in packages/agent/package.json.

## 2026-09-10 - Use native TypeScript builds for omob performance

### What changed

- packages/agent/package.json: build uses tsgo for the emitted workspace build.

### Why

- The native compiler reduces omob build time without changing runtime JavaScript.

### Why this lives in the fork

- The package build manifest owns the compiler used by the fork's release pipeline.

### Expected merge conflict zones

- The `build` script in packages/agent/package.json.

## 2026-09-12 - Upstream sync (upstream/main@71dca871) integration repairs

### What changed

- `packages/agent/package.json`: keeps the fork CalVer version `2026.9.12` and `^2026.9.12` ranges for `@earendil-works/chord`, `@earendil-works/pi-ai` and `@earendil-works/pi-telemetry`, the Node `>=24.0.0` floor, `diff 9.0.0`, `@types/node 26.2.0`, `typescript 7.0.2`, `vitest`/`@vitest/coverage-v8 4.1.11` and `private: true`; upstream's new Chord runtime dependency and bench scripts were adopted.

### Why

- Every `@earendil-works/pi-*` workspace rides the fork's CalVer lockstep so the install lock can treat them as internal packages, and the fork's held tool pins must stay single-instanced across manifests.

### Why an extension could not handle it

- Package version and dependency ranges are resolved by the package manager before any code runs.

### Expected merge conflict zones

- LOW: `version`, `dependencies` and `devDependencies` lines on every upstream release bump.
