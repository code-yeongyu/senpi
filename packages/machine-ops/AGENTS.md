# packages/machine-ops

`@code-yeongyu/senpi-machine-ops`: the engine-free operation layer shared by senpi's built-in tools
(`packages/coding-agent/src/core/tools/machine.ts`) and remote machine executors.

## RULES

- Import only `node:*`, `bun:*`, `@earendil-works/pi-pty`, the zero-dependency `@earendil-works/pi-realm-registry`
  helper and this package's own files. `test/dependency-boundary.test.ts` enforces it; never import from
  `packages/agent` or `packages/coding-agent`.
- State that one engine copy writes and another reads lives behind `realmRegistry` (`files/mutation-queue.ts`), never in
  module scope: a process can hold more than one copy of this package (omo#12965).
- No concurrency cap anywhere. Ordering exists only where semantics need it: one canonical path's mutations
  (`files/mutation-queue.ts`) and one handle's input.
- Filesystem and spawn errors pass through unchanged so the tools keep their exact error text; errors the layer
  raises itself are `MachineOpError` with a code.
- Every behaviour change needs a case in `test/conformance/`, the suite other consumers run.
- Disk state and the `SENPI_MACHINE_SCOPE` child variable exist only when the caller passes a `stateDir`; senpi's tool
  path passes none and must stay free of agent-dir writes.

## VALIDATION

- `bun run --cwd packages/machine-ops test`
- Root `bun run check`
