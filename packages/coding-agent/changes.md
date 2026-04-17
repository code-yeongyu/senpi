# Local fork changes

## 2026-04-05 — add `sanepi` CLI alias

- Changed: `packages/coding-agent/package.json`
- Why: The user wants the built CLI to be directly runnable via `sanepi`. This cannot be implemented through the extension system because shell command exposure is controlled by the package `bin` map, not runtime extension hooks.
- What changed: Added a second CLI bin alias, `sanepi`, pointing at the existing `dist/cli.js` entrypoint alongside `pi`.
- Merge-conflict risk: low. The only expected conflict zone is the `bin` field in `packages/coding-agent/package.json` if upstream changes CLI entrypoint names or packaging layout.

## 2026-04-09 — fix stale coding-agent baseline test expectations

- Changed:
  - `packages/coding-agent/test/resource-loader.test.ts`
  - `packages/coding-agent/test/suite/agent-system/integration.test.ts`
  - `packages/coding-agent/test/suite/agent-system/permission-enforcement.test.ts`
- Why: upstream and prior fork work changed the builtin extension set, removed `SYSTEM.md` / `APPEND_SYSTEM.md` discovery, and split tool-call permission blocking from `agent-system` into `permission-system`. The pre-existing tests were asserting the old behavior and kept the coding-agent Vitest suite red.
- What changed:
  - Updated `resource-loader.test.ts` to account for the current builtin extension identifiers, builtin `/tui` command presence, always-loaded builtin extensions during command-collision scenarios, and the intentional absence of `SYSTEM.md` / `APPEND_SYSTEM.md` loading.
  - Updated `agent-system/integration.test.ts` to assert that `agent-system` no longer blocks denied tool calls directly.
  - Updated `agent-system/permission-enforcement.test.ts` to exercise the current `permission-system` extension behavior for deny, allow, ask-without-UI, and `Allow always` flows.
- Why the extension system could not handle this: these failures were stale assertions in test files. No runtime extension could correct incorrect test expectations without changing the tests themselves.
- Merge-conflict risk: medium. The likely conflict zones are the affected assertion blocks in those three test files if upstream changes resource loading, builtin registration, or permission-system behavior again.

## 2026-04-12 — emit a callable `senpi` artifact from the standard build

- Changed:
  - `packages/coding-agent/package.json`
  - `package.json`
  - `scripts/create-root-senpi-wrapper.mjs`
- Why: The user wants root-level `npm run build` to be sufficient in the same practical sense that `sanepi` was: after building, there should be a directly callable `senpi` command, not just an internal package artifact. A plain copied file in root `dist/` was not enough for `which senpi`; the build also needed to refresh a PATH-visible shim.
- What changed:
  - Updated the coding-agent `build` script to emit `dist/senpi` alongside `dist/cli.js`.
  - Updated the root `build` script to generate a root `dist/senpi` wrapper that delegates to `packages/coding-agent/dist/cli.js`.
  - Added a small build helper at `scripts/create-root-senpi-wrapper.mjs` to write that root wrapper.
  - Updated the root build helper to also write a small `senpi` shim into npm's global `bin/` directory, so `which senpi` resolves after a successful root build.
- Why the extension system could not handle this: root build orchestration, emitted files, and PATH-visible shim installation are packaging concerns controlled by package scripts, not runtime extensions.
- Merge-conflict risk: low to medium. The likely conflict zones are the root `scripts.build` line, the coding-agent `scripts.build` line, the build helper script, and this fork note if upstream changes packaging flow or build helpers.

## 2026-04-17 — drop external `uuid` dep by inlining UUIDv7 generation

- Changed:
  - `packages/coding-agent/src/core/session-manager.ts`
  - `packages/coding-agent/package.json`
- Why: Upstream (commit 018b40c3) switched session id generation to `uuidv7()` from the `uuid` npm package and added `"uuid": "^11.1.0"` to `dependencies`. Downstream consumers of `@code-yeongyu/senpi` (including Sionic Storm's carrier-ordersheet tooling) were hitting runtime failures in `subscription-control.test.ts` and `headless-runtime.test.ts` because `dist/core/session-manager.js` could not resolve `"uuid"` when the consumer's install did not hoist the transitive dep. This bricks any consumer that bundles only the built `dist/` tree or uses a package-lock that predates the `uuid` addition.
- What changed:
  - Replaced the `import { v7 as uuidv7 } from "uuid"` call with a ~15-line inline UUIDv7 generator built on Node's stock `crypto.randomBytes`. Format conforms to RFC 9562 (version nibble `0x7`, variant bits `10`), preserves millisecond-granularity time ordering (still honors the original intent from upstream #3018: session id routing affinity), and uses no external packages.
  - Removed `"uuid": "^11.1.0"` from `dependencies`, eliminating the transitive requirement entirely.
- Why the extension system could not handle this: session id generation runs inside core `SessionManager` before any extension context exists. Extensions cannot patch an `import` in `dist/`, and consumers hit the failure before any extension hook fires.
- Merge-conflict risk: medium. The expected conflict zones are `packages/coding-agent/src/core/session-manager.ts` lines ~1-45 (imports + inline `uuidv7` helper) and `packages/coding-agent/package.json` `dependencies` block if upstream changes the `uuid` version or adds a different session id generator. On the next upstream sync, the resolution is: keep this fork's inline implementation; do NOT re-add `"uuid"` to dependencies.

## 2026-04-17 — make monorepo build cleanly under npm, bun, and pnpm (consolidated)

- Changed:
  - `package.json` (root)
  - `packages/agent/package.json`
  - `packages/ai/package.json`
  - `packages/coding-agent/package.json`
  - `packages/web-ui/package.json`
  - `pnpm-workspace.yaml` (new)
  - `scripts/build-all.mjs` (new)
  - `scripts/run-web-ui-check.mjs` (new)
  - `.npmrc` temporarily added then removed in favor of `pnpm-workspace.yaml` camelCase keys
- Why: The original layout relied exclusively on npm's flat/hoisted install to satisfy cross-workspace transitive imports, and the root `build` / `check` scripts hardcoded `npm run X` while cd-ing through packages. That meant:
  - bun and pnpm both refused to install because several workspaces imported modules they did not declare as direct deps, and the root `package.json` still carried a stale `"@code-yeongyu/senpi": "^0.30.2"` dependency from the rename from `@mariozechner/pi-coding-agent`.
  - Under pnpm/bun, every nested `npm run X` inside a root build spewed `npm warn Unknown env config ...` for each pnpm-only `npm_config_*` env var (`node_linker`, `link_workspace_packages`, etc.) that pnpm/bun exposed to child processes.
  - bun's default install blocked postinstalls for native addons (`@parcel/watcher`, `koffi`, `protobufjs`), and pnpm 10 blocked the same plus `canvas` and `esbuild`, printing approval prompts on every install.
- What changed:
  - Root `package.json`: removed orphaned `"@code-yeongyu/senpi": "^0.30.2"` from `dependencies` (forcing bun to 404 against the public npm registry before workspace resolution ever ran). Replaced the hardcoded `"build": "cd packages/tui && npm run build && ..."` with `"build": "node scripts/build-all.mjs"`, and replaced `"check": "... && npm run check:browser-smoke && cd packages/web-ui && npm run check"` with a `node`-based invocation plus `node scripts/run-web-ui-check.mjs`. Added `trustedDependencies` (for bun) and `pnpm.onlyBuiltDependencies` (for pnpm) to preapprove the postinstall scripts bun and pnpm would otherwise block.
  - Added missing direct dependencies that are used in `src/`:
    - `packages/agent/package.json`: `@sinclair/typebox` (used in `src/types.ts`).
    - `packages/ai/package.json`: `@smithy/node-http-handler`, `@smithy/types` (used in `src/providers/amazon-bedrock.ts`), and `yaml` (used in `src/tool-call-middleware/protocols/yaml-xml.ts`, which is a fork-only file). Also replaced the nested `"build": "npm run generate-models && tsgo ..."` with `"prebuild": "tsx scripts/generate-models.ts"` + `"build": "tsgo -p tsconfig.build.json"` so the parent PM — not an npm subprocess — runs the pre hook.
    - `packages/coding-agent/package.json`: `@sinclair/typebox` (used throughout `src/core/tools/*`). Split the asset-copy step out of `build` into a `postbuild` hook and removed the redundant `copy-assets` script (it was unused after the split). Collapsed `build:binary` down to a bun-only sequence and removed its `npm --prefix` recursion so it runs without npm warnings when the user is on bun.
    - `packages/web-ui/package.json`: `@mariozechner/pi-agent-core`, `@sinclair/typebox`, `highlight.js` (used in the artifact renderers), and `tailwindcss` as a devDep (pulled in transitively by `@tailwindcss/cli` under npm hoisting, invisible under bun/pnpm isolation).
  - Added `pnpm-workspace.yaml` with the exact workspace list plus pnpm 10 camelCase behavior keys: `nodeLinker: hoisted` (mirrors npm's flat install so transitive imports keep resolving across workspaces without a broader direct-dep audit), `linkWorkspacePackages: deep` + `preferWorkspacePackages: true` (pnpm 10 otherwise tries to fetch `@code-yeongyu/senpi` from the public npm registry), and `onlyBuiltDependencies` (pre-approves the five native-addon postinstalls pnpm would otherwise skip). Keeping the pnpm config in `pnpm-workspace.yaml` instead of `.npmrc` avoids leaking pnpm-only keys into npm as env vars that npm then warns about.
  - Added `scripts/build-all.mjs`: PM-agnostic orchestrator that detects the parent package manager via `$npm_execpath` / `$npm_config_user_agent`, strips the known pnpm-only `npm_config_*` env keys before spawning children, and runs `<pm> run build` in each workspace in dependency order. The companion `scripts/run-web-ui-check.mjs` does the same for `packages/web-ui`'s `check`.
- Why the extension system could not handle this: package-manager compatibility, install layout, root build orchestration, and postinstall approval lists are all controlled by package/workspace config files and spawn-time env, none of which a runtime extension can intercept.
- Merge-conflict risk: low to medium per file. Expected conflict zones are the `dependencies`/`scripts` blocks of the five modified `package.json` files, the new settings and `packages` list in `pnpm-workspace.yaml`, and the orchestrator scripts. On the next upstream sync: (1) keep the fork's `scripts/build-all.mjs` and `scripts/run-web-ui-check.mjs`; (2) keep the `trustedDependencies` / `pnpm.onlyBuiltDependencies` entries in root `package.json`; (3) merge additional workspace packages upstream adds into `pnpm-workspace.yaml`; (4) keep the added direct deps in the five package.json files unless upstream inlines equivalent deps.
