# changes

## accepted-only compaction queue transfer (2026-07-24)

### What changed

- `interactive-mode.ts`: input queued while compaction owns the editor is automatically transferred only after an
  accepted compaction result. Rejected, failed, or aborted compaction retains the input in the editor-owned queue
  instead of resubmitting it through the unchanged required-compaction gate and recursively starting compaction.

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
