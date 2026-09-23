## 2026-09-23 — Wire visible-stderr observation into the interactive TUI (senpi#1879)

### What changed

- `packages/coding-agent/src/modes/interactive/tui-renderer.ts` passes `observeVisibleStderrWrites` into `ProcessTerminal` so mouse geometry follows the real stderr destination.

### Why

- Hidden diagnostics were observed above the interactive stderr redirect and duplicated the working frame.

### Why an extension could not handle it

- The interactive TUI factory owns `ProcessTerminal` construction; extensions cannot replace that observer.

### Expected merge conflict zones

- `createInteractiveTui` `ProcessTerminal` options. Keep `onExternalStdoutWrite: appendHiddenTuiStdout`.

## 2026-09-22 - surface models.json provider-rename warnings (senpi#1989)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: renders `modelRuntime.getWarnings()` through `showWarning` at startup, beside the existing models.json error line.

### Why

A models.json written with the legacy provider ids still works (the keys are normalized on read), so it is NOT a load failure and must not use the models.json ERROR channel. The user still needs to be told once which ids moved so they can update the file.

### Why an extension could not handle it

Startup diagnostics are rendered by interactive mode itself; an extension cannot add a line to that startup sequence.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` the startup diagnostics block around the models.json error render.

## 2026-09-22 - reject a typed legacy provider id in /login (senpi#1989)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: `handleLoginCommand` rejects a typed legacy provider id, or one of the legacy display names, with a message naming the new id before it can reach the provider selector.

### Why

A typed legacy id previously fell through to `showLoginProviderSelector(undefined, providerRef)`, opening a selector filtered to nothing - which reads as "this provider vanished" rather than "it was renamed". Config read from disk is normalized instead (todo 8) and never hard-errored.

### Why an extension could not handle it

The login command is interactive mode's own command handler; an extension cannot intercept it before the selector opens.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` `handleLoginCommand`.

## 2026-09-21 - Transcript explains transport drops and never renders the replay marker (senpi#1628)

### What changed

- `packages/coding-agent/src/modes/interactive/components/assistant-render-descriptors.ts`: the `error` branch renders through pi-ai's `describeProviderFailureForUser` (stall wording delegated, WebSocket interruptions worded for a person, no recovery advice while a retry may still run); the raw `Error: ...` fallback and the `aborted` branch pass the text through `stripTurnRetrySuppressionPrefix`.

### Why

- `packages/coding-agent/src/modes/interactive/components/assistant-render-descriptors.ts` printed `Error: senpi:no-turn-retry:WebSocket error` after a Codex WebSocket drop - the session-internal replay marker in front of a bare transport verdict, and nothing about what to do next.

### Why an extension could not handle it

- `packages/coding-agent/src/modes/interactive/components/assistant-render-descriptors.ts` is the transcript renderer; an extension can add entries but cannot rewrite how an assistant message's terminal error is drawn.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/interactive/components/assistant-render-descriptors.ts`: the pi-ai import block and the `error`/`aborted` cases of the stop-reason switch.

## 2026-09-21 - Bind extension user edits locally and through the interactive host

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: binds `editUserMessage` beside assistant edits, refreshes history only after a changed edit, and forwards navigation's caller-supplied `expectedLeafId`.
- `packages/coding-agent/src/modes/interactive/interactive-host-runtime.ts`: forwards user edits to the host rather than the local shadow, restores core typed refusals from wire codes, refreshes history after edits, and returns `result.entry.id`, never the metadata-advanced `leafId`.

### Why

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: the new extension capability must work in interactive mode as well as print and RPC.
- `packages/coding-agent/src/modes/interactive/interactive-host-runtime.ts`: missing proxy methods fall through to the local session, so merely adding the mode binding would edit the wrong session. The client navigation return now includes a leaf, while the proxy's transport-loss cancellation remains a core-shaped result.

### Why an extension could not handle it

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` owns command action construction and history refresh.
- `packages/coding-agent/src/modes/interactive/interactive-host-runtime.ts` owns the session proxy and wire-to-core result/error translation.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: `commandContextActions` navigation and assistant-edit neighbours.
- `packages/coding-agent/src/modes/interactive/interactive-host-runtime.ts`: edit-related imports and proxy navigation/edit property cases.

## 2026-09-20 - Surface a held model switch (senpi#1873)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` renders the new `model_change_pending` event as a warning and invalidates the footer, so a switch waiting for the next message to compact for it is visible rather than looking like nothing happened.

### Why

- #1873 stops refusing a switch onto a model that one compaction would make usable, and holds it instead. Without a surface the model selector would appear to do nothing: the picker closes, the footer still shows the old model, and no error is printed.

### Why an extension could not handle it

- The event is emitted by the session's admission path and consumed by the interactive event switch, which no extension can extend with a new case.

### Expected merge conflict zones

- LOW: the session-event switch in `interactive-mode.ts`, next to the `model_change_skipped` case.

## 2026-09-20 - Share the ask-user answer-frame parser (#1857 I3)

### What changed

- `packages/coding-agent/src/modes/interactive/components/ask-user-answer-chip.ts` re-exports the parser and frame type from the ask-user formatter. The chip's public exports remain unchanged.

### Why

- Restart recovery and transcript rendering must recognize the same frame. Separate copies could drift and cause answered questions to be presented again.

### Why an extension could not handle it

- The host's transcript component imports this parser directly; an external extension cannot change that import.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/interactive/components/ask-user-answer-chip.ts`: parser import and re-export.

## 2026-09-20 - Restore question drafts after reload (#1857 I1)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` passes `initialDraft` to the blocking question component and uses it to initialize async question state.

### Why

- Reattaching the UI must restore the user's selections and comment rather than displaying a fresh question.

### Why an extension could not handle it

- The host owns creation of both question surfaces; the builtin already retains the draft but cannot seed the host's UI without this option.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: QuestionOverlayOptions, showQuestionOverlay, and showAsyncQuestion.

## 2026-09-17 - Remember the detected terminal background (senpi#1781)

### What changed

- New `theme/terminal-theme-cache.ts`: reads and atomically writes `<agentDir>/cache/terminal-theme.json`, failing open in both directions.
- `theme/theme-controller.ts`: seeds `terminalTheme` from that hint before falling back to `detectTerminalBackgroundFromEnv()`, and writes the hint whenever a detection resolves (both the background and the `auto` paths).

### Why

- Detection became non-blocking, so the first frame is painted from a guess. For a `light/dark` setting that guess came only from `COLORFGBG`, which most terminals do not set, and nothing was persisted - so an `auto` user on a light terminal was repainted on every single launch rather than once.

### Why an extension could not handle it

- The terminal background is read by the host's own theme controller before any extension is bound.

### Expected merge conflict zones

- LOW: the `terminalTheme` field initializer and the two detection branches in `theme-controller.ts`.

## 2026-09-17 - Mark the init seams and stop waiting on the theme query (senpi#1781)

### What changed

- `interactive-mode.ts` `init()` resets the `tui` timing namespace and marks changelog, component tree plus `ui.start`, theme, managed tools, key handlers, session rebind and initial render.
- `theme/theme-controller.ts` `applyFromSettings()` applies the environment or last-known theme immediately, runs `detectTerminalBackgroundTheme` / `detectTerminalThemeForAuto` in the background, and applies plus persists a high-confidence answer when it arrives; a pinned theme still skips detection.

### Why

- The phase was measured as a single number, so nothing could be budgeted inside it; the first instrumented run attributed 749 ms of 820 ms to the session rebind and 2 ms to the terminal component tree.
- The OSC query blocked the first frame for up to its 100 ms timeout on every launch with no persisted theme or an `auto` setting.

### Why an extension could not handle it

- Both live in the host's own interactive entry, before and around the extension bind.

### Expected merge conflict zones

- MEDIUM: the body of `init()` and `applyFromSettings()`.

## 2026-09-17 - Skill mentions render bold in the composer, transcript lists every skill (senpi#1778)

### What changed

- `packages/coding-agent/src/modes/interactive/theme/theme.ts`: optional `skillMention` theme color (falls back to `mdLink`); `getEditorTheme().mention` renders a resolved `$skill` token bold in that color. `packages/coding-agent/src/modes/interactive/theme/theme-json.ts` and `packages/coding-agent/src/modes/interactive/theme/theme-schema.json` accept the optional key.
- `packages/coding-agent/src/modes/interactive/components/skill-invocation-message.ts`: the collapsed row lists every invoked skill (`[skill] a, b`) and the expanded view shows one name header and body per skill, from `ParsedSkillBlock.skills`.

### Why

- senpi#1778: Codex renders bound skill mentions in a distinct style; multi-skill prompts showed only the first skill in the transcript.

### Why an extension could not handle it

- Editor theme wiring and the built-in transcript renderer are host-owned.

### Expected merge conflict zones

- LOW: `ThemeColor` union / fallback tables; `updateDisplay()` in the skill component.

## 2026-09-16 - Live rate readout removed from the working line (senpi#1759)

### What changed

- `packages/coding-agent/src/modes/interactive/working-status.ts`: the optional live-rate parameter and the helper that rendered it are removed; the suffix is again `(<elapsed> - <key> to interrupt)`.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: the per-turn rate meter, its rebuild at assistant `message_start`, the `message_update` unit recording, the reader the working line called, and the notice box for the agent loop's rate verdict are removed.

### Why

- The readout existed only to make that verdict observable while it was measured. The guard aborted healthy turns and was withdrawn (senpi#1759), leaving a per-delta rate as noise on every turn; end-of-turn rate is still reported by the builtin TPS extension.

### Why an extension could not handle it

- The working line and its animation frames are owned by interactive mode; extensions can only post notifications after the turn ends.

### Expected merge conflict zones

- LOW: the working-status suffix helper and the `message_start` / `message_update` cases in `interactive-mode.ts` are back to their pre-guard shape.

## 2026-09-16 - Stall transcripts read as stalls (senpi#1740)

### What changed

- `packages/coding-agent/src/modes/interactive/components/assistant-render-descriptors.ts`: the `error` stop-reason branch routes `message.errorMessage` through `describeProviderStallForUser` first and prints that sentence for a provider-stream stall, falling back to the previous `Error: <errorMessage>` line for everything else. The branch is now a block with two early `break`s (tool calls, server-fallback diagnostic) instead of one negated condition; the descriptors it emits are unchanged in kind and order. No recovery advice is printed here - the turn may still be retrying.

### Why

- senpi#1740: the transcript printed `Error: Provider stream start timed out after 180000ms (raise streamStartTimeoutMs ...)` for every stalled attempt, including attempts a retry or a fallback model later recovered, so the watchdog wording was what the user read as the answer.

### Why an extension could not handle it

- Assistant bubbles are built by the host renderer; an extension cannot rewrite a descriptor the host already emitted.

### Expected merge conflict zones

- LOW: the `case "error"` arm of `createAssistantRenderDescriptors` and one import block.

## 2026-09-16 - /rename session command

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` handles `/rename [name]` and the `/name` alias: an argument sets the current session name immediately, and a bare command (or `app.session.renameCurrent`) opens an inline editor prefilled with the current name (Enter commits, Esc cancels, empty names are rejected).
- `packages/coding-agent/src/modes/interactive/components/extension-input.ts` accepts `initialValue` and types it into the input so the cursor lands at the end of the prefill.
- `packages/coding-agent/src/modes/interactive/tips/catalog/session-tips.ts` points the session-name tip at `/rename [name]`.

### Why

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` owns the composer, slash-command dispatch, and session-name writes, so the inline rename editor has to live there.
- `packages/coding-agent/src/modes/interactive/components/extension-input.ts` is the existing single-line overlay the host already swaps in for extension prompts; rename reuse needs a prefill without moving the cursor to column 0.
- `packages/coding-agent/src/modes/interactive/tips/catalog/session-tips.ts` is the startup-tip catalog users see for session labeling.

### Why an extension could not handle it

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` intercepts `/name` before extension commands run; an extension cannot replace that builtin or bind `app.session.renameCurrent` on the default editor.
- `packages/coding-agent/src/modes/interactive/components/extension-input.ts` is the host overlay widget; extensions cannot add `initialValue` to it.
- `packages/coding-agent/src/modes/interactive/tips/catalog/session-tips.ts` is a host-owned tip catalog.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: `app.session.resume` action registration, the `/name` slash-command branch, and `handleNameCommand`.
- `packages/coding-agent/src/modes/interactive/components/extension-input.ts`: `ExtensionInputOptions` and Input construction.
- `packages/coding-agent/src/modes/interactive/tips/catalog/session-tips.ts`: the `session-name` tip render string.

## 2026-09-14 - Clickable-question guidance and multiplexer QA (#1645)

### What changed

- `packages/coding-agent/src/modes/interactive/tips/catalog/input-tips.ts` adds one clickable-question tip. TUI, keyboard and settings guides describe scoped capture, selection bypass, fail-closed geometry and tmux's out-of-band cursor source.
- herdr 0.9.0 passes outer SGR clicks on viewport-filled frames and all question keyboard paths; the builtin reports blocked then working/idle. Fresh short frames write `ESC[?6n` with no private reply: outer `ESC[<0;27;25M` + `ESC[<0;27;25m` did not answer at 120x40, whereas viewport `ESC[<0;27;34M` + `ESC[<0;27;34m` did. Follow-up #1688 tracks that limitation; no unsafe anchor fallback was added.

### Why

- Users need to know when capture is active and how to retain terminal-native selection or answer by keyboard when a multiplexer cannot calibrate a short frame.

### Why an extension could not handle it

- The host owns the built-in tip catalog and pending-question mouse leases. Terminal calibration lives below extension APIs; the herdr limitation is documented, not hidden by extension workarounds.

### Expected merge conflict zones

- The input-tip catalog and mouse/question paragraphs in the public guides. Defaults and keyboard bindings are unchanged.

## 2026-09-14 - Host-owned pending-question mouse capture (senpi#1645)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` owns one pending-question capture lease for the queue/blocking surface and a regular-mode always lease when configured. It releases capture during suspend, external editing, renderer replacement and shutdown, and reapplies intent after start. Widget clicks expand/select the shown request and synchronously write its highlighted selection before single-question submission.
- `packages/coding-agent/src/modes/interactive/components/settings-selector.ts` exposes terminal.mouse with the shared value schema; the host recreates the renderer on a live change so off also disables fullscreen tracking. `tui-renderer.ts` forwards the mouse constructor option.

### Why

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` must preserve capture intent across new renderer instances without enabling mouse for idle regular sessions or leaving it enabled during terminal handoff.
- `packages/coding-agent/src/modes/interactive/components/settings-selector.ts` must make the capture policy discoverable and reversible in the existing settings surface.

### Why an extension could not handle it

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` owns renderer replacement, terminal handoff and the question queue; extensions cannot safely lease the terminal across those boundaries.
- `packages/coding-agent/src/modes/interactive/components/settings-selector.ts` owns the built-in settings list and cannot be augmented by the question extension.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: init/switchTuiMode, question mounting/refresh, suspend/external-editor handoffs and settings callbacks.
- `packages/coding-agent/src/modes/interactive/components/settings-selector.ts`: settings config/callbacks, terminal section and change dispatch. No changes to the default renderer or keyboard bindings.

## 2026-09-14 - Expanded question mouse actions (senpi#1645)

### What changed

- `packages/coding-agent/src/modes/interactive/components/ask-user-question.ts` routes committed primary option rows, own-answer and Submit through mouse regions; descriptions remain inert. Tab labels now have width-aware recorded spans in `ask-user-question-mouse.ts`. Presses claim a target without selecting, while one click activates; Input retains caret placement and the parent retains keyboard focus.

### Why

- The expanded surface needs the same direct choices as the collapsed widget, including multi-select toggles and explicit review before submission.

### Why an extension could not handle it

- The built-in component owns its per-question state, dynamic description rows and inline inputs.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/interactive/components/ask-user-question.ts`: child mounting and updateAll. Keyboard dispatch and response builders are unchanged; helper modules are fork-owned.

## 2026-09-14 - Clickable pending-question widget (senpi#1645)

### What changed

- `packages/coding-agent/src/modes/interactive/components/ask-user-async-widget.ts` renders sanitized, width-bounded option buttons with two-cell gaps, wrapping between buttons. It records the emitted spans and claims left presses without activating; single clicks route option, own-answer, expand and queue-next callbacks. The host can enable a terminal-specific selection-bypass hint.
- Visibility coverage now asserts every wrapped option remains available rather than pinning the former single truncated options line. Keyboard behavior is unchanged.

### Why

- Pending choices should expose direct click targets without guessing columns from repeated labels or activating on a drag.

### Why an extension could not handle it

- The host-owned widget owns its rendered cells and hit testing. An extension cannot attach geometry to its committed layout.

### Expected merge conflict zones

- The fork-owned widget render and countdown update methods; no renderer or keyboard-dispatch changes in this increment.

## 2026-09-14 - Tip lines keep one blank line above them (senpi#1680)

### What changed

- New `packages/coding-agent/src/modes/interactive/tips/tip-line.ts` appends a tip as a `Spacer(1)` followed by its `Text`, so every surface that shows a tip renders one blank line above it.
- `packages/coding-agent/src/modes/interactive/tips/startup-header.ts` and both working-tip paths of `showStatusIndicator` in `packages/coding-agent/src/modes/interactive/interactive-mode.ts` (embedded spinner and standalone status row) append through it instead of adding the tip `Text` directly.

### Why

- The dim tip read as a continuation of the block above it: glued to the header's last line at startup, and to the last transcript entry while a turn runs.

### Why an extension could not handle it

- The startup header and the status row are host-owned containers; extensions cannot reposition their children.

### Expected merge conflict zones

- LOW: the `appendStartupHeader` body and the two tip `addChild` calls in `showStatusIndicator` (`packages/coding-agent/src/modes/interactive/interactive-mode.ts`); upstream pi ships no tips.

## 2026-09-13 - Extension commands paint no optimistic user echo

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: the two `isExtensionCommand` branches in `setupEditorSubmitHandler` dispatch `session.prompt(text)` without `optimisticUserEchoes.begin()`, matching the command dispatch `handleFollowUp` already used. `handleFollowUp`'s streaming branch (Alt+Enter while the main turn streams) now dispatches extension commands the same way instead of painting the echo first.

### Why

- `AgentSession.prompt()` reports `promptDisposition("handled")` only after the command handler resolves, and a command never becomes a canonical user message. For a long-running command such as `/btw`, the `/btw <question>` bubble sat in the transcript for the whole side-query stream next to the panel that already shows the question, then vanished.

### Why an extension could not handle it

- The echo is painted by the host composer before the command reaches any extension; no extension API can suppress it.

### Expected merge conflict zones

- LOW: the `isExtensionCommand` branches in `setupEditorSubmitHandler` (upstream pi dispatches commands there without an echo).

## 2026-09-13 - Acknowledge explicit question dismissal to the model (senpi#1645)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` awaits the shown request's cancelled completion, then sends one existing-format dismissal frame from `/answer skip`. It steers into a streaming turn or follows up while idle. Ordinary abort/lifecycle cancellations remain silent in the builtin, so the explicit command cannot duplicate their delivery.
- Keyboard tests assert the exact frame and request ID in both streaming states while a second request stays pending. Real CLI QA verifies the dismissed widget disappears, a no-answer chip appears, and the model receives a turn.

### Why

- The command previously only showed a local dismissal notice; the plan also requires the model to learn that the user dismissed the question.

### Why an extension could not handle it

- The host owns `/answer skip` and its shown request. A cancelled transport response alone cannot distinguish this explicit command from abort or teardown without changing the wire contract.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: handleAnswerCommand and the awaited `/answer` dispatch. Question wire shapes and the answer formatter remain unchanged.

## 2026-09-13 - Compact answered-question transcript chips (senpi#1645)

### What changed

- New `packages/coding-agent/src/modes/interactive/components/ask-user-answer-chip.ts` recognizes the existing answer-frame prefix and renders muted, width-bounded rows per answer. A handled left press followed by a single click toggles the unchanged full body through MouseRegion; right/repeated clicks do not toggle. Hidden full-body rendering is invalidated and disposed by its owner.
- `packages/coding-agent/src/modes/interactive/components/user-message.ts` branches only for framed answers, keeping ordinary user-message rendering and OSC markers unchanged. A one-line render is both first and last line, so its shell prompt-zone closing markers append instead of landing ahead of the opening marker; taller messages keep the existing off-line-end placement. `packages/coding-agent/src/modes/interactive/interactive-mode.ts` supplies display-only headers from the retained question entry, so comments and no-answer outcomes remain labeled during live rendering and saved-session replay.
- A pre-production, fixed-color-mode snapshot pins ordinary-message bytes; model-facing frame bytes and real persisted answered/timeout replay are tested. Legacy frames without header metadata fall back to the request ID.

### Why

- A completed answer should be a compact receipt, not another large user bubble. Timeout and dismissal frames omit headers, so display metadata is needed without rewriting model input.

### Why an extension could not handle it

- The host-owned user-message renderer is used for both live and replayed transcripts; a question extension cannot replace its built-in branch or mouse target.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/interactive/components/user-message.ts`: constructor and rebuild; `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: plain user-message construction. The new chip module is fork-owned; builtin display metadata is tracked in `core/extensions/builtin/changes.md`.

## 2026-09-13 - Question title, arrival bell and host dialog blocked signals (senpi#1645)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` inserts the shown question header between tool and extension title layers, restores the title on settlement, and writes one BEL through the terminal abstraction for a fresh arrival when `askUser.bell` is enabled. Blocking questions use the same signals; components never write BEL.
- The host question bridge compares the original asked timestamp with the UI attachment epoch to suppress bells for hydration, while repeated request IDs reuse completion. Host and local extension select/confirm/input/editor dialogs emit per-ID `herdr:blocked` pairs with cleanup in `finally`; question signals remain owned by the builtin.

### Why

- A pending question should remain visible in the terminal title without repeated alerts on reconnect, and dialog status must clear even when its promise rejects.

### Why an extension could not handle it

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` owns terminal title precedence, terminal output and host dialog mounting; an extension cannot reliably observe UI hydration or resolve the title layer itself.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: applyTerminalTitle, handleHostUiRequest, createExtensionUIContext, question mount/finish and refreshAsyncWidget. Transport response shapes remain unchanged.

## 2026-09-13 - Shared answer chord and terminal-aware hint (senpi#1645)

### What changed

- `packages/coding-agent/src/modes/interactive/components/ask-user-answer-key.ts` selects the primary configured answer chord for hints, or its retained letter fallback under tmux, Apple Terminal, Warp and VS Code; Option-composed glyph matching remains active.
- `packages/coding-agent/src/modes/interactive/components/ask-user-async-widget.ts` uses that hint. `packages/coding-agent/src/modes/interactive/interactive-mode.ts` and the input tip catalog list the queue and both configurable question actions; keybinding and TUI docs explain dequeue precedence and Windows/WSL behavior.

### Why

- Users need an arrow chord that does not remove the existing answer shortcut or consume a separate dequeue binding.

### Why an extension could not handle it

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` owns the app hotkeys display and pre-action question interception, while the widget owns its terminal-aware hint.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: hotkeys question rows only; handleDequeue is unchanged. The answer-key and widget hint helpers are fork-owned.

## 2026-09-13 - Explicit bound replies and digit answers (senpi#1645)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` intercepts valid option digits only on an empty unobstructed composer, forwards the digit through the mounted component, and binds printable input or bracketed paste to one request. `/answer` lists pending requests with a SelectList, `/answer <n>` opens one, and `/answer skip` dismisses the shown request.
- `packages/coding-agent/src/modes/interactive/components/custom-editor.ts` gives the reply destination label precedence over embedded working status. Follow-up sends as chat; expiration preserves text and clears the binding with a notice.
- `packages/coding-agent/src/modes/interactive/components/ask-user-question-keys.ts` submits an async single-question single-select digit/Enter immediately; `packages/coding-agent/src/modes/interactive/components/ask-user-question.ts` accepts an initial sub-question index for collapsed digit entry.
- Intentional characterization flips: **(b2)** text present before arrival now stays chat; **(e)** async single-question digits now submit immediately. Every other characterization row stays pinned. Existing draft-oriented tests select with Space rather than a now-submitting digit; their draft assertions are unchanged.

### Why

- Numbered options must not become comment text, and later questions must never appropriate a draft or a reply already bound to another request.

### Why an extension could not handle it

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` owns pre-insertion editor dispatch and submission routing; `packages/coding-agent/src/modes/interactive/components/custom-editor.ts` owns the built-in border. Neither is replaceable through the question promise alone.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: question input interception, composer destination, answer command, finish and follow-up routing.
- `packages/coding-agent/src/modes/interactive/components/custom-editor.ts`: renderTopBorder; `packages/coding-agent/src/modes/interactive/components/ask-user-question-keys.ts`: single-select submit guards; `packages/coding-agent/src/modes/interactive/components/ask-user-question.ts`: initial state.

## 2026-09-13 - Request-id keyed pending-question queue (senpi#1645)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` holds a FIFO map and a pinned shown request, removes only the settled id, preserves per-request drafts, and restores editor focus without expanding the next question. `app.question.next` cycles only from an empty, unobstructed composer.
- `packages/coding-agent/src/modes/interactive/components/ask-user-async-widget.ts` shows the pending request count and next-question hint. The widget and `packages/coding-agent/src/modes/interactive/components/ask-user-question.ts` share an absolute countdown; an extension deadline makes it display-only. Only the mounted surface ticks.
- All 18 characterization rows remain unchanged and green in this increment.

### Why

- A second question must not cancel the first or steal focus, and re-rendering must not replace the extension's authoritative idle deadline.

### Why an extension could not handle it

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` owns the editor, widget slot, input interception, and overlay focus. The extension can provide its deadline but cannot queue these host-owned surfaces.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: question state fields, resetExtensionUI, showAsyncQuestion, refreshAsyncWidget, expandPendingQuestion, and composer comment routing.
- `packages/coding-agent/src/modes/interactive/components/ask-user-async-widget.ts` and `packages/coding-agent/src/modes/interactive/components/ask-user-question.ts`: countdown construction and pending-count rendering.

## 2026-09-13 - Ask-user overlay: no focus traps in the own-answer and Submit editors, draft restore on re-expansion (senpi#1641)

### What changed

- `components/ask-user-question-state.ts`: `advance()` and `switchTab()` route through `jumpToQuestion()` /
  `enterSubmit()`, so moving to the next question always lands on its option list (focus `options`) instead of
  leaving the own-answer editor open. New `submitRowIndex` highlights one review row on the Submit tab or the
  comment editor (`commentRowIndex`, `isCommentFocused`), with `moveSubmitRow()` / `focusComment()`.
  `leaveOwnAnswer(row)` closes the editor onto a chosen row, `clearAnswer()` drops a question's selection/text,
  and `restoreDraft()` seeds selections, own texts and the comment from a `QuestionDraft`.
- `components/ask-user-question-keys.ts`: own-answer editor exits — Up/Down save the text and return to the
  option list (Up highlights the row above, Down keeps the own-answer row), Tab/Shift+Tab save and switch tab,
  Backspace on an empty editor returns to the list, Esc discards and returns to the list in both modes;
  Left/Right stay cursor movement. Submit tab — Up/Down walk the review rows and the comment editor, Enter on a
  row jumps to that question, a printable character on a row types into the comment, Left/Right move the
  comment cursor when it has text (tab switch only when empty or a row is highlighted), Backspace on an empty
  comment moves to the last row. Option list — Backspace clears the active answer; the printable check no
  longer admits DEL (0x7f), so Backspace never opens the own-answer editor.
- `components/ask-user-question-render.ts`: review rows carry the `→` highlight; own-answer label and the
  hints line describe the real exits (the single-line `Input` never supported the advertised `shift+enter`).
- `components/ask-user-question.ts`: `AskUserQuestionOptions.initialDraft` seeds the state and the comment
  `Input`; `commitOwnAnswer()` resets the editor (from senpi#1634); the comment `Input` is focused only while
  the comment row is highlighted.
- `interactive-mode.ts`: `expandPendingQuestion()` passes the pending `state.draft` as `initialDraft`, so an
  async question re-expanded after Esc shows the selections and comment captured before the collapse.
- Tests: `test/suite/ask-user-question-{own-answer-focus,submit-focus,reachability}.test.ts` (shared
  `ask-user-question-focus-support.ts`); the reachability guard walks every key sequence up to depth 3 in both
  modes and fails when Tab, Esc or Up is silently swallowed.

### Why

- After senpi#1576 the overlay still trapped focus: the own-answer editor kept focus on the next question,
  Up/Down/Tab did nothing inside either editor, Left/Right switched tabs from the comment, Backspace opened the
  editor from the option list, and an async re-expansion lost the draft. The user report was "once you are in
  the text box you cannot get out, and pressing Up on the Submit tab feels like it should do something".

### Why an extension could not handle it

- The question overlay is an in-tree interactive component driven by `interactive-mode.ts`; extensions only
  receive the resolved `QuestionResponse` and cannot change the key model or the focus state of the TUI.

### Expected merge conflict zones

- `components/ask-user-question-keys.ts` `handleOwnAnswerKey` / `handleSubmitKey` and
  `ask-user-question-state.ts` `advance()` if upstream reworks the ask-user key model; the async single-question
  guard (`waitForAnswer && questions.length === 1`) is intentionally unchanged pending the pending-blocks plan.

## 2026-09-13 - Compact startup banner omits system resources; `system` group in the expanded listing (senpi#1640)

### What changed

- `interactive-mode.ts`: `showLoadedResources` filters `system`-scoped skills, prompts, extensions and themes out of the compact `[Skills]` / `[Prompts]` / `[Extensions]` / `[Themes]` lists (`isSystemResource`), `formatCompactList` returns `""` for an empty list, and `addLoadedSection` builds a `LoadedResourceSection` (empty collapsed text when the compact body is empty) instead of an `ExpandableText` plus trailing `Spacer`. The bodies of `getDisplaySourceInfo`, `getScopeGroup`, `buildScopeGroups` and `formatScopeGroups` are gone: the first three private methods now delegate to `loaded-resource-scopes.ts`, `getScopeGroup` was removed outright, and `isPackageSource` delegates to `isPackageSourceInfo`.
- `loaded-resource-scopes.ts` (new, fork-only): `ResourceScopeGroup` gains `system`, `GROUP_ORDER` is `project, user, path, system`, plus `isSystemResource`, `isPackageSourceInfo`, `getResourceScopeGroup`, `buildResourceScopeGroups`, `formatResourceScopeGroups` and `getDisplaySourceInfo` (which labels a `system` resource `system`), so the grouping logic is unit-testable outside `InteractiveMode`.
- `components/loaded-resource-section.ts` (new, fork-only): the `LoadedResourceSection` container that renders nothing while collapsed with an empty body and adds its own `Spacer` when it has text.
- `components/config-selector.ts`: `ResourceGroup.scope` is typed as `SourceScope` instead of the inline three-member union; behaviour is unchanged.
- `interactive-mode.ts` `getAutocompleteSourceTag` and `loaded-resource-scopes.ts` `getScopeAutocompleteTag` (follow-up, senpi#1640): the `$skill` / slash autocomplete prefix is now exhaustive over `SourceScope`, so system resources show `[s]` instead of falling back to the temporary `[t]` tag.

### Why

- A distribution that ships its own builtin package filled the compact banner with resources the user did not add and cannot toggle, hiding the user's own skills and extensions in the noise. The expanded view (Ctrl+O / `--verbose`) still shows everything, under a `system` group after project, user and path.

### Why an extension could not handle it

- The startup banner is built inside `InteractiveMode.showLoadedResources` from the loader's resource lists; no extension hook can filter or regroup what it prints.

### Expected merge conflict zones

- MEDIUM: `showLoadedResources` (`formatCompactList`, `addLoadedSection` and the four compact-list call sites) and the removed `getDisplaySourceInfo` / `getScopeGroup` / `buildScopeGroups` / `formatScopeGroups` bodies in `interactive-mode.ts`, along with the new `loaded-resource-scopes.ts` and `loaded-resource-section.ts` imports.
- LOW: the `ResourceGroup` interface and `SourceScope` import in `components/config-selector.ts`.

## 2026-09-12 - Working/retry status cadence reads the O(1) entry count (senpi#1635)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: use `getEntryCount()` in
  the hook-status timer, working indicator and retry indicator. Ticker tests cover the 999/1000
  cadence boundary and zero history loads on a trimmed persisted session.

### Why

- These cadence decisions need a count, not the full history that `getEntries()` loads after trim.

### Why an extension could not handle it

- The timer and indicator constructors are internal to interactive mode.

### Expected merge conflict zones

- LOW: the three count-only cadence call sites.

## 2026-09-12 - Upstream sync: status spinners in the editor border, mouse toggles, renderer-only tool cards

### What changed

- `components/custom-editor.ts` / `components/status-indicator.ts` / `interactive-mode.ts`: the base
  editor opts in to `embedWorkingStatus`, so the working, retry and branch-summary indicators render
  inside the editor's top border (upstream c1d4c8011 / 1d9787c11). The fork shimmer
  (`formatWorkingStatusMessageFrame`, elapsed seconds, interrupt hint, large-session cadence) is the
  text that lands in the border; the optional working tip stays as the only status-row line. The
  compaction indicator keeps its own status row (single-row label + streamed preview, pinned by the
  fork compaction suite). `clearStatusIndicator` reserves clear-on-shrink height only for rows that
  were on screen, so an embedded spinner never leaves a two-row placeholder. Extension editors and
  the Grok chrome editor do not opt in and keep the standalone row.
- `interactive-mode.ts`: `createInteractiveTui` / `createInteractiveTuiReference` moved to
  `tui-renderer.ts` (still re-exported); the fork's `ProcessTerminal({ onExternalStdoutWrite:
  appendHiddenTuiStdout })` moved with them. The fullscreen dock comes from `chat-viewport.ts`, which
  gained an optional `hookStatus` slot for the fork's tool-hook status rows. Scrollbar styling uses
  the adopted `scrollbarTrack` / `scrollbarThumb` foreground tokens; `grok-day` / `grok-night` were
  migrated (old thumb background became the track, thumb is the text colour).
- `interactive-mode.ts`: tree navigation re-checks `session.isCompacting` after the summary dialog
  and the streaming abort before touching another operation's UI (upstream 47acd8e6c, ported into
  `runTreeNavigation`); provider login defers default-model selection until the catalog refresh
  lands when the provider's default is not in the snapshot yet (upstream 9767ba275), keeping the
  fork's persist-by-default `setModel`, system-prompt label, risky-model warning and the
  cursor/`cursor-cli-oauth` `allowNetwork` refresh.
- `components/tool-execution*.ts`: the card accepts `ToolRenderers` (a definition or a bare
  renderer pair; `interactive-mode.ts` passes `withBuiltInRenderers(name, definition)`). The fork's
  `ToolExecutionRenderer` keeps its own built-in fallback (`createAllToolDefinitions`, which still
  carries `renderShell`). Left-clicking a finished classic card toggles expansion (upstream
  71026970a) via a `MouseRegion` around each rendered slot.
- `components/assistant-message.ts` / `assistant-render-descriptors.ts`: left-clicking a thinking run
  toggles that run between its label and body; overrides are per run, cleared by
  `setHideThinkingBlock`, and attached to the Markdown/Text child so the incremental reconciler is
  unchanged.
- `theme/theme.ts`: validation is always on. The TypeBox-compiled `validateThemeJson` lives in
  upstream's `theme-json.ts` (schema now includes the optional `scrollbarTrack` / `scrollbarThumb`
  tokens); `theme.ts` re-exports it and uses it as the default validator, with
  `setThemeJsonValidator` kept as an override hook. Upstream made validation opt-in from `main.ts`,
  which the fork does not do.
- `components/model-selector.ts`: unchanged fork behaviour (confirm persists the default; no
  separate `app.models.save` chord). Thinking and scoped-model selectors read their configurable
  save bindings on open.

### Why

- Adopt upstream's border-embedded status, mouse interactions, renderer split and login/tree fixes
  without losing the fork's shimmer, tips, compaction row, hook-status rows, paste pairing or theme
  validation.

### Expected merge conflict zones

- MEDIUM: `showStatusIndicator` / `clearStatusIndicator` / `setEditorWorkingStatusIndicator` and
  `completeProviderAuthentication` in `interactive-mode.ts`; `ToolRenderers` in
  `components/tool-execution-types.ts`; the validator default in `theme/theme.ts`.

## 2026-09-12 - Async ask-user shortcut accepts macOS Option-composed glyphs (senpi#1620)

### What changed

- `packages/coding-agent/src/modes/interactive/components/ask-user-async-widget.ts`: new
  `matchesAskUserAnswerKey(data, platform)` keeps `alt+a` (`ESC a` / CSI-u alt) on every platform
  and, on darwin only, also accepts the glyphs the `a` key types when the terminal lets Option
  compose (`å`, `Å`, raw or as a kitty CSI-u printable). `ASK_USER_ANSWER_KEY` and the widget label
  (`option+a` on darwin, `alt+a` elsewhere) are unchanged.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: `handleAskUserShortcut` matches
  through `matchesAskUserAnswerKey` instead of `matchesKey(data, ASK_USER_ANSWER_KEY)`.

### Why

- Terminal.app, iTerm2, Ghostty and kitty default to Option composing characters on macOS, so the
  advertised `option+a` arrived as `å` and inserted text instead of expanding the pending question.

### Why an extension could not handle it

- The shortcut is consumed inside `CustomEditor.onExtensionShortcut` before extension shortcuts run,
  and the async widget is interactive-mode state; no extension hook sees the raw editor input first.

### Expected merge conflict zones

- LOW: the `ask-user-async-widget.ts` import list and `handleAskUserShortcut` in
  `packages/coding-agent/src/modes/interactive/interactive-mode.ts` (fork-only code).

## 2026-09-12 - Async ask-user widget shows the question; rebindable shortcut and key-free paths (senpi#1623)

### What changed

- `packages/coding-agent/src/modes/interactive/components/ask-user-async-widget.ts`: the collapsed
  widget renders four lines instead of one: `? Question pending (N unanswered) · <countdown>`, the
  first unanswered question as `<header> — <question>`, its options as `1 A · 2 B · own answer`
  (plus `+K more question(s)` when more wait), one `TruncatedText` line each, and a hint naming
  every way in (`enter or <shortcut> to answer · /answer · or just type your reply`). The widget takes
  the `QuestionRequest` and the live `QuestionDraft`, so a partial draft that collapses shows the next
  unanswered question. `ASK_USER_ANSWER_KEY`, `renderAsyncQuestionLine` and `setUnanswered` are gone.
- `packages/coding-agent/src/modes/interactive/components/ask-user-answer-key.ts` (new):
  `ASK_USER_ANSWER_KEYBINDING = "app.question.answer"`, `matchesAskUserAnswerKey(data, platform,
  keybindings)` resolving the chord through the `KeybindingsManager`, and `darwinOptionGlyphs(keys)`
  mapping every bound `alt+<letter>` to its US-layout Option glyph pair (dead keys e/i/n/u excluded),
  which generalizes the senpi#1620 `å`/`Å` acceptance to whatever letter the user binds.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: `handleAskUserShortcut` delegates
  to a new `expandPendingQuestion()`; the editor `onSubmit` calls it for an empty submission (Enter on
  an empty editor opens the pending question, a no-op when nothing is pending); `/answer` is handled in
  the text dispatch beside `/keybindings` and reports `No question is pending.` through `showStatus`;
  `/hotkeys` lists `app.question.answer`.
- `packages/coding-agent/src/modes/interactive/tips/catalog/input-tips.ts`: new `open-pending-question`
  tip bound to `app.question.answer`.
- Docs: `docs/tui.md` async-widget paragraph, `docs/keybindings.md` row for `app.question.answer`.

### Why

- The one-line widget only said that a question existed, so a pending question could sit through its
  whole idle countdown unnoticed. The single `alt+a` chord was a constant outside the keybinding
  system: not rebindable, absent from `/hotkeys`, and dead whenever a terminal, multiplexer or workspace
  prefix claimed Option/Alt+A, with no chord-free way to open the overlay.

### Why an extension could not handle it

- The async widget, the pending-question state and the editor submit path are interactive-mode
  internals; extensions reach neither the editor's empty-submission branch nor the overlay mount.
  `/answer` itself is registered by the builtin ask-user extension (see `src/core/changes.md`) and
  intercepted by interactive-mode the way `/keybindings` is.

### Expected merge conflict zones

- LOW: the ask-user import block, `refreshAsyncWidget`, `handleAskUserShortcut`, the empty-text guard
  in `setupEditorSubmitHandler`, the `/keybindings` dispatch neighbour and the `/hotkeys` table in
  `interactive-mode.ts` (fork-only code paths).

## 2026-09-12 - Async ask-user shortcut accepts macOS Option-composed glyphs (senpi#1620)

### What changed

- `packages/coding-agent/src/modes/interactive/components/ask-user-async-widget.ts`: new
  `matchesAskUserAnswerKey(data, platform)` keeps `alt+a` (`ESC a` / CSI-u alt) on every platform
  and, on darwin only, also accepts the glyphs the `a` key types when the terminal lets Option
  compose (`å`, `Å`, raw or as a kitty CSI-u printable). `ASK_USER_ANSWER_KEY` and the widget label
  (`option+a` on darwin, `alt+a` elsewhere) are unchanged.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: `handleAskUserShortcut` matches
  through `matchesAskUserAnswerKey` instead of `matchesKey(data, ASK_USER_ANSWER_KEY)`.

### Why

- Terminal.app, iTerm2, Ghostty and kitty default to Option composing characters on macOS, so the
  advertised `option+a` arrived as `å` and inserted text instead of expanding the pending question.

### Why an extension could not handle it

- The shortcut is consumed inside `CustomEditor.onExtensionShortcut` before extension shortcuts run,
  and the async widget is interactive-mode state; no extension hook sees the raw editor input first.

### Expected merge conflict zones

- LOW: the `ask-user-async-widget.ts` import list and `handleAskUserShortcut` in
  `packages/coding-agent/src/modes/interactive/interactive-mode.ts` (fork-only code).

## 2026-09-11 - Ask-user overlay uses an explicit question and submit flow

### What changed

- `packages/coding-agent/src/modes/interactive/components/ask-user-question-state.ts`,
  `ask-user-question-keys.ts`, `ask-user-question-render.ts`, and `ask-user-question.ts` now model
  question tabs, an on-demand own-answer editor, and a dedicated Submit tab. Enter confirms and
  advances, Space toggles multi-select, plain Enter works on every terminal, and the comment editor
  no longer occupies the bottom of every question or traps navigation.

### Why

- The previous overlay required a terminal-specific ctrl+Enter path for submission, toggled
  multi-select choices when Enter was used, and routed navigation keys into the always-visible
  comment input after moving down past the options.

### Why an extension could not handle it

- `AskUserQuestionComponent` owns the interactive-mode focus and key dispatch for the builtin
  question extension; no extension hook can replace its component-level state machine.

### Expected merge conflict zones

- LOW in the ask-user component siblings and their focused suite; preserve the async widget's
  `alt+a` expansion and the existing `QuestionResponse` wire shape.

## 2026-09-10 - Safe account labels in footer and English help (senpi#1495)

### What changed

- `packages/coding-agent/src/modes/interactive/components/footer.ts`: displays `@displayName (name)` for named accounts while pin matching and HRW winner selection still use only immutable `name`; legacy name-only output is unchanged. The right-side colouring no longer re-parses the rendered segment with `^\(([^)]+)\) (.*)$` / `^(.+):([^:]+)$`: `colorRightSide` now receives the provider, fast-mode, model and thinking runs that produced the string and clips each run to what the layout kept, so a label containing `)` or `:` cannot mute the wrong span or turn the model id into a thinking level. The account label is truncated with an ellipsis at 24 columns, so a wide label narrows the provider segment instead of pushing the layout onto `right.minimal`, which dropped the account indicator entirely.
- `packages/coding-agent/src/modes/interactive/help-content.ts`: documents account rename/clear commands, the normalization/column/uniqueness rules, immutable IDs, environment restrictions and optional post-login naming cancellation.

### Why

- `packages/coding-agent/src/modes/interactive/components/footer.ts` needs readable labels without selecting a different account and without letting a legal label corrupt footer colouring; `packages/coding-agent/src/modes/interactive/help-content.ts` makes the display/identity distinction and new commands discoverable.

### Why an extension could not handle it

- `packages/coding-agent/src/modes/interactive/components/footer.ts` owns the host footer's account segment and `packages/coding-agent/src/modes/interactive/help-content.ts` owns the shared English help body; extensions provide the commands, not these presentation surfaces.

### Expected merge conflict zones

- MEDIUM: `packages/coding-agent/src/modes/interactive/components/footer.ts` account suffix helper and the `colorRightSide` signature (upstream still colours by regex over the rendered string); LOW: `packages/coding-agent/src/modes/interactive/help-content.ts` final help section assembly.

## 2026-09-10 - The "." manual-continue shortcut paints no user echo

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: submissions go through `beginUserEcho()`, which skips the optimistic echo for a bare `.` on a session that already has messages (via the shared `isManualContinueSubmission`); `OptimisticUserEchoController.promptOptions/reject/remove` and `InteractiveUserInput.pendingEchoId` accept `undefined` as "nothing was painted".

### Why

- The session routes that `.` as a hidden continuation, so the echo painted at submit time showed a user bubble the transcript never receives.

### Why this lives in the fork

- The `.` manual-continue shortcut and the optimistic user echo are both fork behavior in `AgentSession.prompt()` and interactive mode.

### Expected merge conflict zones

- LOW: `OptimisticUserEchoController`, `InteractiveUserInput`, and the echo call sites in `setupEditorSubmitHandler` / `handleFollowUp`.

## /tree renders a refused model switch (2026-09-10)

### What changed

- `packages/coding-agent/src/modes/interactive/components/tree-selector.ts`: `model_change_rejected` gains a render case (`[model rejected: <id> (<reason>)]`, warning colour), search text (`model rejected <id> <reason>`), and membership in the settings/bookkeeping set hidden from the default view.

### Why

- Without the cases the entry fell to `default: result = ""`, so a refused switch (#1526) appeared in `/tree`'s default view as a blank, unsearchable row - the one entry browser the product ships could not reconstruct the incident the record exists for.

### Why an extension could not handle it

- The tree selector owns entry rendering, filtering and search text; extensions cannot contribute renderers for core entry types.

### Expected merge conflict zones

- LOW: the `isSettingsEntry` predicate, `entrySearchText`, and the entry render switch.

## 2026-09-10 - /tree edits carry the leaf token and reach shared hosts
# changes

## 2026-09-11 - Show the active brand changelog without cross-source updates (senpi#1583)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: uses the resolved brand or engine changelog source, persists acknowledgements by source, caps entries at the active version, and avoids engine link rewriting and install telemetry for branded sources.

### Why

- A branded product's release notes and version history must remain separate from the engine's release channel and telemetry.

### Why an extension could not handle it

- Interactive startup notices and the `/changelog` command are host-owned rendering paths that execute outside extension control.

### Expected merge conflict zones

- LOW: changelog startup handling and the `/changelog` command in `interactive-mode.ts`.

## 2026-09-02 - Do not paint two live login inputs

### What changed

- `packages/coding-agent/src/modes/interactive/components/login-dialog.ts`: `showManualInput` and `showPrompt` remount the single Input widget instead of adding it twice, so a browser-callback login no longer shows two stacked `>` prompts. Every `(to cancel)` / `(to close)` hint row is routed through one tracked live hint (`setLiveHint`), so `showWaiting` and `showInfo(showCloseHint)` REPLACE a previous hint instead of painting beside it, and every content-clearing path resets the tracked hint.
- `packages/coding-agent/test/suite/regressions/5433-extension-oauth-prompt-input.test.ts`: covers an unsubmitted paste-code prompt followed by the account-name prompt - asserting exactly one live `>` row - plus an interleaved waiting step that must leave exactly one live hint row.

### Why

- Anthropic OAuth completes via localhost callback while the paste-code input is still mounted. The name prompt then added the same Input child again, and the TUI painted two live `>` rows.

### Why an extension could not handle it

- Login chrome is the interactive LoginDialogComponent, not an extension surface.

### Expected merge conflict zones

- LOW: `showManualInput` / `showPrompt` in `login-dialog.ts`.

## 2026-09-01 - Never swallow an interactive quit request

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: `editAssistantMessageFromTree` captures the leaf when the editor opens and passes it as `expectedLeafId`; a `stale-leaf` refusal is shown as a plain status; the extension `commandContextActions` gain `editAssistantMessage`.
- `packages/coding-agent/src/modes/interactive/interactive-host-runtime.ts`: the session proxy forwards `editAssistantMessage` to the host over `RpcClient.editAssistantMessage` and refreshes history (previously the call fell through to the local shadow session).

### Why

- Without the token an edit prepared before another client moved the session silently overwrote it; without the proxy the #1532 feature could not reach a shared host at all.

### Why an extension could not handle it

- The tree editor flow and the host proxy are interactive-mode internals.

### Expected merge conflict zones

- LOW: `editAssistantMessageFromTree` and the `navigateTree` proxy neighbour in `interactive-host-runtime.ts`.

## 2026-09-10 - One async answer per surface and the `question` client capability

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: `ExtensionUIContext.question` routes `waitForAnswer:false` straight to `showAsyncQuestion` and no longer delivers the answer - the `deliverAsyncAnswer` helper and the `formatUserMessage` import are gone. The widget only resolves the question (submit, comment text, countdown, abort); the ask-user builtin sends the single framed user message. `handleHostUiRequest`'s `question` case is unchanged: it still answers on the `extension_ui_response` channel and the host delivers.
- `packages/coding-agent/src/modes/interactive/interactive-host-runtime.ts`: the new `HOST_CLIENT_CAPABILITIES` (`RENDERED_COMPONENTS_CAPABILITY`, `QUESTION_CAPABILITY` from `packages/coding-agent/src/modes/rpc/custom-capability.ts`) replaces the inline `["rendered_components"]` list in the startup handshake, `setClientInfo`, and `reRegisterClientInfo`, so a host-attached TUI advertises `question`.

### Why

- With delivery centralized in the builtin, the widget's own `session.sendUserMessage` would send every async answer twice. Separately, a TUI attached to a shared host never advertised `question`, so the host degraded every `ctx.ui.question` call into sequential select/input prompts even though this TUI renders the full overlay.

### Why an extension could not handle it

- Both seams are host-owned: `createExtensionUIContext` is built by interactive-mode, and only the host runtime performs the RPC `set_client_info` handshake that declares client capabilities.

### Expected merge conflict zones

- LOW: `interactive-mode.ts` - `createExtensionUIContext`'s `question:` entry and the block after `submitAsyncQuestionComment` (the removed `deliverAsyncAnswer`).
- LOW: `interactive-host-runtime.ts` - the import block, the `client.setClientInfo(80, ...)` startup call, `setClientInfo`, and `reRegisterClientInfo`.

## 2026-09-10 - Async ask-user widget and framed user-message delivery

### What changed

- `packages/coding-agent/src/modes/interactive/components/ask-user-async-widget.ts` (new): `AskUserAsyncWidget`, the collapsed one-line `? Question pending (N unanswered) - <key> to answer, or just type your reply · <countdown>` editor widget with its own idle countdown, plus the pure response builders for the two delivery shapes interactive-mode needs (`buildCommentResponse`, `buildTimedOutResponse`, `unansweredIds`) and the `alt+a` expand key constant.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: `ExtensionUIContext.question` routes `waitForAnswer:false` to the new `showAsyncQuestion` (widget above the editor, turn never blocked; a newer async question supersedes a pending one as `cancelled`); `alt+a` on the editor expands the todo-9 component pre-filled with the last draft, Esc collapses back to the widget without sending; on submit the answer is delivered exactly once as a framed user message (`formatUserMessage`) through `session.sendUserMessage` (`steer` while streaming, `followUp` when idle), then the widget clears and the `ask-user` wake source settles 1 -> 0; ordinary composer text while a question is pending (non-`/`, non-`!`) is claimed as the comment answer and replaces the raw text; `handleHostUiRequest`'s `question` case drives the same widget for a host-attached TUI and answers on the `extension_ui_response` channel (host performs delivery; a locally expired countdown sends nothing); `resetExtensionUI` cancels a pending async question.
- `packages/coding-agent/src/modes/interactive/interactive-host-runtime.ts` + `packages/coding-agent/src/modes/rpc/rpc-client.ts`: the dormant writer seam is wired - `RpcClient.sendExtensionUIProgress` writes an `extension_ui_progress` record fire-and-forget (keeping the host's request id, never minting one) and `RemoteInteractiveRuntime.sendHostUiProgress` forwards the debounced drafts from interactive-mode to the host.

### Why

- Async questions must stay non-modal: the agent keeps working while the question sits above the editor, and the answer must reach the model as a clearly framed user turn (partial answers + one comment) instead of being lost or sent as raw composer text.

### Why an extension could not handle it

- Claiming ordinary editor submissions needs the `onSubmit` path inside interactive-mode, and the shortcut/widget/overlay focus dance is the same editor-container machinery extensions cannot reach; the host-attached writer must also live on the RPC client the TUI owns.

### Expected merge conflict zones

- MEDIUM: `interactive-mode.ts` - `createExtensionUIContext` (`question:` entry), the top of `defaultEditor.onSubmit`, `handleHostUiRequest`'s `question` case, `resetExtensionUI`, `setupExtensionShortcuts`' handler head, and the new `showAsyncQuestion`/`refreshAsyncWidget`/`handleAskUserShortcut`/`submitAsyncQuestionComment`/`deliverAsyncAnswer` block after `hideQuestionOverlay`.
- LOW: `ask-user-async-widget.ts` (new), `interactive-host-runtime.ts` `sendHostUiProgress` next to `setHostUiHandler`, `rpc-client.ts` `sendExtensionUIProgress` next to `sendExtensionUIResponse` and the id-preserving branch in `send`.


## 2026-09-10 - Ask-user question overlay and host `question` bridge

### What changed

- `packages/coding-agent/src/modes/interactive/components/ask-user-question.ts` (+ `-state.ts`, `-render.ts`, `-keys.ts` siblings): new `AskUserQuestionComponent` rendering a `QuestionRequest` — header tab bar (←/→/Tab), numbered options with descriptions (digits 1-9, Up/Down, Space toggle for multiSelect, Enter selects), a per-question `Type your own answer...` row opening an inline input, one always-visible comment editor (`Comment (sent as your reply; other questions stay unanswered)`), a `Submit (n/N answered)` footer (Ctrl+Enter anywhere, Enter in the comment editor), Esc cancel, a countdown chip that switches to `mm:ss` under five minutes, and `onProgress(draft)` emission on every selection/keystroke. An incomplete empty-comment submit shows `You have not answered all questions` and stays open.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: `ExtensionUIContext.question` implemented via `showQuestionOverlay`/`hideQuestionOverlay` (editor-container replace, focus handoff, `Waiting for your answer` working message, AbortSignal → `cancelled`); `handleHostUiRequest` gained `case "question"` which renders the same component for a host-attached TUI, replies `extension_ui_response{answers, comment}` (or `{cancelled: true}`), and forwards `onProgress` drafts as `extension_ui_progress` records debounced to 1s through the optional host-runtime `sendHostUiProgress` seam; `resetExtensionUI` disposes a lingering overlay.

### Why

- The ask-user question tool needs one terminal surface usable both in-process (extensions calling `ctx.ui.question`) and from a TUI attached to a shared RPC host, with partial answers, a single comment, countdown and cancel parity with Claude Code / codex dialogs.

### Why an extension could not handle it

- The overlay replaces the editor container, takes modal key focus and suppresses the editor while open — extension `setWidget`/`custom` surfaces render around the editor and cannot steal focus or suppress it; the host `question` case must also answer on the host-UI response channel, which only interactive-mode owns.

### Expected merge conflict zones

- LOW: `interactive-mode.ts` — `createExtensionUIContext` (`question:` entry), the `handleHostUiRequest` switch (`case "question"` after `case "editor"`), `resetExtensionUI`, and the new `showQuestionOverlay`/`hideQuestionOverlay` pair after `hideExtensionEditor`.
- LOW: the four new `components/ask-user-question*.ts` files have no prior art to conflict with.

## 2026-09-10 - Keep the update command fully visible in the notice box

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: `showNewVersionNotification` now emits the update command on its own notice `extra` line instead of appending it to the why sentence, so a long Bun global install command is not glued to prose.

### Why

- Issue #1539: at 80 columns the update-available notice showed `Run bun add --cwd` and nothing runnable. The command must sit on its own line so it can wrap as one copyable unit.

### Why an extension could not handle it

- The update notice is assembled by interactive mode after the version check; there is no extension hook for that surface.

### Expected merge conflict zones

- LOW: `packages/coding-agent/src/modes/interactive/interactive-mode.ts` `showNewVersionNotification`.



## 2026-09-10 - A cancelled /login renders as "Login cancelled", not a failure (#1542)

### What changed

- `packages/coding-agent/src/modes/interactive/login-outcome.ts` (new, extracted for the LOC ceiling): `isLoginCancellation(error)` is true for an undefined reason, any `AbortError`-named reason (the `DOMException` from `LoginDialogComponent.cancel()` whose message is "This operation was aborted", or the `AbortError` fabricated by `raceWithAbortSignal`), and the literal `"Login cancelled"`; `describeLoginFailure(error, providerName, method)` returns `{ level: "status", message: "Login cancelled" }` for those and `{ level: "error", message }` with the existing `Failed to login to ...` / `Failed to save API key for ...` / `... could not be synchronized: ...` copy otherwise.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: `showLoginDialog` and the API-key dialog render the outcome through the new `showLoginFailure` (`showStatus` for a cancellation, `showError` for a failure) instead of matching `errorMsg !== "Login cancelled"` inline.

### Why

- Issue #1542: Esc in the `/login` dialog aborts `dialog.signal` with no reason, so `ModelsImpl.login` rejected with the DOMException and the inline literal match rendered the user's own cancellation as `Failed to login to OpenAI Codex: This operation was aborted`.

### Why an extension could not handle it

- The dialog, its abort controller and the error rendering are all inside interactive mode's private login flow.

### Expected merge conflict zones

- LOW: `packages/coding-agent/src/modes/interactive/interactive-mode.ts` catch blocks of `showLoginDialog` and the API-key dialog.

## 2026-09-10 - Report a reduced restored context on resume

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: renders the new `resume_context_reduced` session event as a warning, next to the existing required-compaction notice, so a user whose restored context was reduced at admission sees it before the first prompt.

### Why

- Issue #1524: an over-window restored session now opens with a deterministically reduced context. Silently opening it would hide that older turns are no longer in context even though the transcript is still on disk.

### Why an extension could not handle it

- The event is published while the session is being constructed, before extensions are loaded, and the notice must render through interactive mode's own warning surface.

### Expected merge conflict zones

- LOW: `packages/coding-agent/src/modes/interactive/interactive-mode.ts` session-event switch, adjacent to the `resume_compaction_required` case.
## 2026-09-10 - Edit assistant responses from /tree

### What changed

- `packages/coding-agent/src/modes/interactive/components/tree-selector.ts`: `TreeList.editSelected()` routes `app.tree.editMessage` — assistant entries call the new `onEditMessage` callback, user/custom messages reuse `onSelect`, other entries are ignored; the help line gains an `edit` hint and `TreeSelectorComponent` exposes `onEditMessage`.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: the tree selector's summary prompt, streaming abort, summary indicator and post-navigation refresh moved into `runTreeNavigation()` shared by selection and the new `editAssistantMessageFromTree()` flow (extension editor prefilled with the response, empty/unchanged guards, summary prompt only when `treeNavigationAbandonsConversation()` finds abandoned messages).

### Why

- The session tree is where users already revisit responses; editing an assistant answer there and continuing from the edited copy avoids forking or re-prompting.

### Why an extension could not handle it

- The tree selector's key handling and the branch-navigation UI flow are interactive-mode internals with no extension hook.

### Expected merge conflict zones

- MEDIUM: `interactive-mode.ts` `showTreeSelector()` — the inline navigation body was extracted into `runTreeNavigation()`.
- LOW: `tree-selector.ts` `handleInput` chain and `TREE_HELP_ITEMS`.


## 2026-09-09 - Surface required compaction after oversized resume

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: renders the existing session event notice when resume admission defers an unusable restored projection to required compaction.

### Why

- Users must be told that the first prompt will compact instead of seeing a constructor-time model budget refusal.

### Why an extension could not handle it

- The notice originates in core before extension hooks bind; interactive mode is the existing session-event presentation surface.

### Expected merge conflict zones

- LOW: the `handleEvent` switch beside other model and session notices.

## 2026-09-08 - Shortcut context exposes the effective service tier

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: the extension shortcut context built by `setupExtensionShortcuts` sets the new optional `effectiveServiceTier` field from `session.effectiveServiceTier`, next to `serviceTier`.

### Why

- `ExtensionContext.effectiveServiceTier` (code-yeongyu/oh-my-openagent#6795) is what delegating hosts read to inherit a parent's fast mode; the hand-built shortcut context must report the same value the runner's contexts do.

### Why an extension could not handle it

- The shortcut context literal is host code; extensions only receive it.

### Expected merge conflict zones

- LOW: the `createContext` literal in `setupExtensionShortcuts`.

## 2026-09-07 - Add a workflow tip for the report-bug skill

### What changed

- `packages/coding-agent/src/modes/interactive/tips/catalog/subagent-tips.ts`: added a workflow tip that points users to the report-bug skill and explains that it records provider and model details, routes the issue, and waits for confirmation before filing.
- The tip is gated with requiresCommand: "tasks" like every other workflow tip, so it only surfaces where the omo-senpi task command exists.

### Why

- Users need a concise discovery path when they encounter a bug.

### Why this lives in the fork

- This tip describes a workflow skill shipped by the fork.

### Expected merge conflict zones

- LOW: appended array element in `subagent-tips.ts` and the `expectedTips` list.

## 2026-09-07 - /settings auto-compaction toggle persists explicitly (#1422)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: `onAutoCompactChange` calls `settingsManager.setCompactionEnabled` itself and then applies the session override through `session.setAutoCompactionEnabled`.

### Why

- `AgentSession.setAutoCompactionEnabled` no longer persists (it is the RPC session command's implementation), and the settings dialog is the one surface that should.

### Why this lives in the fork

- The settings dialog wiring is interactive-mode code.

### Expected merge conflict zones

- LOW: the `onAutoCompactChange` callback.

## 2026-09-05 - Restore Working text shimmer on turn start

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` now supplies the generated working indicator options when a turn starts.

### Why

- The turn-start path previously passed the unset raw options field, disabling the literal `Working` text shimmer formatter.

### Why this lives in the fork

- Interactive mode owns the working status indicator and its animation configuration.

### Why an extension could not handle it

- `InteractiveMode.showWorkingStatusIndicator` is engine-owned interactive TUI behavior below the extension API.

### Expected merge conflict zones

- LOW: `InteractiveMode.showWorkingStatusIndicator` working-indicator construction.

## 2026-09-05 - Render Astra configuration updates as non-interactive session entries

### What changed

- packages/coding-agent/src/modes/interactive/interactive-mode.ts: handle the configuration-update role without rendering it as a user-visible text message.

### Why

- The wire item affects provider configuration but is not user prose.

### Why this lives in the fork

- Interactive mode owns the terminal projection of session entries.

### Expected merge conflict zones

- Interactive session rendering and message-role handling.

## 2026-09-05 - Restore Working text shimmer formatter

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` no longer constructs a duplicate working status indicator, preserving the literal `Working` text shimmer and formatter wiring.

### Why

- The duplicate construction overwrote the beta.36 conditional chrome-vs-default indicator and its shimmer formatter.

### Why an extension could not handle it

- `InteractiveMode.setWorkingVisible` is engine-owned interactive TUI behavior below the extension API.

### Expected merge conflict zones

- LOW: `InteractiveMode.setWorkingVisible` working-indicator construction.

## 2026-09-05 - Ctrl+P skips favorites without context room

### What changed

- Favorite-model cycling emits a typed `model_change_skipped` event with the
  target budget projection and continues in the requested direction.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` renders a
  warning for each skipped model and a clear compact-or-new-session status when
  every other favorite is rejected. The event is also forwarded through existing
  session event transports, so desktop consumers do not need a desktop-specific
  change.

### Why

- Ctrl+P is an explicit request to switch models. A target that cannot admit
  the current context must be skipped rather than surfacing the later
  `ModelUsabilityBudgetError` as a failed switch.

### Why an extension could not handle it

- Favorite cycling, model usability admission, and the session event stream are
  core host seams below the extension API.

### Expected merge conflict zones

- LOW: `AgentSessionEvent`, `ModelCycleResult`, and `_cycleFavoriteModel`.
- LOW: the interactive `handleEvent` and cycle status path.

## 2026-09-04 - Branded build labels render verbatim in startup UI

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: the non-chrome startup logo line renders through `formatDisplayVersion` instead of a hardcoded `v` prefix, so branded build labels such as `omo@c6e7dd7 2026-09-04 10:17 +09:00` display verbatim.
- `packages/coding-agent/src/modes/interactive/grok/welcome-card.ts`: both grok welcome card render sites route through the same helper.

### Why

- A branded distribution injects a free-form `SENPI_BRAND.displayVersion`, and the hardcoded `v` produced `OmO vomo@c6e7dd7 …` on every startup for those installs. The renderer only owns the prefix decision, so the fix belongs here rather than asking every brand to strip their label to a semver string.

### Why an extension could not handle it

- The logo line and the welcome card are engine-owned chrome. Extensions cannot replace their render paths; they only supply the brand profile string.

### Expected merge conflict zones

- LOW: the logo template literal in `packages/coding-agent/src/modes/interactive/interactive-mode.ts` and the two template literals in `packages/coding-agent/src/modes/interactive/grok/welcome-card.ts`.

## 2026-09-04 - Mark the current thinking level in the selector

### What changed

- `packages/coding-agent/src/modes/interactive/components/thinking-selector.ts`: item labels gain a `✓ ` prefix on the active level (two-space pad otherwise), and fuzzy filtering matches the raw level value plus the description instead of the decorated label (upstream f2a622789, #8900); the fork's selector tests were aligned to the marker in 9e64e52d1.

### Why

- With the check mark embedded in the label, typing a level name would no longer fuzzy-match it; filtering on the value keeps search working while the marker stays visible while browsing.

### Why an extension could not handle it

- The selector is an interactive TUI component rendering inside the host's fullscreen UI.

### Expected merge conflict zones

- LOW: `packages/coding-agent/src/modes/interactive/components/thinking-selector.ts` label construction and `applyFilter`.

## 2026-09-03 - Restore interactive lifecycle seams and branded terminal overrides

### What changed

- Guarded early interactive TUI lifecycle reads when test or host construction has not yet provided session, terminal, or pending-tool state, while retaining the normal runtime behavior.
- Resolved unset terminal capability settings from `SENPI_HYPERLINKS`, `SENPI_IMAGE_PROTOCOL`, and `SENPI_TRUE_COLOR`, with legacy `PI_*` fallback.

### Why

- The upstream sync introduced lifecycle calls at construction and event boundaries where fork-owned fakes and early host events legitimately omit optional state.
- Branded deployments need their capability namespace to reach the TUI detection seam.

### Why an extension could not handle it

- Interactive lifecycle state and terminal capability detection are host-owned infrastructure below the extension API.

### Expected merge conflict zones

- MEDIUM: interactive constructor/event handling and terminal settings resolution during upstream syncs.

## 2026-09-03 - Record fork-owned interactive surfaces against the advanced upstream pin

### What changed

- No behavior changed in this entry. Advancing `.github/upstream.json` to `f41f80466` brought the
  following fork-owned interactive files into the audit's pin-divergence scope, so they are recorded
  here explicitly: `components/assistant-message.ts`, `components/bash-execution.ts`,
  `components/compaction-summary-message.ts`, `components/custom-editor.ts`, `components/diff.ts`,
  `components/earendil-announcement.ts`, `components/extension-selector.ts`, `components/footer.ts`,
  `components/index.ts`, `components/keybinding-hints.ts`, `components/settings-submenu.ts`,
  `components/status-indicator.ts`, `components/thinking-selector.ts`, `components/tool-execution.ts`,
  `components/tree-selector.ts`, `external-editor.ts`, `model-search.ts`, `session-share.ts`, and
  `theme/theme.ts`.
- Each of these is a long-standing fork divergence (senpi branding, footer/dock presentation, notice
  and diff rendering, session sharing, and the fork keybinding/theme surfaces) that predates this
  sync; they carry no upstream counterpart to reconcile at this pin.

### Why

- The tracker audit compares every production path against the pinned upstream tree. When the pin
  advances, fork-only interactive files become newly in-scope and must be named by a tracker entry
  even though the sync itself did not touch them.

### Why an extension could not handle it

- These are host-owned interactive rendering and lifecycle surfaces beneath the extension API; an
  extension cannot supply the footer, transcript components, selectors, or theme resolution.

### Expected merge conflict zones

- LOW: upstream rarely edits these files, but branding strings, footer composition, and component
  rendering will conflict whenever upstream restructures the interactive component tree.

## 2026-09-03 - Reconcile interactive upstream terminal and selector behavior

### What changed

- `interactive-mode.ts`: preserve fork steering-slot, working-dock, footer, shutdown, and notice-block behavior while adopting terminal capability overrides, fullscreen selection-copy wiring, turn-start working/progress restoration, and upstream diagnostics integration adapted to fork rendering.
- `components/model-selector.ts`, `components/scoped-models-selector.ts`, `components/settings-selector.ts`: preserve fork model/scoped-model/settings UX and favorite/availability semantics; retain cheap active/current markers where compatible.
- `interactive-mode.ts` and selector tests: keep fork-diverged selector behavior instead of upstream scope normalization and rejected thinking-selector UX assertions.

### Why

- The fork intentionally owns interactive rendering, steering queue presentation, and scoped-model persistence semantics; upstream additions must not regress those surfaces.

### Why an extension could not handle it

- Terminal capability setup, fullscreen selection behavior, selectors, and notice rendering are host-owned interactive infrastructure beneath extension hooks.

### Expected merge conflict zones

- LOW: interactive lifecycle, selector rendering, and settings submenu composition during upstream syncs.

## 2026-09-03 - Adapt upstream interactive regressions to fork contracts

### What changed

- `test/interactive-mode-assistant-diagnostics.test.ts` and pending-output regression coverage use the fork notice family and fork streaming/working component seams rather than upstream-only renderer details.

### Why

- These tests exercise machine-visible behavior while the fork deliberately diverges in notice-block and streaming rendering.

### Why an extension could not handle it

- The assertions target private interactive host rendering and component lifecycle, which extensions cannot replace.

### Expected merge conflict zones

- LOW: assistant diagnostics and thinking-toggle regression tests when upstream adds renderer-specific expectations.
# 2026-09-05 - Ctrl+P skips models without context room

### What changed

- Favorite-model cycling emits a typed `model_change_skipped` event and continues
  in the requested direction when a candidate model cannot leave the provider's
  minimum answer room for the current conversation.
- Interactive mode renders the event as a warning naming the skipped model and
  the current context/window measurements. The desktop app can consume the event
  without requiring a desktop-specific code change.

### Why

- Ctrl+P is an explicit request to switch, so a model that cannot admit the
  current context must not block the request or silently look like a failed
  switch. The next usable favorite is selected instead, while the skipped
  candidate remains visible to the user.

### Expected merge conflict zones

- LOW: `AgentSessionEvent` model event union and `_cycleFavoriteModel`.
- LOW: the interactive `handleEvent` switch.
# 2026-09-05 - Ctrl+P skips models without context room

### What changed

- Favorite-model cycling emits a typed `model_change_skipped` event and continues
  in the requested direction when a candidate model cannot leave the provider's
  minimum answer room for the current conversation.
- Interactive mode renders the event as a warning naming the skipped model and
  the current context/window measurements. The desktop app can consume the event
  without requiring a desktop-specific code change.

### Why

- Ctrl+P is an explicit request to switch, so a model that cannot admit the
  current context must not block the request or silently look like a failed
  switch. The next usable favorite is selected instead, while the skipped
  candidate remains visible to the user.

### Expected merge conflict zones

- LOW: `AgentSessionEvent` model event union and `_cycleFavoriteModel`.
- LOW: the interactive `handleEvent` switch.

## 2026-09-12 - Upstream sync (upstream/main@71dca871) integration repairs

### What changed

- `packages/coding-agent/src/modes/interactive/chat-viewport.ts`: the fullscreen dock gains an optional `hookStatus` component slot for the fork's tool-hook status rows.
- `packages/coding-agent/src/modes/interactive/tui-renderer.ts`: the default terminal is `ProcessTerminal({ onExternalStdoutWrite: appendHiddenTuiStdout })` so stray stdout lands in the hidden TUI log.
- `packages/coding-agent/src/modes/interactive/components/assistant-message.ts`: fork descriptor-based incremental reconciler (`createAssistantRenderDescriptors`, bounded render signatures, per-run thinking toggles) instead of upstream's rebuild-on-change component.
- `packages/coding-agent/src/modes/interactive/components/custom-editor.ts`: fork prompt-glyph gutter with a minimum horizontal padding of 2 (`getPaddingX`/`setPaddingX` overrides) on top of upstream's `embedWorkingStatus` editor.
- `packages/coding-agent/src/modes/interactive/components/index.ts`: exports the fork `FavoriteModelsSelectorComponent` and its callback/config types; `ScopedModelsSelectorComponent` is not exported.
- `packages/coding-agent/src/modes/interactive/components/scoped-models-selector.ts`: the fork's simplified scoped selection (toggle from all-enabled starts a one-model list, no collapse-to-null normalization) with configurable `app.models.save`; upstream's rejected 6949 UX is not restored.
- `packages/coding-agent/src/modes/interactive/components/status-indicator.ts`: fork loader-based indicators (`CompactionStatusReason` labels, single-row compaction status with streamed preview and cancellation hint, `renderInBorder` override, `IdleStatus.setHeight`).
- `packages/coding-agent/src/modes/interactive/components/thinking-selector.ts`: the `xhigh` description reads "Extended reasoning (~32k tokens or native xhigh effort)".
- `packages/coding-agent/src/modes/interactive/components/tool-execution.ts`: fork card (`ToolExecutionRenderer`, `GrokToolRow` presentation, progress rows, todo strike animation, image sidecar, bounded render signatures) accepting upstream's `ToolRenderers` and click-to-toggle.
- `packages/coding-agent/src/modes/interactive/theme/theme.ts`: validation always on via `validateThemeJson` from `theme-json.ts` (re-exported; `setThemeJsonValidator` kept as an override hook), `grok-night`/`grok-day` shipped as built-ins with `scrollbarTrack`/`scrollbarThumb`, no `isLightTheme`.

### Why

- The fork's interactive chrome (Grok presentation, favorite-model selector, hidden stdout log, hook status rows, always-validated themes) sits on top of upstream's component set; these files are the overlap.

### Why an extension could not handle it

- Interactive components, the renderer factory and theme loading are private to the host; extensions render through them and cannot replace them.

### Expected merge conflict zones

- HIGH: `components/tool-execution.ts` and `components/assistant-message.ts` render paths; `components/status-indicator.ts` class set.
- MEDIUM: `theme/theme.ts` validator and built-in theme loading; `components/scoped-models-selector.ts` toggle logic.
- LOW: `chat-viewport.ts` options; `tui-renderer.ts` terminal construction; `components/index.ts` export list; `components/custom-editor.ts` padding overrides; `components/thinking-selector.ts` label text.

## 2026-09-20 - Coalesce provider network failures (senpi#1874)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` routes live errors, summary retries, cancellation, and replay through `provider-error-presentation.ts`, which owns the displayed failure episode without changing stored messages.
- `packages/coding-agent/src/modes/interactive/components/assistant-render-descriptors.ts` keeps network diagnostics in expanded output rather than printing a raw envelope by default.
- `packages/coding-agent/src/modes/interactive/components/assistant-message.ts` marks errors owned by the grouped notice so expansion does not repeat them on every failed assistant message.
- `packages/coding-agent/src/modes/interactive/components/status-indicator.ts` adds a plain-language network retry status with the existing attempt count and countdown.

### Why

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` appended each summary error and each plain provider envelope; its message-end handler also rendered raw errors before retry-start arrived.
- `packages/coding-agent/src/modes/interactive/components/assistant-render-descriptors.ts` replayed those same envelopes in full.
- `packages/coding-agent/src/modes/interactive/components/assistant-message.ts` otherwise expanded all 17 failed messages even after their errors had been grouped.
- `packages/coding-agent/src/modes/interactive/components/status-indicator.ts` already owned retry timing, so it remains the single transient status surface.

### Why an extension could not handle it

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`, `packages/coding-agent/src/modes/interactive/components/assistant-message.ts`, `packages/coding-agent/src/modes/interactive/components/assistant-render-descriptors.ts`, and `packages/coding-agent/src/modes/interactive/components/status-indicator.ts` own the built-in event-to-render path before an extension can replace its transcript output.

### Expected merge conflict zones

- MEDIUM: event cases and replay in `packages/coding-agent/src/modes/interactive/interactive-mode.ts`.
- LOW: error descriptors in `packages/coding-agent/src/modes/interactive/components/assistant-render-descriptors.ts` and retry wording in `packages/coding-agent/src/modes/interactive/components/status-indicator.ts`.
- LOW: display ownership in `packages/coding-agent/src/modes/interactive/components/assistant-message.ts`.

## 2026-09-23 — Group consecutive exploration calls into one codex-style cell (senpi#2042)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` builds the chat transcript as an `ExplorationTranscriptContainer` and replays saved assistant messages through `replayAssistantTools`, so all four places that append a `ToolExecutionComponent` (streaming tool call, `tool_execution_start`, the late `tool_execution_end` append, and `renderSessionItems` replay) feed the same projection.
- `packages/coding-agent/src/modes/interactive/components/exploration-transcript-container.ts` (new) projects consecutive built-in `read`/`grep`/`find`/`ls` cards into one `ExplorationGroup` at render time; any other tool, assistant text, or user message closes the group. The original cards stay the transcript children, `pendingTools` keeps routing results to them, and the projection never owns or disposes them.
- `packages/coding-agent/src/modes/interactive/components/exploration-group.ts` (new) renders the codex exploring cell: `• Exploring`/`• Explored` (plus ` · N failed`), then `Read a.ts, b.ts` (deduplicated basenames), `Search <pattern>[ in <dir>]`, `List <dir>`, capped at eight body lines with `… +K more`. The tool-expand key or a click on the header shows the original cards unchanged.
- `packages/coding-agent/src/modes/interactive/components/exploration-call.ts` (new) classifies a card as an exploration call only when it uses the classic presentation and the built-in renderers.
- `packages/coding-agent/src/modes/interactive/replay-assistant-tools.ts` (new) places text and thinking between tool calls where the live stream places them, so replayed sessions render the same groups as live ones.
- `packages/coding-agent/src/modes/interactive/components/tool-execution.ts` exposes a read-only `presentationSnapshot`; `packages/coding-agent/src/modes/interactive/components/assistant-message.ts` exposes `isExplorationDetail` for empty or hidden-thinking heads that may sit inside a group; `packages/coding-agent/src/modes/interactive/tool-progress.ts` exports `toolSpinnerGlyph` so the exploring header reuses the tool spinner glyphs.

### Why

- Agents read one file in several ranges and then search and list; each call rendered its own card, so the transcript was mostly read cards. Codex shows the same work as one exploring cell with file names only. senpi#1881 tried a range/count summary and was closed; this lands the codex shape instead.

### Why an extension could not handle it

- The transcript container, the tool-card construction sites, and the session replay path are private to `packages/coding-agent/src/modes/interactive/interactive-mode.ts`; an extension can replace one tool's renderer but cannot merge several cards or change how history is replayed.

### Expected merge conflict zones

- MEDIUM: the chat container construction and the assistant branch of `renderSessionItems` in `packages/coding-agent/src/modes/interactive/interactive-mode.ts`.
- LOW: the added getters in `packages/coding-agent/src/modes/interactive/components/tool-execution.ts` and `packages/coding-agent/src/modes/interactive/components/assistant-message.ts`, and the spinner helper in `packages/coding-agent/src/modes/interactive/tool-progress.ts`.
