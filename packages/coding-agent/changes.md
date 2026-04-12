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
- Why: The user wants root-level `npm run build` to be sufficient, and that root build already delegates to `packages/coding-agent`. The missing behavior was that the normal package build only emitted `dist/cli.js`, while the user expected a directly callable `dist/senpi` artifact like the earlier `sanepi` flow.
- What changed:
  - Updated the coding-agent `build` script to copy the shebang entrypoint from `dist/cli.js` to `dist/senpi` and mark it executable.
  - Kept the change scoped to packaging/build output, so the existing root build chain now produces the callable artifact without changing runtime logic.
- Why the extension system could not handle this: build output shape is controlled by package scripts and emitted files, not by runtime extensions.
- Merge-conflict risk: low. The only expected conflict zone is the `scripts.build` line in `packages/coding-agent/package.json` if upstream changes the coding-agent packaging flow.
