# AgentHarness lifecycle

`AgentHarness` is the orchestration layer above the low-level agent loop. It owns session persistence, runtime configuration, resource resolution, operation locking, and extension-facing mutation semantics.

This document describes the current direction and implemented behavior. Some extension/session-facade details are planned and called out explicitly.

## Ultimate lifecycle goal

Harness listeners and hooks should be able to close over the `AgentHarness` instance and call public harness APIs from any event where those APIs are documented as allowed. Those calls must not corrupt in-flight turn snapshots, reorder persisted transcript entries, lose pending writes, deadlock settlement, or leave the harness in the wrong phase.

The intended rule is:

- structural operations remain rejected while busy
- queue operations are accepted at documented turn-safe points
- runtime config setters update future snapshots without mutating the current provider request
- session writes made while busy are durably queued and flushed in deterministic order
- getters return latest harness config, not in-flight snapshots
- listeners/hooks currently receive no facade; if they close over the raw harness and call settlement APIs such as `waitForIdle()` during the active run, they can deadlock. A future facade should expose `runWhenIdle()` instead.

A final lifecycle hardening pass should prove these guarantees with a broad listener/hook reentrancy test suite.

## Error handling

The target error-handling model is `Result<TValue, TError>` for fallible harness operations instead of thrown exceptions. Implementations should catch backend/provider/filesystem exceptions at the boundary and normalize them into typed error results; callers should inspect returned results instead of relying on thrown exceptions.

This is currently implemented for `ExecutionEnv`, `NodeExecutionEnv`, shell-output capture, and skill/prompt-template resource loading. Older harness/session/compaction APIs still throw in several paths; finishing that migration is tracked in the cleanup todo.

## State model

The harness separates state into four categories.

### Harness config

Harness config is the latest runtime configuration set by the application or extensions:

- model
- thinking level
- tools
- active tool names
- resources
- stream options
- system prompt or system prompt provider

Getters return harness config. They do not return the snapshot used by an in-flight provider request.

Setters update harness config immediately, including while a turn is in flight. Changes affect the next turn snapshot, not the currently running provider request.

`setResources()` accepts concrete resources and emits `resources_update` on every call with shallow-copied current and previous resources. Applications own loading/reloading resources from disk or other sources and should call `setResources()` with new values.

`getResources()` returns shallow-copied current resources. It is a live config read, not the last turn snapshot.

### Turn snapshot

A turn snapshot is the concrete state used for one LLM turn. It is created by `createTurnState()` and contains:

- persisted session messages
- resolved resources
- resolved system prompt
- model
- thinking level
- all tools
- active tools
- stream options
- derived session id

Static option values are used directly. System-prompt provider callbacks are invoked once per `createTurnState()` call. All logic for that turn uses the same snapshot.

Resource arrays are shallow-copied when a snapshot is created. Individual skill and prompt-template objects are not deep-copied.

Stream options are shallow-copied when a snapshot is created. `headers` and `metadata` maps are shallow-copied; their values are not deep-copied. Credentials from `getApiKeyAndHeaders()` are resolved per provider request so expiring tokens can refresh, but the configured stream options and derived session id come from the current turn snapshot.

### Session

The session contains persisted entries only. Session reads return persisted state and do not include queued writes.

### Pending session writes

Session writes requested while an operation is active are queued as pending session writes. Pending writes are based on session-entry shapes without generated fields (`id`, `parentId`, `timestamp`).

Pending session writes are always persisted. They are flushed at save points, at operation settlement, and in failure cleanup.

A public pending-writes/session-facade API is planned but not implemented yet.

## Operation phases

The harness has an explicit phase:

```ts
type AgentHarnessPhase = "idle" | "turn" | "compaction" | "branch_summary" | "retry";
```

Structural operations require `phase === "idle"` and synchronously set the phase before the first `await`:

- `prompt`
- `skill`
- `promptFromTemplate`
- `compact`
- `navigateTree`

Starting another structural operation while the harness is not idle currently throws. This should become a typed result failure as part of the error-handling cleanup.

The following operations are allowed during a turn where appropriate:

- `steer`
- `followUp`
- `nextTurn`
- `abort`
- runtime config setters

Phase/settlement semantics are still provisional and need a full lifecycle pass.

## Turn execution

`prompt`, `skill`, and `promptFromTemplate` follow the same flow:

1. Assert idle and set phase to `"turn"`.
2. Create a turn snapshot with `createTurnState()`.
3. Derive invocation text from that snapshot.
4. Execute the turn with `executeTurn()`.

`skill` and `promptFromTemplate` resolve their resource from the same snapshot that is passed to the turn. They do not resolve resources separately.

`steer`, `followUp`, and `nextTurn` accept text plus optional images and create user messages internally. `nextTurn` messages are inserted before the new user message on the next user-initiated turn.

Queue modes are live, not turn-snapshotted:

- `getSteeringMode()` / `setSteeringMode()`
- `getFollowUpMode()` / `setFollowUpMode()`

Changing a queue mode during a run affects the next queue drain. Queue drains happen at safe points.

## Save points

A save point occurs after an assistant turn and its tool-result messages have completed.

At a save point the harness:

1. flushes pending session writes after the agent-emitted messages for that turn
2. creates a fresh turn snapshot if the low-level loop may continue
3. applies the fresh context/model/thinking-level/stream-options/session-id state before the next provider request

This lets model, thinking level, tool, resource, stream option, and system prompt changes made during a turn affect the next turn in the same run, while never mutating an in-flight provider request. The loop callbacks are not recreated at save points.

The low-level loop converts harness `ThinkingLevel` to provider `reasoning` at the provider boundary:

- `"off"` -> `undefined`
- all other thinking levels pass through

No state refresh is needed on `agent_end` except flushing leftover pending session writes and clearing the operation phase. The exact `settled` event timing is still under review.

If the system-prompt callback throws while starting `prompt`, `skill`, or `promptFromTemplate`, the operation currently throws and the harness returns to idle. This should become a typed result failure as part of the error-handling cleanup. If it throws from the save-point snapshot created by `prepareNextTurn`, the low-level agent run records an assistant error message.

## Hooks and events

Current hooks and listeners receive only the event payload. There is no extension context object yet.

Event payloads describe what is happening. Harness getters describe latest config for future snapshots.

The split between harness-specific events (`AgentHarnessOwnEvent`) and the union of low-level plus harness events (`AgentHarnessEvent`) is provisional but useful for distinguishing hookable harness events from public subscription events.

A future extension context should expose a harness facade plus a queued-write session facade. The facade must not expose APIs that can deadlock the current event dispatch. In particular, listeners/hooks should not call `waitForIdle()` for the active run; expose a `runWhenIdle(() => Promise<void>)` scheduling API instead. This is future extension-context work; current listeners/hooks receive only payloads and no safe harness facade.

## Planned session facade

Extensions should eventually interact with a harness-scoped `HarnessSession` facade rather than the raw session. The facade should wrap the internal session and enforce harness pending-write ordering semantics. Once this exists, hooks and event listeners can receive a context that exposes the full `AgentHarness` plus the session facade without giving direct access to unordered raw session writes.

Planned read semantics:

- reads delegate to persisted session state
- reads do not include queued pending writes

Planned write semantics:

- idle: persist immediately
- busy: enqueue as pending session writes

A planned diagnostics API may expose pending writes explicitly:

```ts
getPendingWrites(): readonly PendingSessionWrite[]
```

Agent-emitted messages are persisted on `message_end` to preserve transcript ordering. Pending extension/session writes flush after those messages at save points.

## Abort

Abort is allowed during a turn. It aborts the low-level run and clears steering/follow-up queues.

Abort does not clear `nextTurn` messages. Messages queued with `nextTurn()` survive abort and are inserted before the user message on the next user-initiated turn.

Abort does not discard pending session writes. Pending writes flush at the next save point if reached, at `agent_end`, or in operation failure cleanup.

Abort barrier semantics still need an audit.

## Compaction and tree navigation

Compaction and tree navigation are structural session mutations.

They are allowed only while idle and are not queued. They operate on persisted session state. The next prompt creates a fresh turn snapshot.

Branch summary generation is part of the tree navigation operation.

Auto-compaction and retry decision points are not implemented in `AgentHarness` yet.

## Test organization

Harness tests should stay focused by area instead of growing one large catch-all file.

Current structure:

- `packages/agent/test/harness/agent-harness.test.ts`: core lifecycle and public API behavior.
- `packages/agent/test/harness/agent-harness-stream.test.ts`: stream options and provider hook semantics.

Preferred future structure:

- `agent-harness-resources.test.ts`: resource snapshot/loading semantics.
- `agent-harness-tools.test.ts`: tool registry getters, active-tool semantics, and update events.
- `agent-harness-lifecycle.test.ts`: phase/save-point/settled/reentrancy behavior.

Use the `pi-ai` faux provider (`registerFauxProvider`, `fauxAssistantMessage`) for deterministic harness/provider tests. Faux response factories can inspect `StreamOptions`, invoke `options.onPayload`, and return scripted assistant messages without real provider APIs or network access.

Harness coverage is configured separately from the default package test run:

```bash
npm run test:harness
npm run coverage:harness
```

`coverage:harness` runs `test/harness/**/*.test.ts` and reports coverage for `src/harness/**/*.ts` plus the non-harness runtime files it directly exercises (`src/agent.ts` and `src/agent-loop.ts`) into `coverage/harness`. Type-only dependencies such as `src/types.ts` are not included because they have no meaningful runtime coverage.

## Implementation todo

This list tracks the remaining work before treating `AgentHarness` as migration-ready.

### 1. Remove `Agent` dependency from `AgentHarness`

Implemented.

`AgentHarness` now calls `runAgentLoop()` directly instead of owning an internal `Agent` instance. The harness owns active run/abort-controller lifecycle, queue draining, provider stream configuration, event reduction, session persistence, pending write flushing, and save-point snapshot refresh.

Implemented validation:

- prompt construction and public runtime config getters/mutators
- steering queue draining and `queue_update` emission
- follow-up queue draining and `queue_update` emission
- `before_agent_start` message ordering and persistence
- abort clearing steer/follow-up queues while preserving `nextTurn` messages
- thrown hook failure cleanup with persisted assistant error messages and settlement
- save-point refresh for model, thinking level, resources, system prompt, and active tools
- pending listener session write ordering after agent-emitted messages
- external `waitForIdle()` waiting for awaited listeners and run settlement
- `tool_call` and `tool_result` hook behavior through the direct loop
- provider stream wrapper behavior in `agent-harness-stream.test.ts`

Remaining lifecycle hardening beyond this refactor is tracked in the final lifecycle hardening suite.

### 2. Finish curated provider/stream configuration

Implemented so far:

- `AgentHarnessOptions.streamOptions` provides curated request configuration.
- `getStreamOptions()` returns a shallow copy of current harness config.
- `setStreamOptions()` replaces current harness config.
- Stream options are snapshotted in `createTurnState()` and applied with `applyTurnState()`.
- `headers` and `metadata` maps are shallow-copied when stream options are copied.
- `sessionId` is derived from `session.getMetadata().id` in the turn snapshot.
- The harness installs its own internal stream wrapper and calls `streamSimple()`.
- The wrapper ignores raw incoming provider options except lifecycle-owned fields that must come from the low-level loop: `signal` and `reasoning`.
- Credentials and auth headers from `getApiKeyAndHeaders()` are resolved per provider request.

Implemented provider hook behavior:

- `before_provider_request` runs before `streamSimple()` and can patch curated stream options for the current request only.
- `before_provider_payload` maps to the underlying `pi-ai` `onPayload` and can inspect/replace provider-specific payloads.
- `after_provider_response` maps to the underlying `pi-ai` `onResponse` and observes response status/headers before body consumption.
- `AgentHarnessStreamOptionsPatch` has explicit deletion semantics:
  - top-level fields present with `undefined` clear that option.
  - `headers` and `metadata` patches may set individual keys to `undefined` to delete them.
  - `headers: undefined` or `metadata: undefined`, when explicitly present, clears the whole map.
- Current-request stream option merge order is:
  1. snapshotted `streamOptions`
  2. auth headers from `getApiKeyAndHeaders()`
  3. `before_provider_request` patches, in hook registration order
- `before_provider_request` does not patch `reasoning`; add that only if a concrete use case appears.

Implemented validation:

- `packages/agent/test/harness/agent-harness-stream.test.ts` uses the `pi-ai` faux provider.
- Tests cover stream option forwarding, auth header merge, request hook patching, request hook deletion semantics, request hook chaining, payload hook chaining, and busy/save-point snapshot behavior.

### 3. Design per-`AgentHarness` model registry

Not started.

Still needed:

- Decide how applications supply the model registry.
- Decide whether the harness stores concrete `Model` objects, model references, or both.
- Validate model selection against the registry.
- Define model change semantics during active turns and save points.
- Preserve current `setModel()` behavior until the registry model is designed.

### 4. Design generic hook/event extension mechanism

Current cleanup already done:

- Removed `AgentHarnessContext`.
- Hooks receive only event payloads.
- `emitHook(event)` derives the hook type from `event.type`.

Still needed:

- Define extension/listener context shape.
- Expose a harness facade plus a session facade rather than raw internals.
- The harness facade should expose safe runtime APIs and `runWhenIdle(() => Promise<void>)`; it should not expose active-run `waitForIdle()` to listeners/hooks.
- The session facade should wrap the internal session and participate in pending session write queue semantics so writes remain ordered with agent-emitted messages.
- Decide which public harness APIs are allowed from each hook/event.
- Decide whether hooks can mutate turn snapshots directly or only through explicit hook results/public APIs.
- Clarify event payload semantics versus harness getter semantics.
- Revisit `AgentHarnessOwnEvent` versus `AgentHarnessEvent`.
- Define hook result chaining where it has clean transform semantics:
  - `before_provider_request`: each hook receives the stream options produced by previous hooks.
  - `before_provider_payload`: each hook receives the payload produced by previous hooks.
  - possibly `context`: each hook receives the messages produced by previous hooks.
  - possibly `tool_result`: each hook receives the result fields produced by previous hooks.
- Do not chain hooks where semantics are policy-based or ambiguous until explicitly designed, such as `tool_call`, `session_before_compact`, `session_before_tree`, and `before_agent_start`.

### 5. Add explicit tool registry read/update semantics

Implemented so far:

- `setTools(tools, activeToolNames?)`
- `setActiveTools(toolNames)`
- invalid active tool names currently throw; convert to result errors
- generic common app tool shape via `AgentHarness<TSkill, TPromptTemplate, TTool>`
- `QueueMode` exported from core types
- `AgentHarnessOptions.steeringMode` / `followUpMode`
- live `getSteeringMode()` / `setSteeringMode()` and `getFollowUpMode()` / `setFollowUpMode()` methods
- queue modes are immediate/live, matching coding-agent behavior

Still needed:

- Add `getTools()` semantics.
- Add `getActiveTools()` semantics.
- Decide and implement tool update observability events.
- Include active-tool-only updates in the uniform runtime config observability plan.

### 6. Full `AgentHarness` lifecycle/state pass

Implemented so far:

- Removed constructor `void syncFromTree()`.
- Removed `syncFromTree()`.
- Added `createTurnState()`, `applyTurnState()`, and `executeTurn()`.
- Low-level `AgentLoopConfig.prepareNextTurn` save-point update exists.
- `prepareNextTurn` updates low-level context/model/thinking-level and harness-applied stream/session snapshot state.
- The loop converts `ThinkingLevel` to provider `reasoning` internally.
- `phase` replaces boolean idle.
- Pending session writes are based on session-entry shapes without generated fields.
- Pending session writes flush at save points, settlement, and failure cleanup.
- `steer`, `followUp`, and `nextTurn` accept text plus optional images and create `UserMessage` internally.
- `nextTurn` ordering is fixed: queued messages before the new user message.
- Removed `liveOperationId`.
- Removed `shell()`; use `harness.env`.

Still needed:

- Finalize phase/idle semantics.
- Audit whether `settled` can fire too early.
- Make session writes inside `settled` callbacks deterministic.
- Audit follow-up behavior around `agent_end`.
- Implement auto-compaction decision point.
- Implement retry handling.
- Ensure structural operations use consistent `try/finally` phase cleanup.
- Verify `before_agent_start` hook semantics against coding-agent:
  - current behavior appends returned messages after the user/next-turn prompt messages.
  - decide whether replacement, prepend, append, or transform semantics are correct.
- Decide if `before_agent_start` needs more turn info such as tools/tool snippets.
- Document or change timing for model/thinking/stream-option events that may fire before queued session entries persist while busy.
- Audit `abort()` barrier semantics.

### 7. Complete `Result`/non-throwing harness cleanup

Started.

Implemented so far:

- Added generic `Result<TValue, TError>` plus helpers.
- Updated `ExecutionEnv` and `NodeExecutionEnv` to return typed results for filesystem/process operations.
- Split filesystem/shell capabilities and moved JSONL session storage/repo onto filesystem picks instead of direct Node imports.
- Added `ExecutionEnv.appendFile()` for streaming append use cases.
- Updated skill and prompt-template loaders to consume `ExecutionEnv` results.
- Updated shell output capture to return a result and use `ExecutionEnv` instead of Node APIs directly, including full-output spill via `appendFile()`.
- Removed `NodeExecutionEnv` from browser-safe root exports; Node-specific callers use the `node` entry point or `harness/env/nodejs.js`.
- Replaced `Buffer` usage in generic truncation utilities with runtime-neutral UTF-8 handling.
- Converted compaction summary helpers to typed result returns and added error-path coverage.
- Expanded `NodeExecutionEnv` tests for file operations, exec errors, aborts, callbacks, timeouts, and shell-output full-output spill.

Still needed:

- Remove remaining throws from `src/harness` APIs and helpers, except explicit adapter/test helpers such as `getOrThrow()`.
- Convert session storage/repo/session APIs to typed result returns.
- Convert structural `AgentHarness` operations to typed result returns for busy, missing-resource, auth, compaction, and branch-summary failures.
- Keep Node-specific APIs isolated under `src/harness/env/nodejs.ts` and Node-backed storage/session implementations, or move those implementations behind explicit Node-only entry points.
- Audit remaining generic harness utilities for Node globals as new APIs are added.
- Audit package exports so browser/generic-JS imports do not pull Node-only modules such as `NodeExecutionEnv`.
- Keep expanding `ExecutionEnv` and shell-output contract tests as the API evolves, especially for non-Node implementations.
- Add tests proving harness APIs return `ok: false` instead of throwing for expected failure paths.

### 8. Later coding-agent migration plan

Not started.

Still needed:

- Map coding-agent resources to sourced loaders.
- Keep app-level resource dedupe/provenance outside the harness.
- Adapt extension loader to the future hook/session facade.
- Preserve UI/session behavior outside core.
- Move coding-agent stream/auth/retry/header behavior onto the harness stream configuration and provider hooks.

### 9. Final lifecycle hardening suite

Before treating `AgentHarness` as migration-ready, add a broad test suite that exercises listeners and hooks closing over the harness and calling public APIs during every relevant event.

Needs broad tests for:

- runtime config setters from low-level lifecycle events and harness events
- uniform runtime config observability events for model, thinking, resources, tools, active tools, and stream options
- resource/tool/model/thinking/stream-option updates during active turns and save points
- session writes from listeners and hooks, including writes from `settled`
- queue operations from turn events, tool events, and provider hooks
- rejected structural operations while busy
- abort from listeners/hooks
- getter behavior during active operations
- deterministic ordering of agent-emitted messages and pending listener writes
- no deadlocks when async listeners call harness APIs and await them
- phase cleanup through success, provider error, hook error, abort, compaction, and tree navigation
