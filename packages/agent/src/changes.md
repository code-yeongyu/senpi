# Changes

## 2026-08-10 - Refresh server-fallback policy between tool turns

### What changed and why

- `AgentLoopTurnUpdate` can now replace `abortServerSideFallback` together with the model and thinking level before
  the next provider request in an active run.
- `agent-loop.ts` applies the refreshed value when rebuilding its request config after tool execution. Previously the
  loop snapshotted the option at run start, so a host that changed models mid-turn could send the next request with
  the prior model's server-fallback policy.
- An explicit `false` remains authoritative because the update uses nullish fallback rather than truthiness.

### Why the extension system could not handle this

- The provider options object is owned and snapshotted inside agent-core before extensions observe the next request;
  only the loop can replace request policy between tool turns.

### Expected merge conflict zones on next upstream sync

- LOW: `types.ts` `AgentLoopTurnUpdate`.
- LOW: `agent-loop.ts` next-turn config replacement.

## 2026-08-09 - Recover invisible text-protocol assistant stops

### What changed and why

- Empty-assistant recovery now covers every model selected for text-tool-call recovery or configured with a text tool
  format, expanding the previous Kimi-only gate to Claude, ANTML, Hermes, morph-XML, YAML-XML, Gemma delimiters, and
  other configured text protocols. A `stop` turn with no visible text and no tool call is discarded and retried once;
  a second invisible stop retains the existing explicit `Model returned an empty response twice` failure.
- Both the completed-message gate and the first-visible-event gate use pi-ai's shared Unicode visibility predicates.
  Unicode format-only deltas such as the U+200B block emitted by the Apitopia Kimi-K3 gateway remain buffered, so
  malformed thinking/tool-marker events from the discarded attempt never reach subscribers.
- The approved universal gate was narrowed after the full-suite audit: buffering all model streams suppressed ordinary
  thinking updates, changed provider stream-start/idle-timeout semantics, and prevented coding-agent TTSR from
  observing and aborting malformed reasoning streams. Plain native-protocol models therefore keep direct streaming,
  while every model exposed to the text-protocol failure mode receives bounded recovery.
- Healthy visible text, tool calls, and non-`stop` terminal states retain their existing pass-through behavior.

### Why the extension system could not handle this

- Provider stream buffering and retry happen inside agent-core before message-update events are forwarded or an
  assistant turn is committed; extensions cannot retract leaked attempt-one events or replace the committed turn.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `empty-assistant-recovery.ts` visibility checks and stream wrapper gate.
- LOW: `agent-loop.ts` at the recovery wrapper call site.

## 2026-07-30 - Bound empty Kimi assistant responses

### What changed and why

- Kimi-family provider streams that finish with `stop` but contain neither non-empty visible text nor a tool call
  are discarded before turn commitment and retried once with the same request.
- A successful second attempt is the only assistant turn committed and carries an
  `empty_assistant_response_recovery` diagnostic. A second empty response becomes a visible error instead of
  ending the session silently or looping indefinitely.
- Error, aborted, refusal, length, and tool-call turns keep their existing behavior. The stream gate buffers only
  Kimi responses before their first visible text/tool signal, avoiding reasoning-stream regressions for other
  model families.
- Coverage: agent-loop tests pin one-shot recovery, bounded failure, terminal-state preservation, and tool
  execution. The real CLI mock-loop scenario proves the user-visible recovery path.

## 2026-07-29 - Bounded provider stream start (streamStartTimeoutMs)

### What changed and why

- `agent-loop.ts` bounds the wait for the FIRST provider stream event with a new optional
  `AgentLoopConfig.streamStartTimeoutMs`. Providers emit their first event only once the HTTP
  response begins, so a dead upstream that accepts a request and never answers was previously
  bounded only by `timeoutMs` (the idle timeout, default 5 minutes): every attempt froze the
  session for 300s with zero events, zero usage, and nothing persisted. Observed in a donated
  5h session log where the same session hung deterministically on reopen while new sessions
  worked. After the first event arrives the idle bound governs as before.
- The failure message `Provider stream start timed out after <ms>ms` deliberately contains
  "timed out" so the existing retryable-error classifier (`isRetryableErrorMessage`) retries
  it instead of dead-ending the session; the request-local abort controller tears the dead
  request down exactly like an idle timeout.
- `agent.ts` plumbs `streamStartTimeoutMs` through `AgentOptions`/`Agent` into the loop config.

### Files modified

- `agent-loop.ts`
- `agent.ts`
- `types.ts`
- `../test/agent-loop-stream-start-timeout.test.ts`

## 2026-07-29 - Continuation-scoped queue and timeout controls

### What changed and why

- `Agent.continue()` and `continueWithQueuedMessages()` accept continuation-only options that defer queued input from
  the first provider request and override both stream idle and stream-start bounds for that request without mutating
  the agent's configured defaults. Later requests in the same run restore the configured bounds; after the first
  retry event, the configured idle timeout also governs inter-event gaps so healthy silent reasoning is not capped.
- Queue-first recompaction recovery takes precedence over deferral: the selected queued message is the continuation
  input, while first-request timeout overrides still apply.
- The core run lifecycle intentionally parks queued steering and follow-up input after terminal error or abort
  responses until an external retry/compaction owner or a later admitted prompt consumes it. This stop-reason policy
  is distinct from `suppressQueuedMessageDrain()`, which transfers one active run's post-`agent_end` ownership.
- Coding-agent retries use these controls after a silent provider stream so a doomed retry cannot consume newly
  queued user input and a later ordinary provider request automatically returns to the configured timeout.

### Files modified

- `agent.ts`
- `types.ts`
- `agent-loop.ts`
- `../test/agent.test.ts`
- `../README.md`

### Why the extension system could not handle this

- Provider-request queue polling, event-reader timeout selection, and post-run native queue draining happen inside
  agent core before coding-agent extensions can safely claim or restore that work.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `agent.ts` continuation APIs/config creation and active-run lifecycle queue draining.
- MEDIUM: `agent-loop.ts` provider-request timeout selection inside `runLoop()`.

## 2026-07-27 - End classifier-refused turns before tool execution

### What changed and why

- `assistant-terminal-state.ts` owns terminal assistant classification, including typed classifier refusals;
  `agent-loop.ts` now consults it before any partial tool calls are executed. Anthropic can emit a tool call and
  then finish the same stream with a refusal/sensitive stop; treating the message as ordinary `toolUse` previously
  ran the refused call and continued on the same model.
- The terminal `agent_end` lets the coding-agent retry/fallback controller immediately apply its configured pinned
  refusal fallback.

## 2026-07-23 - Session-owned post-agent_end queue drain suppression

### What changed and why

- `Agent` now exposes `suppressQueuedMessageDrain()` for the active run. It stops only the lifecycle-owned
  post-`agent_end` steering/follow-up drain, retaining both queues without aborting the run signal.
- `Agent` now exposes `continueWithQueuedMessages()` so compaction recovery can deliver retained steer/follow-up input
  when custom context leaves the transcript tail non-assistant.
- The coding-agent compaction admission gate uses this ownership transfer for required recovery. Real user aborts
  continue to abort the active signal and retain the normal terminal semantics.
- Scheduled continuation can revalidate a model changed by `session_compact`, recompact if required, and then deliver
  retained queues without inventing an empty continuation turn.

### Files modified

- `agent.ts`
- `../test/agent.test.ts`

### Why the extension system could not handle this

- Native queue draining and active-run signal ownership occur inside `Agent` after event subscribers return.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `agent.ts` active-run lifecycle and post-`agent_end` queue draining.

## 2026-07-23 - uuidv7 concurrency refutation + immutable launch profile

### What changed and why

- `harness/session/uuid.ts`: the inlined UUIDv7 implementation uses a synchronous counter over module
  state. A concurrency refutation test (`test/uuid-concurrency.test.ts`) records that N interleaved
  async tasks calling `uuidv7()` produce unique, monotonic-per-timestamp ids — the synchronous counter
  makes uniqueness hold under interleaving (no `await` between timestamp read and counter increment).
  This is a recorded refutation WITH a test, not a bare assertion; it documents that the existing
  synchronous-counter design is correct under interleaving so future refactors do not "fix" a
  non-bug by adding an async lock that would change id ordering.
- `core/agent-session-runtime.ts` (`CreateAgentSessionRuntimeFactory`, `:35,74-242,411`): runtime
  construction now carries an immutable per-open launch profile
  `{ permissionPreset, creationModel, initialThinkingLevel, cwd }`. The profile is retained by
  `AgentSessionRuntime` and survives `new_session`/`switch_session`/reload unless the command
  explicitly changes it. This carries per-session `cwd`, permission-preset, model selection, and
  thinking level with identical semantics to today's spawn flags, without `main.ts` closing over
  process-level parse.

### Files modified

- `harness/session/uuid.ts` (no production change; refutation test only)
- `../test/uuid-concurrency.test.ts` (new)
- `core/agent-session-runtime.ts`

### Why the extension system could not handle this

- The UUIDv7 counter and the launch-profile retention live inside `pi-agent-core` before coding-agent
  extensions or mode renderers participate; the profile must be carried by the runtime the session
  registry constructs inside `runWithProviderScope`.

### Expected merge conflict zones on next upstream sync

- LOW: `harness/session/uuid.ts` (unchanged production code; test is fork-only).
- MEDIUM: `core/agent-session-runtime.ts` around `CreateAgentSessionRuntimeFactory` options.
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
