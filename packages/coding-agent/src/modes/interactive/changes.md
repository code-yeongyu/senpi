# changes

## 2026-08-30 - Harden shared-host reconnect fallback

### What changed

- Shared-host refresh and bash operations now classify transport loss through the common reconnect path, avoiding raw RPC errors in the TUI.
- Local fallback preserves the runtime invalidate/rebind callback contract and rebinds session-bound UI when the transition occurs.
- Reconnect action failures use a transient reconnecting warning; the continuing-locally warning is emitted only after fallback.

### Why

- The shared-host runtime must degrade at the transport boundary without exposing implementation errors or leaving InteractiveMode bound to a stale remote session.

### Expected merge conflict zones

- LOW: reconnect warning and replacement handling in `interactive-host-runtime.ts`.

## 2026-08-30 - Shared-host rendered component integration

### What changed

- `interactive-mode.ts` and `interactive-host-runtime.ts` retain the shared-host rendered-component capability and session-width integration while the RPC host owns per-connection filtering and lifecycle.

### Why

- Interactive clients use the shared host through the runtime bridge and must advertise the same capability and width semantics as direct RPC clients.

### Why an extension could not handle it

- The integration is host startup and session mirror infrastructure, outside extension lifecycle hooks.

### Expected merge conflict zones

- LOW: shared-host client setup in `interactive-host-runtime.ts` and interactive startup wiring in `interactive-mode.ts`.

## 2026-08-30 - Reconcile the shared-host mirror to the host entry list

### What changed

- `interactive-host-runtime.ts`: `performRefresh()` reconciles the session mirror to the complete entry list the host ships in `get_state`, whenever that list is present, instead of backfilling only an empty mirror. A mismatch rebuilds the mirror from the authoritative list, keeping any entry whose `entry_appended` notification crossed the refresh - such an entry postdates the snapshot, so dropping it would strand it until an unrelated refresh happened to run.

### Why

- The host ships its full entry list only while the session file is still deferred (no assistant message yet, so nothing has been written to disk), which makes that list the only authoritative view of the session. `entry_appended` notifications that cross a concurrent refresh land on whichever manager object is current at that instant, so the mirror could hold an arbitrary partial set rather than a prefix of the host's list; backfill-only-when-empty then wedged it at that partial set permanently. Together with event delivery across the rebind this makes the mirror converge after a replacement.

### Why an extension could not handle it

- The mirror is proxy state beneath every extension surface; no extension hook observes it.

### Expected merge conflict zones

- LOW: the entry-list reconciliation block inside `performRefresh()`.


## 2026-08-30 - Rebind the shared-host proxy on session_replaced

### What changed

- `interactive-host-runtime.ts`: the remote session proxy handles the `session_replaced` wire event by refreshing its binding. Refreshes are serialized, so a replacement-driven refresh cannot interleave with a caller-driven one and commit a snapshot mixing two sessions. Replacements this runtime drives itself are wrapped in `aroundLocalReplacement`, which suppresses the echo a multi-session host broadcasts back to the issuing connection; the scope covers the whole command, because the host emits while completing it. `createRemoteSessionProxy` is exported for direct coverage.

### Why

- A replacement can be driven by any other attached client, or by an extension that no client asked, and the command response carries only `{ cancelled }`. Without handling the event the proxy kept serving the previous session's `sessionManager`, `settingsManager`, and mirrored message list while the host had already moved on. Without the suppression the echo raced the runtime's own ordered refresh/rebind, which transports setup entries between two refreshes. The event is deliberately not forwarded to `AgentSession` listeners: it is connection-level, not part of the agent event stream.

### Why an extension could not handle it

- The proxy owns the shared-host binding beneath every extension surface; no extension hook observes the connection's replacement notice.

### Expected merge conflict zones

- LOW: the wire-event switch in the proxy's `client.onEvent` handler, the replacement methods, and the `refresh` definition.


## 2026-08-30 - Scope host UI dispatch to the shared-host lane

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` treats host-driven extension UI as the optional shared-host capability it is: the constructor calls `setHostUiHandler` only when the runtime provides it, and the request type is declared locally instead of cast through `any`.

### Why

- Host-driven extension UI is a shared-host capability. An unconditional constructor call plus a no-op stub on the classic runtime made a host-only concern part of the classic construction contract, so classic mode construction was no longer byte-identical.

### Why an extension could not handle it

- Interactive-mode construction and the runtime capability surface are core wiring beneath the extension API.

### Expected merge conflict zones

- LOW: the host-UI probe in the `InteractiveMode` constructor.

## 2026-08-30 - Forward shared-host switch cwd overrides

- `interactive-host-runtime.ts` forwards the `cwdOverride` field explicitly when the interactive proxy requests a shared-host session replacement, preserving the host-effective cwd through the RPC boundary and subsequent proxy refresh.

### Why

- The interactive runtime's switch options also carry local callbacks. Selecting the wire-supported cwd field explicitly prevents the shared-host request from depending on the broader local callback shape.

## 2026-08-29 - Propagate shared-host bash callback failures

### What changed

- `interactive-host-runtime.ts` now observes asynchronous remote bash output callbacks, aborts the host command on rejection, and rethrows the original callback failure at the client execution boundary.

### Why

- Shared-host bash output callbacks could reject after a successful RPC response, leaving host spill files behind and emitting an unhandled rejection.

### Why an extension could not handle it

- The callback crosses the RPC event boundary inside the built-in interactive host runtime proxy.

### Expected merge conflict zones

- LOW: shared-host bash wire-event handling and the remote executeBash proxy.

## 2026-08-29 - Render external-owner compaction delegation once, as state (#1174 UX half)

### What changed

- `interactive-mode.ts`: auto compaction rejections with `rejectionCause: "external-owner"` now render a
  single muted informational line ("The Claude Agent SDK manages and compacts this session's context
  natively.") at most once per delegation episode, instead of repainting a red error line on every
  rejected attempt. Manual `/compact` rejections keep their explicit error feedback. The episode is
  tracked entirely in the interactive layer from observed `compaction_end` events: it starts on an
  external-owner rejection and the one-time notice re-arms on a successful compaction, a model switch
  (selector, keyboard/favorite `cycleModel`, or retry provider failover via `retry_fallback_applied`),
  a session rebind, a session reload, tree/branch navigation rerenders
  (`renderInitialMessages`), a `model_changed` event (including shared-host/other-client
  switches), or retry provider failover via `retry_fallback_applied`; cosmetic transcript
  rebuilds (hide-thinking, cache-notice visibility, output padding via
  `rebuildChatFromMessages`) deliberately preserve the episode, because post-#1188 core
  emits no repeat rejection event to restore cleared state. The logic does not depend on
  repeat rejection events arriving (the core attempt-suppression half of #1174 landed in
  #1188). The
  external-owner branch is checked before the `aborted` branch because production rejections are
  emitted via `_rejectCompaction(..., true, reason)` and carry `aborted: true`.
- `components/footer.ts`: the context meter appends an ` (SDK)` marker while a delegation episode is
  active, so a saturated meter reads as "compacted natively by the SDK" rather than a stall. The marker
  rides the existing tail segment and respects the footer width ladder; when head elision would leave a
  chopped fragment (e.g. "…SDK)"), the layout is re-planned without the marker so it renders complete or
  not at all. The marker stays muted even when the >90% meter is error-tinted — delegation is expected
  state, not alarm.
- `grok/chrome.ts`: `InteractiveFooter` gains the optional `setCompactionDelegated` seam that feeds the
  marker.

### Why

- Issue #1174: once the local context estimate crossed the compaction threshold on the claude-sdk-oauth
  lane, every turn repainted the same red error line (twice per tool-call turn), presenting a designed
  stand-down as a recurring failure, and the saturated context meter looked like a stall instead of
  SDK-owned state.

### Why an extension could not handle it

- The `compaction_end` rendering branch, the chat container, and the footer meter segments are private
  `InteractiveMode`/footer render state; extensions observe compaction events but cannot restyle or
  dedupe the built-in error rendering.

### Expected merge conflict zones

- LOW: the `compaction_end` error branch in `interactive-mode.ts`; the context segment composition in
  `components/footer.ts`; the footer seam in `grok/chrome.ts`.

## 2026-08-28 - Hydrate setup-only proxy mirrors from host state

- Proxy refresh now hydrates the explicit session path with authoritative host entries when deferred persistence has not created the file yet, so setup entries are visible immediately in replacement contexts.

- Shared-host setup callbacks now run against a detached capture and transport appended custom/user messages to the authoritative host before proxy refresh and rebind.

- Shared-host proxy refresh now carries the host's project trust state into local settings, preventing untrusted project-scoped shell prefixes from leaking into client-local bash (NF-3).
- Shared-host setup callbacks refresh the replacement proxy's mirrored agent messages after setup mutations.
- Replacement callback contexts route sendMessage/sendUserMessage through the shared host prompt path instead of retaining bootstrap-session closures.
- The RPC surface has no host-honored project-trust command or replacement trust payload. Shared-host trust is host-authoritative: the client-side projectTrustContextFactory remains a compatibility callback but cannot override host trust; no new wire protocol is introduced (N4-B9).

- Shared-host bash lifecycle now composes client-local and host-owned running state, so another client's bash events cannot clear a local operation (NF-1).
- Shared-host replacement wrappers preserve client-side `setup`, `withSession`, and `projectTrustContextFactory` callbacks after host confirmation and proxy refresh, matching beta.22 callback ordering (N4-B9).
- Successful shared-host session replacements abort in-flight client-local custom bash and guard result persistence against the replacement session (NF-2).
- Proxy refresh rebuilds the client-local settings surface for the host-effective session cwd, so custom bash uses the current project's shell prefix (NF-3).

- Shared-host replacement and name readback closure: refreshed session managers retain the host-effective cwd (including a differing override when the stored cwd is unavailable), and all `getSessionName()` consumers read the mirrored `session_info_changed` name.

## Shared-host interactive parity regressions (2026-08-28)

- Shared-host session replacement now refreshes the client proxy after /new, /fork, /import, and /resume; tree navigation, reload/veto, compaction abort, queue recovery ordering, bash options/output, model prompt metadata, and JSONL export route to the authoritative host session.
- RPC state mirrors host compaction, retry, bash, and pending-queue lifecycle fields so TUI interrupt and reload guards do not consult the bootstrap session. Queue reads/clear, branch-summary abort, extension-handled bash persistence, and tree labels also route to the host.
- Extension binding remains client-local under the shared host by design: extension UI callbacks and context objects contain local TUI resources that cannot be serialized over JSONL. Session replacement refreshes the proxy identity before rebinding, while no RPC binding route is introduced.
- Bash `operations` are not serialized as executable callbacks. Shared-host interactive execution keeps client-local operations on the client, streams their output to the TUI, and sends only the resulting `record_bash_result` mutation to the host; client-local execution preserves shell prefixes, abort-controller lifecycle, and proxy `isBashRunning` state. Serializable or absent operations continue through the host bash route. Host-side extension dispatch remains unchanged.
- Shared-host queue state now hydrates on attach/refresh, mirrors ordered chronology on every host `queue_update`, preserves the host's ordered clear result as the proxy's non-enumerable `ordered` property, carries the host-effective cwd through replacement refreshes, and routes `getSessionName()` consumers through mirrored host state.

## Shared-host session replacement refreshes the interactive proxy (2026-08-28)

### What changed

- `interactive-host-runtime.ts` refreshes the shared host's state and messages after a successful `switch_session`,
  then updates the interactive proxy's session manager, identity, cwd, and message history before rebinding the TUI.
- `test/interactive-host-runtime.test.ts` switches to a second persisted session carrying a blocked Goal and pins
  that the RPC request completes while the proxy exposes the target session file, ID, manager, and historical user
  message.

### Why

- The shared RPC host changed its authoritative session, but the interactive proxy remained permanently bound to the
  local bootstrap session. `/resume` therefore reported success while the TUI returned to an empty composer with the
  old `0/1M` footer and no target history.

### Why an extension could not handle it

- The proxy owns transport state and the `AgentSessionRuntime` seam before extension events reach the TUI. Extensions
  cannot replace the proxy's session identity, manager, or message mirror after an RPC session replacement.

### Expected merge conflict zones

- LOW in `interactive-host-runtime.ts` around remote session replacement and proxy property routing.

## Shared-host compaction context synchronization and resilient transcript rebuild (2026-08-28)

### What changed

- `interactive-host-runtime.ts`: on `compaction_end` wire events from the host, the remote session proxy calls `reloadFromDisk()` on `local.sessionManager` and updates `local.agent.state.messages` to the refreshed context messages.
- `interactive-mode.ts`: `compaction_end` handler no longer throws a fatal error when `entries[0]?.type !== "compaction"`; instead, it attempts `sessionManager.reloadFromDisk()` and gracefully renders the remaining context entries with the compaction summary card and usage billing notice. `rebuildChatFromMessages()` also attempts `reloadFromDisk()` before querying `buildContextEntries()`.
- `session-manager.ts`: added `reloadFromDisk()` to reload `fileEntries` and rebuild the index from the session file on disk when modified externally.

### Why

- When running with the shared interactive host, a successful compaction committed by the host was not immediately present in the client-side `sessionManager` memory, causing `entries[0]?.type !== "compaction"` to throw `Completed compaction is missing from the session context` and crash the TUI (issue #1173). Full transcript rebuilds also suffered from stale local session state (issue #1172).

### Why an extension could not handle it

- `InteractiveMode`'s compaction handler and `interactive-host-runtime.ts` proxy event pipeline are internal to the interactive runtime and cannot be overridden by extensions.

### Expected merge conflict zones

- LOW: `interactive-mode.ts` `compaction_end` case and `interactive-host-runtime.ts` wire event handling.
## Explain disk-capacity failures during uncaught interactive shutdown (2026-08-29)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: after restoring a live
  terminal and recording the redacted crash log, `uncaughtCrash` now identifies `EDQUOT` and
  `ENOSPC` errors and prints a stable disk-quota or disk-full remedy before the existing fatal
  banner and original error.

### Why

- A filesystem spill write can still reach the last-resort crash path. The generic banner preserved
  the original error but did not tell the operator that local storage or quota was exhausted or
  that freeing filesystem capacity before retrying is the recovery action.

### Why an extension could not handle it

- `uncaughtCrash` is the process-level listener installed by interactive mode and exits
  synchronously after terminal restoration. An extension cannot insert guidance between that
  restoration and `process.exit(1)`, and its own listener would run after the prepended core
  listener has already exited.

### Expected merge conflict zones

- LOW: the final live-terminal output sequence in `InteractiveMode.uncaughtCrash` and the adjacent
  error-code classifier.

## Shared-host sessions await async session reads and render thinking level from the event (2026-08-28)

### What changed

- `interactive-host-runtime.ts`: new `InteractiveSession` type — the TUI-facing session contract that widens `cycleThinkingLevel`, `getAvailableThinkingLevels`, `getSessionStats`, and `getUserMessagesForForking` to `T | Promise<T>` so the shared-host proxy is honestly typed. The proxy's `prompt` now forwards `streamingBehavior`, `thinkingLevel`, and the optimistic-echo `promptDisposition`/`preflightResult` callbacks across the wire, and fire-and-forget setters report RPC failures through a new `interactive_host_action_failed` warning instead of swallowing them.
- `interactive-mode.ts`: the Shift+Tab handler awaits the cycle and only renders the unsupported-model branch; the level status/footer render from the `thinking_level_changed` event (single path for local, remote, and other attached clients). `/settings` thinking levels, `/fork` message list, and `/session` stats await their reads. No more `Thinking level: [object Promise]`.
- `components/footer.ts`, `grok/chrome.ts`, `grok/footer.ts`: session parameters accept `InteractiveSession`.

### Why

- Since the shared RPC host became the default for interactive sessions, the proxy answered these four reads with Promises while the TUI consumed them synchronously: Shift+Tab printed `[object Promise]`, the settings selector lost low/med/high options, and `/fork` + `/session` broke. Event-driven level rendering also fixes multi-client convergence (desktop + terminal on one host session).

### Why an extension could not handle it

- The session contract and key-dispatch handlers are core interactive wiring; extensions cannot retype or resequence them.

### Expected merge conflict zones

- MEDIUM: `interactive-mode.ts` handler/event-case edits and the session getter type.
- LOW: proxy setter overrides in `interactive-host-runtime.ts`.
## Footer shows the active credential account (2026-08-27)

### What changed

- `packages/coding-agent/src/modes/interactive/components/footer.ts`: when the active provider pools more than one credential slot, the footer's provider prefix becomes `(provider@account)` - the pinned slot when present, else the session's HRW winner computed with the same sha256 hash the rotation engine uses. Flat single credentials render exactly as before, and a credential-storage read failure never breaks footer rendering. Exported `accountFooterSuffix` keeps the logic unit-testable.

### Why

- With rotation on by default, the operator needs to see WHICH account a session is riding without opening /account; mirroring the provider-only-when->1 rule keeps single-account setups noise-free.

### Why an extension could not handle it

- The footer is a core interactive component; extensions cannot compose its right-side segments.

### Expected merge conflict zones

- LOW: right-side prefix composition in `formatSegments`.

## 2026-08-26 - Record uncaught crashes in the brand debug log

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: `uncaughtCrash` calls
  `appendUncaughtCrashLog(origin, error)` immediately before `restoreInteractiveStderr()`, wrapped
  in a `try {} catch {}` so a failed log write cannot alter the crash path. Ordering, exit code,
  and the stderr banner are unchanged.
- `emergencyTerminalExit()` takes a required `{ origin, error }` crash context and makes the same
  guarded `appendUncaughtCrashLog` call before its unguarded cleanup, so the silent exit-129 path
  also leaves a record. Both call sites supply it: the dead-terminal branch of `uncaughtCrash`
  (`dead-terminal <origin>`) and the stdout/stderr `terminalErrorHandler` (`dead-terminal stdio
  error`). The parameter is required rather than optional so no future caller can reintroduce a
  silent exit with no record.

### Why

- `uncaughtCrash` restores the real stderr and prints the banner to the terminal, so a crash only
  ever existed in terminal scrollback. When the terminal is closed — or when the crash *is* a
  terminal/EIO failure — the diagnosis has zero evidence; the 2026-08-26 EIO investigation found no
  crash record in the brand debug log for exactly this reason. Writing before the terminal handoff
  means the record survives the very failures that destroy the scrollback.
- The dead-terminal class is the worst case and needed `emergencyTerminalExit` covered too: it exits
  129 with no banner *by design* (the terminal is gone), so before this the entire EIO crash class
  — the one the investigation was chasing — produced no output anywhere at all. Verified against a
  real detached pty: closing the master under a live session now records
  `uncaught crash (dead-terminal stdio error)` with the full `EIO: i/o error, write` stack, where
  the same run previously left the log file non-existent.

### Why an extension could not handle it

- The handler is the process-level `uncaughtException` listener the interactive mode installs, and
  it exits the process a few statements later. No extension hook runs inside that window, and an
  extension's own `process.on("uncaughtException")` would be appended after this prepended listener,
  i.e. after `process.exit(1)`. `emergencyTerminalExit` is stricter still: it is reached from the
  stdout/stderr `error` handler and exits synchronously, so nothing outside core runs at all.

### Expected merge conflict zones

- LOW: `uncaughtCrash` and `emergencyTerminalExit` bodies in `interactive-mode.ts` (guarded calls,
  one import, and the `emergencyTerminalExit` signature plus its two call sites).

## 2026-08-26 - Append canonical user message after compaction rebuild

### What changed

- `interactive-mode.ts` `renderPendingUserEcho`'s `removePending()` returns the container end when
  the pending echo component is already gone (indexOf -1), so `replace()` appends the canonical
  user message instead of splicing it in before the last child.

### Why

- The `compaction_end` handler clears the chat container and rebuilds it with the compaction
  summary last. The stale echo handle then computed insertionIndex -1, and `splice(-1, 0, ...)`
  inserted the canonical user message above the compaction block, inverting the session-canonical
  order (compaction precedes the user message).

### Why this lives in the fork

- The optimistic pending user echo is a fork-owned chrome feature; upstream has no reconciliation
  path to fix.

### Expected merge conflict zones

- LOW: `renderPendingUserEcho` internals during upstream syncs.

## 2026-08-26 - Route dead-terminal uncaught crashes to the silent emergency exit

### What changed

- `uncaughtCrash` in `interactive-mode.ts` classifies dead-terminal errors and routes them to `emergencyTerminalExit()` (silent 129) instead of printing the `exiting due to uncaughtException` banner and exiting 1. `isDeadTerminalError` now also accepts Bun's raw `errno: 5`/`-5` shape alongside string codes.

### Why

- A stdin read EIO from a detached terminal reached the last-resort handler while `isShuttingDown` was false and printed a crash banner to a terminal that was already gone; the dead-terminal path already existed for write errors and now covers uncaught throws too.

### Why this lives in the fork

- The signal/shutdown choreography (`emergencyTerminalExit`, drain ordering) is fork-owned.

### Expected merge conflict zones

- LOW: `uncaughtCrash` and `isDeadTerminalError` in `interactive-mode.ts` during upstream syncs.

## 2026-08-25 - Do not adopt unwired upstream settings submenu

### What changed

- Deliberately omit `packages/coding-agent/src/modes/interactive/components/settings-submenu.ts`; the fork uses its inline `WarningSettingsSubmenu` implementation.

### Why

- The upstream component has no imports in the fork and adding dead UI code would expand the runtime surface without behavior.

### Why this lives in the fork

- Settings submenu wiring is owned by the fork's settings selector implementation.

### Expected merge conflict zones

- LOW: interactive component additions during upstream syncs.

## Interactive mode re-diverges from upstream dcd4619 (2026-08-25)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` keeps the fork chrome and
  startup coordinator (brand/display version, loader indicator, `sanitizeTerminalLabel`, scoped
  startup thinking, settings diagnostics) on top of upstream's rewrite.
- `packages/coding-agent/src/modes/interactive/external-editor.ts` keeps the `launch-failed` result
  status so EAGAIN-style spawn failures stay distinct from real editor exits.
- `packages/coding-agent/src/modes/interactive/components/thinking-selector.ts` keeps the fork
  `xhigh` label ("Extended reasoning (~32k tokens or native xhigh effort)").

### Why

These are fork-owned product surfaces (senpi branding, provider wire behavior, fork runtime features) that upstream does not carry; the sync must re-assert them on top of upstream's tree.

### Why this lives in the fork

The divergence lives in core wiring, package identity, or build plumbing that executes before any extension loads, so no extension hook can express it.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` is a full-file conflict zone in
  every sync; resolve toward the fork coordinator and re-apply upstream's incremental rendering fixes.

## 2026-08-25 - Render provider abort labels without mutating messages

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` and `packages/coding-agent/src/modes/interactive/aborted-error-label.ts`: render provider watchdog labels from a copied assistant message while retaining the real provider cause in session state.

### Why

- UI labels must not overwrite `finalError`, transcript persistence, or replay data.

### Why an extension could not handle it

- Interactive message rendering owns this label-only presentation boundary.

### Expected merge conflict zones

- LOW: aborted assistant `message_end` rendering paths.

## 2026-08-25 - resume hint uses the brand executable name

### What changed

- `interactive-mode.ts`: `formatResumeCommand()` starts the printed resume command with `APP_COMMAND` instead of `APP_NAME`, so quitting the TUI shows the real binary (`omo --session <id>`) when the brand display name differs.

### Why

- The quit hint is a copy-paste shell command. Printing the display brand (`OmO`) makes the hint fail when the executable is lowercase `omo`.

### Why an extension could not handle it

- The resume hint is assembled inside `InteractiveMode` teardown from session identity; extensions cannot replace that printed line.

### Expected merge conflict zones

- LOW: `interactive-mode.ts` `formatResumeCommand()` argument list.
## 2026-08-24 - provider aborts render with explicit provenance

### What changed

- `abortedErrorLabel` receives internal AgentSession abort provenance so user, system, and source-less provider failures render distinct labels in both streaming and replay/tool-result paths.

### Why

- Provider/watchdog exhaustion must not appear as generic `Operation aborted` or user-style retry cancellation.

### Why an extension could not handle it

- Abort ownership is private AgentSession state consumed by interactive rendering.

### Expected merge conflict zones

- LOW: `interactive-mode.ts` aborted assistant rendering call sites.
## 2026-08-24 — streaming head stays single-written while smooth reveal paces (fixes dual-write flicker)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: `syncTrailingAssistantText` no longer overwrites the streaming head component while `streamingReveal.isPacingHead(head)` is true (smooth streaming on, no toolCall block in the head, component bound). The full-head write still lands when smooth streaming is off, when the head carries a toolCall (the reveal dumps full immediately there), and after the reveal stops at `message_end`. Trailing-segment logic is unchanged.
- `packages/coding-agent/src/modes/interactive/streaming-reveal.ts`: new `isPacingHead(message)` — the single ownership query for the pacing condition.
- `packages/coding-agent/test/tui-streaming-head-single-writer.test.ts`: regression test asserting the streaming component's painted text never shrinks before `message_end` with smooth streaming on (mutation-verified).

### Why

- Every assistant `message_update` wrote the head twice: `streamingReveal.setTarget(head)` painted the paced prefix, then `syncTrailingAssistantText` overwrote the component with the full head, and the next reveal tick repainted the shorter prefix. Painted text visibly vanished and burst back (lengths oscillated `[0, 116, 0, 168, ...]` in the regression capture), and the full/prefix height churn tripped the above-viewport scrollback replay, producing the vertical jumping reported after the 2026.8.22 line shipped.

### Why an extension could not handle it

- The streaming component, reveal pacing state, and per-update write ordering are private `InteractiveMode`/`StreamingRevealController` render state; extensions observe session events only.

### Expected merge conflict zones

- HIGH: `syncTrailingAssistantText` and the `message_update` handler in `packages/coding-agent/src/modes/interactive/interactive-mode.ts` (same hunk as the #1064 segment work).
- LOW: `packages/coding-agent/src/modes/interactive/streaming-reveal.ts` around the new `isPacingHead` query.

## 2026-08-22 - working dock stays painted across queued turn boundaries

### What changed

- `interactive-mode.ts`: `agent_end` keeps the working status mounted; the dock clears on the new core `agent_idle` event (not `agent_settled`) only when no locally buffered input is waiting. An `agentIdle` latch is set on `agent_idle` and cleared on `agent_start`. The main input loop composes the optimistic-echo `promptDisposition` so a buffered prompt that resolves `handled` (for example a `UserPromptSubmit` hook block) clears the retained dock while idle; the prompt-admission catch still clears it when a dequeued prompt throws before `agent_start`.
- `clearStatusIndicator` measures the outgoing status container before clearing and uses that height for the regular-mode clear-on-shrink idle placeholder, capped to the terminal height. `IdleStatus` now accepts a reserved height while retaining its two-row default.

### Why

- Clearing the four-row working dock at `agent_end` and remounting it at the next `agent_start` moved the editor/footer between adjacent agentic turns. Clearing on the public `agent_settled` was still too early: settlement-deferred continuations (TTSR, loop-guard, goal recovery) start a turn after that event, re-bouncing the dock, and a locally buffered prompt consumed with `action: "handled"` never produced another lifecycle event to clear it. `agent_idle` fires only after deferred turns resolve with no run started, giving one race-free cleanup boundary. The old hardcoded two-row idle placeholder also allowed a four-row dock to shrink by two rows during clear-on-shrink rendering.

### Why an extension could not handle it

- Agent lifecycle rendering, locally buffered prompt admission, status-container ownership, and clear-on-shrink placeholders are private `InteractiveMode` state.

### Expected merge conflict zones

- `interactive-mode.ts` around the main input-loop disposition composition, `clearStatusIndicator`, and the `agent_start`/`agent_settled`/`agent_idle` handlers.
- `components/status-indicator.ts` around `IdleStatus`.

## 2026-08-21 — assistant text segments keep their painted position between tool cards (fixes #1064)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: `syncTrailingAssistantText` no longer reabsorbs trailing assistant text into the streaming head when the next toolCall arrives. The streaming component now owns only the content through the FIRST toolCall (`assistantStreamingHeadMessage`, also used for the reveal target and the `message_start` reveal begin); every text run after the first toolCall is painted by its own persistent `AssistantMessageComponent`, keyed by its start block index, inserted before the following tool card (or appended at the end) and updated in place while live. `agent_end` and the session-rebuild path detach/clear those segments through `detachAssistantTextSegments()`; `message_end` keeps them as the final layout.
- Removed `packages/coding-agent/src/modes/interactive/split-trailing-assistant-text.ts` (dead after the rewrite) and its `990-trailing-assistant-text` test. The trailing-below-last-card behavior that fix delivered is preserved and now covered, together with the chronological invariant, by `packages/coding-agent/test/suite/regressions/1064-assistant-text-segment-teleport.test.ts`.

### Why

- The split/trailing approach painted text after the last toolCall below the tool cards, then detached it and folded its text back into the streaming component — which renders ABOVE every tool card — as soon as the next toolCall arrived. Every narration/tool boundary therefore teleported a painted text block upward across a tool card, so turns with many tool calls made the transcript visibly shake up and down (field report 2026-08-21, after the 2026.8.20 line shipped). Middle segments also stayed permanently above every tool card, so even the settled layout was not chronological.

### Why an extension could not handle it

- The streaming component, tool-card insertion order, and per-message component ownership are private `InteractiveMode` render state. Extensions observe session events only and cannot decide where a painted component lives inside the transcript container.

### Expected merge conflict zones

- HIGH: `syncTrailingAssistantText`, the `message_start`/`message_update` reveal-target wiring, and the `agent_end` cleanup in `packages/coding-agent/src/modes/interactive/interactive-mode.ts`; any upstream refactor of the streaming render path collides here.
- LOW: the removed `split-trailing-assistant-text.ts` (fork-added file, now deleted; upstream never carried it).

## 2026-08-21 - Queued input renders as waiting state, not as a sent message

### What changed

- `interactive-mode.ts`: `OptimisticUserEchoController.promptOptions` now keeps an optimistic pending user bubble only when its prompt's `promptDisposition` is `started`. `queued` (steer/follow-up while streaming) and `handled` dispositions unpaint the bubble, so waiting input renders exclusively through `updatePendingMessagesDisplay` (dim `Steering:`/`Follow-up:` lines + dequeue hint) until canonical delivery, matching upstream pi semantics where user messages appear only at `message_start`.
- `interactive-mode.ts`: `queueCompactionMessage` no longer begins an optimistic echo. Compaction-queued input has no prompt lifecycle until transfer, so its echo could never be resolved by a disposition (the `deliverQueued` transfer path never fires one), leaving a phantom sent-looking message forever.

### Why

- The optimistic echo feature (2026-08-21 below) made prompts submitted while the agent was streaming look already sent at their submission position; the queued/waiting state disappeared and message ordering diverged from actual delivery order. Reported against omo-ai 5.0.0-0.beta.14 (senpi v2026.8.21/-2).

### Why an extension could not handle it

- Same seam as the original feature: pending-echo records and their reconciliation are interactive-mode internals.

### Expected merge conflict zones

- `interactive-mode.ts` `OptimisticUserEchoController.promptOptions` and `queueCompactionMessage`.


## 2026-08-21 - Model selection releases the selector before the auth round trip

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: `selectModelFromUi` now calls `done?.()` and `ui.requestRender()` *before* awaiting `session.setModel(model)`, instead of only after it resolves. The error path no longer double-releases.

### Why

- `ModelSelectorComponent.handleSelect` disposes the overlay synchronously on Enter, but the selector was only released after `setModel` resolved. `AgentSession._setModel` awaits `modelRuntime.checkAuth(provider)` as its first step, which for subscription-OAuth providers (Cursor) is a network round trip. Between Enter and that resolution the TUI held a torn-down-but-unreleased overlay with no repaint, so the screen appeared frozen on the old model while the switch was in flight.

### Why an extension could not handle it

- Selector lifecycle and overlay release are interactive-mode internals with no extension seam.

### Expected merge conflict zones

- `interactive-mode.ts` around `selectModelFromUi` (line ~6460).


## 2026-08-21 - Optimistic pending user echo

### What changed

- `interactive-mode.ts`: Enter submissions now paint a TUI-local pending user bubble immediately, mark it eligible only after its own `promptDisposition` is `queued` or `started`, and replace it only when an eligible canonical user `message_start` arrives. Foreign user events are appended normally. Rejected and handled inputs unpaint their own pending bubble, and compaction queue cleanup removes only the queue records it owns.
- `compaction-queue-transfer.ts`: queued compaction records carry the TUI-local pending echo id without entering session messages or persistence.
- `packages/coding-agent/test/suite/optimistic-pending-user-echo.test.ts`: covers foreign user events, immediate rendering, exactly-once replacement, rejection/handled cleanup, FIFO queue reconciliation, and render-only persistence.

### Why

- Interactive input previously waited behind session admission gates before its user bubble appeared, creating a measured 0.45s p50 perceived submit delay. The TUI must distinguish its own accepted prompt lifecycle from extension and RPC prompts that can emit user events into the same session.

### Why an extension could not handle it

- Pending records must be created before AgentSession admission and reconciled with private interactive rendering at canonical `message_start`; extensions cannot identify or replace these built-in TUI components without persisting a fake message.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` submit handlers, user `message_start` reconciliation, and compaction queue reset/transfer paths.
- `packages/coding-agent/src/modes/interactive/compaction-queue-transfer.ts` pending echo metadata.

## 2026-08-20 - Resumed transcripts paint the visible tail first

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: the chat transcript now uses `ProgressiveTranscriptContainer`.
- `packages/coding-agent/src/modes/interactive/components/progressive-transcript-container.ts`: the first frame renders a bounded tail of real message/tool components, then warms earlier components in bounded macrotask chunks and requests one exact full-history repaint.

### Why

- Resuming a large session eagerly Markdown-rendered every persisted component before the first useful frame. Thousands of off-screen messages could block the TUI for hundreds of milliseconds even though the user initially sees only the transcript tail.
- Progressive hydration preserves the exact full output and component styling while moving off-screen cache warming out of the input-critical path.

### Why an extension could not handle it

- Initial transcript component construction, chat-container ownership, clearing, disposal, and renderer invalidation are private `InteractiveMode` lifecycle state; extensions cannot replace the built-in transcript container.

### Expected merge conflict zones

- LOW: `packages/coding-agent/src/modes/interactive/interactive-mode.ts` chat-container import and constructor.
- LOW: the new progressive transcript container is a fork-owned component.

## 2026-08-20 - Trailing assistant text renders below the last tool card

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: split trailing text/thinking after the last `toolCall` onto a sibling `AssistantMessageComponent` placed after the tool cards.
- `packages/coding-agent/src/modes/interactive/split-trailing-assistant-text.ts`: extract head (through last toolCall) vs tail (trailing text/thinking).

### Why

- All assistant text lived in the first `AssistantMessageComponent` above the tool stack. Text after the last `toolCall` updated that blob, so a pending eval hid the approval question.

### Why an extension could not handle it

- Layout of streaming assistant messages and tool cards is inside InteractiveMode; no extension hook sits between `message_update` / `message_end` and the chat container.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` `message_update` / `message_end`.
- `packages/coding-agent/src/modes/interactive/split-trailing-assistant-text.ts`
## 2026-08-20 - Late tool_execution_end still draws a TUI card

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: on `tool_execution_end`, create a tool execution card when `pendingTools` misses the id, then reveal and update the result.

### Why

- Cursor can emit `tool_execution_end` without a matching start card, so the result never appeared in the TUI.

### Why an extension could not handle it

- Tool-execution cards are constructed inside InteractiveMode from session events; no extension hook sits between `tool_execution_end` and the chat container.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` `tool_execution_end` case.

## Large-session retry indicator cadence (2026-08-20)

### What changed

- Retry status indicators now reuse the existing large-session cadence policy instead of advancing their decorative spinner every 80 ms.
- Sessions below the 1,000-entry boundary retain the existing animated retry indicator, while large sessions keep the independent one-second retry countdown visible.

### Why

- Every retry spinner frame requests a whole-TUI render. During provider rate-limit waits, large persisted sessions could spend an entire JavaScript core repeatedly rebuilding the transcript even though the network retry itself was sleeping.

### Why an extension could not handle it

- Retry lifecycle events, persisted session entry counts, status-indicator construction, and TUI render scheduling are owned by the built-in interactive runtime.

### Expected merge conflict zones

- LOW: `interactive-mode.ts` around `showRetryStatusIndicator()`.
- LOW: `components/status-indicator.ts` around the retry indicator constructor.
- LOW: `interactive-tui.test.ts` around retry status cadence coverage.

## Canonical interactive notice cards (2026-08-20)

### What changed

- Loaded-resource diagnostics, version and package updates, risky-model and high-reasoning warnings, debug-log completion, and the Earendil announcement text now render through `buildNoticeBox`.
- Existing notice text, diagnostic severity, changelog hyperlink behavior, package lists, and the optional Earendil image remain intact.

### Why

- These multi-line notice cards used independent borders and foreground styling, so they diverged from the shared transcript notice background and title contract.

### Why an extension could not handle it

- These surfaces are constructed directly by `InteractiveMode` or its built-in announcement component; extensions cannot replace their internal TUI components after insertion.

### Expected merge conflict zones

- MEDIUM: `interactive-mode.ts` loaded-resource diagnostics and notification helpers; LOW: `components/earendil-announcement.ts` textual banner construction.

## Trailing assistant text renders below the last tool card (2026-08-19)

Text that arrives after the last `toolCall` is split onto a sibling `AssistantMessageComponent` placed after the tool cards. Approval questions no longer hide above a pending eval stack.

Conflict zone: `interactive-mode.ts` `message_update` / `message_end`.

## Interactive chrome, queued-input recovery, and smooth-streaming settings after the 59a71b23 pin (2026-08-19)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` stays
  divergent from upstream pin
  `59a71b235dadb4ad0d67557a8abb0aaa093e68b4`. It keeps the fork's
  compaction queue recovery: on `compaction_end` a completed compaction
  flushes the queue, a `willRetry` outcome defers admission and reports
  "will send with the next turn" with a `compaction_queue_deferred` session
  log, and a compaction that neither completed nor will retry restores the
  held messages into the editor (`restoreQueuedMessagesToEditor()`) with a
  `compaction_queue_restored` log — where upstream only clears the queue.
  Image-bearing submissions during compaction are still dropped with a
  visible status because the queue carries text only.
- `interactive-mode.ts` also keeps the pluggable chrome
  (`InteractiveChrome`/`GrokChrome`, chrome-owned editor, footer, welcome
  content and root arrangement), the `StreamingRevealController` smooth
  streaming path with `applySmoothStreamingRenderFps()`, the tips runtime
  (`TIP_DEFINITIONS`, startup/working tips, `recordTipShown()`), the
  shimmering working-status and tool-hook status rows with `APP_TITLE`
  terminal titles, keybindings-file editing, and extension notice boxes.
- `packages/coding-agent/src/modes/interactive/components/settings-selector.ts`
  keeps the fork's `Smooth streaming` and `Streaming fps` rows in
  `SettingsConfig`/`SettingsCallbacks` (with the 30/60/90/120 value list and
  `onSmoothStreamingChange`/`onSmoothStreamingFpsChange` dispatch) and the
  `xhigh` thinking description that names native xhigh effort, both absent
  from the new pinned tree.

### Why

- Queued steering input is user text that must never be silently discarded
  when compaction fails or retries; the chrome, tips, smooth streaming, and
  status animation are fork product surfaces, and the settings selector must
  expose the fork-only settings that back them.

### Why an extension could not handle it

- The compaction queue, chrome selection, and streaming reveal are private
  `InteractiveMode` state driven by session events; the settings selector is
  a built-in TUI component wired directly to `SettingsManager`.

### Expected merge conflict zones

- MEDIUM: the `compaction_end` case in the session-event switch of
  `interactive-mode.ts`, and its constructor/render wiring where chrome and
  streaming reveal are installed.
- LOW: the settings row list and switch arms in `settings-selector.ts`.

## Pasted image markers keep canonical numbering and survive undo with their payloads (2026-08-18)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`:
  `reconcilePendingImages()` now clears and refills the SAME `pendingImages`
  map instead of reassigning it, so `handleClipboardPaste`'s by-reference handoff
  into `attachClipboardImage` can never write into an orphaned map;
  `subscribeImageMarkers()` wires the editor's new
  `snapshotAttachmentState`/`restoreAttachmentState` hooks so undo restores
  the payload map alongside the marker text; `queueCompactionSubmission()`
  (called from the submit handler's steer branch and `handleFollowUp`)
  consumes image-bearing submissions during compaction with a visible drop
  status and strips their dead literal markers from the queued text.
- Regression coverage: `test/interactive-mode-clipboard-paste.test.ts` and
  `test/interactive-mode-image-submission.test.ts` now drive a REAL pi-tui
  `Editor` through the REAL paste/notify/submit path (two in-order pastes,
  paste-before-marker, delete+undo payload restore, compaction drops).

### Why

- The second paste in a turn destroyed its own image:
  `insertImageMarker()` fired `onImageMarkersChanged` synchronously, the
  reconciler replaced the map's identity, and the subsequent
  `pendingImages.set(id, ...)` wrote into the orphaned map - shipping
  `[Image #1][Image #2]` with one image. An out-of-order paste (Home then
  paste) shipped `[Image #2][Image #1]` and mispaired the survivor, so
  `look_at("[Image #1]")` resolved to the wrong attachment or threw. Undo
  after a whole-marker delete restored the marker text but not its payload,
  permanently destroying that image. Alt+Enter during compaction consumed and
  silently discarded pasted images.

### Why an extension could not handle it

- `pendingImages`, the marker notification wiring, and the compaction queue
  are private `InteractiveMode` composer state; extensions receive neither the
  marker-id stream nor a hook into the submit/compaction decision points.

### Expected merge conflict zones

- MEDIUM: `reconcilePendingImages()` and `subscribeImageMarkers()` in
  `interactive-mode.ts` (adjacent to the paste handler wiring), and
  `queueCompactionSubmission()` next to `queueCompactionMessage()`.

## Native Cursor login refreshes the CLI fallback lane in the same session (2026-08-18)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`:
  `completeProviderAuthentication()` refreshes both `cursor` and
  `cursor-cli-oauth` after native Cursor login. Every other provider remains
  scoped to its own id, and the existing network/abort/warning behavior is
  unchanged.

### Why

- The fallback lane now bootstraps automatically from the native Cursor OAuth
  credential. Refreshing only `cursor` after `/login cursor` left the CLI
  provider unavailable until a later model-availability refresh or restart.

### Why an extension could not handle it

- The post-login refresh controller and provider list are private
  `InteractiveMode` lifecycle state; the fallback extension receives no
  callback that can extend the native provider's completed login refresh.

### Expected merge conflict zones

- LOW: the provider-list construction immediately before the existing
  `modelRuntime.refresh()` call.

## Extension widget updates preserve stacking order (2026-08-18)

### What changed

- `setExtensionWidget()` in `interactive-mode.ts` no longer deletes and re-appends the updated key on every call. It now removes the key only from the OTHER placement map, disposes the replaced component, and writes through `Map.set`, which keeps an existing key at its insertion position. Removal (`content === undefined`) still deletes from both maps, and a placement change still appends the key at the end of the new placement.
- Regression coverage: `test/interactive-mode-widget-order.test.ts` drives the real `setExtensionWidget` / `renderWidgets` / `renderWidgetContainer` methods and pins that belowEditor and aboveEditor stacking order survives content updates, removals, and placement moves.

### Why

- Every widget refresh used to move the refreshed key to the end of its placement map, so two live widgets with independent refresh timers swapped vertical positions on every paint. With omo-senpi's `omo-task` (250 ms live refresh) and `omo-dag` (1 s live refresh) widgets both active, the below-editor region visibly bounced up and down several times per second.

### Why this cannot be expressed externally

- The stacking maps and `renderWidgets()` are private core state; extensions can only call `setWidget`, not control where an update lands.

### Expected merge conflict zones

- LOW: the body of `setExtensionWidget()` in `interactive-mode.ts` only.

## Post-login provider catalog refresh explicitly allows network discovery (2026-08-18)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`:
  `completeProviderAuthentication()` now passes `allowNetwork: true` to its
  existing provider-scoped, 15-second background refresh after successful
  OAuth/API-key login.

### Why

- Ordinary interactive runtimes default model networking off. The post-login
  refresh inherited that default, so dynamic providers such as native Cursor
  stored valid credentials but restored only cached models instead of
  fetching the authenticated account catalog immediately.

### Why an extension could not handle it

- Login completion, its bounded refresh controller, and the status/warning UI
  are private `InteractiveMode` lifecycle code. Provider extensions cannot
  alter the options on the core refresh that runs after their login returns.

### Expected merge conflict zones

- LOW: the single `modelRuntime.refresh()` option object inside
  `completeProviderAuthentication()`.

## Repository-wide changes.md audit backfill for interactive rendering, selectors, and editor surfaces (2026-08-17)

### What changed

- Backfill from the repository-wide changes.md audit (pin `914cf147`, tag v0.84.2): this entry names every upstream-owned interactive production path that still diverges from the pinned upstream tree. Detailed behavioral history stays in the dated entries of this file; the entries added by this backfill carry the rest.
- Transcript renderers: `packages/coding-agent/src/modes/interactive/components/assistant-message.ts` (incremental descriptor reconciliation, per-section thinking-duration headers, compact provider-native web-search rendering, descriptor extraction into `assistant-render-descriptors.ts`), `packages/coding-agent/src/modes/interactive/components/tool-execution.ts` (lifecycle/renderer/images split, todo-strike reveal, animation teardown), `packages/coding-agent/src/modes/interactive/components/bash-execution.ts` (bash syntax highlighting in the command header), and `packages/coding-agent/src/modes/interactive/components/compaction-summary-message.ts` (OpenAI remote compaction details plus display-only escape sanitization).
- Selectors: `packages/coding-agent/src/modes/interactive/components/model-selector.ts` (ranked search with favorites-first partition and frozen favorite ordering), `packages/coding-agent/src/modes/interactive/components/extension-selector.ts` (windowed option lists), `packages/coding-agent/src/modes/interactive/components/settings-selector.ts` (smooth-streaming and streaming-fps controls), `packages/coding-agent/src/modes/interactive/components/status-indicator.ts` (bounded single-row compaction progress with the compact-label collapse), `packages/coding-agent/src/modes/interactive/components/tree-selector.ts` (providerNative content blocks count as non-empty text), `packages/coding-agent/src/modes/interactive/components/thinking-selector.ts` (extended xhigh wording), and `packages/coding-agent/src/modes/interactive/components/scoped-models-selector.ts` (still consumed directly for scoped-model configuration; its components-barrel export moved to the favorites selector and the residual diff is comment/format churn).
- Editor and footer surfaces: `packages/coding-agent/src/modes/interactive/components/custom-editor.ts` (prompt marker and padding floor), `packages/coding-agent/src/modes/interactive/components/diff.ts` (intra-line highlighting with the single-span fast path), `packages/coding-agent/src/modes/interactive/components/keybinding-hints.ts` (`escape` displays as `esc`), `packages/coding-agent/src/modes/interactive/components/footer.ts` (anchor-pinned width ladder, fast-mode glyph, abbreviated tokens; OmO badge removed), `packages/coding-agent/src/modes/interactive/components/index.ts` (exports `FavoriteModelsSelectorComponent`, drops `ScopedModelsSelectorComponent`), `packages/coding-agent/src/modes/interactive/external-editor.ts` (launch-failure discrimination plus the `editFileInExternalEditor()` seam), and `packages/coding-agent/src/modes/interactive/theme/theme.ts` (grok-night/grok-day built-in themes, theme proxy through `Reflect.get`).

### Why

- Merges resolve tracker files to `ours`, so every divergent upstream-owned path needs an entry in its exact nearest tracker that names it; the audit and the next upstream sync read this inventory instead of silently dropping fork behavior.

### Why an extension could not handle it

- These files are the built-in interactive renderer, selector, editor, and theme surfaces themselves. Extension hooks compose around them but cannot replace their private render paths, selector callbacks, or settings writes.

### Expected merge conflict zones

- MEDIUM: `packages/coding-agent/src/modes/interactive/components/assistant-message.ts`, `packages/coding-agent/src/modes/interactive/components/tool-execution.ts`, `packages/coding-agent/src/modes/interactive/components/footer.ts`, and `packages/coding-agent/src/modes/interactive/components/model-selector.ts` (heavily rewritten render paths).
- LOW: the remaining component files, `packages/coding-agent/src/modes/interactive/external-editor.ts`, and the builtin-theme loading in `packages/coding-agent/src/modes/interactive/theme/theme.ts`.

## Custom editor keeps its prompt marker and configured padding (2026-08-17)

Landed 2026-08-03 (commits 5573069b1 and ce53fc60d).

### What changed

- `packages/coding-agent/src/modes/interactive/components/custom-editor.ts`: the composer reserves a prompt gutter of at least two columns (`promptPaddingX = max(2, configured)`) while `getPaddingX()`/`setPaddingX()` report and accept the configured value, so `paddingX: 0` no longer erases the gutter and custom editors keep the padding they were handed (companion to the `paddingX` propagation on pi-tui's `EditorComponent`).
- `render()` draws the themed `❯` prompt marker on the first content row and keeps it there when the draft wraps; the marker is skipped only for the history-scroll `↑` row and terminals narrower than five columns.

### Why

- A small or zero `paddingX` collapsed the prompt gutter entirely, and the chevron drifted off the first row on wrapped drafts, leaving the composer without a stable prompt anchor.

### Why an extension could not handle it

- The prompt marker and padding are drawn inside the built-in `CustomEditor` render override; extensions supply editor components but cannot re-anchor the default composer's gutter.

### Expected merge conflict zones

- LOW: `packages/coding-agent/src/modes/interactive/components/custom-editor.ts` constructor, padding accessors, and `render()` override.

## Single-span fast path for intra-line diffs (2026-08-17)

Landed 2026-06-16 (commit 1da1ab5e4).

### What changed

- `packages/coding-agent/src/modes/interactive/components/diff.ts`: `renderIntraLineDiff()` tries `renderIntraLineDiffFastPath()` first — identical lines return immediately, and a single replacement span (found by trimming the common prefix and suffix) renders directly as prefix plus inverse removed/added text — falling back to the exported `renderIntraLineDiffWithDiffWords()` (`Diff.diffWords`) only for multi-span edits. `LONG_LINE_FAST_PATH_LIMIT` (500) is exported for the bench and focused tests.
- Coverage: `packages/coding-agent/test/diff-intraline-fastpath.test.ts`, `packages/coding-agent/test/diff-intraline-no-diffwords.test.ts`, and `packages/coding-agent/bench/word-diff.ts` against the pinned `bench/baseline/word-diff-baseline.json`.

### Why

- Most edit-tool diffs change one span per line; routing every line through `diffWords` dominated diff rendering time for large edits.

### Why an extension could not handle it

- Intra-line highlighting is computed by the built-in diff component before any extension result renderer sees the tool output.

### Expected merge conflict zones

- LOW/MEDIUM: `packages/coding-agent/src/modes/interactive/components/diff.ts` around the fast-path helpers and the exported seams.

## Key hints display `escape` as `esc` (2026-08-17)

### What changed

- `packages/coding-agent/src/modes/interactive/components/keybinding-hints.ts`: `keyText()`/`keyHint()` resolve display names through `KEY_DISPLAY_ALIASES` (`escape` → `esc`) before the existing macOS `alt` → `option` rule, so hints read `esc to cancel` while bindings keep matching the canonical `escape` id.

### Why

- The spelled-out `escape` widened single-row hints (compaction cancel hints, selector footers) beyond the key users actually press.

### Why an extension could not handle it

- Key display formatting is the shared helper every built-in hint row renders through; the alias must stay consistent across all of them.

### Expected merge conflict zones

- LOW: the `KEY_DISPLAY_ALIASES` map and `formatKeyPart()` in `packages/coding-agent/src/modes/interactive/components/keybinding-hints.ts`.

## Model selector search text helper removed (2026-08-17)

Landed 2026-08-09 (commit 444f900d0).

### What changed

- `packages/coding-agent/src/modes/interactive/model-search.ts`: `getModelSelectorSearchText()` is deleted. `/model` search ranks through `rankModelSearchItems` (see "model selector search ranking and frozen ordering"), which left the selector-specific concatenated-string builder with no consumers; `getModelSearchText()` remains for command autocomplete.

### Why

- Dead helpers in the shared search module invite the next editor to rank through the retired path that mis-ordered `opus` queries.

### Why an extension could not handle it

- The helper was private interactive-mode search plumbing; no extension consumed it.

### Expected merge conflict zones

- LOW: the deletion site in `packages/coding-agent/src/modes/interactive/model-search.ts`; an upstream sync restoring it conflicts trivially.

## Renderer-only hosts: startup guards the default editor and stop defers exit output (2026-08-17)

Landed 2026-08-16 (commit 03f46f57e, shipped in PR #892; see the focus-routing entry in `packages/tui/src/changes.md`).

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: startup wires the `app.clear`, Ctrl-D, and startup-submit handlers on `defaultEditor` only when a base editor exists, because renderer-only lifecycle hosts may mount the chrome tree without constructing one. `stop(fullscreenExitOutput?)` no longer eagerly reads the fullscreen-exit setting at default-parameter evaluation; the value resolves as `fullscreenExitOutput ?? this.settingsManager.getFullscreenExitOutput()` when the TUI is actually stopped.

### Why

- The v0.84.2 sync introduced renderer-only hosts; assuming a default editor and reading settings eagerly broke both paths outside the classic editor lifecycle.

### Why an extension could not handle it

- Startup wiring and `stop()` are `InteractiveMode` lifecycle internals that run before and after extension hooks.

### Expected merge conflict zones

- LOW: the `defaultEditor` guard block and the `stop()` signature/default resolution in `packages/coding-agent/src/modes/interactive/interactive-mode.ts`.

## OmO Native footer badge removed (2026-08-17)

Landed 2026-08-10 (commit c416335e9). Supersedes every copy of "Footer prepends (OmO Native) badge when the OMO native stack is active (2026-07-28)" in this file.

### What changed

- `packages/coding-agent/src/modes/interactive/components/footer.ts`: the `(OmO Native)` anchor segment and its `footerData.isOmoNative()` feed are gone; the footer renders no OmO-specific coupling. The width-elision ladder, fast-mode glyph, and the rest of the fork footer behavior are unchanged.
- The supporting `detectOmoNativeInstall()` module and its tests were deleted with the badge (the core-side data-provider cleanup is tracked by `packages/coding-agent/src/core/changes.md`).

### Why

- The badge coupled the brand-neutral footer to OmO-specific install detection that no longer carries product meaning; removing it deletes the detection path instead of leaving it dark.

### Why an extension could not handle it

- Footer segment composition is built into the interactive footer renderer; an extension cannot remove a built-in anchor segment.

### Expected merge conflict zones

- LOW: `packages/coding-agent/src/modes/interactive/components/footer.ts` around the (already removed) anchor construction.

## Grok slash-menu colors resolve through chrome tokens (2026-08-17)

Landed 2026-07-26 (commit ed353b365).

### What changed

- `packages/coding-agent/src/modes/interactive/grok/chrome-tokens.ts` and `packages/coding-agent/src/modes/interactive/grok/chrome.ts`: the grok chrome colors slash-menu selection prefixes, primary text, and descriptions through chrome tokens backed by the active theme, composing each row via the pi-tui `SelectListTheme.renderRow` seam (see the renderRow entry in `packages/tui/src/changes.md`) instead of inline hex literals.
- Coverage: `packages/coding-agent/test/grok/chrome.test.ts` pins the token-resolved rows.

### Why

- The mixed command/skill picker needed grok-night and grok-day to color the same rows differently without forking the shared select list.

### Why an extension could not handle it

- Chrome tokens are consumed inside the built-in interactive chrome strategy before extension UI contributions are composed.

### Expected merge conflict zones

- LOW: the token additions in `packages/coding-agent/src/modes/interactive/grok/chrome-tokens.ts` and the composer wiring in `packages/coding-agent/src/modes/interactive/grok/chrome.ts` (fork-only directory).

## Custom-editor Enter submissions are no longer dropped (2026-08-16)

### What changed

- The custom-editor submit bridge in `interactive-mode.ts` (`setCustomEditorComponent`) now expands the submitted value via a new `expandSubmittedText()` in `editor-paste-transfer.ts`. It preserves a non-empty live expanded value for custom editors that submit before clearing, but falls back to the authoritative callback text (and any surviving paste registry) when pi-tui has already cleared the editor.
- The previous bridge called `expandEditorSubmission()`, which prefers `editor.getExpandedText()` over the submitted text. That preference is correct for live draft reads (`getExpandedEditorText()`) but wrong at submit time: pi-tui's `Editor.submitValue()` clears the editor state and paste registry *before* invoking `onSubmit`, so any custom editor implementing `getExpandedText()` (e.g. a wrapper delegating to a pi-tui `Editor`) reported "" and the entire submission was silently discarded — Enter cleared the prompt without sending anything.
- `expandEditorSubmission()` itself is unchanged; only the submit call site switched. Regression coverage now drives the real host bridge with both clear-before-callback and uncleared custom editors.

### Why

- With a custom editor installed (for example the `pi-voice-stt` dictation extension), pressing Enter cleared the prompt but no message ever reached the model — the TUI could not send any user input at all.

### Why this cannot be expressed externally

- The submit bridge lives in the core custom-editor wiring; extensions can only supply the editor component, not how the host reads back its submission.

### Expected merge conflict zones

- LOW: one call site and one import in `interactive-mode.ts`, plus one additive export in the fork-only `editor-paste-transfer.ts`.

## Show the selected settings source (2026-08-16)

### What changed

- Interactive mode renders `settings_source_selected` as a concise dim status such as `Settings: settings.jsonc (JSONC)`.
- Rendering is event-driven: one startup/reload selection produces one status update, with no polling or input-path emission.

### Why

- JSONC precedence is otherwise invisible, especially when both settings flavors exist.

### Why this cannot be expressed externally

- The event can arrive before extension UI binding and the built-in transcript/status lifecycle owns startup rendering.

### Expected merge conflict zones

- LOW: one additive `handleEvent` case and helper in `interactive-mode.ts`.

## Favorite persist merges by pattern resolution, keeping `:level` / `:priority` decorators (2026-08-16)

Supersedes "Favorite patterns survive a persist while providers are unavailable (2026-08-12)": the
`unresolvedPatterns` contract described there no longer exists, and `persistFavoritePatterns` is gone.

### What changed

- `mergeFavoritePatternsForPersist()` in `components/model-favorites.ts` now consumes
  `PatternResolution[]` (per-pattern ownership metadata from `core/model-resolver.ts`) instead of a
  flat `unresolvedPatterns` list. Contract, per stored pattern:
  - unresolved (malformed, empty, or zero-match) passes through verbatim;
  - resolved with zero owned ids is dropped (it only duplicated models an earlier pattern claimed,
    so keeping it would resurrect a model the user just removed);
  - resolved whose visible owned ids are ALL still selected and still an unbroken ordered block is
    preserved VERBATIM, so `claude-opus-5:xhigh` and `gpt-5.5:priority:high` survive a toggle of an
    unrelated favorite;
  - a partially deselected glob EXPLODES into exact decorated entries - still-selected visible ids in
    selector order, then owned ids outside the candidate set, each re-decorated from the glob's
    `serviceTier` / `thinkingLevel`;
  - newly favorited models append as bare canonical ids; identical strings dedupe first-wins;
    `undefined` is still written only when the merged result is genuinely empty.
- Stored patterns are paired with their resolutions through a `Map<pattern, PatternResolution>`, not
  by array position. When the two lists drift - settings mutated externally between snapshot capture
  and merge, an inserted/removed/reordered entry, or an empty `patternResolutions` - a decorated
  pattern is still matched by identity. The previous positional guard
  (`resolution.pattern !== storedPatterns[index] -> continue`) silently skipped such patterns into the
  bare-id append path, which is exactly the decorator loss this entry exists to prevent. Duplicate
  identical stored patterns share the first (owning) resolution; the later duplicate resolves to no
  ownership anyway, so first-wins keeps the output identical.
- `interactive-mode.ts` replaced `persistFavoritePatterns` with `captureFavoritePatternSnapshot()` +
  `applyFavoriteSelection()`, so the LIVE session favorites and the persisted settings both derive
  from the SAME merged pattern list. Previously the session was rebuilt from bare ids before the
  persist, dropping decorators pre-write.
- Coverage: `../../../test/favorite-model-pattern-merge.test.ts` (verbatim preservation, glob
  explosion, unfavorite/refavorite round trip, unresolved pass-through, overlapping-pattern drop,
  and the drifted-snapshot class: inserted, removed, reordered, empty resolutions, duplicates), plus
  the existing `favorite-models-preserve-unresolvable`, `favorite-models-frozen-order`, and
  `favorite-model-selection` suites as the regression fence.

### Why

- Favorite patterns carry per-model reasoning and service-tier intent (`:xhigh`, `:priority:high`).
  The selectors present favorites as plain ids, so persisting that view collapsed every decorated
  pattern to a bare id: toggling one unrelated favorite silently reset another model's reasoning
  level. Ownership metadata is the only way to tell "the user did not touch this pattern" from "the
  user deselected part of it".
- Keying by pattern rather than position closes the same bug class at its second entry point: a
  snapshot that no longer lines up with `settings.json` must not be able to turn a decorated pattern
  into a bare id.

### Why this cannot be expressed externally

- Interactive mode owns the selector callbacks, the availability-filtered favorites view, and the
  settings write. No extension hook can intervene between the filtered view and the persist, and the
  ownership metadata it merges against is internal model-resolver output.

### Expected merge conflict zones

- LOW: `components/model-favorites.ts` around `mergeFavoritePatternsForPersist` (the whole helper is
  fork-specific; upstream has no equivalent).
- LOW: `interactive-mode.ts` around `captureFavoritePatternSnapshot()` / `applyFavoriteSelection()`
  and the two selector persist callbacks - the zone the 2026-08-12 entry declared, now renamed.

## Extension selector windows long option lists (2026-08-13)

### What changed

- `components/extension-selector.ts` renders only a window of options around the selection (sized like
  `TreeList`: half the terminal rows, minimum 5, defaulting to 10 without a TUI handle) with muted
  `… N more above/below` markers when clipped. Previously `updateList()` rebuilt every option on every
  keypress; on large model registries the overflowing list pushed past the viewport and the moved highlight
  was never painted, so arrows and j/k looked dead in `/fallback` even though the selection moved (issue #795).
- Coverage: `test/suite/regressions/795-extension-selector-windowing.test.ts` and the real-CLI scenario
  `.agents/skills/senpi-qa/scripts/scenarios/fallback-selector-nav-repro.mjs` (60-model registry,
  kitty-encoded and legacy input).

### Why

- Every `/fallback` chain edit on a large registry hit a selector whose visible highlight never updated:
  the selection index advanced synchronously, but the full-list repaint was lost past the viewport, so the
  flow looked frozen while Esc (a single cheap repaint of the restored editor) still responded.

### Why this cannot be expressed externally

- The component is the shared extension-dialog selector owned by interactive mode; no extension hook
  intercepts its per-keypress render.

### Expected merge conflict zones

- LOW: `components/extension-selector.ts` `updateList()` and constructor option handling.

## Deferred assistant messages are not errors (2026-08-13)

### What changed

- The assistant renderer treats upstream's new `deferred` stop reason as a successful non-error terminal state.
- Focused component coverage proves it does not synthesize an `Error:` row.

### Why

- The exhaustive switch predated the new stop reason, causing both a build failure and the risk of falsely
  presenting intentionally deferred work as a provider error.

### Why this cannot be expressed externally

- The built-in assistant component owns terminal-state rendering before extension UI contributions are composed.

### Expected merge conflict zones

- LOW: `components/assistant-render-descriptors.ts` stop-reason switch.

## Favorite patterns survive a persist while providers are unavailable (2026-08-12)

> SUPERSEDED by "Favorite persist merges by pattern resolution, keeping `:level` / `:priority`
> decorators (2026-08-16)". Retained for history. Two claims below are no longer accurate:
> `mergeFavoritePatternsForPersist()` no longer takes an `unresolvedPatterns` list (it takes
> `PatternResolution[]` and derives unresolved status per pattern), and `persistFavoritePatterns` no
> longer exists (`interactive-mode.ts` persists through `captureFavoritePatternSnapshot()` +
> `applyFavoriteSelection()`). The underlying guarantee - stored favorites are not erased by a
> persist taken while providers are unavailable - still holds, and is now the `unresolved` branch of
> the newer contract.

### What changed

- `mergeFavoritePatternsForPersist()` in `components/model-favorites.ts` merges the
  selector's visible selection with stored favorite patterns that currently resolve to
  no model. `interactive-mode.ts` persists through it from both the model selector's
  `onFavoriteChange` and the favorites selector's `onPersist`.
- The persisted list keeps unresolvable patterns in their stored order and appends the
  user's selection without duplicating entries. `undefined` is still written only when
  the merged result is genuinely empty.

### Why

- Both selectors derive their favorite ids from `session.favoriteModels`, which is
  `resolveModelScope()` filtered against the current availability snapshot. Persisting
  that view verbatim erased every stored favorite whose provider was momentarily
  unauthenticated or unreachable, and an empty result removed the `favoriteModels` key
  from `settings.json` entirely.

### Why this cannot be expressed externally

- Interactive mode owns the selector callbacks and the settings write, so no extension
  hook can intervene between the filtered view and the persist.

### Expected merge conflict zones

- LOW: `components/model-favorites.ts` around the merge helper and `interactive-mode.ts`
  around the two selector persist callbacks.

## External-editor launch failures remain distinct (2026-08-12)

### What changed

- `editInExternalEditor()` now resolves a discriminated child-process outcome:
  the `error` event returns `launch-failed`, while `close` after a real launch
  returns `failed` for nonzero or signal exits and `complete` only for exit 0.
- The composer still replaces its text only for `complete`, so launch failures
  and editor failures both preserve the current prompt without widening the
  UI control flow.
- Deterministic coverage uses a guaranteed-missing executable to force a real
  operating-system launch failure, rather than mocking `spawn`, sleeping,
  increasing timeouts, or relying on an overloaded full suite to reproduce by
  chance.

### Why

- The old path resolved `error` as `null` and then treated it as an editor
  nonzero exit. Under full-suite process pressure, the editor could fail to
  launch while callers and tests received the status that means it did launch.
- The sibling file-editor path already preserves this distinction because only
  a launched editor may have modified caller-owned files.

### Why this cannot be expressed externally

- The built-in interactive mode owns the process spawn, temporary prompt
  directory, editor result type, and composer replacement decision before any
  extension hook can intervene.

### Expected merge conflict zones

- LOW: `external-editor.ts` around `ExternalEditorResult` and the prompt-editor
  `spawn` event handlers.

## Correct extension-command immediate-dispatch comments (2026-08-09)

### What changed

- Updated the comments in the `onSubmit` handler and in `handleFollowUp` inside `src/modes/interactive/interactive-mode.ts` so they describe the post-fix dispatch flow accurately: extension commands short-circuit at the `isExtensionCommand` branch (the Enter path returns there) and dispatch immediately inside `AgentSession.prompt()` — including during compaction and barrier-held continuation runs — because `prompt()` now hoists the extension-command branch above the settled-work gate.
- The `onSubmit` compaction branch comment now states that only non-command text reaches it (queued for post-compaction delivery) and notes that its `isExtensionCommand` re-check is already unreachable today (the earlier `isExtensionCommand` branch returns first) and stays harmless after the fix.
- `handleFollowUp` is bound directly to `app.message.followUp` (Alt+Enter) and does NOT pass through `onSubmit`, so its `isExtensionCommand` check IS reachable and is the live dispatch point on that path; its comments say so explicitly instead of claiming an `onSubmit` short-circuit.
- The streaming branch comment now clarifies that the steer/followUp behavior applies only to ordinary text, prompt template expansion, and queueing — extension commands are already dispatched immediately by `prompt()`.

### Why

- The previous comments claimed "extension commands execute immediately" in the compaction and streaming paths, which was false for the barrier-held and compaction cases until the parallel `AgentSession.prompt()` hoist landed. The corrected comments align the code's narrative with the actual post-fix control flow.

### Why extension system couldn't handle this

- The gate that serialized extension commands lives inside `AgentSession.prompt()` (core), not in the interactive mode. The TUI comments merely needed to stop asserting a behavior the TUI does not control.

### Expected merge conflict zones

- `src/modes/interactive/interactive-mode.ts`: the `onSubmit` dispatch block (compaction branch comment ~line 3591, streaming branch comment ~line 3608) and the `handleFollowUp` comments (~line 4785, ~line 4808).

## model selector search ranking and frozen ordering

- Added `src/modes/interactive/model-search-rank.ts` so model search ranks each query token against the independent fields `id`, `name`, `provider`, and `provider/id` through a tier ladder (exact, whole token, boundary substring, substring, then `fuzzyMatch` as a last resort), with a canonical provider-path check and a favorites-first partition ahead of the relevance costs in the composite sort key.
- Changed `src/modes/interactive/components/model-selector.ts` so `/model` search ranks through `rankModelSearchItems` with favorites-first partitioning in the all-models scope, and so both the base sort and the search partition read a favorite-ids snapshot taken when the selector opens; a `Ctrl+F` toggle updates only the favorite marker and no longer re-sorts rows mid-session.
- Changed `src/modes/interactive/components/favorite-models-selector.ts` so `/favorite-models` row order is frozen at screen open (a `displayIds` snapshot), favoriting or unfavoriting flips only the marker, explicit reorder keys mirror-swap the snapshot so rows still visibly move, and search ranks through the same module without a favorites partition.
- Why: user-reported UX bugs. Unfavoriting a row made the whole list jump under the cursor, and the query `opus` ranked `claude-sonnet-4-5` above `claude-opus-5` because the old concatenated-string `fuzzyFilter` let a greedy subsequence match scattered letters across "anthropic…claude…sonnet" and score better than the literal word in the opus id.
- This was changed in core UI because the selector components and their ranking are internal `InteractiveMode` behavior; no extension hook can replace selector search ranking or row ordering without reimplementing the built-in selectors.
- Expected merge-conflict zone on upstream sync: `src/modes/interactive/components/model-selector.ts` and `favorite-models-selector.ts` (extending the zone already declared by the favorite model cycling entry), plus `src/modes/interactive/model-search.ts` and the new `src/modes/interactive/model-search-rank.ts`.

## Server fallback abort uses one TUI notice (2026-08-05)

### What changed

- `components/assistant-render-descriptors.ts` now owns assistant transcript descriptor construction and no longer
  emits the provider's refusal-shaped `Error:` row when the message carries the `server_fallback_aborted` diagnostic.
  The dedicated interactive warning widget remains the single visible explanation and still reports the server
  transition plus configured-chain behavior.
- `components/assistant-message.ts` delegates descriptor construction to that focused module, keeping both renderer
  files below the repository's 250 pure-LOC ceiling.
- Assistant render signatures now include diagnostics, so a diagnostic added to the active message removes any stale
  error descriptor during incremental rendering.
- `../../../test/assistant-message-incremental-render.test.ts` covers both initial diagnosed rendering and same-message
  diagnostic updates.

### Why

- The provider error and the dedicated fallback widget described the same client-policy abort back to back, making one
  fallback transition look like two separate failures.

### Why extension system couldn't handle this

- Assistant stop-reason descriptors and their incremental render cache are private built-in TUI behavior. An extension
  cannot suppress one diagnostic-specific error row while preserving the session message and dedicated warning event.

### Expected merge conflict zones

- LOW: `components/assistant-message.ts` descriptor integration and `components/assistant-render-descriptors.ts`
  error-tail construction.

## Fallback transitions render as shared notice boxes (2026-08-04)

### What changed

- `retry_fallback_applied`/`succeeded`/`reverted`/`exhausted` and `server_fallback_aborted` now render through `InteractiveMode.showNoticeBox` (shared `buildNoticeBox` from `src/core/extensions/notice/`) as titled notice boxes with per-event tones, replacing the one-line `showWarning`/`showStatus`/`showError` texts. The `FALLBACK_STATUS_KEY` footer indicator is unchanged.
- `showNoticeBox` sanitizes every rendered line with `sanitizeTuiErrorMessage`, preserving the OSC/control-strip invariant previously carried by the `showError` exhausted path; `interactive-mode-fallback-error-sanitization.test.ts` re-pins that property against the box.

### Why

- Fallback transitions join loop-guard detections, ttsr injections, and goal cache-warm entries on one notice widget, so transient one-liners no longer scroll away unnoticed.

### Expected merge conflict zones

- LOW: five `case` bodies in `handleEvent` and one additive method beside `showError` in `interactive-mode.ts`.

## Bun console diagnostics stay behind the interactive terminal guard (2026-08-03)

### What changed

- While the TUI owns the terminal, the interactive stderr guard now routes `console.info`, `console.warn`, and
  `console.error` through its hidden, redacted debug-log sink and restores the exact console methods whenever the
  terminal is released.
- Coverage models Bun's native console behavior, which bypasses a replaced `process.stderr.write`, and pins
  terminal silence, debug-log redaction, and restoration.

### Why

- omo-senpi emits ulw-loop and start-work diagnostics through `console.*`. Node routes those calls through the
  patched stderr writer, but Bun writes them through its native console implementation, so the diagnostics could
  corrupt the interactive footer even though direct `process.stderr.write` coverage was green.

### Why this cannot be expressed externally

- Extensions cannot protect the host TUI from runtime-specific console output before it reaches the terminal.
  The host must own console interception for exactly the interval in which it owns the terminal.

### Expected merge conflict zones

- LOW: `interactive-stderr-guard.ts` and its focused regression test.

## Backfill: exit alias and footer provider priority (2026-08-01)

### What changed

- Interactive slash-command dispatch accepts the fork's exit-command alias.
- Provider counts appear immediately and provider prefixes win the footer layout priority they need.

### Why

- Exit behavior must remain discoverable and the active provider must stay visible under constrained terminal width.

### Why this cannot be expressed externally

- Both behaviors depend on the built-in command registry and interactive footer layout scheduler.

### Expected merge conflict zones

- `interactive-mode.ts`, slash-command registration, and footer/status layout code.

## Global queue chronology for compaction recovery (2026-07-31)

- Queue submissions reserve one monotonic order across native steer/follow-up buckets and TUI-owned compaction input. Native delivery priority remains unchanged.
- `AgentSession.clearQueue()` preserves its enumerable `{ steering, followUp }` shape and exposes global recovery chronology through a non-enumerable `ordered` side channel.
- Retry handoff carries reserved order into native queues; legacy messages without order retain deterministic compatibility ordering. Matching records leave chronology when native delivery starts.
- The existing `clearQueue({ abortWillFollow })` contract remains intact, so terminal restore does not leak abort state.
- Coverage: `test/suite/regressions/compaction-terminal-queue-order.test.ts`, `535-terminal-compaction-abort-flag.test.ts`, and `post-compaction-queued-input-resume.test.ts`.

### Expected merge conflict zones

- MEDIUM: `core/agent-session.ts` queue bookkeeping and `interactive-mode.ts` compaction transfer/restoration.

## Model-switch status uses optimized-prompt wording (2026-07-31)

### What changed

- `cycleModel` and `selectModelFromUi` status lines now read `optimized system prompt applied: <preset>` instead of `system prompt: <preset>`, and stay silent when the switch emits no preset name (unmatched models fall back to the senpi dynamic prompt without announcement). Behavior counterpart: `builtin/prompt-preset` (see its changes.md, 2026-07-31).

### Why

- User request: switch messages should convey that a model-optimized system prompt was applied, and say nothing for models without one.
## Queue restoration does not leak abort state (2026-07-31)

### What changed

- Native queue draining now records cleared messages for `session_abort` only when the caller will immediately abort the session.
- Terminal compaction restoration and manual dequeue-to-editor drains leave later idle aborts silent, while the deliberate clear-then-abort paths retain their existing `session_abort` behavior.
- Coverage: `test/suite/regressions/535-terminal-compaction-abort-flag.test.ts` drives terminal `compaction_end` restoration with native steer and follow-up messages and pins both sides of the abort-event distinction.

### Why

- Terminal compaction failure restoration previously left `_hadClearedQueuedMessages` set indefinitely. A later unrelated idle abort emitted `session_abort`, which extensions can interpret as a control-plane instruction such as blocking an active goal.

### Expected merge conflict zones

- LOW: queue draining in `core/agent-session.ts` and the queue restoration helpers in `interactive-mode.ts`.

## Footer marks fast mode on the model label (2026-07-31)

### What changed

- `components/footer.ts` prefixes the right-hand model label with a lightning bolt whenever
  `session.isFastModeActive()` is true, so a priority-tier session is visible without running
  `/fast` again to check. The glyph is part of the `FooterSegment` plain text, so the width ladder
  in `footer-layout.ts` accounts for it instead of overflowing narrow terminals, and
  `colorRightSide()` paints it `warning` while the model keeps `accent` and `:thinking` keeps `dim`.
- Coverage: `test/footer-fast-mode-icon.test.ts` pins the indicator, its absence when fast mode is
  off, and width safety with a wide CJK model id at width 60.

### Why

- Both fast paths (an `openai` `-fast` catalog variant and the Codex session toggle) were invisible
  in the footer, which is the only always-on surface showing the active model.

## Double-Escape history recovers after refusal fallback exhaustion (2026-07-31)

### What changed

- Terminal classifier-refusal fallback exhaustion now returns `AgentSession.retryAttempt` to zero and emits the failed `auto_retry_end` event consumed by interactive retry cleanup.
- The existing empty-editor double-Escape handler therefore reaches the session tree again after the final `Aborted after N retry attempts` result; no keybinding or timing semantics changed.
- Coverage: `test/suite/regressions/fallback-abort-double-escape-session-history.test.ts`.

### Why

- The interactive Escape handler intentionally prioritizes active retry cancellation over session history. A stale positive retry attempt made that active-retry branch permanent even after the turn had settled.

### Expected merge conflict zones

- NONE in interactive source; the behavioral fix is isolated to `core/agent-session.ts` retry lifecycle cleanup.

## Failed compaction restores queued input (2026-07-30)

### What changed

- Terminal compaction failures, rejections, and aborts restore messages queued during compaction to the editable composer instead of leaving them pending indefinitely. Native session steer and follow-up queues are drained into the composer too.
- Failed pre-prompt overflow compaction now emits `willRetry: false`, so queued input follows the terminal restoration path instead of waiting for a retry that cannot run.
- The defensive retryable-failure branch keeps the native-queue handoff (`flushCompactionQueue({ willRetry: true, deferAdmission: true })`) for any producer that can truthfully promise a retry.
- Coverage: `test/interactive-mode-compaction.test.ts` pins truncated, timed-out, rejected, retryable, and successful compaction outcomes; `test/suite/regressions/post-compaction-queued-input-resume.test.ts` drives the real failed pre-prompt overflow path and real editor-restoration helper.

### Why

- Retrying queued delivery against the unchanged over-threshold context repeats the same required-compaction failure; restoring the draft lets the user edit or retry explicitly.

### Expected merge conflict zones

- LOW: `interactive-mode.ts` in the `compaction_end` queue handoff branch.

## Risky main-model selection warning (2026-07-30)

- Interactive startup, `/model` (including exact references), the full and favorite-model selectors, post-auth default selection, and favorite rotation now pass the selected main model through one shared warning predicate.
- Provider/model identifiers and displayed model names containing `minimax` or `qwen`, case-insensitively, render a prominent `error`-red Korean warning box. Safe model families render no warning.
- The warning is confined to the interactive main-session model surface; task/subagent routing is unchanged.
- Coverage: `test/risky-main-model-warning-tui.test.ts` pins matching fields, case-insensitivity, Korean/CJK output, red styling, selector/rotation paths, and a safe-model negative case.

## high_reasoning_warning TUI box (2026-07-30)

- `interactive-mode.ts` consumes `high_reasoning_warning` and renders a scary red (`error`-themed) warning box via `showHighReasoningWarning`, urging use via the ultrabrain subagent. Mirrors `showNewVersionNotification` styling.
- QA: `local-ignore/qa-evidence/20260730-high-reasoning-warning/` (ans/html/grid triplet; 916 red cells; WARNING+ultrabrain+responsibility confirmed).

## Omo-senpi coding workflow tips (2026-07-30)

### What changed

- `tips/catalog/subagent-tips.ts` now advertises the shipped `init-deep`, debugging, refactor,
  remove-ai-slops, and visual-qa skills alongside the existing plan, ultrawork, research, and review tips.
- Every new entry uses the existing `tasks` command gate so users only see omo-senpi workflow tips when
  the task extension surface is available.
- Coverage: `test/suite/list-tips.test.ts` pins each ID, rendered line, and command gate.

### Why

- The tip rotation covered the headline orchestration workflows but skipped the everyday project
  initialization, diagnosis, cleanup, and visual-verification skills that omo-senpi also installs.

### Expected merge conflict zones

- LOW: additive entries in `tips/catalog/subagent-tips.ts` and one focused catalog assertion.

## Footer hides low cache hit rates (2026-07-29)

### What changed

- `components/footer.ts`: the cache-hit segment is omitted when the latest hit rate is below 10%; rates at 10% and above continue to render.
- Coverage: `test/footer-token-format.test.ts` pins the 9.9% hidden case and the 10% boundary.

### Why

- Very low hit rates add a footer block without providing useful cache-health signal.

### Expected merge conflict zones

- LOW: `components/footer.ts` around optional middle-stat construction.

## Long footer paths yield before cache and cost stats (2026-07-29)

### What changed

- `components/footer-layout.ts`: when the pwd consumes more than one third of the available footer width, the responsive ladder shortens the indexed pwd anchor from the head at each right-label/middle-stat richness rung before dropping another middle segment. Ordinary shorter paths retain the existing provider-prefix and middle-elision order. The explicit pwd index keeps leading badges intact; the `pwd-elided` plan carries the retained middle count, ellipsis-marker state, and full/minimal model-label choice.
- `components/footer.ts`: pwd-elided rendering keeps the middle segments selected by the layout plan, so cache hit rate and total cost remain visible when shortening the leading path is enough to fit them.
- Coverage: `test/footer-width.test.ts` pins a width-110 long-cwd case that retains the `coding-agent` tail, `CH25.0%`, `$1.234`, and the model label without overflowing, plus an OmO Native case proving the badge stays intact while the actual path elides.

### Why

- Long workspace paths consumed footer width before the layout considered shortening them, so the right-most telemetry fields (cost first, then cache hit rate) disappeared even when eliding the non-identifying path head could preserve both.

### Expected merge conflict zones

- LOW: `components/footer-layout.ts` around the width-priority ladder and `pwd-elided` plan shape.
- LOW: `components/footer.ts` around `pwd-elided` materialization.

## Ethos tips: tool-call repair now names Kimi K3 (2026-07-29)

### What changed

- `tips/catalog/ethos-tips.ts`: the `ethos.tool-call-repair` copy now covers Kimi K3 alongside Claude - "claude's sloppy invokes, kimi k3's leaked XTML channels, all of it" - matching the new normal-mode XTML recovery in `packages/ai` (Kimi models get the same leaked tool-call auto-correction Claude has).
- Coverage: `test/suite/ethos-tips.test.ts` pin updated verbatim.

### Why

- The repair tip only described the Claude/antml case. With XTML recovery shipped for Kimi models, the brag undersells the feature.

### Expected merge conflict zones

- LOW: single render string in `ethos-tips.ts` and its verbatim pin.

## Footer omits cumulative input and output counters (2026-07-29)

### What changed

- `components/footer.ts` no longer adds the cumulative `↑<input>` and `↓<output>` token segments to the interactive footer.
- Context-window usage, cache-hit rate, session name, cost, model, working directory, branch, and extension statuses remain unchanged.
- Coverage: `test/footer-token-format.test.ts` asserts that the usage arrows are absent while the neighboring cache-hit and context details still render.

### Why

- The cumulative input/output counters add visual noise to the always-visible footer without helping the active context decision; the context-window segment remains the relevant token signal.

### Expected merge conflict zones

- LOW: `components/footer.ts` around the optional middle-stat segment construction.

## Tip lines point at the give-me-tips skill (2026-07-29)

### What changed

- `tips/startup-tip.ts` and `tips/working-tip.ts`: the resolved `line` now carries a second pointer
  line - `↳ Want the full story on any tip? Ask about it — the give-me-tips skill has the tour.` -
  appended under the byte-identical `Tip: ${body}` first line. Both render sites draw the tip as a
  single `Text` component, so the pointer lands directly below the tip row.
- Coverage: `test/suite/startup-tip.test.ts` and `test/suite/working-tip.test.ts` pin the two-line
  shape and the `give-me-tips` literal.

### Why

- A one-line tip cannot tell the whole story; the pointer teaches users that the give-me-tips skill
  can expand any tip on ask.

### Expected merge conflict zones

- LOW: the `line` template in both resolvers.

## Ethos tips: the fork's voice in the tip rotation (2026-07-29)

### What changed

- `tips/catalog/ethos-tips.ts` (new): a `ETHOS_TIPS` catalog of seven manifesto tips framing how `@code-yeongyu/senpi` is tuned - system-prompt discipline for `gpt-5.6-sol`, tools that stay out of the way, spending tokens to buy time, and pointers to `ulw-plan` on `fable-5 xhigh` and the `ulw loop`.
- `tips/registry.ts`: `TIP_DEFINITIONS` now concatenates `...ETHOS_TIPS` after `SUBAGENT_TIPS`.
- The two command-referencing tips (`ethos.ulw-plan-sage`, `ethos.ulw-loop-shallow`) declare `requiresCommand: "tasks"`, so they only surface when the omo plugin's `tasks` command is registered - matching the `workflow-skills.*` tips in `subagent-tips.ts`. The eight pure manifesto tips (including the monitor/cache bragging tips) are keyless and ungated.
- Three additional tips brag about the harness's monitor tool (subscribe to stdout, never sleep), the prompt-cache budget (never block past cache TTL), and the live cache-hit rate in the footer. All three are keyless and ungated.
- Three more tips brag about multimodal vision (the agent sees screenshots, PDFs, diagrams), Claude Code OAuth multi-account (switch logins, not env vars), and the agent-SDK foundation (no ToS gray zone, no ban anxiety). All three are keyless and ungated.
- One tip brags about the tool-call repair middleware (malformed antml:invoke calls are intercepted, corrected, and salvaged instead of failing the turn). Keyless and ungated.
- Coverage: `test/suite/ethos-tips.test.ts` pins the fourteen ids, the verbatim approved English copy, the `tasks` gating, and the unbound/ungated manifesto set.

### Why

- The tip line taught mechanics and commands but had no voice for the fork's tuning philosophy. These tips surface the system-prompt-tuning claim (a 5-minute job takes 5 minutes, a 12-hour job takes 12), the anti-tool-study stance, and the spend-tokens-for-time trade, which are the fork's reason for existing.
- Gating the ulw command tips on `tasks` preserves the existing honesty invariant: never advertise commands the session cannot run.

### Expected merge conflict zones

- LOW: `tips/registry.ts` import block and the `TIP_DEFINITIONS` concatenation tail.

## Footer prepends (OmO Native) badge when the OMO native stack is active (2026-07-28)

> SUPERSEDED by "OmO Native footer badge removed (2026-08-17)". Retained for history: the `(OmO Native)` anchor
> segment, its `footerData.isOmoNative()` feed, and `detectOmoNativeInstall()` were removed on 2026-08-10 (commit
> c416335e9), so this badge no longer renders. The width-elision ladder it participated in is unchanged.

### What changed

- `components/footer.ts`: `render()` prepends an `(OmO Native)` anchor segment (colored `success`) as the leftmost footer element when `footerData.isOmoNative()` returns true, before pwd and branch. The badge participates in the existing width-elision ladder as an anchor (never dropped, only elided with pwd when space is exhausted).
- The badge is fed by `FooterDataProvider.isOmoNative()`, set once at startup by `interactive-mode.ts` from `detectOmoNativeInstall()` (see root `src/changes.md`).
- Coverage: `test/omo-native-footer.test.ts` asserts the segment is the leftmost rendered text when active and absent when inactive.

### Why

- Makes the OMO native install state visible in the bottom-left footer without a separate status line.

### Expected merge conflict zones

- LOW: `components/footer.ts` around the anchor segment construction.

## Large resumed sessions use event-driven Working updates (2026-07-28)

### What changed

- `working-status.ts` adds `largeSessionWorkingStatusInterval()`: sessions below 1,000 persisted entries retain the
  existing 32 ms message shimmer and 600 ms indicator cadence. Larger histories refresh informational Working text
  and hook rows every second while limiting the decorative indicator fallback to once per 60 seconds.
- `interactive-mode.ts` applies the policy to the default Working indicator, message, and tool-hook timers. Tool,
  stream, status, and message events still request immediate renders, so large sessions remain live without
  continuously repainting an unchanged transcript.
- The persisted-entry threshold is sampled when a default indicator is created (and when a hook ticker starts);
  custom `setWorkingIndicator()` options bypass this policy by design.
- `test/interactive-mode-working-status.test.ts` locks both sides of the threshold and both large-session cadences;
  `test/hook-status-ticker.test.ts` locks the one-second large-session hook timer.

### Why

Each animation tick asks the TUI to render the complete component tree. That is cheap for ordinary sessions but can
become continuous CPU work after resuming a multi-thousand-entry transcript. One-second informational updates keep
elapsed labels honest, while event-driven renders and the 60-second decorative fallback avoid continuous repainting
of settled history.

### Expected merge conflict zones

- LOW: `working-status.ts` around animation timing helpers.
- LOW/MED: `interactive-mode.ts` around `getWorkingIndicatorOptions()` and `startToolHookStatusTimer()`.

## Paste markers survive editor hand-off; unset is a same-instance no-op (2026-07-28)

### What changed

- `interactive-mode.ts` `setCustomEditorComponent()`: switching between the default and a custom editor now transfers raw text plus the paste registry snapshot when the source exposes a snapshot AND the target implements the paired paste-state API (`setPasteState` with `getPasteState` — a target that could not re-export collapsed markers on the next hand-off receives expanded text instead), so `[paste #N ...]` markers stay collapsed across the swap. Otherwise it falls back to the expanded text via `getExpandedEditorText()`.
- New `getExpandedEditorText()` helper used by every full-editor-text consumer (`ctx.ui.getEditorText()`, Alt+Enter follow-up, external-editor open, and the hand-off fallback): prefers the editor's `getExpandedText()`, then expansion from `getPasteState()` via pi-tui's exported `expandPasteMarkers()`, then raw text (an editor with neither capability never had expandable markers).
- `setCustomEditorComponent(undefined)` is a draft no-op when the default editor is already active (`resetExtensionUI()` calls it unconditionally during extension resets and session invalidation): no hand-off happens, so no setText round-trip touches the user's draft.
- Previously the raw text alone was copied into the destination editor, whose empty registry turned live markers into dead literals — submit then sent the `[paste #N ...]` placeholder to the model instead of the pasted body.

### Why

- Companion to the pi-tui paste-registry fix (`packages/tui/src/changes.md`, same date). The hand-off is interactive-mode logic: only this layer knows both editor instances and their optional capabilities.

### Expected merge conflict zones

- LOW: `setCustomEditorComponent()` around the transfer helper and the factory/unset branches.
- LOW: `packages/coding-agent/test/suite/regressions/0000-editor-paste-marker-transfer.test.ts` (drives the real method with real tui editors).

## /reload honors the session_before_reload extension veto (2026-07-28)

### What changed

- `interactive-mode.ts` `handleReloadCommand()`: before building the reload box, the handler calls
  `session.checkReloadVeto()`; when an extension cancels (`session_before_reload` returning
  `cancel: true`), the command shows the extension's `reason` as a warning and returns — no reload box,
  no focus steal, no teardown. A cancelled result from `session.reload()` itself (late veto) dismisses
  the box back to the previous editor and shows the same warning.

### Why

- Reload destroys the extension runtime; extensions owning live background work (running subagents in
  omo-senpi) need a way to block it. The streaming/compaction guards already set the warning precedent.

### Expected merge conflict zones

- LOW: `interactive-mode.ts` around `handleReloadCommand()`.

## Fix: the startup tip is destroyed by extension headers (2026-07-27)

### What changed

- `tips/startup-header.ts` (new): `appendStartupHeader()` attaches the built-in header and the startup tip to the header container as **separate children**.
- `interactive-mode.ts`: the tip is no longer interpolated into the `ExpandableText` header closures.

### Why

`ui.setHeader()` replaces the built-in header component in place, and the builtin `prompt-preset` extension calls it on every `session_start`. Because the tip was part of the header's own text, that replacement silently discarded it: the tip resolved and was recorded into `tipsHistory`, but never reached the terminal. Keeping the tip as a sibling of the header makes it survive any extension header override.

## Tips cover the whole feature surface, and command tips are gated (2026-07-28)

### What changed

- `tips/catalog/` (new): the tip catalog is split by domain into `model-tips.ts`, `input-tips.ts`, `session-tips.ts`, `workspace-tips.ts`, `settings-tips.ts`, `cli-tips.ts`, and `subagent-tips.ts`, with the shared `TipDefinition` in `catalog/types.ts`. `tips/registry.ts` is now a barrel that concatenates them, so `TIP_DEFINITIONS` and `TipDefinition` keep their import paths.
- The catalog grew from 25 to 70 tips: model fallback chains and `/fallback`, `/login`, `--models` scoping, `thinkingBudgets`, `promptPreset`, `@` file references, Tab path completion, the `?` overlay, steering vs follow-up delivery, `escape` restoring the queue, `/clone`, `-c`/`-r`, `/name`, `/session`, `/export`, `/share`, `/compact`, auto-compaction, AGENTS.md context loading, `/skill:name` and prompt templates, `/files`, `/diff`, `/todo`, `/goal`, `/btw`, `/lookat`, `/mcp`, `/rules`, `/hooks`, `/websearch`, settings locations, `permissionPreset`, `packages`, custom themes, `/reload`, `/trust`, the `tips` toggle, print mode, tool/allow deny flags, subagent categories, `/tasks`, `~/.omo/omo.jsonc`, and teams.
- `TipDefinition.requiresCommand` (new): a tip that teaches an extension-provided command names it, and `selectTip()` skips that tip when the injected `hasCommand` resolver reports the command is not registered. `interactive-mode.ts` injects `hasRegisteredCommand()` (backed by `extensionRunner.getCommand()`) into both the startup and working tip resolvers.

### Why

The tip line was teaching a small slice of the product while most of the surface - retry fallback chains, session branching, permissions, subagent categories, the omo config file - stayed invisible. Gating by registered command keeps that breadth honest: builtin extensions can be disabled and the omo workflow tips only apply when the omo plugin is loaded, so those tips no longer advertise commands the session cannot run.

## Feature discoverability: tips, `?` overlay, live favorite hints, `/keybindings` (2026-07-27)

### What changed

- `tips/registry.ts` (new): a `TIP_DEFINITIONS` catalog teaching existing senpi features and workflow skills (`ulw plan`, `$start-work`, `ulw`/`ulw loop`, `ulw-research`, `hyperplan`, `review work`). Each tip declares its `bindings` and renders through an injected key resolver, so displayed keys always reflect the user's live configuration.
- `tips/scheduler.ts` (new): `selectTip()` picks the least-recently-shown eligible tip, honoring an injected key-availability resolver and a caller-owned exclusion set. `tips/history-writer.ts` (new): pure `recordTipShown()` merge with no module state; persistence is explicit via `settings-manager`.
- `tips/startup-tip.ts` (new): `resolveStartupTipLine()` resolves one banner tip line, gated by the `tips` setting and `quietStartup`. `interactive-mode.ts` renders it in both compact and expanded startup variants and records it once through the shared writer with a per-session shown-set.
- `tips/working-tip.ts` (new): `resolveWorkingTipLine()` resolves the tip under the working status. `interactive-mode.ts` wraps the indicator and tip in one Container so the single-child `statusContainer` contract holds, caches the pick per turn, excludes the banner tip, and resets on turn end.
- `tips/favorite-messages.ts` (new): `buildFavoriteCycleStatusMessage()` renders the favorite-model empty/single states with live `app.model.select` / `app.models.toggleFavorite` keys instead of the previous hardcoded copy.
- `components/shortcut-overlay.ts` (new): `ShortcutOverlay` plus the pure `shouldShowShortcutOverlay()` predicate. `interactive-mode.ts` mounts it only on a typed `?` in an empty editor (paste and non-empty text never trigger) and dismisses it on any further input or submit.
- `keybindings-command.ts` (new): `seedKeybindingsFile()` writes the effective bindings when the config is missing, and `applyKeybindingsFileEdit()` reloads only valid JSON. `interactive-mode.ts` adds a `/keybindings` dispatch that opens the real config via the new `editFileInExternalEditor()` seam in `external-editor.ts` and reloads the live manager without restart.

### Why

- The product already cycles favorites, toggles thinking, and exposes dozens of shortcuts, but none of that was discoverable in-product; users (including the owner) did not know `Ctrl+F` toggles favorites or that a favorite cycle existed.

### Merge-conflict zones

- `interactive-mode.ts` imports block, the startup banner assembly, the `defaultEditor.onChange` / `onSubmit` handlers, `showStatusIndicator`/`clearStatusIndicator`, and the slash-command text dispatch beside `/hotkeys` (five serialized edits).

## Footer cache segment removal and anchor-pinned layout (2026-07-27)

### What changed

- `components/footer-layout.ts` (new): pure width planning for the classic footer. `planFooterLayout()` picks the
  richest layout that fits the terminal: full line, then middle segments elided right-most-first behind a single
  dim "…" marker, then the pwd head-elided ("…/senpi"), then the whole left block head-elided, with the model
  label truncated only as the last resort. `elideHead()` keeps the tail of a path, which carries the most
  identifying information.
- `components/footer.ts`: the `cache <read>/<write>` totals segment was removed (the `CH<x>%` cache-hit-rate
  segment stays); rendering now builds plain/colored `FooterSegment` pairs and delegates fitting to
  `planFooterLayout()`, so the model label and the pwd • branch • context-usage block stay visible at any width
  instead of the right side being truncated away first.

### Why

- The cache read/write totals cost footer space out of proportion to their value, and the old truncation logic
  sacrificed the right-side model label whenever the left overflowed — the two anchors users watch (context
  usage, current model) were the first things to disappear on narrow terminals.

### Expected merge conflict zones

- MEDIUM: `components/footer.ts` `render()` was rewritten around `FooterSegment` pairs; upstream footer layout
  changes will conflict textually. `components/footer-layout.ts` is additive.

## Adaptive smooth-streaming buffer (2026-07-27)

### What changed

- `streaming-reveal.ts`, `streaming-reveal-pacing.ts`, and `streaming-reveal-content.ts`: smooth assistant output
  waits for an 80ms startup buffer, estimates the provider's grapheme arrival rate with an EWMA, and follows that
  learned base rate without a hard ceiling. Individual outlier samples are limited to four times the prior
  estimate, extra catch-up is bounded independently, and signed backlog correction converges toward roughly
  140ms of queued text across provider chunk cadences.
- Fully drained bursts reset fractional progress so a later chunk cannot inherit reveal budget from an earlier
  burst. Streaming tool arguments retain one-code-unit progress and parse in bounded 64-unit batches, preserving
  surrogate pairs while sharing the assistant pacing helper.
- `../../../test/streaming-reveal-{content,pacing}.test.ts`, `../../../test/streaming-reveal.test.ts`, and
  `../../../test/helpers/streaming-reveal.ts`: split grapheme, pacing, and controller coverage into focused modules
  and exercise timed 45/90/180/240/500-unit-per-second arrivals, multiple cadences, sustained fast streams,
  convergence and final-tail bounds, lifecycle flushes, and drained-burst carry reset.

### Why

- The previous fixed 267ms catch-up policy drained each provider burst completely, while the first adaptive
  implementation capped the total reveal rate at 240 graphemes per second. Providers above that rate accumulated
## Footer omits cumulative input and output counters (2026-07-29)

### What changed

- `components/footer.ts` no longer adds the cumulative `↑<input>` and `↓<output>` token segments to the interactive footer.
- Context-window usage, cache-hit rate, session name, cost, model, working directory, branch, and extension statuses remain unchanged.
- Coverage: `test/footer-token-format.test.ts` asserts that the usage arrows are absent while the neighboring cache-hit and context details still render.

### Why

- The cumulative input/output counters add visual noise to the always-visible footer without helping the active context decision; the context-window segment remains the relevant token signal.

### Expected merge conflict zones

- LOW: `components/footer.ts` around the optional middle-stat segment construction.

## Tip lines point at the give-me-tips skill (2026-07-29)

### What changed

- `tips/startup-tip.ts` and `tips/working-tip.ts`: the resolved `line` now carries a second pointer
  line - `↳ Want the full story on any tip? Ask about it — the give-me-tips skill has the tour.` -
  appended under the byte-identical `Tip: ${body}` first line. Both render sites draw the tip as a
  single `Text` component, so the pointer lands directly below the tip row.
- Coverage: `test/suite/startup-tip.test.ts` and `test/suite/working-tip.test.ts` pin the two-line
  shape and the `give-me-tips` literal.

### Why

- A one-line tip cannot tell the whole story; the pointer teaches users that the give-me-tips skill
  can expand any tip on ask.

### Expected merge conflict zones

- LOW: the `line` template in both resolvers.

## Ethos tips: the fork's voice in the tip rotation (2026-07-29)

### What changed

- `tips/catalog/ethos-tips.ts` (new): a `ETHOS_TIPS` catalog of seven manifesto tips framing how `@code-yeongyu/senpi` is tuned - system-prompt discipline for `gpt-5.6-sol`, tools that stay out of the way, spending tokens to buy time, and pointers to `ulw-plan` on `fable-5 xhigh` and the `ulw loop`.
- `tips/registry.ts`: `TIP_DEFINITIONS` now concatenates `...ETHOS_TIPS` after `SUBAGENT_TIPS`.
- The two command-referencing tips (`ethos.ulw-plan-sage`, `ethos.ulw-loop-shallow`) declare `requiresCommand: "tasks"`, so they only surface when the omo plugin's `tasks` command is registered - matching the `workflow-skills.*` tips in `subagent-tips.ts`. The eight pure manifesto tips (including the monitor/cache bragging tips) are keyless and ungated.
- Three additional tips brag about the harness's monitor tool (subscribe to stdout, never sleep), the prompt-cache budget (never block past cache TTL), and the live cache-hit rate in the footer. All three are keyless and ungated.
- Three more tips brag about multimodal vision (the agent sees screenshots, PDFs, diagrams), Claude Code OAuth multi-account (switch logins, not env vars), and the agent-SDK foundation (no ToS gray zone, no ban anxiety). All three are keyless and ungated.
- One tip brags about the tool-call repair middleware (malformed antml:invoke calls are intercepted, corrected, and salvaged instead of failing the turn). Keyless and ungated.
- Coverage: `test/suite/ethos-tips.test.ts` pins the fourteen ids, the verbatim approved English copy, the `tasks` gating, and the unbound/ungated manifesto set.

### Why

- The tip line taught mechanics and commands but had no voice for the fork's tuning philosophy. These tips surface the system-prompt-tuning claim (a 5-minute job takes 5 minutes, a 12-hour job takes 12), the anti-tool-study stance, and the spend-tokens-for-time trade, which are the fork's reason for existing.
- Gating the ulw command tips on `tasks` preserves the existing honesty invariant: never advertise commands the session cannot run.

### Expected merge conflict zones

- LOW: `tips/registry.ts` import block and the `TIP_DEFINITIONS` concatenation tail.

## Footer prepends (OmO Native) badge when the OMO native stack is active (2026-07-28)

> SUPERSEDED by "OmO Native footer badge removed (2026-08-17)". Retained for history: the `(OmO Native)` anchor
> segment, its `footerData.isOmoNative()` feed, and `detectOmoNativeInstall()` were removed on 2026-08-10 (commit
> c416335e9), so this badge no longer renders. The width-elision ladder it participated in is unchanged.

### What changed

- `components/footer.ts`: `render()` prepends an `(OmO Native)` anchor segment (colored `success`) as the leftmost footer element when `footerData.isOmoNative()` returns true, before pwd and branch. The badge participates in the existing width-elision ladder as an anchor (never dropped, only elided with pwd when space is exhausted).
- The badge is fed by `FooterDataProvider.isOmoNative()`, set once at startup by `interactive-mode.ts` from `detectOmoNativeInstall()` (see root `src/changes.md`).
- Coverage: `test/omo-native-footer.test.ts` asserts the segment is the leftmost rendered text when active and absent when inactive.

### Why

- Makes the OMO native install state visible in the bottom-left footer without a separate status line.

### Expected merge conflict zones

- LOW: `components/footer.ts` around the anchor segment construction.

## Large resumed sessions use event-driven Working updates (2026-07-28)

### What changed

- `working-status.ts` adds `largeSessionWorkingStatusInterval()`: sessions below 1,000 persisted entries retain the
  existing 32 ms message shimmer and 600 ms indicator cadence. Larger histories refresh informational Working text
  and hook rows every second while limiting the decorative indicator fallback to once per 60 seconds.
- `interactive-mode.ts` applies the policy to the default Working indicator, message, and tool-hook timers. Tool,
  stream, status, and message events still request immediate renders, so large sessions remain live without
  continuously repainting an unchanged transcript.
- The persisted-entry threshold is sampled when a default indicator is created (and when a hook ticker starts);
  custom `setWorkingIndicator()` options bypass this policy by design.
- `test/interactive-mode-working-status.test.ts` locks both sides of the threshold and both large-session cadences;
  `test/hook-status-ticker.test.ts` locks the one-second large-session hook timer.

### Why

Each animation tick asks the TUI to render the complete component tree. That is cheap for ordinary sessions but can
become continuous CPU work after resuming a multi-thousand-entry transcript. One-second informational updates keep
elapsed labels honest, while event-driven renders and the 60-second decorative fallback avoid continuous repainting
of settled history.

### Expected merge conflict zones

- LOW: `working-status.ts` around animation timing helpers.
- LOW/MED: `interactive-mode.ts` around `getWorkingIndicatorOptions()` and `startToolHookStatusTimer()`.

## Paste markers survive editor hand-off; unset is a same-instance no-op (2026-07-28)

### What changed

- `interactive-mode.ts` `setCustomEditorComponent()`: switching between the default and a custom editor now transfers raw text plus the paste registry snapshot when the source exposes a snapshot AND the target implements the paired paste-state API (`setPasteState` with `getPasteState` — a target that could not re-export collapsed markers on the next hand-off receives expanded text instead), so `[paste #N ...]` markers stay collapsed across the swap. Otherwise it falls back to the expanded text via `getExpandedEditorText()`.
- New `getExpandedEditorText()` helper used by every full-editor-text consumer (`ctx.ui.getEditorText()`, Alt+Enter follow-up, external-editor open, and the hand-off fallback): prefers the editor's `getExpandedText()`, then expansion from `getPasteState()` via pi-tui's exported `expandPasteMarkers()`, then raw text (an editor with neither capability never had expandable markers).
- `setCustomEditorComponent(undefined)` is a draft no-op when the default editor is already active (`resetExtensionUI()` calls it unconditionally during extension resets and session invalidation): no hand-off happens, so no setText round-trip touches the user's draft.
- Previously the raw text alone was copied into the destination editor, whose empty registry turned live markers into dead literals — submit then sent the `[paste #N ...]` placeholder to the model instead of the pasted body.

### Why

- Companion to the pi-tui paste-registry fix (`packages/tui/src/changes.md`, same date). The hand-off is interactive-mode logic: only this layer knows both editor instances and their optional capabilities.

### Expected merge conflict zones

- LOW: `setCustomEditorComponent()` around the transfer helper and the factory/unset branches.
- LOW: `packages/coding-agent/test/suite/regressions/0000-editor-paste-marker-transfer.test.ts` (drives the real method with real tui editors).

## /reload honors the session_before_reload extension veto (2026-07-28)

### What changed

- `interactive-mode.ts` `handleReloadCommand()`: before building the reload box, the handler calls
  `session.checkReloadVeto()`; when an extension cancels (`session_before_reload` returning
  `cancel: true`), the command shows the extension's `reason` as a warning and returns — no reload box,
  no focus steal, no teardown. A cancelled result from `session.reload()` itself (late veto) dismisses
  the box back to the previous editor and shows the same warning.

### Why

- Reload destroys the extension runtime; extensions owning live background work (running subagents in
  omo-senpi) need a way to block it. The streaming/compaction guards already set the warning precedent.

## Fix: the startup tip is destroyed by extension headers (2026-07-27)

### What changed

- `tips/startup-header.ts` (new): `appendStartupHeader()` attaches the built-in header and the startup tip to the header container as **separate children**.
- `interactive-mode.ts`: the tip is no longer interpolated into the `ExpandableText` header closures.

### Why

`ui.setHeader()` replaces the built-in header component in place, and the builtin `prompt-preset` extension calls it on every `session_start`. Because the tip was part of the header's own text, that replacement silently discarded it: the tip resolved and was recorded into `tipsHistory`, but never reached the terminal. Keeping the tip as a sibling of the header makes it survive any extension header override.

## Tips cover the whole feature surface, and command tips are gated (2026-07-28)

### What changed

- `tips/catalog/` (new): the tip catalog is split by domain into `model-tips.ts`, `input-tips.ts`, `session-tips.ts`, `workspace-tips.ts`, `settings-tips.ts`, `cli-tips.ts`, and `subagent-tips.ts`, with the shared `TipDefinition` in `catalog/types.ts`. `tips/registry.ts` is now a barrel that concatenates them, so `TIP_DEFINITIONS` and `TipDefinition` keep their import paths.
- The catalog grew from 25 to 70 tips: model fallback chains and `/fallback`, `/login`, `--models` scoping, `thinkingBudgets`, `promptPreset`, `@` file references, Tab path completion, the `?` overlay, steering vs follow-up delivery, `escape` restoring the queue, `/clone`, `-c`/`-r`, `/name`, `/session`, `/export`, `/share`, `/compact`, auto-compaction, AGENTS.md context loading, `/skill:name` and prompt templates, `/files`, `/diff`, `/todo`, `/goal`, `/btw`, `/lookat`, `/mcp`, `/rules`, `/hooks`, `/websearch`, settings locations, `permissionPreset`, `packages`, custom themes, `/reload`, `/trust`, the `tips` toggle, print mode, tool allow/deny flags, subagent categories, `/tasks`, `~/.omo/omo.jsonc`, and teams.
- `TipDefinition.requiresCommand` (new): a tip that teaches an extension-provided command names it, and `selectTip()` skips that tip when the injected `hasCommand` resolver reports the command is not registered. `interactive-mode.ts` injects `hasRegisteredCommand()` (backed by `extensionRunner.getCommand()`) into both the startup and working tip resolvers.

### Why

The tip line was teaching a small slice of the product while most of the surface - retry fallback chains, session branching, permissions, subagent categories, the omo config file - stayed invisible. Gating by registered command keeps that breadth honest: builtin extensions can be disabled and the omo workflow tips only apply when the omo plugin is loaded, so those tips no longer advertise commands the session cannot run.

## Feature discoverability: tips, `?` overlay, live favorite hints, `/keybindings` (2026-07-27)

### What changed

- `tips/registry.ts` (new): a `TIP_DEFINITIONS` catalog teaching existing senpi features and workflow skills (`ulw plan`, `$start-work`, `ulw`/`ulw loop`, `ulw-research`, `hyperplan`, `review work`). Each tip declares its `bindings` and renders through an injected key resolver, so displayed keys always reflect the user's live configuration.
- `tips/scheduler.ts` (new): `selectTip()` picks the least-recently-shown eligible tip, honoring an injected key-availability resolver and a caller-owned exclusion set. `tips/history-writer.ts` (new): pure `recordTipShown()` merge with no module state; persistence is explicit via `settings-manager`.
- `tips/startup-tip.ts` (new): `resolveStartupTipLine()` resolves one banner tip line, gated by the `tips` setting and `quietStartup`. `interactive-mode.ts` renders it in both compact and expanded startup variants and records it once through the shared writer with a per-session shown-set.
- `tips/working-tip.ts` (new): `resolveWorkingTipLine()` resolves the tip under the working status. `interactive-mode.ts` wraps the indicator and tip in one Container so the single-child `statusContainer` contract holds, caches the pick per turn, excludes the banner tip, and resets on turn end.
- `tips/favorite-messages.ts` (new): `buildFavoriteCycleStatusMessage()` renders the favorite-model empty/single states with live `app.model.select` / `app.models.toggleFavorite` keys instead of the previous hardcoded copy.
- `components/shortcut-overlay.ts` (new): `ShortcutOverlay` plus the pure `shouldShowShortcutOverlay()` predicate. `interactive-mode.ts` mounts it only on a typed `?` in an empty editor (paste and non-empty text never trigger) and dismisses it on any further input or submit.
- `keybindings-command.ts` (new): `seedKeybindingsFile()` writes the effective bindings when the config is missing, and `applyKeybindingsFileEdit()` reloads only valid JSON. `interactive-mode.ts` adds a `/keybindings` dispatch that opens the real config via the new `editFileInExternalEditor()` seam in `external-editor.ts` and reloads the live manager without restart.

### Why

- The product already cycles favorites, toggles thinking, and exposes dozens of shortcuts, but none of that was discoverable in-product; users (including the owner) did not know `Ctrl+F` toggles favorites or that a favorite cycle existed.

### Merge-conflict zones

- `interactive-mode.ts` imports block, the startup banner assembly, the `defaultEditor.onChange` / `onSubmit` handlers, `showStatusIndicator`/`clearStatusIndicator`, and the slash-command text dispatch beside `/hotkeys` (five serialized edits).

## Footer cache segment removal and anchor-pinned layout (2026-07-27)

### What changed

- `components/footer-layout.ts` (new): pure width planning for the classic footer. `planFooterLayout()` picks the
  richest layout that fits the terminal: full line, then middle segments elided right-most-first behind a single
  dim "…" marker, then the pwd head-elided ("…/senpi"), then the whole left block head-elided, with the model
  label truncated only as the last resort. `elideHead()` keeps the tail of a path, which carries the most
  identifying information.
- `components/footer.ts`: the `cache <read>/<write>` totals segment was removed (the `CH<x>%` cache-hit-rate
  segment stays); rendering now builds plain/colored `FooterSegment` pairs and delegates fitting to
  `planFooterLayout()`, so the model label and the pwd • branch • context-usage block stay visible at any width
  instead of the right side being truncated away first.

### Why

- The cache read/write totals cost footer space out of proportion to their value, and the old truncation logic
  sacrificed the right-side model label whenever the left overflowed — the two anchors users watch (context
  usage, current model) were the first things to disappear on narrow terminals.

### Expected merge conflict zones

- MEDIUM: `components/footer.ts` `render()` was rewritten around `FooterSegment` pairs; upstream footer layout
  changes will conflict textually. `components/footer-layout.ts` is additive.

## Adaptive smooth-streaming buffer (2026-07-27)

### What changed

- `streaming-reveal.ts`, `streaming-reveal-pacing.ts`, and `streaming-reveal-content.ts`: smooth assistant output
  waits for an 80ms startup buffer, estimates the provider's grapheme arrival rate with an EWMA, and follows that
  learned base rate without a hard ceiling. Individual outlier samples are limited to four times the prior
  estimate, extra catch-up is bounded independently, and signed backlog correction converges toward roughly
  140ms of queued text across provider chunk cadences.
- Fully drained bursts reset fractional progress so a later chunk cannot inherit reveal budget from an earlier
  burst. Streaming tool arguments retain one-code-unit progress and parse in bounded 64-unit batches, preserving
  surrogate pairs while sharing the assistant pacing helper.
- `../../../test/streaming-reveal-{content,pacing}.test.ts`, `../../../test/streaming-reveal.test.ts`, and
  `../../../test/helpers/streaming-reveal.ts`: split grapheme, pacing, and controller coverage into focused modules
  and exercise timed 45/90/180/240/500-unit-per-second arrivals, multiple cadences, sustained fast streams,
  convergence and final-tail bounds, lifecycle flushes, and drained-burst carry reset.

### Why

- The previous fixed 267ms catch-up policy drained each provider burst completely, while the first adaptive
  implementation capped the total reveal rate at 240 graphemes per second. Providers above that rate accumulated
  an unbounded tail that snapped onscreen at `message_end`; separating the learned base rate from bounded
  correction keeps immediate completion flushes small without delaying lifecycle events.

### Expected merge conflict zones

## Footer prepends (OmO Native) badge when the OMO native stack is active (2026-07-28)

> SUPERSEDED by "OmO Native footer badge removed (2026-08-17)". Retained for history: the `(OmO Native)` anchor
> segment, its `footerData.isOmoNative()` feed, and `detectOmoNativeInstall()` were removed on 2026-08-10 (commit
> c416335e9), so this badge no longer renders. The width-elision ladder it participated in is unchanged.

### What changed

- `components/footer.ts`: `render()` prepends an `(OmO Native)` anchor segment (colored `success`) as the leftmost footer element when `footerData.isOmoNative()` returns true, before pwd and branch. The badge participates in the existing width-elision ladder as an anchor (never dropped, only elided with pwd when space is exhausted).
- The badge is fed by `FooterDataProvider.isOmoNative()`, set once at startup by `interactive-mode.ts` from `detectOmoNativeInstall()` (see root `src/changes.md`).
- Coverage: `test/omo-native-footer.test.ts` asserts the segment is the leftmost rendered text when active and absent when inactive.

### Why

- Makes the OMO native install state visible in the bottom-left footer without a separate status line.

### Expected merge conflict zones

- LOW: `components/footer.ts` around the anchor segment construction.

## Large resumed sessions use event-driven Working updates (2026-07-28)

### What changed

- `working-status.ts` adds `largeSessionWorkingStatusInterval()`: sessions below 1,000 persisted entries retain the
  existing 32 ms message shimmer and 600 ms indicator cadence. Larger histories refresh informational Working text
  and hook rows every second while limiting the decorative indicator fallback to once per 60 seconds.
- `interactive-mode.ts` applies the policy to the default Working indicator, message, and tool-hook timers. Tool,
  stream, status, and message events still request immediate renders, so large sessions remain live without
  continuously repainting an unchanged transcript.
- The persisted-entry threshold is sampled when a default indicator is created (and when a hook ticker starts);
  custom `setWorkingIndicator()` options bypass this policy by design.
- `test/interactive-mode-working-status.test.ts` locks both sides of the threshold and both large-session cadences;
  `test/hook-status-ticker.test.ts` locks the one-second large-session hook timer.

### Why

Each animation tick asks the TUI to render the complete component tree. That is cheap for ordinary sessions but can
become continuous CPU work after resuming a multi-thousand-entry transcript. One-second informational updates keep
elapsed labels honest, while event-driven renders and the 60-second decorative fallback avoid continuous repainting
of settled history.

### Expected merge conflict zones

- LOW: `working-status.ts` around animation timing helpers.
- LOW/MED: `interactive-mode.ts` around `getWorkingIndicatorOptions()` and `startToolHookStatusTimer()`.

## Paste markers survive editor hand-off; unset is a same-instance no-op (2026-07-28)

### What changed

- `interactive-mode.ts` `setCustomEditorComponent()`: switching between the default and a custom editor now transfers raw text plus the paste registry snapshot when the source exposes a snapshot AND the target implements the paired paste-state API (`setPasteState` with `getPasteState` — a target that could not re-export collapsed markers on the next hand-off receives expanded text instead), so `[paste #N ...]` markers stay collapsed across the swap. Otherwise it falls back to the expanded text via `getExpandedEditorText()`.
- New `getExpandedEditorText()` helper used by every full-editor-text consumer (`ctx.ui.getEditorText()`, Alt+Enter follow-up, external-editor open, and the hand-off fallback): prefers the editor's `getExpandedText()`, then expansion from `getPasteState()` via pi-tui's exported `expandPasteMarkers()`, then raw text (an editor with neither capability never had expandable markers).
- `setCustomEditorComponent(undefined)` is a draft no-op when the default editor is already active (`resetExtensionUI()` calls it unconditionally during extension resets and session invalidation): no hand-off happens, so no setText round-trip touches the user's draft.
- Previously the raw text alone was copied into the destination editor, whose empty registry turned live markers into dead literals — submit then sent the `[paste #N ...]` placeholder to the model instead of the pasted body.

### Why

- Companion to the pi-tui paste-registry fix (`packages/tui/src/changes.md`, same date). The hand-off is interactive-mode logic: only this layer knows both editor instances and their optional capabilities.

### Expected merge conflict zones

- LOW: `setCustomEditorComponent()` around the transfer helper and the factory/unset branches.
- LOW: `packages/coding-agent/test/suite/regressions/0000-editor-paste-marker-transfer.test.ts` (drives the real method with real tui editors).

## /reload honors the session_before_reload extension veto (2026-07-28)

### What changed

- `interactive-mode.ts` `handleReloadCommand()`: before building the reload box, the handler calls
  `session.checkReloadVeto()`; when an extension cancels (`session_before_reload` returning
  `cancel: true`), the command shows the extension's `reason` as a warning and returns — no reload box,
  no focus steal, no teardown. A cancelled result from `session.reload()` itself (late veto) dismisses
  the box back to the previous editor and shows the same warning.

### Why

- Reload destroys the extension runtime; extensions owning live background work (running subagents in
  omo-senpi) need a way to block it. The streaming/compaction guards already set the warning precedent.

## Fix: the startup tip is destroyed by extension headers (2026-07-27)

### What changed

- `tips/startup-header.ts` (new): `appendStartupHeader()` attaches the built-in header and the startup tip to the header container as **separate children**.
- `interactive-mode.ts`: the tip is no longer interpolated into the `ExpandableText` header closures.

### Why

`ui.setHeader()` replaces the built-in header component in place, and the builtin `prompt-preset` extension calls it on every `session_start`. Because the tip was part of the header's own text, that replacement silently discarded it: the tip resolved and was recorded into `tipsHistory`, but never reached the terminal. Keeping the tip as a sibling of the header makes it survive any extension header override.

## Tips cover the whole feature surface, and command tips are gated (2026-07-28)

### What changed

- `tips/catalog/` (new): the tip catalog is split by domain into `model-tips.ts`, `input-tips.ts`, `session-tips.ts`, `workspace-tips.ts`, `settings-tips.ts`, `cli-tips.ts`, and `subagent-tips.ts`, with the shared `TipDefinition` in `catalog/types.ts`. `tips/registry.ts` is now a barrel that concatenates them, so `TIP_DEFINITIONS` and `TipDefinition` keep their import paths.
- The catalog grew from 25 to 70 tips: model fallback chains and `/fallback`, `/login`, `--models` scoping, `thinkingBudgets`, `promptPreset`, `@` file references, Tab path completion, the `?` overlay, steering vs follow-up delivery, `escape` restoring the queue, `/clone`, `-c`/`-r`, `/name`, `/session`, `/export`, `/share`, `/compact`, auto-compaction, AGENTS.md context loading, `/skill:name` and prompt templates, `/files`, `/diff`, `/todo`, `/goal`, `/btw`, `/lookat`, `/mcp`, `/rules`, `/hooks`, `/websearch`, settings locations, `permissionPreset`, `packages`, custom themes, `/reload`, `/trust`, the `tips` toggle, print mode, tool allow/deny flags, subagent categories, `/tasks`, `~/.omo/omo.jsonc`, and teams.
- `TipDefinition.requiresCommand` (new): a tip that teaches an extension-provided command names it, and `selectTip()` skips that tip when the injected `hasCommand` resolver reports the command is not registered. `interactive-mode.ts` injects `hasRegisteredCommand()` (backed by `extensionRunner.getCommand()`) into both the startup and working tip resolvers.

### Why

The tip line was teaching a small slice of the product while most of the surface - retry fallback chains, session branching, permissions, subagent categories, the omo config file - stayed invisible. Gating by registered command keeps that breadth honest: builtin extensions can be disabled and the omo workflow tips only apply when the omo plugin is loaded, so those tips no longer advertise commands the session cannot run.

## Feature discoverability: tips, `?` overlay, live favorite hints, `/keybindings` (2026-07-27)

### What changed

- `tips/registry.ts` (new): a `TIP_DEFINITIONS` catalog teaching existing senpi features and workflow skills (`ulw plan`, `$start-work`, `ulw`/`ulw loop`, `ulw-research`, `hyperplan`, `review work`). Each tip declares its `bindings` and renders through an injected key resolver, so displayed keys always reflect the user's live configuration.
- `tips/scheduler.ts` (new): `selectTip()` picks the least-recently-shown eligible tip, honoring an injected key-availability resolver and a caller-owned exclusion set. `tips/history-writer.ts` (new): pure `recordTipShown()` merge with no module state; persistence is explicit via `settings-manager`.
- `tips/startup-tip.ts` (new): `resolveStartupTipLine()` resolves one banner tip line, gated by the `tips` setting and `quietStartup`. `interactive-mode.ts` renders it in both compact and expanded startup variants and records it once through the shared writer with a per-session shown-set.
- `tips/working-tip.ts` (new): `resolveWorkingTipLine()` resolves the tip under the working status. `interactive-mode.ts` wraps the indicator and tip in one Container so the single-child `statusContainer` contract holds, caches the pick per turn, excludes the banner tip, and resets on turn end.
- `tips/favorite-messages.ts` (new): `buildFavoriteCycleStatusMessage()` renders the favorite-model empty/single states with live `app.model.select` / `app.models.toggleFavorite` keys instead of the previous hardcoded copy.
- `components/shortcut-overlay.ts` (new): `ShortcutOverlay` plus the pure `shouldShowShortcutOverlay()` predicate. `interactive-mode.ts` mounts it only on a typed `?` in an empty editor (paste and non-empty text never trigger) and dismisses it on any further input or submit.
- `keybindings-command.ts` (new): `seedKeybindingsFile()` writes the effective bindings when the config is missing, and `applyKeybindingsFileEdit()` reloads only valid JSON. `interactive-mode.ts` adds a `/keybindings` dispatch that opens the real config via the new `editFileInExternalEditor()` seam in `external-editor.ts` and reloads the live manager without restart.

### Why

- The product already cycles favorites, toggles thinking, and exposes dozens of shortcuts, but none of that was discoverable in-product; users (including the owner) did not know `Ctrl+F` toggles favorites or that a favorite cycle existed.

### Merge-conflict zones

- `interactive-mode.ts` imports block, the startup banner assembly, the `defaultEditor.onChange` / `onSubmit` handlers, `showStatusIndicator`/`clearStatusIndicator`, and the slash-command text dispatch beside `/hotkeys` (five serialized edits).

## Footer cache segment removal and anchor-pinned layout (2026-07-27)

### What changed

- `components/footer-layout.ts` (new): pure width planning for the classic footer. `planFooterLayout()` picks the
  richest layout that fits the terminal: full line, then middle segments elided right-most-first behind a single
  dim "…" marker, then the pwd head-elided ("…/senpi"), then the whole left block head-elided, with the model
  label truncated only as the last resort. `elideHead()` keeps the tail of a path, which carries the most
  identifying information.
- `components/footer.ts`: the `cache <read>/<write>` totals segment was removed (the `CH<x>%` cache-hit-rate
  segment stays); rendering now builds plain/colored `FooterSegment` pairs and delegates fitting to
  `planFooterLayout()`, so the model label and the pwd • branch • context-usage block stay visible at any width
  instead of the right side being truncated away first.

### Why

- The cache read/write totals cost footer space out of proportion to their value, and the old truncation logic
  sacrificed the right-side model label whenever the left overflowed — the two anchors users watch (context
  usage, current model) were the first things to disappear on narrow terminals.

### Expected merge conflict zones

- MEDIUM: `components/footer.ts` `render()` was rewritten around `FooterSegment` pairs; upstream footer layout
  changes will conflict textually. `components/footer-layout.ts` is additive.

## Adaptive smooth-streaming buffer (2026-07-27)

### What changed

- `streaming-reveal.ts`, `streaming-reveal-pacing.ts`, and `streaming-reveal-content.ts`: smooth assistant output
  waits for an 80ms startup buffer, estimates the provider's grapheme arrival rate with an EWMA, and follows that
  learned base rate without a hard ceiling. Individual outlier samples are limited to four times the prior
  estimate, extra catch-up is bounded independently, and signed backlog correction converges toward roughly
  140ms of queued text across provider chunk cadences.
- Fully drained bursts reset fractional progress so a later chunk cannot inherit reveal budget from an earlier
  burst. Streaming tool arguments retain one-code-unit progress and parse in bounded 64-unit batches, preserving
  surrogate pairs while sharing the assistant pacing helper.
- `../../../test/streaming-reveal-{content,pacing}.test.ts`, `../../../test/streaming-reveal.test.ts`, and
  `../../../test/helpers/streaming-reveal.ts`: split grapheme, pacing, and controller coverage into focused modules
  and exercise timed 45/90/180/240/500-unit-per-second arrivals, multiple cadences, sustained fast streams,
  convergence and final-tail bounds, lifecycle flushes, and drained-burst carry reset.

### Why

- The previous fixed 267ms catch-up policy drained each provider burst completely, while the first adaptive
  implementation capped the total reveal rate at 240 graphemes per second. Providers above that rate accumulated
  an unbounded tail that snapped onscreen at `message_end`; separating the learned base rate from bounded
  correction keeps immediate completion flushes small without delaying lifecycle events.

### Expected merge conflict zones

- LOW: the fork-only streaming reveal modules, focused tests, and the shared pacing call in `tool-args-reveal.ts`.

## Runtime-error headline rendering (2026-07-27)

### What changed

- `extension-error-format.ts` (new): `formatExtensionErrorHeadline()` renders runtime-emitted errors
  (`extensionPath === RUNTIME_EXTENSION_PATH`) as `Runtime error (<event>): <message>`; real extensions keep the
  `Extension "<path>" error: <message>` framing.
- `extension-error-format.ts` also owns `sanitizeTuiErrorMessage()`, moved out of `interactive-mode.ts`, and the
  formatter applies it to the message, event name, and extension path. Provider error bodies are JSON-decoded
  before rendering, so `\u001b` escapes that were previously inert become live OSC/CSI sequences on an
  ANSI-preserving row; sanitizing inside the formatter means every consumer is protected by default.
- `interactive-mode.ts`: `showExtensionError()` consumes the full error object and uses the shared formatter, and
  imports the sanitizer from the format module instead of defining its own copy.

### Why

- Background session-title failures rendered as `Extension "<runtime>" error: {raw provider json}` — misattributed
  to an extension and unreadable.

### Expected merge conflict zones

- LOW: `showExtensionError()` in `interactive-mode.ts`; the formatter module is additive.

## combined tmux setup warning with allow-passthrough guidance (2026-07-17)

### What changed

- `checkTmuxKeyboardSetup` became `checkTmuxSetup` and reports every missing recommended tmux setting in one
  startup warning instead of one setting per restart. The message renders a copy-pasteable `~/.tmux.conf`
  block with aligned reason comments.
- New `tmux-setup.ts` owns the pure `buildTmuxSetupWarning` builder (unit-tested in
  `test/tmux-setup.test.ts`): `set -g extended-keys on` (unless `on`/`always`),
  `set -g extended-keys-format csi-u` (only when `xterm`), and `set -g allow-passthrough all` for inline
  Kitty images. The passthrough recommendation only appears when images are not already flowing
  (`getCapabilities().tmuxPassthrough !== true`) and the outer terminal can render Kitty graphics
  (`outerKittyGraphicsMode` from pi-tui, fed by `#{client_termname}`); users who chose
  `allow-passthrough on` are not nagged to switch to `all`.

### Why

- The tmux Kitty passthrough support in pi-tui needs `allow-passthrough`; the startup guidance is where users
  discover tmux configuration, and the previous one-at-a-time flow forced repeated tmux restarts.

### Expected merge conflict zones

- LOW: `interactive-mode.ts` `checkTmuxSetup` and its `run()` call site; `tmux-setup.ts` is additive.

## grok chrome seam for interactive mode (2026-07-26)

### What changed

- `interactive-mode.ts`: new optional `chrome` seam. `chrome: "grok"` constructs the `GrokChrome` strategy (`grok/chrome.ts`), which owns the base editor (wrapped in the rounded `GrokInputCard`), the compact `GrokFooter` (model and cwd only), the `GrokWelcomeCard` startup content, the braille working indicator (`⠹`, accent-tinted), the editor theme and border colour, overlay decoration, and root arrangement. Extensions continue to own their editor factory; the default no-chrome path is unchanged.
- `grok/tool-row.ts`: single-line tool presentation with a stable guide column (`┃` guide, `◆` marker), selected when the chrome's `toolPresentation` is `"grok"`.
- `grok/palette.ts` + `grok/chrome-tokens.ts`: capture-measured hex constants and glyphs, with chrome tokens delegating to the active theme so `grok-day` and custom themes stay coherent.

### Why

- The experimental `--grok-neo` mode reuses the ordinary interactive loop; the seam injects presentation without forking interactive-mode logic.

### Expected merge conflict zones

- LOW: the `chrome` constructor option and the `this.chrome ?` branches in `interactive-mode.ts`; the `grok/` directory is additive.

## Inspector VM-import rejection recovery (2026-07-24)

### What changed

- With `SENPI_RECOVER_INSPECTOR_VM_IMPORT=1` set at process start, interactive mode keeps running when an active Node
  Inspector evaluation creates the exact `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` unhandled rejection from an
  `<anonymous>` timer callback. Recovery remains disabled by default and is documented in
  `../../../docs/environment-variables.md`.
- The TUI shows guidance to use `require()` or a target-side loader.
- `cli-main.ts` installs the recovery seam before the asynchronous bootstrap, so a rejection fired while paused at an
  `--inspect-brk` breakpoint (before `registerSignalHandlers()` runs) is also recovered; the TUI warning is deferred
  until the handler registration consumes the pending recovery count.
- Crash-policy inspection is non-throwing: hostile rejection values with throwing `has` traps or `code`/`stack`
  getters are classified as non-recoverable instead of terminating the process inside the uncaughtException handler.
- Application-owned `evalmachine.<anonymous>` failures and every unrelated uncaught exception retain the existing
  terminal restoration and exit-1 behavior.

### Why

- Node's Inspector evaluator does not provide a dynamic-import callback. A delayed `import()` from `node inspect exec`
  previously surfaced as a process-wide uncaught exception and terminated an otherwise healthy debugging session.

### Why extension system couldn't handle this

- The rejection reaches the process-wide fatal handler before extension-level tool or event hooks can intercept it.

### Expected merge conflict zones

- LOW: `interactive-mode.ts` around `uncaughtCrash()` and `registerSignalHandlers()`.

## bounded compaction progress row (2026-07-24)

### What changed

- `components/status-indicator.ts`: the combined compaction spinner, status, and streamed preview is truncated to the
  actual terminal width. The status label (including its cancellation hint) is allocated first and the preview only
  receives the leftover columns; when a preview appears, the reason-specific label collapses to the shortest form that
  still shows the hint. The preview keeps the newest trailing columns of the accumulated summary, and the indicator is
  a single row both before and after the first progress event.
- `../../../test/interactive-mode-compaction.test.ts`: pins a hostile multiline, 600-column progress update to one
  rendered row no wider than the requested terminal width, with the cancellation hint retained and the newest streamed
  text (not the frozen opening words) visible.

### Why

- Long streamed summaries could wrap the otherwise single-row lifecycle indicator, push the composer upward, and make
  previous output appear erased as the terminal viewport remapped. A fixed half-width preview reservation could also
  starve the `esc to cancel` hint out of the row, head-first truncation froze the preview on the opening words of the
  summary, and the empty-preview state rendered a second spacer row that shifted the composer when progress arrived.

### Expected merge conflict zones

- LOW: `components/status-indicator.ts` compaction progress rendering.

## accepted-only compaction queue transfer (2026-07-24)

### What changed

- `interactive-mode.ts`: input queued while compaction owns the editor is automatically transferred only after an
  accepted compaction result. Rejected, failed, or aborted compaction retains the input in the editor-owned queue
  instead of resubmitting it through the unchanged required-compaction gate and recursively starting compaction.
- Consecutive `compaction_start` events share one Escape override. The original editor handler is preserved through
  supersession and restored exactly once on terminal cleanup, session rebind, invalidation, or TUI stop.
- Compaction progress, errors, and summaries are stripped of terminal control sequences only when rendered. Persisted
  summaries and provider/session content remain unchanged.
- The shared compaction-summary component applies the same display-only sanitization, covering rebuilt chat and
  reopened-session expansion in addition to live `compaction_end` rendering.
- Provider-derived fallback exhaustion errors are sanitized at the shared `showError()` render boundary; raw retry
  events and persisted/provider error content remain unchanged.

### Why

- Rejection and cancellation do not create a new admissible context. Automatically replaying the same prompt caused an
  unbounded compaction-start/rejection/restore loop.

### Expected merge conflict zones

- LOW: `interactive-mode.ts` `compaction_end` handling around `flushCompactionQueue()`.

## per-section thinking duration headers (2026-07-22)

### What changed

- `components/assistant-message.ts`: consecutive thinking sections with `startedAt` timing now show an italic
  `Thought: <duration>` header above visible reasoning, or replace the collapsed `Thinking...` label when reasoning is
  hidden. Active timed sections keep the configured thinking label; untimed and all-empty legacy sections retain their
  prior rendering.
- `../../../test/assistant-message.test.ts`: covers finished, active, legacy, empty/redacted, custom-label, and
  all-empty thinking-duration rendering states.
- `../../../test/streaming-reveal.test.ts`: verifies partially revealed thinking blocks retain their timing metadata.

### Why

- Per-section elapsed time makes completed reasoning runs legible without exposing hidden reasoning or introducing a
  live timer into the transcript.

### Why extension system couldn't handle this

- Thinking-section coalescing, hidden-label selection, streaming display slices, and transcript descriptor
  reconciliation are private core renderer behavior; an extension cannot insert a stable header into that sequence or
  preserve its metadata through the host-owned reveal path.

### Expected merge conflict zones

- LOW: `components/assistant-message.ts` around consecutive-thinking descriptor construction.
- LOW: `changes.md` fork-entry prepend.

## unified tool progress durations (2026-07-22)

### What changed

- `tool-progress.ts`: elapsed and maximum wait durations now share `formatWorkingElapsedSeconds()`, so progress rows use
  one seconds/minutes/hours grammar (`4m 28s / max 5m 00s`) instead of mixing humanized elapsed time with raw maximum
  seconds (`4m 28s / max 300s`).

### Why

- A single progress row should not force users to mentally convert the timeout while the elapsed side is already
  human-readable.

### Why extension system couldn't handle this

- The progress suffix is composed by the built-in interactive tool renderer after extension result rendering.

### Expected merge conflict zones

- LOW: `tool-progress.ts` around the maximum-wait suffix.
## braille tool progress spinner (2026-07-22)

### What changed

- `tool-progress.ts`: partial tool progress rows now use the same ten-frame braille spinner sequence as other Senpi
  waiting surfaces instead of cycling directional triangles (`⏵`, `⏷`, `⏴`, `⏶`).

### Why

- Long-running task, team-wait, and terminal progress rows should read as active work rather than a rotating disclosure
  marker. The existing 80ms component ticker already advances frames; the formatter now presents that animation with
  standard terminal spinner glyphs.

### Why extension system couldn't handle this

- Generic partial-progress rows are composed by the built-in `ToolExecutionRenderer` after extension result renderers
  run, so an individual tool extension cannot replace the host-owned progress prefix consistently.

### Expected merge conflict zones

- LOW: `tool-progress.ts` around `formatToolProgressLine()`.

## todo completion strike reveal (2026-07-21)

### What changed

- `components/todo-strike.ts` (new): pure, zero-import module exporting the strike
  reveal constants (`TODO_STRIKE_HOLD_FRAMES = 2`, `TODO_STRIKE_REVEAL_FRAMES = 12`,
  `TODO_STRIKE_TOTAL_FRAMES = 14`, `TODO_STRIKE_FRAME_INTERVAL_MS = 65`),
  `strikeRevealCount(text, frame)` (frame-to-visible-char-count math over code
  points), `partialStrikethrough(text, visibleChars, strike)` (code-point-safe
  splitter; strike styling comes ONLY from the injected `strike` callback — no
  raw ANSI literals), and `hasCompletedTodoTasks(details)`. Purity keeps the
  todotools extension free of interactive-runtime dependencies on non-interactive
  load paths and keeps the interactive core free of built-in-extension imports.
- `components/tool-execution.ts`: `updateResult()` also calls
  `updateTodoStrikeAnimation()`, which starts an `unref`'d, self-terminating
  `setInterval` (65ms, stops after `TODO_STRIKE_TOTAL_FRAMES`) when the result is
  a final non-error `todo` result with non-empty `completedTasks` AND
  `this.executionStarted` is set. Each tick advances `spinnerFrame`, busts the
  render cache, repaints, and requests a render; the settle tick restores the
  static full-strike rendering. `stopTodoStrikeAnimation()` clears the interval
  and resets `spinnerFrame` only when no spinner is running.
  `stopSpinnerAnimation()` leaves `spinnerFrame` to the strike owner while a
  strike is in flight. `stopAnimation()` also stops the strike. New
  `override dispose()` calls `stopAnimation()` before `super.dispose()` so pi-tui
  `Container.clear()`/`Container.dispose()` child propagation kills a mid-flight
  interval on chat teardown (also closes the pre-existing spinner teardown hole).
- `interactive-mode.ts`: new private `stopChatToolAnimations()` iterates
  `this.chatContainer.children` and calls `stopAnimation()` on every
  `ToolExecutionComponent`; `stop()` calls it immediately after
  `clearPendingTools()`. A completed mid-strike todo block has already left
  `pendingTools` (deleted at `tool_execution_end`) and `ui.stop()` does not
  dispose the component tree, so without this the interval would repaint a
  stopped UI until self-termination.

### Why

- A completion checkmark should land visibly. Without an animation, a finished
  task row silently switches from accent to dim+strikethrough and the user can
  miss which item just completed. A bounded ~910ms left-to-right reveal (2 hold
  frames + 12 sweep frames at 65ms/frame) makes the just-completed task
  unmistakable, then settles to byte-identical pre-change rendering.

### Why extension system couldn't handle this

- The strike interval is component-scoped and drives `ToolExecutionComponent`'s
  render-cache invalidation, `spinnerFrame` render signature, and lifecycle hooks
  (`updateResult`, `stopAnimation`, `dispose`); extensions cannot own built-in
  component private state or hook `Container.clear()`/`dispose()` propagation,
  and the per-frame repaint must route through the host's `requestRender` to
  respect the TUI FPS cap.
- The `executionStarted` rebuild-replay suppressor is core-private state set
  only on the live path (`renderSessionItems` rebuilds never call
  `markExecutionStarted()`); an extension cannot gate historical replay this way.

### Expected merge conflict zones

- MEDIUM: `components/tool-execution.ts` around `updateResult`, `stopAnimation`,
  `dispose`, and the `spinnerFrame`-reset guard in `stopSpinnerAnimation`.
- LOW: `interactive-mode.ts` around `stop()` and the new `stopChatToolAnimations`
  helper.
- LOW: the fork-only `components/todo-strike.ts` module.

## model fallback lifecycle notices (2026-07-20)

### What changed

- `interactive-mode.ts`: renders fallback apply, success, revert, and exhaustion notices; maintains a keyed `fallback`
  footer status while a fallback model is active; and suppresses the retry spinner for immediate fallback retries.
- Startup now shows fallback-chain validation warnings that were calculated by `AgentSession` when the session was created.

### Why

- A fallback model change is user-visible state. The chat and footer now make the active model and its lifecycle clear
  without adding synthetic messages to model context.

### Why extension system couldn't handle this

- Retry lifecycle events and session-start validation state are owned by the core session and rendered through the
  built-in interactive event handler.

### Expected merge conflict zones

- LOW: `interactive-mode.ts` retry event switch and startup warning block.

## exhaustive compaction_end rendering (2026-07-20)

### What changed

- `interactive-mode.ts`: the `compaction_end` handler no longer silently falls
  through when a rejection carries no `errorMessage` (e.g. legacy shape). It
  prefers the extension-provided `errorMessage` inside the `aborted` branch so
  per-turn-cap / circuit-breaker / provider-error cancels render the real cause
  instead of the generic "Compaction cancelled", and adds a fallback
  `showError("Compaction failed (no result); cause: <rejectionCause>")` so no
  future `compaction_end` shape can be ignored.

### Why

- Manual `/compact` used to render nothing when core rejected the summary as
  overflow-would-still-happen. The handler only branched on `aborted / result /
  errorMessage` and `_rejectCompaction` used to emit none of those fields for
  `would-overflow`. Combined with core now populating `errorMessage`, the
  interactive fallback closes plan §1.

## abbreviated footer token notation (2026-07-20)

### What changed

- `components/footer.ts`: `formatTokens` now renders oh-my-pi-style K/M/B abbreviations (e.g. `546K`, `1M`, `1.5M`)
  instead of comma-grouped `toLocaleString` output. The footer context-usage display now reads
  `546K/1M (54.6%)` instead of `545,661/1,000,000 (54.6%)`; the same notation applies to the ↑/↓/cache counters and
  the `interactive-mode.ts` token readouts that reuse `formatTokens`.

### Why

- Comma-grouped raw counts are wide and hard to scan in the status line; abbreviated notation matches oh-my-pi's
  status-line style and keeps the footer compact at narrow widths.

### Why extension system couldn't handle this

- Footer token formatting is a core display primitive, not an extension-registered status segment.
## paced streaming tool argument previews (2026-07-20)

### What changed

- `tool-args-reveal.ts`: adds per-tool-call pacing for streaming partial JSON. The first usable prefix appears
  immediately, later append-only growth follows the smooth-streaming cadence, parsing is batched in at least 64
  UTF-16-unit increments, and reveal boundaries never split surrogate pairs.
- `interactive-mode.ts`: routes in-flight tool arguments through the controller, flushes exact arguments at message and
  execution boundaries, cancels stale state on direct-update paths, publishes buffered arguments before teardown, and
  refreshes timers after live smooth streaming setting changes.

### Why

- Large tool arguments can arrive in provider bursts. Parsing and rendering every burst makes previews jump abruptly
  and repeatedly reparses nearly identical JSON prefixes.

### Why extension system couldn't handle this

- Extensions cannot own the built-in pending-tool component map or coordinate its private argument updates with
  assistant-message, tool-execution, settings, and teardown lifecycles.

### Expected merge conflict zones

- MEDIUM: `interactive-mode.ts` around streamed tool-call handling and lifecycle flushes.
- LOW: the fork-only argument reveal controller.

## smooth streaming reveal (2026-07-20)

### What changed

- `streaming-reveal.ts`: adds append-aware grapheme counting/slicing and a real-time reveal controller with 90
  units/second minimum velocity, a 267ms catchup horizon, 1–100ms delta clamping, and configurable 30–120fps ticks.
- `interactive-mode.ts`: routes assistant start/update events through one controller, flushes final content directly,
  stops pacing on abort/session teardown, resyncs live thinking visibility, and applies the TUI FPS cap.
- `components/settings-selector.ts`: adds “Smooth streaming” and “Streaming fps” controls.

### Why

- Bursty provider deltas should appear as a readable, steady reveal without splitting Korean, emoji ZWJ, combining, or
  other grapheme clusters.

### Why extension system couldn't handle this

- Extensions cannot replace the built-in in-flight assistant component or coordinate its render timer with session
  teardown and TUI scheduling.

### Expected merge conflict zones

- MEDIUM: `interactive-mode.ts` assistant event handling and settings callbacks.
- LOW: the fork-only controller and new selector items.

## incremental assistant message re-render (2026-07-19)

### What changed

- `components/assistant-message.ts`: replaces full child teardown on every assistant streaming delta with a flat
  descriptor reconciliation. Stable children are reused, same-kind Markdown changes update in place, and the first
  kind/text/list divergence rebuilds only the remaining suffix.
- `../../../test/assistant-message-incremental-render.test.ts`: compares incremental output byte-for-byte with fresh
  components across the supported block shapes and verifies leading and growing Markdown identities remain stable.

### Why

- Clearing the content container made every streamed token recreate preceding Markdown components, keeping their
  instance caches cold and repeatedly re-lexing already-finished blocks.

### Why extension system couldn't handle this

- Assistant transcript child reconciliation is private host-renderer state; an extension cannot retain or replace the
  built-in component's nested children.

### Expected merge conflict zones

- MEDIUM: `components/assistant-message.ts` around descriptor construction, child reconciliation, and render-cache
  invalidation.

## eval tool call single-box render (2026-07-17)

### What changed

- `components/tool-execution-renderer.ts`: `getRenderContext()` now sets `hasResult: this.state.result !== undefined`
  so a self-framing call renderer can yield once a result exists (see `../../core/extensions/changes.md` 2026-07-17).

### Why

- The codemode `eval` tool draws a full `╭─ … ╰─` frame in BOTH `renderCall` and `renderResult`. Because
  `update()` renders call-then-result into one container, a finished eval showed two stacked boxes (a stale
  pending/running frame above the live done frame). With `hasResult`, the call renderer yields and the result
  renderer owns a single frame that updates in place pending -> running -> done.

### Why extension system couldn't handle this

- Result presence for a tool row is private host renderer state; only the interactive renderer can populate the
  public `ToolRenderContext.hasResult` field the extension renderer reads.

### Expected merge conflict zones

- LOW: `components/tool-execution-renderer.ts` around `getRenderContext()`.

## Transactional post-compaction queue transfer (2026-07-13)

### What changed

- `compaction-queue-transfer.ts`: transfers one captured interactive batch entry by entry, commits exact accepted identities, searches past hook-handled entries until prompt work has an owner, and restores only the still-owned undelivered suffix ahead of later input.
- `interactive-mode.ts`: post-compaction rollback no longer clears unrelated native session queues. Transferred-but-unaccepted entries remain visible to Alt-Up/Esc, cancellation restores them without a later prompt start, and detached continuation-launch failures surface in the TUI while native work remains retryable. Overlapping flush requests run in call order, stop when exact ownership is cleared, and are invalidated when a session rebind advances the transfer generation.
- Mixed steer/follow-up batches adopt the native queue contract after the first prompt owns work: steering runs before follow-ups, with FIFO preserved within each mode rather than across modes.

### Why extension system couldn't handle this

- `compactionQueuedMessages` and the first-prompt handoff are private TUI state. Extensions can add native continuations, but cannot transactionally own or restore the host's interactive queue.

### Expected merge conflict zones

- HIGH: `interactive-mode.ts` around `flushCompactionQueue()` and pending-message display updates.
- LOW: `compaction-queue-transfer.ts` (fork-only helper).

## eval/tool image renderer lifecycle (2026-07-10)

### What changed

- `components/tool-execution.ts`: keeps tool lifecycle state, spinner updates, and bounded render caching while
  delegating renderer composition and image handling to focused collaborators.
- `components/tool-execution-renderer.ts`: resolves built-in/custom renderer slots, preserves reusable renderer
  components and shared state, and passes the active terminal image protocol through the renderer context (see
  `../../core/extensions/changes.md` 2026-07-10).
- `components/tool-execution-images.ts`: owns host image/fallback composition and Kitty conversion. Converted images
  are keyed by source identity, and generation checks prevent late conversion callbacks from replacing newer results.

### Why

- Eval/tool results can reuse renderer components across partial and final updates. Without the host fallback and
  conversion invalidation, non-PNG Kitty results could remain blank or cached instead of being replaced by the
  converted PNG.

### Why extension system couldn't handle this

- Extensions can inspect `imageProtocol` and return a result component, but they do not own the host's image conversion,
  post-renderer child composition, or display-cache invalidation across reused `ToolExecutionComponent` results.

### Expected merge conflict zones

- MEDIUM: `components/tool-execution.ts`, `tool-execution-renderer.ts`, and `tool-execution-images.ts` around lifecycle
  snapshots, renderer context/reuse, render signatures, and Kitty image conversion.

## preserve steer intent when draining queued input (2026-07-10)

### What changed

- `interactive-mode.ts`: the classic TUI main loop dispatches drained user input with explicit `steer` behavior so an
  automatic continuation that starts between input capture and dispatch queues the message instead of rejecting it as
  an unspecified concurrent prompt.

### Why

- Input can be accepted while the session is idle and remain pending until the main loop resumes. If processing becomes
  active during that interval, dropping the interactive queue intent surfaces a false `Agent is already processing`
  error even though the user submitted through the TUI's steer path.

### Why extension system couldn't handle this

- The race occurs in `InteractiveMode.run()` after the built-in editor/input queue hands control back to the main loop;
  extensions cannot replace that host-owned dispatch boundary.

### Expected merge conflict zones

- LOW: `interactive-mode.ts` around the main `getUserInput()` / `session.prompt()` loop.

## live hook identity in tool hook status rows (2026-07-04)

### What changed

- `interactive-mode.ts`: the `Running PreToolUse/PostToolUse hook` row renders live status text published through the
  new tool-hook `update` phase (`ctx.updateToolHookStatus()`, see `core/extensions/changes.md` 2026-07-04) instead of
  a static per-extension guess like `running builtin:hooks`.

### Why

- Users could not tell which hook was running or what it was doing; command-hook `statusMessage` configs were parsed
  but never rendered live.

### Why extension system couldn't handle this

- The hook status row is InteractiveMode's built-in UI; extensions publish status, the mode renders it.

### Expected merge conflict zones

- LOW/MED: `interactive-mode.ts` hook status row rendering and ticker lifecycle.

## external stdout/stderr guards while the TUI is active (2026-07-04)

### What changed

- `interactive-mode.ts`: wires the `ProcessTerminal` external stdout guard (hidden writes go redacted to the debug
  log via `core/hidden-stdout-log.ts`) and the stderr guard (`interactive-stderr-guard.ts`, fork-only) so no stray
  library/extension output reaches the screen while the TUI owns the terminal.

### Why

- External writes interleaved with frames and permanently desynchronized differential rendering (TUI-side guard in
  `packages/tui/src/changes.md` 2026-07-04; startup-dialog wiring in `cli/changes.md` 2026-07-04).

### Why extension system couldn't handle this

- Terminal stream ownership during interactive mode is the mode's own lifecycle concern.

### Expected merge conflict zones

- LOW: `interactive-mode.ts` TUI start/stop wiring; `interactive-stderr-guard.ts` (fork-only).

## hook-status ticker unref (2026-07-03)

### What changed

- `interactive-mode.ts`: the hook-status ticker interval is unref'd after creation.
- `packages/coding-agent/test/hook-status-ticker.test.ts`: verifies the timer exposes and calls `unref()`.

### Why

- The hook-status ticker should not keep the interactive process alive after other work completes.

### Why extension system couldn't handle this

- The timer is internal to `InteractiveMode`'s built-in hook status lifecycle.

### Expected merge conflict zones

- LOW/MED: `interactive-mode.ts` around `startToolHookStatusTimer`, `stopToolHookStatusTimer`, and hook status
  lifecycle methods.

## custom entry renderer display order sync (2026-07-02)

### What changed

- `interactive-mode.ts`: accepted upstream rendering for extension custom entry renderers and kept fork-specific
  hook/system-prompt UI behavior.
- `components/custom-entry.ts`: added the display component for custom session entries rendered by extension entry
  renderers.

### Why

- Display-only custom entries appended during assistant streaming must render in persisted session order and before the
  live assistant message, matching replayed sessions.

### Why extension system couldn't handle this

- Extensions provide renderer implementations, but the built-in interactive mode owns session-entry ordering and the
  default component host where persisted custom entries are displayed.

### Expected merge conflict zones

- MEDIUM: `interactive-mode.ts` around session entry rendering, live assistant message ordering, and extension renderer
  dispatch.
- LOW: `components/custom-entry.ts` if upstream changes custom-entry component shape.

## abort queue restoration during retry (2026-06-18)

### What changed

- `interactive-mode.ts`: Escape during streaming or retry now aborts the active operation, clears queued steering/follow-up
  rows, and restores the queued text to the editor instead of auto-submitting it as a fresh prompt.

### Why

- Auto-submitting restored queue text could race the abort barrier and surface `Agent is already processing` after the user
  had already aborted. It also made an aborted retry appear to keep working on queued input.

### Why extension system couldn't handle this

- The default Escape handler and pending-message display are owned by `InteractiveMode`; extensions can request aborts but
  cannot change the built-in queue restoration path.

### Expected merge conflict zones

- HIGH: `interactive-mode.ts` around `abortAndFireQueuedMessages()` and the default Escape handler.

## normal Working animation and packaged TUI runtime (2026-05-20)

### What changed

- `interactive-mode.ts`: the default normal TUI Working indicator uses two visible frames, `•` and `◦`, plus the
  animated `Working (Xs • esc to interrupt)` message formatter.
- `packages/coding-agent/package.json`: the public `@code-yeongyu/senpi` package bundles the private forked
  `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui` workspaces.
- `scripts/release.mjs`: release no longer rewrites those dependencies to upstream npm `0.x` packages before publish.

### Why

- The normal TUI looked static after `@code-yeongyu/senpi` installed an upstream `@earendil-works/pi-tui` package whose
  `Loader` ignored `messageFormatter`, so the installed CLI rendered only `• Working`.
- The source tree already had richer Working text animation; the npm tarball must carry the forked TUI runtime that
  implements it.

### Why extension system couldn't handle this

- `InteractiveMode` owns the built-in Working row and the default `LoaderIndicatorOptions`.
- Extensions can override the row, but they cannot repair the packaged runtime dependency used by global npm installs.

### Expected merge conflict zones

- HIGH: `interactive-mode.ts` around `getWorkingIndicatorOptions()`; preserve two default frames plus message formatter.
- HIGH: release/package files around bundled workspace dependencies; do not pin `@earendil-works/pi-*` to upstream npm
  versions for `@code-yeongyu/senpi` publishing.
- MEDIUM: `packages/tui/src/components/loader.ts`; preserve `messageFormatter` and independent message animation.

## live tool hook status rows (2026-05-19)

### What changed

- `interactive-mode.ts`: active `tool_hook_status` events render in a dedicated status lane below the normal Working
  loader, with Codex-like `Running PreToolUse hook: ...` and `Running PostToolUse hook: ...` wording.
- `working-status.ts`: hook rows reuse the existing Working shimmer treatment and append live elapsed time without
  adding an interrupt hint.

### Why

- Extension hooks can perform visible work before and after tool execution. Showing the specific hook and elapsed time
  makes the TUI more informative than a generic Working row.

### Why extension system couldn't handle this

- The built-in interactive renderer owns the live status layout and shimmer styling. Extensions can inject widgets, but
  they cannot reliably render host-managed lifecycle rows beside the existing Working indicator.

### Expected merge conflict zones

- MEDIUM: `interactive-mode.ts` around status containers, Working loader helpers, and `handleEvent()`.
- LOW: `working-status.ts` around the shared shimmer formatting helpers.

## OpenAI remote compaction details (2026-05-15)

### What changed

- `interactive-mode.ts`: synthetic post-compaction summary messages now preserve `CompactionResult.details`.
- `components/compaction-summary-message.ts`: the compact summary card shows when OpenAI remote compaction was used,
  including requested input count, retained item count, original token pressure, and whether the route was Responses
  WebSocket compaction or the compact endpoint.

### Why

- Users need to tell whether a turn used the extension fallback summary route or OpenAI's provider-native compact API.

### Why extension system couldn't handle this

- The visible summary card is built by the interactive renderer, and the synthetic message is created by the built-in
  `compaction_end` event handler.

### Expected merge conflict zones

- LOW: `interactive-mode.ts` around the `compaction_end` handler.
- LOW: `components/compaction-summary-message.ts` around collapsed and expanded summary rendering.

## compaction feedback labels (2026-05-15)

### What changed

- `interactive-mode.ts`: `compaction_start` now renders clearer loader text for extension and pre-prompt compaction instead of labeling every non-manual route as auto-compaction.

### Why

- The fork's builtin compaction extension can run a blocking summary before the next turn. Once that route emits canonical compaction events, the TUI should say it is compacting context rather than implying an automatic threshold compaction.

### Why extension system couldn't handle this

- The loader label is produced by the built-in `InteractiveMode` handler for core session events.

### Expected merge conflict zones

- LOW: `interactive-mode.ts` around the `compaction_start` event handler.

## compact provider-native web search rendering (2026-05-14)

### What changed

- `components/assistant-message.ts`: provider-native web-search blocks render through the shared formatter in `../provider-native-rendering.ts` instead of dumping raw provider JSON.
- Recognized Anthropic, OpenAI, and Google native web-search metadata now show compact query/status/source summaries while unknown provider-native blocks keep the generic JSON fallback.

### Why

- The raw provider-native JSON exposed implementation fields such as `encrypted_content` and made native web search blocks visually inconsistent with normal tool widgets.

### Why extension system couldn't handle this

- Provider-native assistant content is rendered by the built-in assistant message component before extension tool renderers are involved.

### Expected merge conflict zones

- LOW: the provider-native branch in `components/assistant-message.ts` and shared formatting behavior in `../provider-native-rendering.ts`.

## Slash command path tilde expansion (2026-05-13)

### What changed

- `interactive-mode.ts`: `/export ~/...` and `/import ~/...` expand leading `~` to the user's home directory before invoking session import/export.

### Why

- Built-in slash commands previously treated `~` as a literal path segment, which could create or read files under `./~/...`.

### Why extension system couldn't handle this

- Slash-command path parsing is internal to `InteractiveMode`; extensions cannot normalize the built-in command argument after parsing.

### Expected merge conflict zones

- LOW: `getPathCommandArgument()` in `interactive-mode.ts`.

## bash execution command syntax highlighting

- Changed `src/modes/interactive/components/bash-execution.ts` so the command header for interactive/user shell execution highlights bash syntax with the existing TUI syntax palette instead of coloring the whole command as a single bash-mode string.
- This was changed in core UI because the live bash execution component owns the command header render path; extensions cannot intercept that component without replacing the built-in interactive renderer.
- Expected merge-conflict zone on upstream sync: the `BashExecutionComponent` command header setup and `updateDisplay()` rebuild path.

## non-blocking startup tool discovery

- Changed `src/modes/interactive/interactive-mode.ts` so interactive startup only probes an already-installed `fd` path for autocomplete instead of awaiting `fd`/`rg` downloads before showing the UI.
- Added `src/modes/interactive/startup-tools.ts` to keep the startup-only tool resolution behavior small and directly testable.
- This was changed in core UI because the blocking call happens inside `InteractiveMode.init()` before extension startup hooks can run, so a builtin extension cannot prevent the first-launch wait.
- Expected merge-conflict zone on upstream sync: tool setup in `InteractiveMode.init()` near the startup changelog/header initialization.

## favorite model cycling

- Changed `src/modes/interactive/interactive-mode.ts` so Ctrl+P reports missing favorite models instead of cycling through every available model, and `/favorite-models` saves selections to the new `favoriteModels` settings field.
- Changed `src/modes/interactive/components/model-selector.ts` and `favorite-models-selector.ts` so favorite rows can also select the active model, while `Ctrl+F` toggles the selected row's favorite state from either `/model` or `/favorite-models`; `/model` toggles persist immediately because that selector has no separate save command.
- This was changed in core UI because the built-in status text and favorite-model selector wiring are internal `InteractiveMode` behavior; extensions cannot replace the default Ctrl+P command semantics without racing the built-in binding.
- Expected merge-conflict zone on upstream sync: model cycling status, `/model` favorite toggle wiring, and `/favorite-models` selector wiring in `src/modes/interactive/interactive-mode.ts` plus the two model selector components.

## builtin extension display paths

- Changed `src/modes/interactive/interactive-mode.ts` so synthetic builtin extension ids render as `builtin/<name>` in the startup Extensions section.
- Changed `src/modes/interactive/interactive-mode.ts` so builtin extensions render in their own `builtin` group and `todowrite` is labeled as `todo` in the startup Extensions section.
- This was changed in core UI because the display formatting lives in `InteractiveMode.formatDisplayPath()`; the extension system cannot intercept that built-in startup formatter.
- Expected merge-conflict zone on upstream sync: `showLoadedResources()` helpers in `src/modes/interactive/interactive-mode.ts`.

## disable startup update checks

- Changed `src/modes/interactive/interactive-mode.ts` so startup no longer checks upstream npm registry version/package updates before entering the interactive loop.
- This was changed in core UI because those startup checks are internal `InteractiveMode` methods and there is no extension hook that can reliably suppress them before they run.
- Expected merge-conflict zone on upstream sync: startup helpers around `checkForNewVersion()` and `checkForPackageUpdates()` in `src/modes/interactive/interactive-mode.ts`.

## clipboard paste error surfacing

- Changed `src/modes/interactive/interactive-mode.ts` so `handleClipboardPaste()` failures show a `Clipboard paste failed: <reason>` status instead of being silently swallowed; an empty clipboard still stays quiet.
- This was changed in core UI because clipboard paste is internal `InteractiveMode` editor wiring (`onPasteImage`); extensions cannot observe that catch path.
- Expected merge-conflict zone on upstream sync: `handleClipboardPaste()` in `src/modes/interactive/interactive-mode.ts`.

## compaction queue delivery after unsuccessful compaction

- Changed `src/modes/interactive/interactive-mode.ts` and `compaction-queue-transfer.ts` so every terminal `compaction_end` flushes the TUI compaction queue: accepted compactions keep prompt-admission delivery, while failed/rejected/aborted ones route queued input through the native steer/followUp queues (`deferAdmission`) with a visible held-count status and a `compaction_queue_deferred` session-log event. Previously the queue was flushed only on success, so messages typed during a failing compaction were silently parked forever and lost on session switch (field report 2026-07-30).
- This was changed in core UI because the compaction queue and `compaction_end` handling are internal `InteractiveMode` state; extensions cannot observe or drain that queue.
- Expected merge-conflict zone on upstream sync: the `compaction_end` handler and `flushCompactionQueue()` in `src/modes/interactive/interactive-mode.ts`, plus `compaction-queue-transfer.ts` transfer options.

## Pasted clipboard images ride the submission channel as attachments (2026-08-18)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: `handleClipboardPaste()` now attaches the pasted image instead of inserting its temp path. When the editor is image-aware it calls `insertImageMarker()`, stores the processed bytes in a `pendingImages` map keyed by marker id, and keeps that map aligned with the visible `[Image #N]` numbers through `onImageMarkersChanged` (`reconcilePendingImages`). On submit, `takeSubmissionImages()` reads only the submitted text plus `pendingImages` (never live editor state) to build the ordered `images: ImageContent[]` carried on the user message, with a pre-resolved path for flows whose `setText("")` prune chain would otherwise destroy the payloads before resolution.
- `packages/coding-agent/src/modes/interactive/editor-paste-transfer.ts`: `transferEditorContent()` now moves the image-marker registry snapshot alongside the text and paste state, returns `{ imageMarkersTransferred }`, and strips `[Image #N]` markers (collapsing leftover whitespace) when the destination editor cannot own them, so the caller can drop the orphaned payloads instead of shipping a dead literal marker with a live attachment behind it.

### Why

- Inserting the raw `pi-clipboard-*.png` path leaked local temp paths into the composer and the transcript, and nothing carried the image bytes to the model. Markers plus a keyed payload map let one user turn carry both text and image parts in reading order.

### Why an extension could not handle it

- The submission pipeline, the editor wiring, and the pending-payload lifecycle are private `InteractiveMode` state; an extension receives no callback that can attach bytes to a submitted user message or re-key payloads when markers are renumbered.

### Expected merge conflict zones

- MEDIUM: the paste handler, submit path, and editor wiring in `packages/coding-agent/src/modes/interactive/interactive-mode.ts`.
- LOW: `packages/coding-agent/src/modes/interactive/editor-paste-transfer.ts` (small transfer helper, additive return value).

## 2026-08-20 — render-stall fixes: mode-switch detach + reload-scoped extension UI reset

- `switchTuiMode()` now moves components to the new renderer with
  `detachAll()` instead of `clear()`. Clearing disposed the live components
  (tool spinners, reveals, extension widgets) and remounted the dead
  instances, killing every interval they owned: the TUI froze until an input
  event forced a frame. Regression: `test/interactive-tui.test.ts`
  ("switchTuiMode component lifecycle").
- `handleReloadCommand()` resets extension UI inside reload()'s
  `beforeSessionStart` callback instead of up front, so a vetoed or failed
  reload no longer destroys live extension footers/widgets/tickers.
  Regression: `test/interactive-tui.test.ts` ("handleReloadCommand extension
  UI lifecycle").

## 2026-08-25 - reject upstream Radius interactive sharing surface

### What changed

- `packages/coding-agent/src/modes/interactive/session-share.ts`: intentionally absent from Senpi; the upstream Radius session-share surface is rejected under the fork sharing policy.

### Why

- Senpi retains the fork's gist-based `/share` flow and `pi.dev` viewer rather than introducing Radius links.

### Why an extension could not handle it

- Interactive sharing command ownership and product policy are implemented in the core interactive mode, before an extension can replace the share surface.

### Expected merge conflict zones

- NONE: the upstream-only Radius session-share artifact remains excluded from the fork tree.

## 2026-08-27 - render JSON tool results as a styled key-value fallback

### What changed

- `packages/coding-agent/src/modes/interactive/components/tool-execution-fallback.ts`: `createToolResultFallback()` now inspects the rendered text output before styling it. When the trimmed text starts with `{` or `[`, parses as JSON, and yields a non-null object or array, the fallback renders a bounded `key: value` view (keys in `muted`, string values in `toolOutput`, numbers/booleans in `accent`, `null` in `dim`) with 2-space indentation per nesting level. Anything else — prose, logs, malformed JSON — keeps the previous `theme.fg("toolOutput", output)` path byte for byte.
- The view is bounded so a large payload cannot flood the transcript: max nesting depth 3 (deeper containers collapse to a truncated compact `JSON.stringify`), max 24 rendered rows followed by a single dim `… N more` line, and string values truncated to 100 characters with a trailing ellipsis. The function still returns the same `Text` component type as before.
- `packages/coding-agent/test/tool-execution-fallback-json.test.ts`: new regression suite covering nested objects, prose passthrough, malformed-JSON passthrough, row/string bounds, and top-level primitive arrays.

### Why

- Tools without a `renderResult` hook — MCP-wrapped tools and third-party extensions in particular — commonly return their payload as a JSON string. The fallback dumped that raw string into the transcript, so a single call could paste an unreadable one-line blob across the viewport. A bounded key-value view keeps the same information scannable without asking every tool author to ship a renderer.

### Why an extension could not handle it

- This is the renderer of last resort inside `ToolExecutionComponent` for tools that have no renderer. An extension can only supply `renderResult` for its own tools; it has no hook covering results produced by other extensions or by MCP-bridged tools, which is exactly the population that hits this path.

### Expected merge conflict zones

- LOW: `createToolResultFallback()` in `packages/coding-agent/src/modes/interactive/components/tool-execution-fallback.ts` (additive helpers plus a two-line branch in one small function).

- NF-1 RED: HEAD rejected setup-state custom entries with "Shared-host setup cannot transport custom entries" (binding test before implementation).
- NF-1 GREEN: setup now transports every captured SessionEntry verbatim through append_session_entry; custom and session_info entries are persisted and observable by a second RPC client.

- NF-2 RED: replacement string sendUserMessage dropped expandPromptTemplates, so the binding host trace did not preserve explicit false.
- NF-2 GREEN: string replacement messages now forward expandPromptTemplates exactly like array messages; explicit false leaves /help as provider content.

## Interactive RPC reconnect cancellation and terminal fallback (2026-08-30)

- Treats transport loss in value-returning interactive host operations as user cancellation with inert results, so reconnect/fallback warnings are not repeated as action errors.
- Makes reconnect exhaustion terminal after three attempts and awaits the local fallback session rebind before disposal.

## Interactive RPC reconnect cancellation ordering (2026-08-30)

- Preserves structured cancellation results for reload and reload-veto checks when the shared transport disconnects.
- Keeps fallback warning emission behind the completed local rebind handoff.
