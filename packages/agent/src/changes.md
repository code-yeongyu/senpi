# Changes

## Agent loop config surface re-diverges from upstream dcd4619 (2026-08-25)

### What changed

- `packages/agent/src/agent.ts` keeps the fork run-loop surface on top of upstream: the
  `buildProviderContext` re-export from `agent-loop.ts`, and the config passthroughs `timeoutMs`,
  `streamStartTimeoutMs`, `removedToolHints`, `resolveUnknownToolCall`, `abortServerSideFallback`,
  and `cursorExecHandlers`.

### Why

These are fork-owned product surfaces (senpi branding, provider wire behavior, fork runtime features) that upstream does not carry; the sync must re-assert them on top of upstream's tree.

### Why this lives in the fork

The divergence lives in core wiring, package identity, or build plumbing that executes before any extension loads, so no extension hook can express it.

### Expected merge conflict zones

- The `AgentConfig`/loop-config type blocks and the `agent-loop.ts` import list in
  `packages/agent/src/agent.ts`.

## 2026-08-25 - Preserve provider retry watchdog abort provenance

### What changed

- `packages/agent/src/agent.ts` accepts an abort reason and emits a provider-owned assistant abort for retry-watchdog cancellation.
- `packages/agent/src/agent-loop.ts` preserves an explicit abort Error instead of replacing it with generic `Request was aborted` text.
- `packages/agent/src/assistant-terminal-state.ts` stamps provider provenance where terminal stream failures are constructed.
- `packages/agent/src/index.ts` exports the typed watchdog abort reason for session hosts.

### Why

- The session watchdog must carry the real provider stall cause through low-level Agent cancellation so retry classification and terminal reporting do not lose the provider failure.

### Why an extension could not handle it

- Abort reason propagation and assistant failure-message construction occur inside the browser-safe agent lifecycle.

### Expected merge conflict zones

- LOW: `agent.ts` abort API and `agent-loop.ts` event-reader cancellation path.

## 2026-08-20 - End the turn when idle after completed Cursor tools

### What changed

- `packages/agent/src/agent-loop.ts`: `streamAssistantResponse` catch now treats `StreamIdleTimeoutError` after Cursor-resolved tools or buffered exec results as a finished turn (`stopReason: "stop"`) instead of a terminal error.
- `packages/agent/src/assistant-terminal-state.ts`: `isStreamIdleTimeoutError` and `shouldFinalizeIdleAsStop` decide when that idle is a completed turn versus a real hang.

### Why

- After Cursor-resolved tools (or buffered exec results) the parent stream can sit silent until the 300s idle timeout and die as `StreamIdleTimeoutError` even though the child work already finished (issue #997).

### Why an extension could not handle it

- The idle reader and `streamAssistantResponse` catch live inside the agent loop; no extension hook sits between the idle timeout and the terminal assistant message it currently emits.

### Expected merge conflict zones

- `packages/agent/src/agent-loop.ts` `streamAssistantResponse` catch
- `packages/agent/src/assistant-terminal-state.ts` idle helpers appended after `shouldTerminateAssistantTurn`

## 2026-08-20 - Continue when stop still has pending toolCalls

### What changed

- `packages/agent/src/assistant-terminal-state.ts`: `promoteStopWithPendingToolCalls` rewrites assistant `stopReason` from `stop` to `toolUse` when the message still contains `toolCall` blocks; text-only stop stays terminal.
- `packages/agent/src/agent-loop.ts`: apply that promotion after streaming so pending (non-exec-channel) tool calls execute in the same turn and their results go back to the model. Cursor exec-resolved blocks stay filtered out of the local batch and do not re-enter the loop.

### Why

- Cursor often ends a turn as `stop` while toolCall blocks are still present. The loop treated that as a finished turn and dropped the pending tools (issue #1010).

### Why an extension could not handle it

- Stop-reason classification lives inside the agent loop after the stream returns; no extension hook sits between stream completion and tool-batch execution.

### Expected merge conflict zones

- `packages/agent/src/assistant-terminal-state.ts` promotion helper
- `packages/agent/src/agent-loop.ts` success path after `streamAssistantResponse`

## 2026-08-20 - Cursor exec handlers bind to the owning run signal

### What changed

- `packages/agent/src/agent-loop.ts`: when `config.cursorExecHandlers` is a factory, the loop now
  resolves it with the outer owning-run signal (`signal ?? requestAbortController.signal`) instead of
  the per-request idle-timeout controller, and normal request completion aborts the request-scoped
  fallback so signal-less direct loop callers cannot leave stale handlers live.

### Why

- The bridge session (`cursor-exec-bridge-session.ts`) verifies ownership by identity against the
  agent's live run signal. The per-request controller is a different object by construction, so every
  native Cursor exec frame failed the check and returned `Tool execution has no active run`
  (issues #979/#1000/#1003, regression from 31a71f0c5).

### Why an extension could not handle it

- The factory resolution happens inside the loop's provider-request assembly; no extension hook sits
  between `streamAssistantResponse` and the provider options it constructs.

### Expected merge conflict zones

- `agent-loop.ts` provider-request assembly and the request `finally` teardown (fork-only Cursor exec
  channel; upstream has no cursor provider).

## Finalize idle-after-completed-tools as stop (2026-08-19)

If the provider stream goes idle after Cursor-resolved tool calls (or buffered exec results) and there is no pending local work, the turn ends as `stop` instead of `StreamIdleTimeoutError`. A hang with no tools is still an idle error.

Conflict zone: `agent-loop.ts` `streamAssistantResponse` catch.

## Loop and agent divergence re-established against upstream 59a71b23 (2026-08-19)

### What changed

- `packages/agent/src/agent-loop.ts` stays divergent from the new pin on the fork's own turn machinery:
  per-request stream bounds (`StreamStartTimeoutError` / `StreamIdleTimeoutError`, the
  `initialRequestTimeoutMs` / `initialRequestStreamStartTimeoutMs` overrides that apply to the first
  provider request only, after which the configured idle timeout resumes so a healthy reasoning gap is
  not bound by the short liveness probe);
  queued-input recovery (`drainedTerminatingQueue` plus `refreshTerminatingQueueDrain`, which hands
  steering/follow-up messages back to `config.restorePendingMessages` on every terminating path instead
  of dropping them); `streamKind: "main"` stamped on the loop's own provider request so auxiliary calls
  stay distinguishable downstream; thinking-block `startedAt` / `endedAt` stamping from the
  `thinkingTiming` map at stream-event receipt; the Cursor exec-channel bridge (handler factory resolved
  with the outer owning-run signal rather than the provider request's idle-timeout signal, mid-stream
  tool results buffered and appended, `kCursorExecResolved`
  blocks excluded from the executable tool batch); `withEmptyAssistantRecovery` around the stream fn; and
  the `prepareNextTurn` merge of `thinkingSelection` and `abortServerSideFallback`.
- `packages/agent/src/agent.ts` stays divergent on the run-ownership surface those loop features require:
  `AgentContinuationOptions` (`deferQueuedMessages`, `timeoutMs`, `streamStartTimeoutMs`),
  `continueWithQueuedMessages()` — queue-first continuation that re-delivers drained steering input when a
  compaction leaves custom context at the tail — the `clearGeneration` counter and `prepend()` on the
  message queue, `suppressQueuedMessageDrain()` for one active run, the `restorePendingMessages` wiring
  back into the queues, and the runtime options carried onto the loop config (`timeoutMs`,
  `streamStartTimeoutMs`, `removedToolHints`, `resolveUnknownToolCall`, `abortServerSideFallback`,
  `cursorExecHandlers`).

### Why

- Upstream `59a71b235d` has no per-request stream bounds, no queued-input ownership contract, and no
  provider-executed-tool channel, so every one of these behaviors re-diverges on merge rather than being
  reconciled away. The behavioral rationale for each lives in the dated entries below (stream-start and
  continuation-scoped timeouts 2026-07-29, empty-assistant recovery 2026-07-30, Cursor exec-channel
  contract 2026-08-16 and 2026-08-18, thinking-selection provenance 2026-08-18); this entry records that
  the sync to the new pin leaves both files divergent for exactly those reasons.

### Why an extension could not handle it

- Stream-request construction, abort-signal ownership, the pending-message queues, and the tool-batch
  filter are the loop's own control flow. An extension observes turn events after the fact and cannot
  bound a stream that never emits, re-park input the loop already drained, or exclude a block from the
  batch the loop is about to execute.

### Expected merge conflict zones

- HIGH: `agent-loop.ts` `streamAssistantResponse` request construction and the timeout/idle wrappers;
  the tool-call collection and execution block; the `prepareNextTurn` config merge.
- MEDIUM: `agent.ts` `runPromptMessages` / `continue` entry points and the loop-config assembly that
  forwards the fork's runtime options.

## Cursor exec handlers bind to their owning run (2026-08-18)

### What changed

- `packages/agent/src/types.ts`: `AgentLoopConfig.cursorExecHandlers` also
  accepts a `(runSignal: AbortSignal) => CursorExecHandlers` factory.
- `packages/agent/src/agent-loop.ts`: when a factory is supplied, the loop
  resolves it with the outer owning-run signal. Direct loop callers without an
  outer signal retain the request controller as a scoped fallback, and normal
  request completion aborts that fallback so stale handlers cannot remain live.

### Why

- A host bridge built once per session cannot tell which run an exec frame
  belongs to. Handing it the owning run's signal at stream creation lets the
  host refuse a straggler frame from a stream whose run already ended, instead
  of executing it inside the replacement run.
- The plain-object form is unchanged, so existing hosts keep working.

### Why an extension could not handle it

- Only the loop knows which run owns the stream it is opening. The owning
  signal exists solely inside `streamAssistantResponse` at stream creation, so
  no extension hook can supply it to the host bridge after the fact.

### Expected merge conflict zones

- `agent-loop.ts` `execHandlers` injection block, `types.ts`
  `cursorExecHandlers` declaration.

## 2026-08-18 - Thinking-selection provenance through the agent loop

### What changed

- `packages/agent/src/types.ts`: `AgentState` gains `thinkingSelection`; `AgentLoopTurnUpdate` gains a
  tri-state `thinkingSelection` (undefined leaves unchanged, null clears).
- `packages/agent/src/agent.ts`: `createLoopConfig` forwards the state selection alongside `reasoning`.
- `packages/agent/src/agent-loop.ts`: mid-run `prepareNextTurn` updates re-propagate the selection.
- `packages/agent/src/proxy.ts`: the selection joins the serializable proxy request options.

### Why

- Providers that encode reasoning on the wire (Cursor) must distinguish an explicit user choice from the
  always-materialized effective level, which startup defaults to `medium`.

### Why an extension could not handle it

- Loop config assembly, turn-update merging, and proxy request serialization are core agent-loop seams with
  no extension hook.

### Expected merge conflict zones

- `agent-loop.ts` prepareNextTurn config merge, `proxy.ts` serializable option list, `types.ts` state and
  turn-update interfaces.

## Late Cursor bridge lifecycle events after run teardown (2026-08-18)

### What changed

- `packages/agent/src/agent.ts`: `Agent.emitExternalEvent()` now accepts the
  originating run signal and
  discards bridge-generated lifecycle events when that signal no longer owns
  the active run.

### Why

- Cursor exec handlers can outlive an aborted provider stream. Their final
  `tool_execution_end` event previously reached `processEvents()` after
  `finishRun()` cleared `activeRun`, producing an unhandled
  `Agent listener invoked outside active run` rejection.
- The ownership guard remains specific to externally injected events. Internal
  loop events still require an active run, and listener failures during the
  owning active run still propagate.

### Why the extension system could not handle this

- The race occurs in the engine contract between the provider-owned Cursor exec
  handler and the agent run lifecycle, before an extension can intercept or
  recover the rejected event promise.

### Expected merge conflict zones

- `packages/agent/src/agent.ts`: the external event entry point and active-run
  ownership checks.

> Audit backfill (2026-08-17): the canonical four-section records added today were recorded during
> the repository-wide changes.md audit of divergences from the upstream pin (v0.84.2, `914cf1472e`)
> so every audited production path assigned to this tracker carries a canonical record; they are
> dated by their underlying work. Legacy entries keep their original wording and detail.

## Agent source audit backfill (2026-08-17)

### What changed

- Recorded the fork divergences this tracker owns against the pinned upstream
  (badlogic/pi-mono v0.84.2, `914cf1472e715297caa30db4b9535d534a9eb718`) so the
  repository-wide changes.md audit reports them covered. The pre-backfill audit
  report assigned zero already-covered and thirteen uncovered production paths
  to this tracker; this entry is their canonical four-section record.
- Audited production paths covered by this entry:
  - `packages/agent/src/agent-loop.ts`
  - `packages/agent/src/agent.ts`
  - `packages/agent/src/types.ts`
  - `packages/agent/src/proxy.ts`
  - `packages/agent/src/stream-fn.ts`
  - `packages/agent/src/harness/types.ts`
  - `packages/agent/src/harness/messages.ts`
  - `packages/agent/src/harness/reducer.ts`
  - `packages/agent/src/harness/env/nodejs.ts`
  - `packages/agent/src/harness/session/state.ts`
  - `packages/agent/src/harness/compaction/branch-summarization.ts`
  - `packages/agent/src/harness/compaction/compaction.ts`
  - `packages/agent/src/harness/compaction/utils.ts`
- `packages/agent/src/empty-assistant-recovery.ts` and
  `packages/agent/src/assistant-terminal-state.ts` are fork-only files absent
  from the pin tree, so the audit exempts them; their behavior stays recorded
  in the 2026-08-09 and 2026-07-27 entries.
- Legacy entries predate the canonical four-heading format (their "What changed
  and why" style does not canonicalize), so the per-change detail for the paths
  above remains in those dated entries; the audit-backfill sections added today
  carry the canonical records for the harness reducer, session store,
  compaction, and stream-function surfaces.

### Why

- Root policy requires every fork-specific source change to update the nearest
  `changes.md` in the same verified increment, and `scripts/audit-changes-md.mjs`
  now enforces the canonical-section contract mechanically. Without this record
  the gate reports every agent-core divergence as untracked.

### Why an extension could not handle it

- Tracker hygiene for fork-owned agent-core divergence. The audited surfaces
  themselves (loop scheduling, harness session and compaction internals, proxy
  wire types, stream-function plumbing) execute below the coding-agent
  extension runtime, as the per-change entries already document.

### Expected merge conflict zones

- NONE for this record itself (tracker prose only). The underlying per-file
  zones are unchanged and stay listed in the dated entries: MEDIUM for
  `packages/agent/src/agent-loop.ts` tool-call collection and stream plumbing
  and `packages/agent/src/agent.ts` continuation/lifecycle queues; LOW for the
  harness type, reducer, session-state, Windows kill, proxy wire, and
  compaction content sites.

## 2026-08-16 - Cursor exec-channel contract in the agent loop

### What changed and why

- `agent-loop.ts`: the tool-call collection sites (loop collection and the
  `executeToolCalls` re-filter) skip `toolCall` blocks stamped
  `kCursorExecResolved` — Cursor's server-driven protocol already executed
  those tools mid-stream through the exec bridge, and re-running them would
  duplicate side-effecting bash/write calls.
- `streamAssistantResponse` returns `{ message, providerToolResults }`: when
  `config.cursorExecHandlers` is set, the loop injects `execHandlers` plus a
  buffering `onToolResult` into the stream options; buffered results are
  emitted as ordinary `message_start`/`message_end` events and appended to the
  context right after the assistant message — including on terminal
  error/abort paths, so resolved calls never end up unpaired.
- The idle watchdog (`readNextAssistantEvent`) re-arms instead of failing when
  the provider stream reports pending local work
  (`AssistantMessageEventStream.hasPendingLocalWork`), because a
  server-requested tool run legitimately emits no events while it executes.
- `agent.ts`: `AgentOptions.cursorExecHandlers` flows onto the loop config;
  `emitExternalEvent()` (new) lets the exec bridge inject
  `tool_execution_start`/`tool_execution_end` lifecycle events for tools that
  run inside the provider stream, outside the loop's executor.
- `types.ts`: `AgentLoopConfig.cursorExecHandlers`.

### Why the extension system could not handle this

- Tool-call execution skipping and transcript ordering are loop-core
  decisions made between the provider stream ending and `executeToolCalls`
  starting; no extension hook exists in that window, and a `tool_call` block
  hook can only produce error-shaped results.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `agent-loop.ts` at the tool-call collection block and
  `streamAssistantResponse`'s return shape (upstream returns the bare
  message).
- LOW: `agent.ts` options/config plumbing (additive), `types.ts` additive
  field.

## Durable harness reducer and SessionState projection hardening (2026-08-13)

### What changed

- `packages/agent/src/harness/reducer.ts`: the durable-log projection guards in
  `validateToolStart` and `deriveToolBatch` replaced the negated disjunction
  (`!assistantEntry || assistantEntry.type !== "message" || ...`) with
  optional-chain narrowing (`assistantEntry?.type !== "message" || ...`), so
  tool-start validation and tool-batch derivation keep narrowing the projected
  assistant entry under the repository's warning-as-error type gate.
- `packages/agent/src/harness/session/state.ts`: the fork-target guard applies
  the same optional-chain narrowing (`entry?.type !== "message"`) before
  rejecting a non-message fork target with `invalid_fork_target`.
- `packages/agent/src/harness/types.ts`: `getOrUndefined` is now a generic
  null-to-undefined normalizer — the fork removed the dead Result-unwrapping
  original on 2026-06-10 and the v0.84.x sync reintroduced the name with the
  narrowed semantics — and the harness error classes (`FileError`,
  `ExecutionError`, `CompactionError`) declare a typed `readonly cause`
  assigned after `super()` so `cause` stays typed under ES2021 library
  declarations.
- Consolidates the 2026-08-13 "Upstream harness type cleanup" and 2026-05-11
  "Harness ES2021 diagnostic compatibility" records under the canonical
  four-section format; runtime behavior is unchanged.

### Why

- The merged durable harness code had to pass the fork's stricter diagnostics
  and library level without weakening the durable projection invariants: a tool
  start must reference a projected assistant entry, a fork target must be a
  message entry, and harness errors must carry a typed cause for callers that
  inspect failure chains.

### Why an extension could not handle it

- These guards run inside the durable session reducer and the `SessionState`
  projection, and the error contracts are exported harness primitives consumed
  before any coding-agent extension loads.

### Expected merge conflict zones

- LOW: `packages/agent/src/harness/reducer.ts` tool-start validation and
  tool-batch derivation guards; `packages/agent/src/harness/session/state.ts`
  fork-target validation; `packages/agent/src/harness/types.ts`
  `getOrUndefined` and the error-class cause declarations.

## Atomic JSONL publication and session-name clearing on the durable store (2026-08-13)

### What changed

- Adopted, with the upstream v0.84.1/v0.84.2 syncs, the durable session store
  whose JSONL publication is crash-safe:
  `packages/agent/src/harness/session/jsonl/storage.ts` stages a complete
  sibling `.tmp` file and atomically renames it over the destination, so a
  crash while populating a fork or repair leaves the published file untouched
  and at most an ignored temporary behind; a torn tail (an unacknowledged
  partial append after a crash) is repaired by atomically publishing the valid
  prefix.
- Session names became clearable through the same durable mutation log:
  `setName(name: string | undefined)` enqueues a `name` fact mutation and
  passing `undefined` clears the name
  (`packages/agent/src/harness/session/jsonl/storage.ts`,
  `packages/agent/src/harness/session/jsonl/codec.ts`,
  `packages/agent/src/harness/session/memory.ts`,
  `packages/agent/src/harness/session/session.ts`).
- The retired `jsonl-repo`/`memory-repo` layer referenced by the 2026-05-11
  UUID entry is gone; that conflict zone now maps to the store files above
  behind the session facade. The only fork divergence left in this tree is the
  `SessionState` projection guard recorded in the reducer entry.

### Why

- Crash-safe publication and torn-tail repair keep a forked or repaired session
  recoverable instead of half-written, and clearable names let hosts release
  stale labels without deleting durable history. Recording the migration keeps
  the tracker's legacy conflict zones honest after the store refactor.

### Why an extension could not handle it

- JSONL staging, atomic rename, torn-tail truncation, and name-fact mutations
  are storage-layer durability mechanics inside the harness session store,
  below every extension hook.

### Expected merge conflict zones

- LOW: `packages/agent/src/harness/session/jsonl/storage.ts` staged publication
  and torn-tail repair; `packages/agent/src/harness/session/state.ts`
  projection guards (fork narrowing only).

## Durable compaction API migration (2026-08-13)

### What changed

- Adopted the promoted durable harness compaction API from the upstream
  v0.84.x syncs: compaction runs against the durable session model with
  Result-typed helpers in `packages/agent/src/harness/types.ts`, compaction
  entries persist as session entries, and the split-turn summary-request
  serialization accepted earlier (2026-07-02 entry) kept its scheduling slot
  through the promotion (`packages/agent/src/harness/compaction/compaction.ts`).
- The fork's surviving compaction-surface divergences on top of the promoted
  API: `CompactionSummaryMessage.details` in
  `packages/agent/src/harness/messages.ts` (provider-native compaction route
  details for TUI rendering and replay, 2026-05-15 entry) and the summary-safe
  request-content wiring plus cut-point retention recorded in the adjacent
  2026-08-13 summary-safe entry.

### Why

- The promotion moved compaction onto the same durability and error contracts
  as the rest of the harness; recording it keeps the tracker's compaction
  history continuous across the API change instead of implying the fork still
  patches the pre-promotion call sites.

### Why an extension could not handle it

- Compaction entry persistence, Result error contracts, and summary-request
  scheduling run inside the harness compaction helpers before coding-agent
  extensions observe a compacted session.

### Expected merge conflict zones

- LOW: `packages/agent/src/harness/messages.ts` around
  `CompactionSummaryMessage`; `packages/agent/src/harness/types.ts` compaction
  error contracts; `packages/agent/src/harness/compaction/compaction.ts`
  summary-request scheduling and content extraction.

## Summary-safe request content for branch summarization and compaction (2026-08-13)

### What changed

- `packages/agent/src/harness/compaction/utils.ts` exports
  `contentTextForSummary()`, which filters provider-native replay blocks from a
  copy before handing content to pi-ai's portable `contentText()`; the
  provider-native blocks stay on the persisted assistant message for
  same-provider replay, and the persisted message is never cast or mutated.
- Wired into every summarization request path:
  `packages/agent/src/harness/compaction/branch-summarization.ts`
  (`generateBranchSummary`), `packages/agent/src/harness/compaction/compaction.ts`
  (`generateSummaryWithUsage`, `generateTurnPrefixSummary`), and
  `serializeConversation()`'s user/assistant/tool-result extraction in
  `packages/agent/src/harness/compaction/utils.ts`.
- `findCutPoint()` in `packages/agent/src/harness/compaction/compaction.ts`
  keeps the last valid cut point when the recent-token budget overshoots the
  newest eligible cut point instead of dropping the compaction (PR #40,
  2026-06-15).
- Consolidates the 2026-08-13 "Summary-safe branch compaction text" record
  under the canonical four-section format.

### Why

- Provider-native replay content must not leak into durable summaries, and a
  token-budget overshoot must still compact rather than leave the session over
  context; both decide request content before any extension sees the payload.

### Why an extension could not handle it

- The summary request content is assembled inside harness compaction helpers
  before coding-agent extensions can inspect or rewrite the session entry
  payload.

### Expected merge conflict zones

- LOW: `packages/agent/src/harness/compaction/utils.ts` around
  `contentTextForSummary()` and `serializeConversation()`;
  `packages/agent/src/harness/compaction/branch-summarization.ts` in
  `generateBranchSummary()` content extraction;
  `packages/agent/src/harness/compaction/compaction.ts` content extraction and
  the `findCutPoint()` overshoot branch.

## 2026-08-13 - Summary-safe branch compaction text

### What changed and why

- Branch summarization and compaction use `contentTextForSummary()` instead of
  the portable-only AI `contentText()` helper.
- Provider-native replay blocks must be filtered while preserving the text that
  belongs in a durable branch summary.

### Why the extension system could not handle this

- Harness compaction constructs the summary request before any coding-agent
  extension can inspect or rewrite the session entry payload.

### Expected merge conflict zones on next upstream sync

- LOW: `harness/compaction/branch-summarization.ts`, in
  `generateBranchSummary()` content extraction.
- LOW: `harness/compaction/utils.ts`, where the summary-safe helper is defined.

## 2026-08-13 - Upstream harness type cleanup

### What changed and why

- Removed an unused compaction image type import and adopted optional-chain narrowing in reducer and session-state
  guards introduced by the upstream harness v2 merge.
- Runtime behavior is unchanged; the edits make the merged harness pass the repository's warning-as-error gate.

### Why the extension system could not handle this

- These are internal harness compiler and lint boundaries, evaluated before any coding-agent extension loads.

### Expected merge conflict zones on next upstream sync

- LOW: harness compaction imports, reducer assistant-entry guards, and session fork-target validation.

## 2026-08-11 - Resolve eligible inactive tools at model call time

### What changed and why

- `AgentLoopConfig.resolveUnknownToolCall` is consulted before the existing unknown-tool result is emitted.
- A host may return a newly activated tool, which then follows the normal argument validation, hooks, execution, and result lifecycle.
- Returning `undefined` preserves the existing `Tool <name> not found` behavior byte-for-byte.

### Why the extension system could not handle this

- Unknown tool names were rejected inside the low-level agent loop before coding-agent tool hooks or extension callbacks ran.

### Expected merge conflict zones on next upstream sync

- LOW: `types.ts` next to tool-loop callback configuration.
- LOW: `agent-loop.ts` unknown-tool preparation branch.
- LOW: `agent.ts` loop-config forwarding.

## 2026-08-11 - Windows process-tree kill survives an unresolvable taskkill

### What changed and why

- `harness/env/nodejs.ts`: the Windows branch of the harness `killProcessTree` moved into the exported
  `killWindowsProcessTree`, which walks the ordered launcher list from the new `windowsTaskkillCandidates` export
  (every existing absolute `System32` / `Sysnative` `taskkill.exe`, then the bare PATH-resolved name), runs each with
  `spawnSync` under a 5s timeout, and only degrades to `process.kill(pid)` when no launcher starts at all.
- `spawn("taskkill", ...)` resolves through PATH and reports a failed lookup asynchronously on the child's `error`
  event, so the surrounding `try`/`catch` never observed it. Without a listener Node re-emits ENOENT as an uncaught
  exception, killing the host process instead of the target tree whenever PATH had lost `%SystemRoot%\System32`.
- The kill is synchronous so a caller that tears down and exits in the same tick still terminates its children;
  `spawnSync` also reports a failed lookup on its returned `error` field instead of emitting it. The direct
  `process.kill` stays a last resort because `TerminateProcess` leaves descendants orphaned.
- The same fix lands in `packages/coding-agent/src/utils/shell.ts`; the two harnesses keep independent copies of this
  helper as they already do for `getShellEnv` and bash resolution.

### Why the extension system could not handle this

- The kill runs inside the Node harness's own process supervision, below every extension hook.

### Expected merge conflict zones on next upstream sync

- LOW: the Windows branch of `killProcessTree` and the `node:child_process` / `node:fs` import lines in
  `harness/env/nodejs.ts`.

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

## Default StreamFn compatibility for empty-assistant recovery (2026-07-30)

### What changed

- `packages/agent/src/stream-fn.ts` re-exports `withEmptyAssistantRecovery`
  from `packages/agent/src/empty-assistant-recovery.ts`, keeping the injectable
  stream-function seam (`setDefaultStreamFn`/`getDefaultStreamFn`) the single
  place a host wires streaming.
- `packages/agent/src/agent-loop.ts` wraps the resolved stream function with
  `withEmptyAssistantRecovery(requestConfig.model, streamFunction)` before each
  provider request, so bounded empty-assistant recovery applies to every
  StreamFn in effect — explicitly passed or installed as the host default —
  without hosts importing the wrapper from a deep path.
- Landed with the Kimi empty-response retry; the 2026-07-30 and 2026-08-09
  recovery entries remain the accurate behavioral history and are preserved
  unchanged.

### Why

- Recovery must compose with host-installed default stream functions (the
  browser-safe core ships no provider catalog of its own), and the re-export
  keeps the loop importing its stream plumbing from one module.

### Why an extension could not handle it

- The wrapper sits between the loop and the provider stream, buffering and
  retrying empty assistant responses before message-update events reach
  subscribers or a turn is committed; extensions cannot retract leaked
  attempt-one events or replace the committed turn.

### Expected merge conflict zones

- LOW: `packages/agent/src/stream-fn.ts` re-export line;
  `packages/agent/src/agent-loop.ts` at the recovery wrapper call site.

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
