# senpi-desktop-service fork changes

## 2026-09-27 - Scripted input refusals in the fake engine (senpi#2128)

### What changed

- `packages/desktop-service/test/fake-desktop.mjs`: `FAKE_ENGINE_INPUT_ERROR=<code>` makes every input method fail with that engine error and its real rpc code, the way the input gate refuses (Suspended, StopPathUnavailable, PermissionDenied, ScreenLocked).

### Why

- The computer_actions enforcement tests need the engine's refusals on the wire.

### Why an extension could not handle it

- Test fixture of this package.

### Expected merge conflict zones

- None.

## 2026-09-27 - A computer run that returns without awaiting the host settles (senpi#2128)

### What changed

- `packages/desktop-service/src/run/runtime.ts`: after the first evaluation, the run schedules one `resumeVm` drain. The vm context uses `microtaskMode: "afterEvaluate"`, so the host's subscription to the run's promise sits on the vm's own queue, which only a later `runInContext` drains. A run that awaited no host call never got that drain and hung until its timeout.
- `packages/desktop-service/test/run.test.ts`: `settles a run that returns without awaiting any host call` covers an immediate return, an early return before any host call, and a vm-only await.

### Why

- A run whose code path returns before touching the desktop, such as an input refused by a pre-check, timed out instead of returning its value (found by the computer_actions adapter, plan todo 45).

### Why an extension could not handle it

- The run runtime is this package's code.

### Expected merge conflict zones

- None: a fork-only package.

## 2026-09-25 - computer.run runtime and desktop facade over the engine client (senpi#2128)

### What changed

- `packages/desktop-service/src/run/`: `runComputerCode` runs model code in a `node:vm` context inside the coding-agent process (`microtaskMode: "afterEvaluate"`, each synchronous stretch bounded by the run budget, the vm resumed from `setImmediate` after each host promise settles). Its globals are the `desktop` facade (root, window handles, element handles), `wait`, `assert`, `console`, and `tool.*`, which is bridged to an injected `executeTool`. The runtime also enforces the read-only guard from the `-protocol` tier tables, displays inline and artifact-only captures, and collects the run's audit events.
- `packages/desktop-service/src/service/parse.ts`: exports its shape helpers so the run layer parses engine results with them.

### Why

- Todo 20 of the computer-use plan: `computer.run` and direct `call` chains need a runtime over the engine client. AD-9 replaced oh-my-pi's Bun worker with an in-process `node:vm` context.

### Why an extension could not handle it

- This package is fork-only. It is the runtime the computer-use extension is built on.

### Expected merge conflict zones

- None in this package: it does not exist upstream.

## 2026-09-24 - DesktopService JSON-RPC client over the engine child (senpi#2128)

### What changed

- `packages/desktop-service/src/service/`: `DesktopService` runs one lazy `senpi-desktop-engine --stdio` child. It checks the ABI in `engine.hello`, keeps the `session.open` resume token private, multiplexes requests by id, sends `$/cancel` on abort or timeout, and kills and respawns the child after a 750 ms grace. It heartbeats `stopPath.heartbeat` every 500 ms and fans out `audit` and `stopPath.changed` notifications.
- `packages/desktop-service/package.json`: depends on `-engine` (locator, ABI error) and `-protocol` (wire types).

### Why

- Todo 19 of the computer-use plan: the host needs one client over the engine's stdio JSON-RPC before the `computer.run` runtime (todo 20) and the tool (todo 24) can call the engine.

### Why an extension could not handle it

- This package is fork-only. The client is the transport the computer-use extension itself is built on.

### Expected merge conflict zones

- None in this package: it does not exist upstream.

## 2026-09-24 - Desktop package wired into the workspace (senpi#2128)

### What changed

- `packages/desktop-service/`: skeleton package (empty entry plus one placeholder test) wired into the workspace, the build phases, the entry-graph budgets, and the bundled-workspace staging. Todos 19-20 fill it.

### Why

- Desktop computer use (senpi#2128) ships as five flat TS packages. Every enumerating script has to know about all five before any of them gains behavior, or publish staging breaks.

### Why an extension could not handle it

- This package is fork-only. The wiring lives in root build and publish scripts that run before any extension loads.

### Expected merge conflict zones

- None in this package: it does not exist upstream.
