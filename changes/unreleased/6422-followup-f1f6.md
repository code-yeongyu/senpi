<!-- changes-log: packages/ai/src/changes.md -->
## 2026-11-13 - Provider strict mode: undefined and null read as on (omo#12965)

### What changed

- `packages/ai/src/api-registry.ts`, `packages/ai/src/images-api-registry.ts`: when the realm's provider-scope instance holds a strict mode that is not exactly `false` (including `undefined` and `null`), strict mode is on. It read as off for those two values.

### Why

- Design 3.1 reads every strict-mode value that is not a boolean as on; two values took the looser branch. No current copy produces them.

### Why an extension could not handle it

- These are the engine's own readers of state shared between engine copies; an extension cannot change how the engine reads it.

### Expected merge conflict zones

- LOW: the strict-mode line in `getActiveProviderScope` and `getActiveImagesProviderScope`.

<!-- changes-log: packages/coding-agent/src/core/changes.md -->
## 2026-11-13 - Fail-closed readers of cross-copy state; decision-record condition (omo#12965)

### What changed

- `packages/coding-agent/src/core/turn-origin.ts`: a record-scope answer that is not exactly `false` reads as delegated (`recordIsDelegated`, `noteRunStart`). It read as not delegated.
- `packages/coding-agent/src/core/session-write-reservation.ts`: `hasOtherLive` counts a registered owner that lacks `isPersisted` or `getSessionFile` as another live writer. It was skipped.
- `packages/coding-agent/src/core/kill-guard/runtime.ts`: a copy with no holder of its own that finds an unreadable active record still builds no guard variables, and now emits one process warning per copy (`PI_KILL_GUARD_RECORD_UNREADABLE`).
- `packages/coding-agent/src/core/permission-decision.ts`: documents the condition the decision record rests on: a session's runtime and the session come from one engine copy.

### Why

- Design 3.1 picks the stricter branch for a value a reader cannot read. No current copy produces these values, so no arrangement that works today changes.

### Why an extension could not handle it

- These are the engine's own readers of state shared between engine copies; an extension cannot change how the engine reads it.

### Expected merge conflict zones

- LOW: `recordScope` readers in `turn-origin.ts`; `hasOtherLive` in `session-write-reservation.ts`.

<!-- changes-log: packages/coding-agent/src/core/extensions/changes.md -->
## 2026-11-13 - An unreadable kernel-tool invoker is refused (omo#12965)

### What changed

- `packages/coding-agent/src/core/extensions/kernel-tools-context.ts`: `activeKernelToolInvoker()` throws an error with `code: "PI_KERNEL_TOOL_INVOKER_UNREADABLE"` when an invoker was entered but has no string `sessionId`. It read as no invoker, and the runner then stamped its own session on a cross-session call.

### Why

- Once a kernel enforces cross-session permissions, an invoker identity this copy cannot read must refuse, not become the runner's own session. Nothing entered still reads as none.

### Why an extension could not handle it

- These are the engine's own readers of state shared between engine copies; an extension cannot change how the engine reads it.

### Expected merge conflict zones

- LOW: `activeKernelToolInvoker`, read only by `runner.ts`.

<!-- changes-log: scripts/changes.md -->
## 2026-11-13 - Realm census: structural class rule, vendored directories, corrected reasons (omo#12965)

### What changed

- `scripts/check-realm-census.mjs`, `scripts/realm-census-population.mjs`, `scripts/realm-census-initializers.mjs`: a binding initialised by `realmRegistry(` must be classed `realm-registry`, and a `realm-registry` entry must sit in a file that creates one.
- `scripts/realm-census-source.mjs`: vendored directories are in the population (four bindings classified); only generated `gen` and `_generated` directories are skipped.
- `scripts/realm-census.json`: the session holder, terminal manifest lease, schedule delivery and console redactor reasons state the real condition (a session is served by one engine copy; the console wrapper reads one copy's sealed context); three file-touching template reasons are specific.

### Why

- The census claimed more than it enforced: a class change with a reason passed, and vendored code in the engine realm was invisible.

### Why an extension could not handle it

- These are the engine's own readers of state shared between engine copies; an extension cannot change how the engine reads it.

### Expected merge conflict zones

- MEDIUM: `scripts/realm-census.json`.

<!-- changes-log: packages/ai/CHANGELOG.md -->
### Fixed

- A provider strict mode of `undefined` or `null` held by the realm's provider-scope instance is strict, not off.

<!-- changes-log: packages/coding-agent/CHANGELOG.md -->
### Fixed

- An unreadable kernel-tool invoker is refused with `PI_KERNEL_TOOL_INVOKER_UNREADABLE` instead of being read as no invoker; a turn-origin answer that is not exactly `false` reads as delegated; a session writer owner another engine copy shaped differently counts as another live writer; and a kill-guard record this copy cannot read is reported once.
