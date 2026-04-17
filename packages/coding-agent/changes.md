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
