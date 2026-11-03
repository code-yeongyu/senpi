<!-- changes-log: packages/coding-agent/src/core/tools/changes.md -->
## 2026-11-03 - Built-in file and shell tools run on the shared machine-ops layer (senpi#5592)

### What changed

- `packages/coding-agent/src/core/tools/read.ts`, `packages/coding-agent/src/core/tools/write.ts`, `packages/coding-agent/src/core/tools/edit.ts`, `packages/coding-agent/src/core/tools/ls.ts`: the default `ReadOperations`, `WriteOperations`, `EditOperations` and `LsOperations` call `MachineOps.files` (`read`, `write`, `edit`'s read/write, `stat`, `list`) through a `ToolMachine` (new `machine` option). Caller-supplied `operations` still win, and `serverPinned` and the write baseline still key on them. Rendering, truncation and error text are unchanged: filesystem errors pass through the layer as the same `fs` errors.
- `packages/coding-agent/src/core/tools/find.ts`: the default fd search runs as `MachineOps.files.glob` (same fd arguments, `.gitignore` handling, limit notice and error text); custom `FindOperations.glob` is unchanged.
- `packages/coding-agent/src/core/tools/bash.ts`, `packages/coding-agent/src/core/tools/powershell.ts`: `createLocalShellOperations` runs the shell through `MachineOps.process.exec` (own process group, scope token `OMO_MACHINE_SCOPE`, same abort/timeout/stream-callback handling, same detached-group tracking via `onSpawn`/`onExit`). `createLocalBashOperations` and `createLocalPowerShellOperations` take an optional machine.
- `packages/coding-agent/src/core/tools/index.ts`: `ToolsOptions` gains `machineOps` and `machinePolicy`; `createAllToolDefinitions`, `createCodingTools` and `createReadOnlyTools` pass one `ToolMachine` to every tool. With a `machinePolicy.beforeOp`, each tool call runs it exactly once before any effect, and a denial throws its reason; without one the tools keep their exact timing (no added await).
- `packages/coding-agent/src/core/tools/file-mutation-queue.ts`, `packages/coding-agent/src/core/tools/filesystem-policy.ts`, `packages/coding-agent/src/core/tools/bounded-realpath.ts`: re-export the implementations that moved to `@code-yeongyu/senpi-machine-ops`.
- New `packages/coding-agent/src/core/tools/machine.ts`: the process-wide local `MachineOps` (state under the agent dir, in-process PTY holder, `killProcessTree`, fd via `ensureTool`) and `createToolMachine`.
- `packages/coding-agent/src/core/tools/grep/index.ts`: the path probe uses `MachineOps.files.stat`; the search engine is unchanged.

### Why

- A remote machine executor and the agent's own tools must share one implementation of file and process operations, their limits and their permission checks. The shared layer is the new engine-free workspace package `packages/machine-ops` (`@code-yeongyu/senpi-machine-ops`), which imports nothing from `packages/agent` or `packages/coding-agent`.

### Why an extension could not handle it

- The built-in tools' default operations live in core; an extension can replace a tool but cannot change the default implementation behind `ReadOperations`, `WriteOperations`, `EditOperations`, `LsOperations` or `createLocalBashOperations`.

### Expected merge conflict zones

- MEDIUM: the default-operations blocks and the start of `execute` in `read.ts`, `write.ts`, `edit.ts`, `ls.ts`, `find.ts`; `createLocalShellOperations` in `bash.ts`; `createAllToolDefinitions` in `index.ts`.

<!-- changes-log: packages/coding-agent/src/utils/changes.md -->
## 2026-11-03 - Open-free realpath walker and child-process wait moved to machine-ops (senpi#5592)

### What changed

- `packages/coding-agent/src/utils/paths.ts`: `realpathWithoutOpen` and `realpathWithoutOpenStrict` re-export the implementation now in `@code-yeongyu/senpi-machine-ops`.
- `packages/coding-agent/src/utils/child-process.ts`: `waitForChildProcess` and `WaitForChildProcessOptions` re-export the implementation now in `@code-yeongyu/senpi-machine-ops`.

### Why

- A remote machine executor and the agent's own tools must share one implementation of file and process operations, their limits and their permission checks. The shared layer is the new engine-free workspace package `packages/machine-ops` (`@code-yeongyu/senpi-machine-ops`), which imports nothing from `packages/agent` or `packages/coding-agent`.
- The moved filesystem policy, mutation queue and exec need these helpers, and the package may not import coding-agent.

### Why an extension could not handle it

- These are core utilities that core tools import; extensions cannot relocate them.

### Expected merge conflict zones

- LOW: the re-export lines that replace the moved functions in `paths.ts` and `child-process.ts`.

<!-- changes-log: packages/coding-agent/src/changes.md -->
## 2026-11-03 - Source runtime resolves the machine-ops workspace package (senpi#5592)

### What changed

- `packages/coding-agent/src/experimental/source-resolver.ts`: the workspace source aliases include `@code-yeongyu/senpi-machine-ops` (and its subpaths), so source-run child processes (tool child, session workers) load its sources instead of a missing or stale `dist`.

### Why

- Core tools now import `@code-yeongyu/senpi-machine-ops`; without the alias a source-run tool child exited before ready.

### Why an extension could not handle it

- The resolver is the internal-process preload; extensions do not run before it.

### Expected merge conflict zones

- LOW: the alias filter in `registerWorkspaceSourceResolver`.

<!-- changes-log: packages/coding-agent/changes.md -->
## 2026-11-03 - coding-agent depends on @code-yeongyu/senpi-machine-ops (senpi#5592)

### What changed

- `packages/coding-agent/package.json`: new dependency `@code-yeongyu/senpi-machine-ops`; `build:binary` builds it before coding-agent.
- `packages/coding-agent/tsconfig.build.json`: paths for `@code-yeongyu/senpi-machine-ops` and its `in-process-holder` subpath to the package's `dist`.

### Why

- A remote machine executor and the agent's own tools must share one implementation of file and process operations, their limits and their permission checks. The shared layer is the new engine-free workspace package `packages/machine-ops` (`@code-yeongyu/senpi-machine-ops`), which imports nothing from `packages/agent` or `packages/coding-agent`.

### Why an extension could not handle it

- A package dependency and build paths are manifest changes, not extension surface.

### Expected merge conflict zones

- LOW: the dependency list and `build:binary` in `package.json`; the `paths` block in `tsconfig.build.json`.

<!-- changes-log: scripts/changes.md -->
## 2026-11-03 - Release scripts carry the machine-ops workspace (senpi#5592)

### What changed

- `scripts/release-packages.mjs`: `packages/machine-ops/package.json` joins the lockstep CalVer set.
- `scripts/local-release.mjs`: local release builds and packs `@code-yeongyu/senpi-machine-ops`.
- `scripts/registry-packages.mjs`, `scripts/prepare-senpi-publish-manifest.mjs`, `scripts/senpi-publish-pack-checks.mjs`, `scripts/build-all.mjs`: the package is published under its own name with an exact version in the senpi manifest, its tarball must carry `dist/src/index.js` and the conformance entry, and it builds after pty.

### Why

- A remote machine executor and the agent's own tools must share one implementation of file and process operations, their limits and their permission checks. The shared layer is the new engine-free workspace package `packages/machine-ops` (`@code-yeongyu/senpi-machine-ops`), which imports nothing from `packages/agent` or `packages/coding-agent`.

### Why an extension could not handle it

- Release and build tooling is repository infrastructure.

### Expected merge conflict zones

- LOW: the package lists in `release-packages.mjs`, `local-release.mjs`, `registry-packages.mjs` and `build-all.mjs`.

<!-- changes-log: .github/changes.md -->
## 2026-11-03 - CI runs the machine-ops workspace tests (senpi#5592)

### What changed

- `.github/workflows/ci.yml`: `--workspace packages/machine-ops` in the workspace test step, which runs the package's conformance suite and dependency-boundary test.

### Why

- A remote machine executor and the agent's own tools must share one implementation of file and process operations, their limits and their permission checks. The shared layer is the new engine-free workspace package `packages/machine-ops` (`@code-yeongyu/senpi-machine-ops`), which imports nothing from `packages/agent` or `packages/coding-agent`.

### Why an extension could not handle it

- CI configuration is repository infrastructure.

### Expected merge conflict zones

- LOW: the workspace list of the "Workspace tests (all but coding-agent)" step.

<!-- changes-log: changes.md -->
## 2026-11-03 - Type checking and vitest resolve the machine-ops workspace from source (senpi#5592)

### What changed

- `tsconfig.json`: paths for `@code-yeongyu/senpi-machine-ops`, `/in-process-holder` and `/conformance` to the package sources.
- `vitest.base.ts`: the same three aliases, so every package's tests load the sources.

### Why

- A remote machine executor and the agent's own tools must share one implementation of file and process operations, their limits and their permission checks. The shared layer is the new engine-free workspace package `packages/machine-ops` (`@code-yeongyu/senpi-machine-ops`), which imports nothing from `packages/agent` or `packages/coding-agent`.

### Why an extension could not handle it

- Root type-check and test resolution are repository infrastructure.

### Expected merge conflict zones

- LOW: the `paths` block in `tsconfig.json`; `workspaceSourcePaths` and the alias list in `vitest.base.ts`.

<!-- changes-log: packages/coding-agent/CHANGELOG.md -->
### Added
- The built-in `read`, `write`, `edit`, `ls`, `find`/`glob` and `bash` tools run on `@code-yeongyu/senpi-machine-ops`, a shared engine-free operation layer, and `createAllToolDefinitions` accepts `machineOps` and a `machinePolicy` whose `beforeOp` gates each tool call once before any effect ([#5592](https://github.com/code-yeongyu/senpi/issues/5592))
