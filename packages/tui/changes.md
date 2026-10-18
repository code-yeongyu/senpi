## 2026-10-10 - Test-run temporary storage has an owner (senpi#3064)

### What changed

- `packages/tui/package.json`: test invocations use scripts/run-tests.mjs so TMPDIR/TEMP/TMP are scoped before the test runtime starts and cleaned after exit.

### Why

- Vitest SSR copies and interrupted fixture writes must not accumulate in the OS temp directory.

### Why an extension could not handle it

- Test-process bootstrap is repository tooling, before runtime extensions load.

### Expected merge conflict zones

- Test command arguments and runtime selection; preserve existing reporters, shards and test filters.

## 2026-09-30 - Sync with upstream v0.99.1 (6a4af07d6): manifests, build and check scripts

### What changed

- `packages/tui/package.json`: Root `package.json`: fork scripts kept (`build-all.mjs` build, the fork `check` chain with conflict-marker/bun-lock/install-lock/claude-sdk-platform-lock gates, `run-workspaces.mjs` launchers, `refresh-lock`, `preinstall`); devDependencies kept (biome 2.5.14, @types/node 26.6.2, typescript 7.0.2, @typescript/typescript6, tsx 4.23.13, vitest + @vitest/coverage-v8 5.0.1). Adopted from upstream: `generate:models` runs generate-models only (the `generate-image-models` chain dropped for the D-3 image-model unification), and `test:scripts` also runs the adopted upstream `scripts/model-catalog-protocol.test.ts`. Not adopted: codemode/mcp/durable build phases, the tsx removal. `packages/tui/package.json`: version OURS; adopted `build: tsc`.

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

- `packages/tui/package.json`: `files` excludes `dist/**/*.map`.

### Why

- The maps point at `src/`, which is not published, so they cannot resolve for consumers and only add install size.

### Why an extension could not handle it

- Package publish metadata.

### Expected merge conflict zones

- LOW: the `files` list in `package.json`.

# changes

## 2026-09-21 - Refresh the renderer dependency pins (senpi#1895)

### What changed

- `packages/tui/package.json`: `marked` 18.0.11 -> 18.0.13 and `get-east-asian-width` 1.6.0 -> 1.7.0.

### Why

- Both are fork-owned exact pins shared with `packages/coding-agent`, and the renderer's wide-glyph measurement has to agree with the CLI's, so the two sites move together to the newest release in the same minor that satisfies `min-release-age=2`.

### Why an extension could not handle it

- Manifest dependency versions are resolved by the package manager before any extension loads.

### Expected merge conflict zones

- LOW: the dependency version block, on every upstream release bump.

## 2026-09-14 - tmux short-frame cursor source (#1645)

### What changed

- `packages/tui/src/terminal.ts` uses the extracted `packages/tui/src/tmux-cursor-query.ts` source for TMUX_PANE, with two stable CLI readings and a 750 ms total deadline. Tests inject the existing TmuxExecFile contract.

### Why

- tmux swallows private DECXCPR; regular-mode short frames need a pane-relative out-of-band anchor without bare CPR.

### Why an extension could not handle it

- Cursor queries and frame calibration are terminal-owned. The exact nearest source tracker also records the implementation.

### Expected merge conflict zones

- `packages/tui/src/terminal.ts` cursor broker and options. No renderer or default setting changes.

## 2026-09-10 - Use native TypeScript builds for omob performance

### What changed

- packages/tui/package.json: build uses tsgo for the emitted workspace build.

### Why

- The native compiler reduces omob build time without changing runtime JavaScript.

### Why this lives in the fork

- The package build manifest owns the compiler used by the fork's release pipeline.

### Expected merge conflict zones

- The `build` script in packages/tui/package.json.

## 2026-09-12 - Upstream sync (upstream/main@71dca871) integration repairs

### What changed

- `packages/tui/package.json`: fork CalVer `2026.9.12`, `private: true`, Node `>=24.0.0`, `@xterm/headless 6.0.0`, the `test` script importing `tsx` and `./test/setup-multiplexer-env.mjs`, and a `bench:frame-cost` script; upstream's Linux native `files` globs were adopted.

### Why

- The fork's TUI tests need the multiplexer env setup and tsx loader, and the package rides the CalVer lockstep.

### Why an extension could not handle it

- Package scripts and versions are not runtime code.

### Expected merge conflict zones

- LOW: `scripts.test`, `version`, `engines` and `devDependencies` lines.
