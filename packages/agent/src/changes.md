# Changes

## 2026-07-23 - Session-owned post-agent_end queue drain suppression

### What changed and why

- `Agent` now exposes `suppressQueuedMessageDrain()` for the active run. It stops only the lifecycle-owned
  post-`agent_end` steering/follow-up drain, retaining both queues without aborting the run signal.
- The coding-agent compaction admission gate uses this ownership transfer for required recovery. Real user aborts
  continue to abort the active signal and retain the normal terminal semantics.

### Files modified

- `agent.ts`
- `../test/agent.test.ts`

### Why the extension system could not handle this

- Native queue draining and active-run signal ownership occur inside `Agent` after event subscribers return.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `agent.ts` active-run lifecycle and post-`agent_end` queue draining.

## 2026-07-17 - Truncation-recovery flagged-call failure and proxy payload

### What changed and why

- A tool call that the text tool-call middleware could only partially recover now arrives at the
  agent loop carrying `incomplete: true`. Previously a truncated text-protocol call could be silently
  dropped, leaked as raw markup, or executed from stale arguments; the loop had no way to treat a
  partially recovered call as a failure and ask the model to retry.
- `prepareToolCall` now produces an immediate error outcome for any flagged call (an `isError` tool
  result carrying a retry diagnostic such as "Re-issue the tool call"), skipping
  validation/hooks/execution while preserving source-order event emission in the same scheduler. The
  existing native `length` stop rule is preserved for provider-native streams; only the text-middleware
  wrapper converts a terminal `length` to `toolUse` when tool-call activity was finalized.
- The flagged error result keeps the inner loop alive (`failToolCallsFromTruncatedMessage` already
  returns `{ terminate: false }`), so the loop streams another assistant turn and the model re-issues
  the truncated call — the retry contract.
- Flagged-call diagnostics always append `Re-issue the tool call with complete arguments.` to parser-provided error messages without duplicating a final period.
- `proxy.ts` `toolcall_end` wire event gains an optional full `toolCall` payload so a flagged call
  (which emits no argument deltas) can still be delivered to clients. The client prefers the payload
  and falls back to delta reconstruction; against an older server that omits it, the client degrades
  to the legacy delta-only path. The producing server is external; the in-repo deliverable is the
  wire type, the client merge, and the skew-degradation tests.

### Files modified

- `agent-loop.ts`
- `proxy.ts`
- `../test/agent-loop.test.ts`, `../test/proxy-events.test.ts`

### Why the extension system could not handle this

- Flagged-call routing into an immediate error outcome, the retry decision, and the proxy wire type
  all live inside `pi-agent-core` before coding-agent extensions or mode renderers participate.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `agent-loop.ts` around `prepareToolCall` and `failToolCallsFromTruncatedMessage`.
- LOW: `proxy.ts` around the `toolcall_end` wire event and client reconstruction.

## 2026-07-20 - Terminating queue recovery survives compaction preparation

### What changed and why

- `agent-loop.ts` re-polls a terminating turn's drained steering or follow-up queue after next-turn preparation, restoring it on preparation failure or abort and continuing only with work that remains queued.
- This keeps queued recovery input owned by agent-core while coding-agent compaction settles, preventing a queued prompt from being dropped or dispatched from stale history.

### Files modified

- `packages/agent/src/agent-loop.ts`
- `packages/agent/test/agent.test.ts`

### Why the extension system could not handle this

- Queue draining, restoration, and next-turn preparation run inside the agent loop before coding-agent extensions can observe or safely requeue the consumed messages.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `packages/agent/src/agent-loop.ts` around terminating tool batches, queue polling, and next-turn preparation.

## 2026-07-06 - Stream idle timeout aborts the dangling provider request

### What changed and why

- The idle-timeout reader rejected the turn but left the underlying provider request dangling:
  `iterator.return()` is a no-op on `EventStream`, so a silently dead connection (network drop + reconnect) kept its
  socket and stream alive forever.
- The agent loop now owns a per-request `AbortController`, propagates caller aborts into it through a single listener,
  and aborts it with `StreamIdleTimeoutError` when the reader times out, tearing the request down so auto-retry can
  recover the turn.

### Files modified

- `packages/agent/src/agent-loop.ts`
- `packages/agent/test/agent-loop.test.ts`

### Why the extension system could not handle this

- Stream lifetime and abort propagation live inside the agent loop's provider-request plumbing, upstream of any
  coding-agent extension hook.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `packages/agent/src/agent-loop.ts` around provider stream creation, idle-timeout reading, and abort-signal
  wiring.

## 2026-07-02 - Upstream harness timeout and compaction serialization sync

### What changed and why

- Accepted upstream harness changes for rejecting invalid/non-positive Node timeouts and serializing split-turn compaction
  summary requests.
- This keeps the fork aligned with upstream runtime validation and prevents single-concurrency providers from receiving
  overlapping compaction-summary generations.

### Files modified

- `packages/agent/src/harness/compaction/compaction.ts`
- `packages/agent/src/harness/env/nodejs.ts`

### Why the extension system could not handle this

- Timeout validation and harness compaction scheduling happen inside shared agent-core helpers before coding-agent
  extensions or mode renderers participate.

### Expected merge conflict zones on next upstream sync

- LOW: `packages/agent/src/harness/env/nodejs.ts` around timeout parsing and validation.
- LOW: `packages/agent/src/harness/compaction/compaction.ts` around summary request scheduling.

## 2026-05-15 - Tool abort loop termination

### What changed and why

- Stopped the core agent loop immediately after a tool batch finishes under an aborted signal.
- This prevents a tool-level abort result from continuing into `prepareNextTurn`, steering queue polling, follow-up queue
  polling, or another provider request.
- This closes the remaining abort path not covered by terminal assistant stream event normalization.

### Files modified

- `packages/agent/src/agent-loop.ts`
- `packages/agent/test/agent-loop.test.ts`

### Why the extension system could not handle this

- The decision to poll queued steering after tool execution happens inside the core loop before extensions can safely
  restore UI/editor queue state.

### Expected merge conflict zones on next upstream sync

- `packages/agent/src/agent-loop.ts` after `turn_end` emission in `runLoop()`.

## 2026-05-15 - Upstream harness refactor sync preservation

### What changed and why

- Preserved the fork's ES2021 diagnostic compatibility while accepting upstream's result-based harness/environment refactor.
- Kept stream option patching on `Object.prototype.hasOwnProperty.call` instead of `Object.hasOwn`.
- Kept harness error `cause` capture without relying on two-argument `Error` construction.

### Files modified

- `packages/agent/src/harness/agent-harness.ts`
- `packages/agent/src/harness/types.ts`

### Why the extension system could not handle this

- These are exported harness primitives and internal option-merging helpers that are evaluated before coding-agent
  extensions can participate.

### Expected merge conflict zones on next upstream sync

- `packages/agent/src/harness/agent-harness.ts` around `applyStreamOptionsPatch()`.
- `packages/agent/src/harness/types.ts` around harness error constructors.

## 2026-05-15 - Compaction summary metadata

### What changed and why

- Added optional `details` metadata to the harness `CompactionSummaryMessage` type.
- This keeps the shared agent-core message augmentation compatible with coding-agent compaction summaries that carry
  provider-native compaction route details for TUI rendering and replay.

### Files modified

- `packages/agent/src/harness/messages.ts`

### Why the extension system could not handle this

- This is exported type metadata in the shared harness message model. Extensions can populate compaction details, but they
  cannot alter the core `CustomAgentMessages` declaration merge.

### Expected merge conflict zones on next upstream sync

- LOW: `packages/agent/src/harness/messages.ts` around `CompactionSummaryMessage`.

## 2026-05-12 - Abort terminal event normalization

### What changed and why

- Normalized terminal assistant stream messages in `agent-loop.ts` so the event-level `reason` is authoritative for
  `done`/`error` events.
- This prevents an abort event with a stale assistant `stopReason` from being treated as a normal stop and draining queued
  steering/follow-up messages after the user interrupted the run.

### Files modified

- `packages/agent/src/agent-loop.ts`
- `packages/agent/test/agent.test.ts`

### Why the extension system could not handle this

- The stale-stopReason decision happens inside the core agent loop before extensions see a completed turn.
- Extensions can observe abort events after the fact, but they cannot prevent the loop from deciding to continue into
  queued messages.

### Expected merge conflict zones on next upstream sync

- `packages/agent/src/agent-loop.ts` around terminal `done`/`error` stream handling.

## 2026-04-05 - Parallel tool completion emission

### What changed and why

- Updated `executeToolCallsParallel()` to finalize prepared tool calls concurrently after sequential preflight.
- This lets `tool_execution_end` and `toolResult` message events appear as soon as each tool finishes instead of waiting behind an earlier slow tool.
- The returned `toolResults` array still stays in assistant source order, which preserves next-turn context ordering and matches existing semantic expectations.

### Files modified

- `packages/agent/src/agent-loop.ts`
- `packages/agent/src/types.ts`
- `packages/agent/README.md`
- `packages/agent/test/agent-loop.test.ts`

### Why the extension system could not handle this

- The scheduling and final result collection logic lives in `@mariozechner/pi-agent-core`, specifically `executeToolCallsParallel()`.
- Coding-agent extensions can observe and mutate tool inputs/results, but they cannot replace the agent loop's internal await/collection strategy or `toolExecution` scheduling behavior.
- The existing builtin `parallel-tool-calls` extension only changes provider payloads (`parallel_tool_calls: true`) and does not control runtime result finalization.

### Expected merge conflict zones on next upstream sync

- `packages/agent/src/agent-loop.ts` around `executeToolCallsParallel()`
- `packages/agent/src/types.ts` tool execution mode docs
- `packages/agent/README.md` tool execution behavior description

## 2026-05-11 - Inline harness UUIDv7 generation

### What changed and why

- Replaced upstream harness imports of `uuid/v7` with a local UUIDv7 generator backed by Node's `crypto.randomBytes`.
- This keeps clean package-manager builds working without adding a new direct `uuid` dependency to `@earendil-works/pi-agent-core`.

### Files modified

- `packages/agent/src/harness/session/uuid.ts` (current location; the generator originally landed in the since-restructured session repo/storage files)

### Why the extension system could not handle this

- The failing imports live inside the agent harness session storage implementation and run before any coding-agent extension can intercept them.

### Expected merge conflict zones on next upstream sync

- `packages/agent/src/harness/session/uuid.ts`
- its importers `packages/agent/src/harness/session/{repo-utils,memory-storage,jsonl-storage}.ts` around session/entry id creation.

## 2026-05-11 - Harness ES2021 diagnostic compatibility

### What changed and why

- Replaced `ErrorOptions`/two-argument `Error` construction in `FileError` with an equivalent local `{ cause }`
  option stored on the class.
- Replaced `Object.hasOwn` with `Object.prototype.hasOwnProperty.call` in the stream option patch helper.
- This keeps the upstream harness behavior intact while avoiding diagnostics in environments that type-check the package with
  ES2021 library declarations.

### Files modified

- `packages/agent/src/harness/types.ts`
- `packages/agent/src/harness/agent-harness.ts`

### Why the extension system could not handle this

- These are type-level compatibility fixes in exported harness primitives and internal option-merging code that run before
  coding-agent extensions are involved.

### Expected merge conflict zones on next upstream sync

- `packages/agent/src/harness/types.ts` around `FileError` construction.
- `packages/agent/src/harness/agent-harness.ts` around `hasOwn()`.

## 2026-07-22 - Per-thinking-block stream timing

### What changed and why

- `agent-loop.ts` now stamps each streamed thinking block's `startedAt` and `endedAt` with best-effort receipt timestamps. Every thinking update is restamped because thinking projection middleware may replace the block object between events; terminal completion, error/abort, reader failure, and normal stream fallthrough all close unfinished blocks before emitting the final message.

### Files modified

- `packages/agent/src/agent-loop.ts`
- `packages/agent/test/agent-loop.test.ts`

### Why the extension system could not handle this

- The timestamps must be attached at the agent loop's provider-event choke point, before extensions receive message updates or terminal messages.

### Expected merge conflict zones on next upstream sync

- LOW: `packages/agent/src/agent-loop.ts` streaming event switch and terminal response paths.
