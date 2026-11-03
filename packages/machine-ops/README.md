# @code-yeongyu/senpi-machine-ops

Engine-free host operation layer. senpi's built-in file and shell tools and a remote machine executor call the same
implementation of file and process operations, their limits and their permission checks.

- `createLocalMachineOps({ stateDir, holder, limits })` returns a `MachineOps` with `files`, `process` and `info`.
- Every operation takes an `OpContext`: scope root, principal, abort signal, limits, `PolicyHooks` and an audit sink.
- `PolicyHooks.beforeOp` gates an operation before any effect; `PolicyHooks.filesystem` sees the canonical target.
- `ProcessOps.exec` runs in its own process group with a scope token (`OMO_MACHINE_SCOPE`) recorded under
  `<stateDir>/machine/scopes/` before spawn; `sweep(tokens)` ends a token's members with HUP/TERM/KILL.
- `ProcessOps.spawn` goes through a `HolderLink`. This package ships an in-process link over `@earendil-works/pi-pty`
  (`@code-yeongyu/senpi-machine-ops/in-process-holder`); its terminals end with the process that created them.
- No concurrency cap: `Limits.maxPtySessions` undefined means unlimited, and execs never queue.

The package depends only on `node:*` builtins and `@earendil-works/pi-pty`.

## Conformance suite

`@code-yeongyu/senpi-machine-ops/conformance` exports `defineMachineOpsConformance(runner, target)`. Pass your test
runner's `describe`/`it` and a factory for the implementation under test; the suite asserts that it behaves like
`createLocalMachineOps`.
