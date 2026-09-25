# senpi-desktop-prelude fork changes

## 2026-09-25 - JS/Python computer facades, declarations, and model-facing docs (senpi#2128)

### What changed

- `packages/desktop-prelude/src/prelude.js`, `src/prelude.py`, `declarations.d.ts`, `docs/computer.md`, `docs/computer-safety.md`: ported from oh-my-pi's computer Eval prelude. The `__omp_prelude__` transport is replaced by the ordinary `tool.computer({ action, ... })` call. The Python facade is synchronous, and the docs are rewritten as eval-prompt helper lines covering senpi's discovery, permission tiers, stop path, focus guard, and sole-window rule.
- `packages/desktop-prelude/src/index.ts`: exports `computerPreludeAssets` (`javascript`, `python`, `declarations`, `documentation`, `safety`, `exports`, `methodAllowlist`).
- `packages/desktop-prelude/scripts/generate-assets.ts` + `src/assets.generated.ts`: `build` compiles the asset texts into TS string constants.
- `packages/desktop-prelude/test/`: facade argument mapping (JS and a real Python interpreter), result unwrapping, the allowlist guard against the protocol tier tables, asset drift, and doc coverage. These replace the skeleton placeholder test.

### Why

- IS-1 and IS-11: the `computer` global in the js and py kernels, with oh-my-pi's facade surface and model docs, reaches the kernels through `ToolDefinition.kernelPrelude` with no reserved bridge.

### Why an extension could not handle it

- This package is fork-only and holds no host code: it is data consumed by `@code-yeongyu/senpi-desktop-tool`.

### Expected merge conflict zones

- None in this package: it does not exist upstream.

## 2026-09-24 - Desktop package wired into the workspace (senpi#2128)

### What changed

- `packages/desktop-prelude/`: skeleton package (empty entry plus one placeholder test) wired into the workspace, the build phases, the entry-graph budgets, and the bundled-workspace staging. Todo 23 fills it.

### Why

- Desktop computer use (senpi#2128) ships as five flat TS packages. Every enumerating script has to know about all five before any of them gains behavior, or publish staging breaks.

### Why an extension could not handle it

- This package is fork-only. The wiring lives in root build and publish scripts that run before any extension loads.

### Expected merge conflict zones

- None in this package: it does not exist upstream.
