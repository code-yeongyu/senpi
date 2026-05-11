# AgentHarness lifecycle

`AgentHarness` is the orchestration layer above the low-level `Agent`. It owns session persistence, runtime configuration, resource resolution, operation locking, and extension-facing mutation semantics.

This document describes the current direction and implemented behavior. Some extension/session-facade details are planned and called out explicitly.

## Ultimate lifecycle goal

Harness listeners and hooks should be able to close over the `AgentHarness` instance and call public harness APIs from any event where those APIs are documented as allowed. Those calls must not corrupt in-flight turn snapshots, reorder persisted transcript entries, lose pending writes, deadlock settlement, or leave the harness in the wrong phase.

The intended rule is:

- structural operations remain rejected while busy
- queue operations are accepted at documented turn-safe points
- runtime config setters update future snapshots without mutating the current provider request
- session writes made while busy are durably queued and flushed in deterministic order
- getters return latest harness config, not in-flight snapshots

A final lifecycle hardening pass should prove these guarantees with a broad listener/hook reentrancy test suite.

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

Starting another structural operation while the harness is not idle throws.

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

- `steeringMode`
- `followUpMode`

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

If the system-prompt callback throws while starting `prompt`, `skill`, or `promptFromTemplate`, the operation throws and the harness returns to idle. If it throws from the save-point snapshot created by `prepareNextTurn`, the low-level agent run records an assistant error message.

## Hooks and events

Current hooks receive only the event payload. There is no extension context object yet.

Event payloads describe what is happening. Harness getters describe latest config for future snapshots.

The split between harness-specific events (`AgentHarnessOwnEvent`) and the union of low-level plus harness events (`AgentHarnessEvent`) is provisional but useful for distinguishing hookable harness events from public subscription events.

A future extension context may expose the harness and a queued-write session facade.

## Planned session facade

Extensions should eventually interact with a harness-scoped session facade rather than the raw session.

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

Abort is allowed during a turn. It aborts the low-level run and clears low-level steering/follow-up queues.

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

- `packages/agent/test/harness/agent-harness.test.ts`: basic construction/API smoke tests.
- `packages/agent/test/harness/agent-harness-stream.test.ts`: stream options and provider hook semantics.

Preferred future structure:

- `agent-harness-resources.test.ts`: resource snapshot/loading semantics.
- `agent-harness-tools.test.ts`: tool registry getters, active-tool semantics, and update events.
- `agent-harness-lifecycle.test.ts`: phase/save-point/settled/reentrancy behavior.

Use the `pi-ai` faux provider (`registerFauxProvider`, `fauxAssistantMessage`) for deterministic harness/provider tests. Faux response factories can inspect `StreamOptions`, invoke `options.onPayload`, and return scripted assistant messages without real provider APIs or network access.

## Implementation todo

This list tracks the remaining work before treating `AgentHarness` as migration-ready.

### 1. Remove `Agent` dependency from `AgentHarness`

New top priority.

`AgentHarness` should likely call `agentLoop` / `agentLoopContinue` directly instead of owning an internal `Agent` instance. The harness already owns session persistence, runtime config snapshots, queues, provider stream configuration, hooks/events, phase semantics, and abort semantics. Keeping `Agent` in the middle creates duplicated state and adapter seams.

Still needed:

- Replace internal `new Agent(...)` with direct low-level loop calls.
- Move active run/abort-controller lifecycle into `AgentHarness`.
- Move queue draining into `AgentHarness` only, removing duplicated low-level `Agent` queues.
- Reduce low-level `AgentEvent` state directly in the harness where needed.
- Preserve current public behavior for `prompt`, `skill`, `promptFromTemplate`, `steer`, `followUp`, `nextTurn`, `abort`, and `waitForIdle`.
- Preserve provider hook behavior implemented by the harness stream wrapper.
- Preserve save-point snapshot refresh semantics without side-effecting through `Agent.prepareNextTurn`.
- Decide whether `AgentHarness.agent` remains temporarily for compatibility or is removed before migration.
- Add tests covering parity with the current harness behavior before and after the refactor.

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

- Define extension context shape.
- Likely expose a harness facade plus a session facade rather than raw internals.
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
- invalid active tool names throw
- generic common app tool shape via `AgentHarness<TSkill, TPromptTemplate, TTool>`
- `QueueMode` exported from `Agent`
- `AgentHarnessOptions.steeringMode` / `followUpMode`
- live `steeringMode` / `followUpMode` getters/setters
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
  - current behavior prepends returned messages.
  - decide whether replacement, prepend, append, or transform semantics are correct.
- Decide if `before_agent_start` needs more turn info such as tools/tool snippets.
- Document or change timing for model/thinking/stream-option events that may fire before queued session entries persist while busy.
- Audit `abort()` barrier semantics.

### 7. Later coding-agent migration plan

Not started.

Still needed:

- Map coding-agent resources to sourced loaders.
- Keep app-level resource dedupe/provenance outside the harness.
- Adapt extension loader to the future hook/session facade.
- Preserve UI/session behavior outside core.
- Move coding-agent stream/auth/retry/header behavior onto the harness stream configuration and provider hooks.

### 8. Final lifecycle hardening suite

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
