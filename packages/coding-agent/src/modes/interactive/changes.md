## 2026-10-10 - The footer shows the reasoning level and its cycle key (senpi#3090)

### What changed

- `packages/coding-agent/src/modes/interactive/components/footer-right-label.ts` (new): `buildRightLabel` owns the right-side ladder and the run colouring (`RightSideRun`, `colorRightSide` moved here from `footer.ts`). For a reasoning model the ladder is: `(provider) <model> • effort <level> (<key>)` and `(provider) <model> • effort <level>`, both used only when the whole footer fits as is; then the compact `(provider) <model>:<level>` while middle stats may elide; then `<model>:<level>` as the floor with pwd elision - the last two are exactly the forms the footer had before. `<key>` is `keyText("app.thinking.cycle")` (the user's own binding; an unbound action yields no hint form). The virtual-model routing suffix stays after the model id in every form. So the key hint drops first, then the readable label, then the provider; stats, path and `model:level` are visible at exactly the widths they were before (measured 40-200 columns against main, three fixtures, zero differences).
- `packages/coding-agent/src/modes/interactive/components/footer-layout.ts`: `FooterRightLabel` is `{ forms: [richest, ..., floor] }` of `FooterRightForm`s instead of `{ minimal, full }`; each form carries `fitsWith: "everything" | "middle-elision" | "pwd-elision"` (default) saying how much the left side may give up for it, and the `full` / `middle-elided` / `pwd-elided` plans carry `rightForm` (index into `forms`) instead of `useFullRight`. Head elision and right truncation use the floor form.
- `packages/coding-agent/src/modes/interactive/components/footer.ts`: builds the provider prefix and calls `buildRightLabel`; the model-label block, run type and colouring left the file (273 -> 234 pure LOC).
- `packages/coding-agent/src/modes/interactive/tips/reasoning-level-notice.ts` (new): `resolveReasoningLevelNotice` returns the one-time `Tip: <Key> changes the reasoning level` line for a reasoning model when `app.thinking.cycle` is bound and the tip id `reasoning-level-key` is not yet in the settings tip history.
- `packages/coding-agent/src/modes/interactive/tips/startup-tips.ts` (new): `resolveStartupTips({ settings, now, modelReasoning, hasCommand, keys, displayKeys })` is the startup tip block as a free function over a settings port (`getTipsEnabled` / `getQuietStartup` / `getTipsHistory` / `setTipShown`): it resolves that notice before the rotating startup tip, records each shown tip in `tipsHistory` (so the notice never repeats from that agent directory), excludes the rotating `thinking-level` tip on the launch the notice shows, and returns the joined lines plus the shown tip ids. The same `tips` / `quietStartup` gates apply.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: `init()` calls `resolveStartupTips` with its settings manager and lazy thunks for the model and registered commands, adds the shown ids to `sessionShownTipIds`, and puts the text in the one tip slot under the header. Hand-built `init` fixtures (the grok characterization tests) keep working because nothing new is required of `this`. Two sessions starting for the very first time at the same moment can each show the notice once (same race the rotating tips have).
- Tests: `test/footer-reasoning-level.test.ts` (default/rebound/unbound key, non-reasoning, `off`, routed model; a 60-200 sweep proving the hint never evicts a stat; cost/CH at 100-119 as on main; `model:level` down to 45 columns), `test/reasoning-level-notice.test.ts` (pure resolver, plus `resolveStartupTips` on a real `SettingsManager`: recorded once, no `thinking-level` entry that launch, silent after a restart, obeys `tips=false` / quiet startup); `footer-width` ladder tests use `fitsWith`.

### Why

- Users did not discover that Shift+Tab cycles the reasoning level: the only sign was a dim `:high` glued to the model id with nothing saying a key changes it (senpi#3090, requested by @devxoul). The readable forms must not cost live stats or path, which is why they are gated on a full fit and the compact form takes over below.

### Why an extension could not handle it

- The footer's right-side label, its width ladder and the startup tip slot are the interactive mode's own rendering; an extension can add a status line but cannot change how the model label is composed or truncated.

### Expected merge conflict zones

- LOW: the model-label block of `footer.ts` `render()` and the `FooterRightLabel` / `FooterLayout` types in `footer-layout.ts` (both fork-only); the startup-tip block in `interactive-mode.ts` (fork-only tips).

## 2026-10-08 - In-session resume warns about foreign holders (senpi#2951)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: keeps the existing `handleResumeSession` and missing-cwd retry inline; after a successful switch publishes the CLI hold, warns with the foreign holder pid/cwd. A holder lookup filesystem error warns without turning a successful resume into a fatal error.

### Why

An in-session `/resume` previously opened a held JSONL silently.

### Why an extension could not handle it

The resume selector and runtime switch are owned by interactive mode.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: imports and the successful-switch paths in `handleResumeSession`.

## 2026-10-08 - `/answer skip` keeps a required question's refusal (senpi#2949)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: `/answer skip` passes the question's `required` flag to `formatUserMessage`, so a dismissed required question reaches the model as "do not take the action it gates" instead of only "The user dismissed the question."

### Why

- `/answer skip` is the only path that sends a dismissed-question message to the model; without the flag, the ask-user builtin's required-question text never reached it (senpi#2949).

### Why an extension could not handle it

- The `/answer` command and its message are owned by interactive mode.

### Expected merge conflict zones

- LOW: `interactive-mode.ts` `/answer skip` branch, the `formatUserMessage` call.

## 2026-10-07 - A terminal model pick no longer rewrites the default model (senpi#2870)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`:
  - `applyModelSelection(mode, model, origin, persistDefault = false)` switches through `setSessionModel` unless the default was asked for explicitly. It is used by `/model <id>` (`command`), the model picker (`picker`, actor `model-selector`), the favorites picker (`picker`, actor `favorites`) and the control endpoint's `set_model` (`control`). `/model <id> --default` and the picker's save chord persist the default, and the status line says so.
  - The favorites cycle key passes `persistDefault: false`. A provider login's default-model choice records `provider-login`.
  - A `model_changed` event with `duringTurn` adds a transcript row naming both models and the source (fallbacks keep their own notice box), and the same row is rebuilt from the `model_change` entry when the transcript is re-rendered.
- `packages/coding-agent/src/modes/interactive/components/model-selector.ts`: Enter no longer writes the default model. `app.models.save` (Ctrl+S), which `docs/keybindings.md` already describes as saving the selected default model, selects with `asDefault: true`. `onSelect` receives `{ asDefault }`, and the settings argument is kept only for its callers.
- `packages/coding-agent/src/modes/interactive/model-change-notice.ts` (new): `/model --default` parsing and the mid-turn notice text.

### Why

senpi#2870: every terminal selection silently rewrote the global `defaultModel`, so one pane's pick changed the model of every session started afterwards on the machine, agent lanes and background sessions included.

### Why an extension could not handle it

The model picker, `/model` and the control endpoint's `set_model` are interactive-mode internals.

### Expected merge conflict zones

- `interactive-mode.ts`: `handleModelCommand`, `selectModelFromUi`, `applyModelSelection`, the two picker callbacks, `cycleModel`, the provider-login default model, the `model_changed` case, and `renderSessionEntries` / `renderSessionItems`.
- `model-selector.ts`: `handleSelect` and the key handling.

## 2026-10-07 - Streaming turns hold the scrollback replay (senpi#2836)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`:
  - `agent_start` calls `ui.setScrollbackReplayHold(true)` and deliberately does not catch up. A turn nobody typed (auto-retry, an extension's `triggerTurn`) can start while the reader is still scrolled up, and a turn the user started already caught up on their Enter key.
  - `agent_end` sets `ui.setScrollbackReplayHold("until-input")`, so finishing a reply never replays under a reader who scrolled up. Their next key press corrects the stale rows once.
- `packages/coding-agent/test/interactive-mode-scrollback-hold.test.ts`: a real `TUI`. A turn leaves stale rows, the reader scrolls up, then an untyped turn's `agent_start` arrives. There is no `ESC[3J` and the view is unchanged. With a catch-up at `agent_start` it fails (1 replay).
- Four tests with hand-built `ui` doubles (`interactive-mode-transcript-write-failed`, `tool-execution-update-wiring`, `tui-vertical-jitter`, `tui-vertical-jitter-lifecycle`) gain the two methods.

### Why

See `packages/tui/src/changes.md` (same date): a streamed table widening its columns re-laid out rows above the viewport, and every frame then replayed the scrollback, snapping a scrolled-up view to the top.

### Why an extension could not handle it

The turn lifecycle and the TUI instance belong to the interactive mode, not to an extension.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: the `agent_start` and `agent_end` cases.

## 2026-10-07 - A notice during a streaming turn goes above the live reply (senpi#2836)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: `showStatus()` (the path for `ctx.ui.notify(..., "info")`, including bare `/todo`) inserts its spacer and text before `streamingComponent` while a turn streams, the way `addCustomEntryToChat()` already does. The "replace the previous notice in place" check now looks at the two children above the live message. When idle it appends as before.
- `packages/coding-agent/test/interactive-mode-notice-during-stream.test.ts`, a real `TUI` on a counting `VirtualTerminal` (80x20):
  - a 40-line notice posted mid-stream causes no `ESC[3J` scrollback replay across five more deltas, and the live tail stays in view;
  - a user scrolled up 8 rows keeps seeing the same top row through the notice and the deltas;
  - a second notice in the same turn replaces the first above the live message;
  - an idle notice still lands at the end.
  The first three fail before this change (on main the scrolled-up view is thrown back to the first line).

### Why

Appended after the live reply, a notice taller than the screen pushed the reply's tail above the viewport. Every streamed delta then changed rows above it while the line count changed, so `TUI.doRender()` took `renderScrollbackReplay()` (`ESC[3J` plus a full rewrite) once per token, which a terminal shows as the view jumping to the top again and again.

### Why an extension could not handle it

Notice placement is the interactive mode's own chat container logic.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: `showStatus()`.

## 2026-10-06 - A terminal session takes model, thinking-level and interrupt controls from its control endpoint (oh-my-openagent#9660)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: two private static methods, called through the class with the mode, are split out of the UI paths (static so that a handler run on a partial `this`, as existing tests do, reaches only the members the switch uses). `applyModelSelection` is the `/model` switch, and `applyThinkingLevel` is the thinking-level selector's apply; each throws instead of showing the error. `selectModelFromUi` and `selectThinkingLevel` call them and show a throw as before. `sessionControlContext` gives the control endpoint `selectModel`, `selectThinkingLevel` and `interruptTurn`, which runs the Esc path `abortAndFireQueuedMessages`.
- `packages/coding-agent/src/modes/interactive/session-control-commands.ts` and `session-control-session-commands.ts` (new): the endpoint answers `get_available_models`, `get_available_thinking_levels`, `set_model`, `set_thinking_level` and `interrupt` through those surface methods. `get_protocol_info` lists the accepted `commands`.
- `test/suite/interactive-session-controls.test.ts` (new): a real interactive mode on a virtual terminal, driven over its live control socket. It covers the model switch (session, footer, pane status, remembered default), an unknown model, a supported level and an unsupported one, an interrupt on an idle session, and an interrupt mid-turn that answers only after the turn settled.

### Why

- `thread_set_model`, `thread_set_reasoning` and `thread_interrupt` failed against every terminal session, which is most live sessions. Running the pane's own paths gives a remote change the same validation, footer update and persistence the user gets typing it in the pane.

### Why an extension could not handle it

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: the footer, the editor border, the status line and the Esc queue restore are private to the interactive mode. An extension switching the model through `pi` would skip them.

### Expected merge conflict zones

- LOW: `selectModelFromUi` / `selectThinkingLevel` in `interactive-mode.ts` (bodies moved into `applyModelSelection` / `applyThinkingLevel`), and `sessionControlContext`.

## 2026-10-06 - A delivered message says who sent it (oh-my-openagent#9660)

### What changed

- `packages/coding-agent/src/core/extensions/session-control-types.ts`: `admitExternalMessage` takes optional `sender` (`agent { session_id, name? }`, `command_line { user? }`, `external { platform, author? }`) and `display_text`, the message as its sender wrote it. Both are stored on the delivery's `details` (`core/external-admission.ts`). `sessionControlSenderOf` reads a sender back.
- `packages/coding-agent/src/modes/interactive/components/remote-delivery-message.ts`: a delivery that names its sender renders one dim label line, `Sent by another agent · <name>`, `Sent from the command line`, or `Sent from <platform> · <author>`, over `display_text`. A delivery without a sender keeps the `remote message` heading over the full text.
- `test/remote-delivery-message.test.ts` (new): each sender kind renders its label (an agent with and without a name, the command line, an external chat with and without an author). A sender it cannot read, or a sender without `display_text`, falls back to the old heading over the full text, never to a wrong label.

### Why

- The terminal showed the raw provenance header (`[OMO_GATEWAY v=1 source=peer_agent actor=...]`) to its user. The model still reads that header in the message content; the human surface gets a clean label.

### Why an extension could not handle it

- The `session_control_delivery` renderer is built in, and `details` is written by admission; an extension sees neither before the entry is written.

### Expected merge conflict zones

- LOW: `AdmitExternalMessageInput` / `SessionControlDeliveryDetails` in `session-control-types.ts` and `deliveryMessage` in `external-admission.ts`.

## 2026-10-06 - Stray writes to fd 1 can no longer push the input box off-screen (senpi#2815)

### What changed

- `packages/coding-agent/src/modes/interactive/stdout-fd-redirect.ts` (new): while the TUI owns the screen, fd 1 is `dup2`'d to the debug log, and `process.stdout` (the renderer's writer) writes through a duplicate of the terminal descriptor. Its `columns`/`rows` come from that duplicate and are refreshed on `SIGWINCH`, with a `resize` event re-emitted. `restore()` puts fd 1 back and unwinds the patch. One terminal duplicate per process is reused across suspend and editor round-trips.
- `packages/coding-agent/src/modes/interactive/interactive-stderr-guard.ts`: `takeOverInteractiveStderr()` also redirects fd 1, but only when stdout is a TTY, and starts an unref'd 5 s check that keeps the debug log under 32 MiB (`capHiddenOutputLog`: past the cap, the file is cut to its last 256 KiB behind a marker line). `restoreInteractiveStderr()` stops the check and restores fd 1 before fd 2. Every path that already hands the terminal back (exit, crash, suspend, the external editor) therefore restores fd 1 too.
- `packages/coding-agent/src/modes/interactive/components/extension-editor.ts`: the extension editor's external-editor path stopped the TUI without handing the descriptors back; it now restores them first and takes them over again afterwards, like the main editor path.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: `withTerminalHandedOver()` holds the stop -> restore -> run -> take over -> start sequence. The main external editor and `/keybindings` both use it; `/keybindings` used to spawn `$VISUAL`/`$EDITOR` with `stdio: "inherit"` while the TUI owned the terminal, so under the redirect its editor would draw into the log.
- `stdout-fd-redirect.ts` also never stacks `write` wrappers across suspend/resume cycles (the next takeover wraps the original write), and a takeover that fails after `dup2` puts fd 1 back instead of leaving it redirected.
- `packages/coding-agent/test/suite/regressions/2815-tui-stdout-never-floods.test.ts`: run under a real terminal (`script`). A raw fd 1 write, a child inheriting stdout and native `console.log` reach the log while the renderer's frame (with the terminal's width) reaches the screen. A piped stdout is untouched. The bash tool still captures its command's output. The crash path hands fd 1 back before exit. The cap cuts an oversized log. `/keybindings` runs its editor with the terminal handed back (fails before `withTerminalHandedOver`).

### Why

A community report: in a long session the input box vanished after "some read message flooded the terminal". A raw write of 120 lines to fd 1 on a 26-row terminal reproduces it: the terminal scrolls behind the renderer, whose cursor math then puts the editor below the screen. fd 2 was already captured this way (#2284).

### Why an extension could not handle it

The redirect has to be installed and released together with the TUI's own terminal ownership, inside interactive mode.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/interactive/interactive-stderr-guard.ts`: `takeOverInteractiveStderr()`, `restoreInteractiveStderr()` and the fd helpers next to `takeOverStderrFd()`.
- `packages/coding-agent/src/modes/interactive/components/extension-editor.ts`: `handleOpenExternalEditor()`.

## 2026-10-03 - The first-run provider guidance is shown once (senpi#2677)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: handles the new `provider_required` session event by showing its notice as a warning; when the startup warning was already "No models available" (`formatNoModelsAvailableMessage()`), the first such event is absorbed by it. `test/interactive-mode-provider-required.test.ts` covers the absorb, a later notice, and no-startup-warning.

### Why

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: a first run with no provider used to show a compaction error from a startup extension's background turn. The decision is that such a turn is neither silent nor an error: the user sees the same `/login` guidance a typed prompt gets, once, on the first screen.

### Why an extension could not handle it

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: session events are rendered by the interactive mode itself; no extension owns the first-run warning list.

### Expected merge conflict zones

- LOW: the `resume_context_reduced` / `provider_required` cases in the session event switch.

## 2026-10-03 - Exact tool-card result bytes for the memory report (senpi#1960)

### What changed

- `packages/coding-agent/src/modes/interactive/components/tool-execution.ts`: a card's final `updateResult` measures its retained result once (`serializedToolResultBytes`) and records it in the render cache (`finalizeResult`); a streaming card keeps its last figure.

### Why

- The memory report's `tuiRenderCache` reports exact `resultBytes` and `finishedCards`, so a later bound on the cache is designed from a measurement.

### Why an extension could not handle it

- The card and its render cache are private to the core interactive mode.

### Expected merge conflict zones

- LOW: `ToolExecutionComponent.updateResult()` in `tool-execution.ts`.

## 2026-10-02 - Tool-card render cache totals (senpi#2561)

### What changed

- `packages/coding-agent/src/modes/interactive/components/tool-execution-cache.ts` (new): each tool card's rendered-lines cache and render revision, with process-wide O(1) totals (components, cached lines, images) published to the memory report.
- `tool-execution-animation.ts` (new): the spinner and todo-strike timers and when a card animates; `tool-execution-fallback-preview.ts` (new): the collapsed fallback preview. `tool-execution.ts` delegates to them; rendering is unchanged.

### Why

- The on-demand memory report (`SENPI_MEMORY_REPORT=1`) needs the terminal render cache's size without walking components.

### Why an extension could not handle it

- The cache is private to the core tool card.

### Expected merge conflict zones

- `components/tool-execution.ts` (cache fields, animation timers, `render`).

## 2026-10-02 - Question answer provenance (senpi#2533)

### What changed

- `packages/coding-agent/src/modes/interactive/components/ask-user-question-state.ts`: widget response construction marks submitted answers as `local_ui`.
- `packages/coding-agent/src/modes/interactive/components/ask-user-async-widget.ts`: collapsed widget and composer answers carry `local_ui`; timeouts do not.
- `packages/coding-agent/src/modes/interactive/session-control-commands.ts`: admitted question answers carry `control_endpoint`; cancellation does not.
- Closure: every terminal outcome of a question these surfaces show (an answer from any surface, timeout, cancellation) is published once on the new `ask-user:closed` extension event, `{ requestId, status, resolvedBy? }`, by the ask-user builtin (`src/core/extensions/changes.md`). A losing surface's late answer or cancellation publishes nothing, and reload detaching the widget is not a closure.

### Why

- `packages/coding-agent/src/modes/interactive/components/ask-user-question-state.ts`, `packages/coding-agent/src/modes/interactive/components/ask-user-async-widget.ts`, `packages/coding-agent/src/modes/interactive/session-control-commands.ts`: integrations need the winning surface even when multiple surfaces can answer the same question.

### Why an extension could not handle it

- `packages/coding-agent/src/modes/interactive/components/ask-user-question-state.ts`, `packages/coding-agent/src/modes/interactive/components/ask-user-async-widget.ts`, `packages/coding-agent/src/modes/interactive/session-control-commands.ts`: only these response builders know whether input came from the local widget or an external endpoint.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/interactive/components/ask-user-question-state.ts`, `packages/coding-agent/src/modes/interactive/components/ask-user-async-widget.ts`, `packages/coding-agent/src/modes/interactive/session-control-commands.ts`: response object construction.

## 2026-10-02 - Route Warp-on-WSL empty paste events to the clipboard

### What changed

- `packages/coding-agent/src/modes/interactive/components/custom-editor.ts`: an exact empty bracketed-paste packet invokes the existing clipboard handler only in a direct Warp-on-WSL session, using the shared hardened session predicate. Non-empty bracketed paste remains editor text input, and other terminal sessions are unchanged.

### Why

- Physical Ctrl+V with a copied image was captured as `ESC[200~ESC[201~`, not a Ctrl+V key byte. Adding a Ctrl+V keybinding alone could not repair this path because the base editor silently ignored empty paste content.

### Why an extension could not handle it

- An optional input hook can work around the event, but the default composer owns clipboard dispatch and must route the terminal paste event without requiring an installed extension.

### Expected merge conflict zones

- LOW: the TUI import and clipboard dispatch condition in `packages/coding-agent/src/modes/interactive/components/custom-editor.ts`.

## 2026-10-01 - Release render caches of rows above the kept main-screen history (senpi#2508)

### What changed

- `packages/coding-agent/src/modes/interactive/components/progressive-transcript-container.ts`: when the kept history window's first child moves forward, `releaseRenders()` drops the cached renders, heights and live-row records of the children that left it and invalidates them, so their own line caches go too.

### Why

In a long regular-mode run every message that scrolled above the kept window kept its rendered lines (and its component's own caches) forever, although the main screen never paints it again. Over a 10-minute event stream this grew the heap about 3 KB per added entry beyond what a cold open of the same session holds. Fullscreen and `/tree` render those rows again on demand; in regular mode they stay above the kept window and are not painted again.

### Why an extension could not handle it

This is the interactive transcript container.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/interactive/components/progressive-transcript-container.ts`: `keptHistoryStart` and the new `releaseRenders`.

## 2026-10-01 - Release session memory after the first render of a resumed session (senpi#2508)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: `init()` calls `session.releaseSettledSessionMemory()` right after `renderInitialMessages()`.

### Why

Rendering a resumed session builds the session views, and no run settles idle afterwards, so a resumed 50,000-entry session kept about 60 MB of views until the first turn ended.

### Why an extension could not handle it

This is the interactive startup sequence.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: `init()` around `renderInitialMessages()`.

## 2026-10-01 - Settled transcript entries are rendered once (senpi#2508)

### What changed

- `packages/coding-agent/src/modes/interactive/components/assistant-message.ts`, `packages/coding-agent/src/modes/interactive/components/user-message.ts`, `packages/coding-agent/src/modes/interactive/components/custom-message.ts`, `packages/coding-agent/src/modes/interactive/components/custom-entry.ts`, `packages/coding-agent/src/modes/interactive/components/compaction-summary-message.ts`, `packages/coding-agent/src/modes/interactive/components/branch-summary-message.ts`, `packages/coding-agent/src/modes/interactive/components/skill-invocation-message.ts`, `packages/coding-agent/src/modes/interactive/components/bash-execution.ts`, `packages/coding-agent/src/modes/interactive/components/themed-text.ts`, `packages/coding-agent/src/modes/interactive/components/dynamic-border.ts`: report a render revision that moves at every point their render cache is dropped (or derive it from their children).
- `packages/coding-agent/src/modes/interactive/components/tool-execution.ts`: a finished card (final result, complete args, no animation, classic presentation) reports a revision moved by every setter; running cards keep rendering every frame.
- The fork-only transcript containers cache each revisioned child's lines per (width, capabilities, theme generation, revision), reuse the unchanged leading block of history, memoize the exploration projection and each card's exploration call, and keep their own child heights for mouse dispatch.

- The progressive transcript container keeps the last painted rows of a live (unrevisioned) child that is entirely inside native scrollback; it renders again once it settles, scrolls back on screen, or the width, capabilities or theme change.

- In the regular (main-screen) mode the progressive container paints only the most recent history (`mainScreenHistoryLines()`), led by one muted marker line (`N earlier messages · /tree to browse, or switch to fullscreen`); the kept window grows to 1.5x its budget before its top moves, so appends never rewrite history. Fullscreen and renders outside a frame still return the full transcript, and `interactive-mode.ts` passes the themed marker. Decision from the lead (user side): instant resume and repaint over scrollback the terminal discards anyway; nothing is lost because the session file, `/tree`, fullscreen, copy and export use the full history.

### Why

Typing, streaming a background-triggered reply, or a spinner frame re-rendered every message, card and exploration group of the session; read cards even walked the filesystem per frame for their classification. An exploration spinner that had scrolled into the terminal history changed a row the terminal cannot repaint in place, so every spinner frame replayed the entire transcript.

### Why an extension could not handle it

These are the built-in transcript components and their containers.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/interactive/components/assistant-message.ts`: `invalidate`, `updateContent`, `render`.
- `packages/coding-agent/src/modes/interactive/components/tool-execution.ts`: `render`, `invalidateRenderCache`.
- The other listed components: an added `getRenderRevision` override next to `setExpanded`/`invalidate`.

## 2026-10-01 - Forward explicit picker argument requirements (senpi#2479)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: forward `requiresArguments` from builtins, extensions, templates and skills, leaving it unset when the source did not declare it.

### Why

Optional arguments must not force a second Enter to open selectors.

### Why an extension could not handle it

The interactive host assembles every autocomplete command source.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: createBaseAutocompleteProvider mappings.

## 2026-09-30 - Sync with upstream v0.99.1 (6a4af07d6): interactive mode and theme

### What changed

- `packages/coding-agent/src/modes/interactive/bug-report.ts` (deleted): `session-share.ts` stays deleted (Radius share rejected; gist `/share` kept); `bug-report.ts` (upstream-only) removed (D-6, Exclusion list).
- `packages/coding-agent/src/modes/interactive/components/compaction-summary-message.ts`: `compaction-summary-message.ts`, `skill-invocation-message.ts`: upstream click-to-toggle `MouseRegion` content container with the fork details line, sanitized summary and multi-skill body.
- `packages/coding-agent/src/modes/interactive/components/config-selector.ts`: `config-selector.ts`: upstream built-in rows (`BUILTIN_PATH_PREFIX`) with the fork `SourceScope`; the rows list whatever the fork builtin registry resolves.
- `packages/coding-agent/src/modes/interactive/components/extension-input.ts`: `extension-input.ts`: upstream `description` option; fork cursor-at-end prefill kept.
- `packages/coding-agent/src/modes/interactive/components/footer.ts`: `footer.ts`: fork O(1) session-manager usage totals, account suffix and colored right-side runs kept; upstream virtual-model routing adopted as ` → <physical-model>:<level>` after the model label (fork label format); upstream per-render stats cache not adopted (the fork totals are already O(1)).
- `packages/coding-agent/src/modes/interactive/components/pi-logo.ts` (deleted): deleted in this sync (see the lane decision record).
- `packages/coding-agent/src/modes/interactive/components/settings-selector.ts`: `settings-selector.ts`: upstream system theme entry first (with description), lowercase "automatic", system theme as the default pick, "Fullscreen wheel scrolling" setting; fork thinking-level callback, terminal mouse setting and select-list theme kept; upstream cache-warming row removed (D-5).
- `packages/coding-agent/src/modes/interactive/components/skill-invocation-message.ts`: `compaction-summary-message.ts`, `skill-invocation-message.ts`: upstream click-to-toggle `MouseRegion` content container with the fork details line, sanitized summary and multi-skill body.
- `packages/coding-agent/src/modes/interactive/components/tool-execution.ts`: `tool-execution.ts` = OURS (fork renderer/images split); upstream args on the title line ported into `tool-execution-fallback.ts` `createToolCallFallback(toolName, args, expanded)` via `formatToolCallWithArgs` (argument strings stripped of terminal escapes/control characters, line breaks kept) and called from `tool-execution-renderer.ts`; upstream stale-conversion guard already present in the fork `ToolExecutionImages`.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: Upstream adopted: theme-following text everywhere the upstream switched to `ThemedText` (extension errors + stacks, compaction failure line, provider error line, `/name` echo, `/session` info built on demand, update/debug notices where the fork had no notice box, Copilot/Anthropic notices); the startup header and the loaded-resource listing are built on demand so they recolor on theme changes (`logo()`, instruction thunks; fork `LoadedResourceSection` now takes body thunks); startup applies the theme, then awaits `themeController.waitForTerminalColors()` (ends at DA1, <= 100 ms) before building the header; `[Themes]` startup section removed (D-14); session picker passes the upstream abort `signal` through `currentScopeSessions`/`allScopeSessions` (progressive listing, dfbf793b78); fullscreen wheel scrolling setting (`fullscreenWheelScrollLines` into the renderer, the settings menu and `setWheelScrollLines`), read at every site, the settings menu included, through the fork optional-getter guard `getFullscreenWheelScrollLines?.() ?? "auto"` like the other fullscreen getters (2026-09-03 lifecycle seams); Finder file-path paste before image/text (`readClipboardFilePaths`, bash-mode quoting, control-character rejection, #10136); extension package warnings in `[Extension issues]` (`LoadExtensionsResult.warnings`, #9863); Anthropic thinking-drop notice shortened and de-duplicated against the previous response (`maybeShowThinkingDropNotice`, 13784598d2/4658534986); nested tool calls (`parentToolCallId`, made through `ctx.executeTool()`) are not rendered as separate rows (start and end skip them); boundary-committed entries (`entry_appended` custom_message display and boundary compaction re-render, 466db0fecd); loaded-extension crash-stack hint on fatal errors and uncaught exceptions (`findExtensionStackMatches` + `formatCrashExtensionHint`, 63787ee6ba). Fork preserved: `[s]` autocomplete tag for system-scoped resources (upstream untags other built-in extension commands), ask-user widgets and pending-question flows, goal/loop footers, account switching, herdr/session-control host, `/scoped-models`, gist `/share`, `/answer`, the notice-block family (`showNoticeBox`/`buildNoticeBox` for update, package-update, risky-model, high-reasoning, debug-log and diagnostic notices), fork chrome (`this.chrome.createWelcomeContent`, `APP_NAME` + `formatDisplayVersion` logo, startup tips), Copilot tool-limit notice once per session (`maybeShowAssistantDiagnostics`, now also delegating the live thinking-drop notice), fork uncaught-crash path (debug log, storage-write message, one-line summary), fork submit dispatch, image markers + in-memory pending images, clipboard error logging, `showSessionRenameInput`, fork `handleToolExecutionStart` working labels, fork compaction queue delivery. Not adopted: `/bug`, `reportBug`, the bug-report hint after errors, crash recording + `crashReportInstructions` + the startup crash notice (D-6); cache warming (`addCacheWarmingUsage`, cache-warm usage rows on replay, `/session` Cache Warming block, `onCacheWarmingModeChange`, D-5); the pi logo (`piLogoLines`, fork chrome keeps the brand header; `components/pi-logo.ts` removed, unused). Why: upstream v0.99.1 made every rendered string follow theme changes (system theme recolors when the terminal reports its colors), added virtual-model/nested-call/boundary events and several interactive fixes; the fork's UI surfaces are pinned by fork tests and consumed by omo. Why an extension could not handle it: InteractiveMode is the TUI host every extension renders into. Expected merge conflict zones: import block, header/tip construction in `init`, `showLoadedResources` section builders, `setupEditorSubmitHandler` dispatch table, `handleEvent` message_end/tool_execution_*/compaction_end branches, `maybeShowAssistantDiagnostics`, `handleFatalRuntimeError`/uncaught crash tail, `showSettingsSelector` config + callbacks, `showSessionSelector` loaders, `handleSessionCommand`, `/hotkeys` table.
- `packages/coding-agent/src/modes/interactive/session-share.ts` (deleted): `session-share.ts` stays deleted (Radius share rejected; gist `/share` kept); `bug-report.ts` (upstream-only) removed (D-6, Exclusion list).
- `packages/coding-agent/src/modes/interactive/theme/system-theme.ts`: resolved by L6a against upstream v0.99.1 (6a4af07d6): upstream constructs adopted, fork behavior kept.
- `packages/coding-agent/src/modes/interactive/theme/theme-controller.ts`: resolved by L6a against upstream v0.99.1 (6a4af07d6): upstream constructs adopted, fork behavior kept.
- `packages/coding-agent/src/modes/interactive/theme/theme.ts`: resolved by L6a against upstream v0.99.1 (6a4af07d6): upstream constructs adopted, fork behavior kept.
- `packages/coding-agent/src/modes/interactive/tui-renderer.ts`: `tui-renderer.ts`: fork `mouse` plus upstream `fullscreenWheelScrollLines`.
- `packages/coding-agent/src/modes/interactive/components/extension-selector.ts`: Silent rows read and accepted: export-html `template.css`/`template.js` (nested call records, toggle state), `extension-selector.ts` (description), `session-selector.ts` (progress/abort), `tree-selector.ts` (usage entries hidden, context_edit rows), `theme-json.ts` (`appearance`, compiled validator kept), `theme-schema.json`; tests `interactive-mode-compaction` (#9340), `interactive-tui` (wheel lines, file-path mock), `session-selector-path-delete`, `settings-selector` (system theme, wheel cycle), `streaming-render-debug.ts`, `tree-selector`, `utilities.ts`.
- `packages/coding-agent/src/modes/interactive/components/session-selector.ts`: Silent rows read and accepted: export-html `template.css`/`template.js` (nested call records, toggle state), `extension-selector.ts` (description), `session-selector.ts` (progress/abort), `tree-selector.ts` (usage entries hidden, context_edit rows), `theme-json.ts` (`appearance`, compiled validator kept), `theme-schema.json`; tests `interactive-mode-compaction` (#9340), `interactive-tui` (wheel lines, file-path mock), `session-selector-path-delete`, `settings-selector` (system theme, wheel cycle), `streaming-render-debug.ts`, `tree-selector`, `utilities.ts`.
- `packages/coding-agent/src/modes/interactive/components/tree-selector.ts`: Silent rows read and accepted: export-html `template.css`/`template.js` (nested call records, toggle state), `extension-selector.ts` (description), `session-selector.ts` (progress/abort), `tree-selector.ts` (usage entries hidden, context_edit rows), `theme-json.ts` (`appearance`, compiled validator kept), `theme-schema.json`; tests `interactive-mode-compaction` (#9340), `interactive-tui` (wheel lines, file-path mock), `session-selector-path-delete`, `settings-selector` (system theme, wheel cycle), `streaming-render-debug.ts`, `tree-selector`, `utilities.ts`.
- `packages/coding-agent/src/modes/interactive/theme/theme-json.ts`: Silent rows read and accepted: export-html `template.css`/`template.js` (nested call records, toggle state), `extension-selector.ts` (description), `session-selector.ts` (progress/abort), `tree-selector.ts` (usage entries hidden, context_edit rows), `theme-json.ts` (`appearance`, compiled validator kept), `theme-schema.json`; tests `interactive-mode-compaction` (#9340), `interactive-tui` (wheel lines, file-path mock), `session-selector-path-delete`, `settings-selector` (system theme, wheel cycle), `streaming-render-debug.ts`, `tree-selector`, `utilities.ts`.
- `packages/coding-agent/src/modes/interactive/theme/theme-schema.json`: Silent rows read and accepted: export-html `template.css`/`template.js` (nested call records, toggle state), `extension-selector.ts` (description), `session-selector.ts` (progress/abort), `tree-selector.ts` (usage entries hidden, context_edit rows), `theme-json.ts` (`appearance`, compiled validator kept), `theme-schema.json`; tests `interactive-mode-compaction` (#9340), `interactive-tui` (wheel lines, file-path mock), `session-selector-path-delete`, `settings-selector` (system theme, wheel cycle), `streaming-render-debug.ts`, `tree-selector`, `utilities.ts`.

### Why

Upstream v0.99.1 (6a4af07d6) changed these paths while the fork carries its own behavior; interactive mode adopts the upstream system theme, virtual-model footer and args display while keeping fork chrome; no /bug (plan D-14, D-6).

### Why an extension could not handle it

Interactive mode is the host UI that renders extensions.

### Expected merge conflict zones

Every path listed above conflicts again where upstream edits the hunks named in its line; the fork-kept constructs named there are the anchors to preserve.

## 2026-09-30 - The TUI warns once about a clamped explicit thinking level (senpi#2395)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: startup shows `session.startupThinkingClamp` as a warning, and a `thinking_level_clamped` session event shows the same warning.

### Why

- An explicit thinking level on a model not marked `reasoning: true` was clamped to off with no visible explanation (senpi#2395).

### Why an extension could not handle it

- The startup warning list and the session-event switch belong to `InteractiveMode`.

### Expected merge conflict zones

- `interactive-mode.ts`: the startup warning block after fallback-chain warnings, and the `high_reasoning_warning` case of the session event switch.

## 2026-09-30 - Ask-user navigation stays in range; a fully answered widget click submits (omo#9268)

### What changed

- `packages/coding-agent/src/modes/interactive/components/ask-user-question-state.ts`: `jumpToQuestion()` normalizes any requested index (negative, fractional, NaN, past the end) into the available question range before it becomes the active question.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: `clickPendingQuestion()` submits the draft when every question already has an answer, instead of expanding the overlay at index -1.
- `packages/coding-agent/src/modes/interactive/components/ask-user-async-widget.ts`: `buildAnsweredResponse()` builds that submission from the draft (a draft comment makes it `comment-submitted`, matching the overlay's submit rule).

### Why

- omo#9268 exposed an undefined-question dereference in the overlay. A stale or computed index must never leave the overlay without an active question, and a widget click with nothing left to answer must not navigate to a question that does not exist.

### Why an extension could not handle it

- The overlay's active index and the collapsed widget's click routing are host-owned interactive state; extensions only receive the final `QuestionResponse`.

### Expected merge conflict zones

- LOW: `jumpToQuestion()` in `ask-user-question-state.ts`, `clickPendingQuestion()` in `interactive-mode.ts`, and the response builders in `ask-user-async-widget.ts`.

## 2026-09-30 - Control endpoint: a question answer settles by the host's rule, so its comment reaches the model (senpi#2407)

### What changed

- `packages/coding-agent/src/modes/interactive/session-control-commands.ts`: `questionResponse` settles through `settledQuestionStatus` and `unansweredQuestionIds` (`../rpc/extension-ui-response.ts`, shared with the host bridge): a non-blank `comment` is `comment-submitted`, unanswered ids come from the pending request's questions, and a frame with neither answers nor a comment is refused `question_incomplete` with the question left pending. `TuiControlSurface` gains `pendingQuestion(requestId)` (the pending request's questions); `answerQuestion` looks the question up through it.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: `sessionControlContext` implements `pendingQuestion` from `pendingQuestions`.
- Tests: `test/suite/session-control-answer-parity.test.ts` (new): the same frames (text-only combined, with `confirmed`, comment-only, structured, structured + comment, short form, blank) answered on a host and on a terminal through the real `ask_user_question` tool deliver the identical model message. `test/suite/session-control-ui-response.test.ts`: the short-form comment answer now expects `comment-submitted` with the unanswered id. `test/helpers/session-control-fixture.ts`: the `questions` seam takes `pendingQuestion`.

### Why

senpi#2407: the terminal always built `status: "answered"` with `unanswered: []`, and the ask-user formatter prints a comment only for `comment-submitted`, so a comment-only answer (what a relaying client sends for a question) reached the model as an empty `[Answer to question <id>]` while the host delivered the text.

### Why an extension could not handle it

The endpoint's command surface is core.

### Expected merge conflict zones

- `answerQuestion` / `questionResponse` in `session-control-commands.ts`; `sessionControlContext` in `interactive-mode.ts`.

## 2026-09-29 - The revert notice says when a fallback could not serve (senpi#2376)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: the `⇄ Reverted to <to>` notice explains `<from> cannot serve right now (its account hit a billing or usage limit), so the session is back on the original model.` when the event carries `cause: "fallback-unusable"`; every other revert keeps "The original model is back after its cooldown lapsed."

### Why

- A return from a billing-dead fallback happens before the original's cooldown lapses, so the cooldown wording would misstate why the model changed.

### Why an extension could not handle it

- The fallback notices are rendered by the interactive event loop, not an extension.

### Expected merge conflict zones

- LOW: the `retry_fallback_reverted` case in `packages/coding-agent/src/modes/interactive/interactive-mode.ts`.

## 2026-09-29 - Control endpoint: `extension_ui_response` names the question in `uiRequestId` and replies under the frame `id`

### What changed

- `packages/coding-agent/src/modes/interactive/session-control-commands.ts`: `answerQuestion` reads the question id from `uiRequestId` (short form: `id`, through `answeredUiRequestId` in `../rpc/extension-ui-response.ts`) and answers success and refusals (`unknown_request`, `invalid_response`) under the frame's `id`, the same contract as a multi-session host.
- Tests: `test/suite/session-control-ui-response.test.ts` (new): a `uiRequestId` answer resolves once under the frame id, a replay and an unknown question are `unknown_request`, a malformed answer is `invalid_response` and leaves the question pending, the short form works as before. `test/helpers/session-control-fixture.ts`: optional `questions` surface seam.

### Why

senpi#2372: one reply contract on both endpoint kinds.

### Why an extension could not handle it

The endpoint's command surface is core.

### Expected merge conflict zones

- `answerQuestion` in `session-control-commands.ts`.

## 2026-09-29 - The TUI says when a turn was not saved to the session file

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: `handleEvent` handles the `transcript_write_failed` session event with one warning per run (`transcriptWriteNoticeShown`, reset on `agent_start`): `This turn was not saved to the session file (<code>); the model will not see it after the next prompt.` The code is the error's leading `EACCES`/`ENOSPC`-style code, else the sanitized error text.

### Why

- A refused turn stayed on screen unmarked while the next prompt no longer sends it to the model; a prompt-owned run showed only the raw `EACCES ... <session>.jsonl` error, so the screen and the model disagreed with no explanation.

### Why an extension could not handle it

- Extensions can subscribe to session events, but the chat's own error rendering for the failed prompt and the per-run notice belong to the interactive mode's event switch.

### Expected merge conflict zones

- LOW: one `case` next to `continuation_error` in `handleEvent`, one line in its `agent_start` case, and one field declaration.

## 2026-09-29 - Session control endpoint: a registered TUI serves a `tui` endpoint and wakes its inbox drain on edges

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: installs a `TuiSessionControlHost` on the session before every extension bind (`setControlEndpointHost`) and disposes the previous endpoint first; wraps the default editor's `onChange`/`onSubmit` after they are assigned (`attachEditor`) to feed the editor revision, `draft_cleared` and `submission` edges; disposes the endpoint before `runtimeHost.dispose()` on both shutdown paths; tells the host when async questions change (`refreshAsyncWidget`); renders a `session_control_delivery` custom message with the built-in remote-provenance renderer when no extension registered one. The composer hold (`attachment` for pending images, `draft` for non-blank text) is one private `composerHold()`. Nothing else in the TUI changes: extensions stay bound with `mode: "tui"`, the user follow-up handler, `editor.setText` and ^Z are untouched, and a TUI with no registrant creates no listener and no directory.
- `session-control-host.ts`, `session-control-endpoint.ts`, `session-control-lifecycle.ts`, `session-control-registry.ts`, `session-control-server.ts`, `session-control-commands.ts`, `session-control-feed.ts`, `session-control-wake.ts`, `components/remote-delivery-message.ts` (new, all under `packages/coding-agent/src/modes/interactive/`): the endpoint. Only the host is imported at startup; the endpoint loads on the first `pi.session.registerControlEndpoint` (never `multi-session-host.ts`, never `createRpcConnectionHandler`). Registration persists the session header, reaps dead `tui` endpoints (`gcHostEndpoints(agentDir, { kinds: ["tui"] })`), binds `<agentDir>/rpc/tui/t-<sha256(instance)[:16]>.sock` (dir 0700, socket and `.secret` 0600; a path over 103 bytes moves to `/tmp/senpi-rpc-<sha256(agentDir)[:8]>/tui/`, used only when it is a private directory of this user), and only then registers under the ensure lock: generation record first, `endpoint.json` (`endpoint_kind: "tui"`) last. A failed step undoes the earlier ones and shows one notice `control endpoint unavailable: <reason>`. Every connection must pass the 32-byte secret handshake (`authenticateSocket`) before any JSONL; the commands are `get_protocol_info` (answers the recorded `instanceId`, capability `tui_control`), `list_sessions`, `get_state` (plus `turn_epoch`, `blocking_question`, `compacting`, `editor_has_draft`, `state_version`), `get_messages`, `set_session_name`, `subscribe` (cursor feed of state/report/question/completion events), `wake` (runs the drain and answers its admissions) and `extension_ui_response` (only for a question the session asked); everything else, `prompt`/`steer`/`follow_up` included, answers `unsupported`. The drain runs on edges only - idle, submission, draft cleared, command, inbox (`fs.watch` on the registrant's inbox directory through the shared watch worker), emitted, continue (a persistent SIGCONT listener deferred past the terminal restore) - one pass at a time, with edges during a pass coalesced into exactly one more pass. Clean exit stops the edges, closes the socket, removes a header-only session file only when the registrant's `isSessionReferenced()` answers false, and removes the endpoint directory; an undisposed exit removes it synchronously on `exit`.

- Submitted input holds admission (`hold_reason: "draft"`) until the runtime has taken it: every editor submission opens a ticket in `TuiSessionControlHost`. A branch whose input still has to reach the runtime claims it (`claimHandoff()`): text buffered for the main loop (released by the loop on that input's prompt disposition via `buildMainLoopPromptOptions`, or in its `finally`) and a steer into a running turn (released on its disposition or when its prompt ends). Every other submission - a `!` command, a slash command - is released as soon as the handler's synchronous part returns, i.e. once dispatched, so a long-running `!` command (a dev server, `tail -f`) never holds deliveries. Input held in the compaction queue holds too (`noteBufferedElsewhere`, fed from `updatePendingMessagesDisplay`). No turn start releases anything, so neither the previous input's turn nor an extension-started turn lets a delivery overtake buffered input. The `submission` edge fires when the last ticket is released. The wrapper forwards every `onSubmit` argument, not only the text. The control context moved to `sessionControlContext()` so `test/interactive-session-control-submission-order.test.ts` drives it, with the real submit handler and prompt options.

### Why

Session gateway (IS-4, IS-6, IS-7): a standalone OmO TUI must be listed and reachable by other sessions through the one endpoint registry, and a delivery must reach it while it is idle, without a sender alive and without touching what the user is typing.

### Why an extension could not handle it

The editor's draft state, the TUI's submission and clear edges, its question overlay and the terminal's stop/continue cycle are interactive-mode internals; an extension can register the endpoint but cannot observe or serve them.

### Expected merge conflict zones

- `interactive-mode.ts`: `InteractiveUserInput`, the `pendingImages` field block, the main loop's `finally`, `buildMainLoopPromptOptions`' `promptDisposition`, the streaming-steer and normal-submission branches of the submit handler (`claimHandoff`), `setupEditorSubmitHandler()` call site, the top of `bindCurrentSessionExtensions`, both `runtimeHost.dispose()` sites in `shutdown`, `sessionControlContext`/`composerHold` before `refreshAsyncWidget`, the head of `updatePendingMessagesDisplay`, and the `case "custom"` renderer lookup.

## 2026-09-29 - Startup warns about config edited in ~/.pi/agent after its copy (omo#9173)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: `InteractiveModeOptions.legacyPiEditNotice` is shown with `showWarning` next to the migrated-credentials warning.

### Why

- Config edited in `~/.pi/agent` after the copy to the agent dir had no effect and no explanation (omo#9173).

### Why an extension could not handle it

- The notice comes from pre-extension startup state and belongs with the other startup warnings.

### Expected merge conflict zones

- LOW: the startup-warnings block that destructures `this.options`.

## 2026-09-29 - `/model` lists ambient-only providers after configured ones (senpi#2327)

### What changed

- `packages/coding-agent/src/modes/interactive/components/model-selector.ts`: `sortModels` orders models from providers the user configured before providers available only through ambient cloud credentials (`createAmbientProviderCheck`), after the current model and favorites and before the provider/id order.

### Why

- Bedrock's many models sorted second by provider name, so AWS keys in the environment made them lead `/model` for users who never set Bedrock up (senpi#2327).

### Why an extension could not handle it

- Sorting is private to `ModelSelectorComponent`.

### Expected merge conflict zones

- LOW: the comparator in `sortModels`.

## 2026-09-29 - Confirm an unknown command with a second Enter (senpi#2348)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: the submit handler and `handleFollowUp` send a submission as text (`unknownCommandAsText`) when it repeats the text of the last refused unknown command; the default editor's `onEscape` forgets that refusal first. `reportUnknownCommandRejection` adds a line built from the configured `tui.input.submit` and `app.interrupt` keys ("Enter again sends it as a message; Esc keeps editing.", without the Esc part while the agent is streaming, where Esc interrupts).
- `packages/coding-agent/src/modes/interactive/unknown-command-feedback.ts` (fork-only): `reportUnknownCommand` arms the confirmation through the target's `armConfirmation` and appends the confirm hint. The refused text lives in the plain `refusedUnknownCommandText` field, read and cleared by the static `confirmsRefusedUnknownCommand`, so handlers driven on hand-built test contexts keep working.

### Why

- The leading-space escape was hidden in prose and the refusal repeated on every Enter; a deliberate second Enter on the unchanged text is the discoverable way to send `/foo` prose.

### Why an extension could not handle it

- The submit handler, editor restore and Esc handling are interactive-mode internals.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: `setupEditorSubmitHandler` (the `unknownCommandAsText` line), `setupKeyHandlers` (`onEscape` first line), `handleFollowUp`, `reportUnknownCommandRejection`.

## 2026-09-29 - The TUI always runs on its own local session; the shared-host proxy is gone (senpi#2328)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-host-runtime.ts` and `packages/coding-agent/src/modes/interactive/interactive-host-attach.ts`: deleted. `main.ts` stopped constructing the proxy in the previous change, so the `InteractiveSession` union, the RPC session proxy, the reconnect loop, the fallback/reconnect warnings and `HOST_CLIENT_CAPABILITIES` had no caller left.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: the `session` getter is typed `AgentSession` again. Removed the proxy-only branches: the `HostUiRequest`/`HostUiResponse`/`HostUiCapableRuntime` types, the `setHostUiHandler` hook in the constructor, `handleHostUiRequest` with its `linesFactory` helper and `custom_unsupported` notice, the `setClientInfo` calls after `ui.start()` and in the SIGWINCH handler (the handler itself existed only for that call), the `questionArrivalEpochMs` field and the `notifyArrival` question option (only a replayed host question set it, so the arrival bell now always follows the `askUser.bell` setting, which is what a local question already did). `cycleThinkingLevel`, `getAvailableThinkingLevels`, `getSessionStats` and `getUserMessagesForForking` are read synchronously again, as the local `AgentSession` returns them; this reverts the widening recorded in the `/thinking` entry below ("awaited at every new call site because `InteractiveSession` widens it"). The enclosing methods keep their `async` signatures, so callers and the error routing of `app.thinking.cycle` are unchanged. The `thinking_level_changed` status line, the `model_changed` delegation reset, the TUI `bindExtensions({ mode: "tui" })`, the user follow-up handler and ^Z handling are untouched.
- The proxy's `unknownCommandAsText` forwarding (senpi#2258) goes with `interactive-host-runtime.ts`. Every local submit path in `interactive-mode.ts` already hands the flag straight to `AgentSession.prompt`, and extension `sendUserMessage` on the local session prompts with `source: "extension"`, which the unknown-command check exempts, so the proxy's forced opt-out for extension input has no local counterpart to keep.
- `packages/coding-agent/src/modes/interactive/components/footer.ts`, `packages/coding-agent/src/modes/interactive/grok/chrome.ts`, `packages/coding-agent/src/modes/interactive/grok/footer.ts`: take and store `AgentSession` instead of `InteractiveSession`.

### Why

- Interactive launches no longer join a shared RPC host (senpi#2328), so every proxy branch was unreachable code that still shaped the TUI's types and call sites.

### Why an extension could not handle it

- The removed code is the TUI's own session seam and its host-driven UI path; extensions sit behind it.

### Expected merge conflict zones

- MEDIUM: the `session` getter and constructor of `InteractiveMode`, the extension-UI block around `withBlockedHostDialog`, `registerSignalHandlers`, and the `showQuestionOverlay`/`showAsyncQuestion` bell lines in `interactive-mode.ts`.
- LOW: the session type import and fields of `components/footer.ts`, `grok/chrome.ts`, `grok/footer.ts`.

## 2026-09-29 - The model-fallback notice says which model or account hit its usage limit (omo#8296)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: the `retry_fallback_applied` notice body uses `usageLimitCause` when the event carries `limit`: "<from> hit its usage limit; the turn continues on <to>." or "the <provider> account hit its usage limit, so its other models were skipped; the turn continues on <to>." Other switches keep "Retry switched models (<reason>)".

### Why

- A user whose model ran out of its usage limit saw a generic "(transient)" switch and could not tell a limit from a network blip (omo#8296).

### Why an extension could not handle it

- The notice is rendered by the interactive mode's own event switch.

### Expected merge conflict zones

- LOW: the `retry_fallback_applied` case in `interactive-mode.ts`.

## 2026-09-28 - Show Copilot tool-limit omissions once per session (senpi#2298)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: a successful assistant message carrying the `github_copilot_tool_limit` diagnostic shows its redaction-safe message as a warning once for the current session, independently of the cache-miss-notice setting. Transcript rebuilds re-arm the notice so the rebuilt chat still contains it, while later turns in the same rendered session do not repeat it.

### Why

- The AI adapter diagnostic was persisted in session JSONL and available to RPC consumers, but the interactive TUI ignored it. A request could succeed after omitting excess Copilot tools and the user would have no visible indication that some definitions were unavailable to the model.

### Why an extension could not handle it

- The diagnostic is attached inside the provider adapter after extension payload hooks run, and the completed assistant message is rendered by `InteractiveMode`; no extension hook owns that host diagnostic-to-transcript presentation.

### Expected merge conflict zones

- LOW: the field block beside other session-scoped warning guards, the start of `renderSessionItems`, and `maybeShowAssistantDiagnostics` in `interactive-mode.ts`.

## 2026-09-28 - No runtime error output on the TUI screen (#2284)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: `registerSignalHandlers` prepends an `unhandledRejection` listener (removed with the other signal cleanups) that routes to the new private `unhandledRejection`: a dead-terminal reason takes the silent `emergencyTerminalExit`, a recoverable Inspector VM import keeps its warning, and everything else is appended to the debug log (`appendUnhandledRejectionLog`, redacted) and never printed; the session keeps running. `init` awaits `prepareInteractiveStderrCapture()` before the first `takeOverInteractiveStderr()`. `uncaughtCrash` prints `exiting due to uncaughtException: <name>: <message>` on one line plus `Details: <debug log path>` after the terminal is restored; the whole error is printed only when the debug-log write failed.
- `packages/coding-agent/src/modes/interactive/interactive-stderr-guard.ts` and the new `stderr-fd-redirect.ts` (fork-only): on Bun (darwin/linux) the takeover also points fd 2 at the debug log with `dup`/`dup2` through `bun:ffi`, and `restoreInteractiveStderr` puts the original descriptor back first, so every existing restore path (quit, crash, SIGTERM/SIGHUP shutdown, ctrl+z suspend, external editor) returns the terminal's fd 2. Node and Windows keep the JS-level guard only.

### Why

- Under Bun an unhandled rejection never reaches `uncaughtException`: Bun printed its native source-preview dump onto the terminal the TUI was drawing on (the reported `Timeout waiting for response to prompt` spray, repeated, inside the input box) and nothing reached the debug log. Worker-thread `console.*` and children spawned with `stderr: "inherit"` wrote fd 2 directly and bypassed the JS guard the same way.

### Why an extension could not handle it

- Process-level error routing and terminal ownership belong to `InteractiveMode`; an extension cannot own fd 2 or register the TUI's crash policy, and the output being hidden often comes from extensions themselves.

### Expected merge conflict zones

- LOW: the `uncaughtException` listener block in `registerSignalHandlers`, the tail of `uncaughtCrash`, and the `takeOverInteractiveStderr()` try block in `init`.

## 2026-09-28 - /sessions alias and thinking/resume guidance (#1437)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: `setupEditorSubmitHandler` opens the session selector for `/sessions` exactly as for `/resume`.
- `packages/coding-agent/src/modes/interactive/help-content.ts`: the `/help` getting-started primer names `/thinking <level>` with the live `app.thinking.cycle` key, and `/resume` (or `/sessions`).
- `packages/coding-agent/src/modes/interactive/tips/catalog/model-tips.ts`: the `thinking-level` tip names `/thinking <level>` and `/thinking` beside the cycle key; a new `efforts-command` tip, gated by `requiresCommand: "efforts"`, names `/efforts <level>`.
- `packages/coding-agent/src/modes/interactive/tips/catalog/session-tips.ts`: the `continue-session` tip names `/resume` and `/sessions` in the TUI beside `-r` and `-c` from the shell.

### Why

- A new user could not find how to change the thinking level (`/thinking` was broken, #1437) or how to reopen a session: they looked for `/sessions`, the OpenCode name, and `/help` and the tips never mentioned either path.

### Why an extension could not handle it

- `/sessions` has to open the interactive session selector, which only `InteractiveMode` owns, and builtin names are matched in the submit handler before extension commands; the `/help` primer and the tip catalog are host-owned with no extension registration API.

### Expected merge conflict zones

- LOW: the `/resume` branch in `setupEditorSubmitHandler`, `buildGettingStarted` in `help-content.ts`, and the two tip catalog files.

## 2026-09-28 - Picker argument hints and unknown-command feedback (omo #9042)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: `createBaseAutocompleteProvider` passes `argumentHint` for extension commands and `skill:<name>` rows, so their picker rows wait for arguments. The submit handler reads `EditorSubmitDetails.rawText`: a `/...` submission typed after leading whitespace carries `unknownCommandAsText` through the steering, idle (`InteractiveUserInput` and `buildMainLoopPromptOptions`), Alt+Enter follow-up, and compaction-queue paths (`queueCompactionSubmission`/`queueCompactionMessage` gain an optional trailing flag). An `UnknownCommandError` from any of those paths goes to the new `reportUnknownCommandRejection`: the optimistic echo is dropped, the text returns to an empty editor, and the message is shown as a warning instead of an error. A rejected first compaction-queue prompt is consumed as `handled` so it cannot block the messages behind it.
- `packages/coding-agent/src/modes/interactive/unknown-command-feedback.ts` (fork-only): `submitsCommandAsText` and `reportUnknownCommand`.
- `packages/coding-agent/src/modes/interactive/compaction-queue-transfer.ts` (fork-only): `CompactionQueuedMessage.unknownCommandAsText`.
- `packages/coding-agent/src/modes/interactive/interactive-host-runtime.ts` (fork-only): the shared-host proxy forwards `unknownCommandAsText`, and extension `sendUserMessage` over the proxy sets it because the host sees that input as `rpc`.

### Why

- An unknown command must not reach the model, and the user needs the text back to fix it, plus a way to send `/...` prose on purpose.

### Why an extension could not handle it

- The submit handler, optimistic echo, and editor restore are interactive-mode internals.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: `createBaseAutocompleteProvider` extension/skill rows, `setupEditorSubmitHandler`, the main-loop catch in `run()`, `buildMainLoopPromptOptions`, `handleFollowUp`, `queueCompactionMessage`/`queueCompactionSubmission`, and the compaction transfer `deliverFirstPrompt`.

## 2026-09-28 - Restore the /thinking interactive dispatch (#1437)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: `setupEditorSubmitHandler` dispatches `/thinking` and `/thinking <level>` to `handleThinkingCommand` (next to the `/model` branch); `createBaseAutocompleteProvider` gives the `thinking` builtin argument completions from `session.getAvailableThinkingLevels()`; `handleThinkingCommand`, `selectThinkingLevel`, and `showThinkingSelector` are restored from upstream 496185f6 with the `ThinkingSelectorComponent` import.
- Upstream's single `session.setThinkingLevel(level, { persist })` is mapped onto the fork's split setters: `/thinking <level>` and Enter in the selector call `setSessionThinkingLevel` (session scope), Ctrl+S in the selector calls `setThinkingLevel`, which records the per-model level and refreshes `defaultThinkingLevel`, the same persistence as Shift+Tab and `/efforts <level>`.
- `getAvailableThinkingLevels()` is awaited at every new call site because `InteractiveSession` widens it for the shared-host proxy; `getArgumentCompletions` is async for the same reason.

### Why

- The sync merge 463279038 (#1119) kept upstream's `thinking` entry in `BUILTIN_SLASH_COMMANDS` but resolved `interactive-mode.ts` without the handler, so autocomplete and `/help` advertised a command that fell through to `session.prompt()` and reached the model as a user message (#1437).

### Why an extension could not handle it

- Builtin slash commands are matched by literal text inside the interactive submit handler before extension commands are consulted; an extension cannot register `thinking` because the name is reserved by `BUILTIN_SLASH_COMMANDS` (`reasoning-commands.test.ts` pins that no alias is registered).

### Expected merge conflict zones

- MEDIUM: the `/model`..`/export` run of `if (text === ...)` branches in `setupEditorSubmitHandler`, the `loginCommand`/`thinkingCommand` completion blocks in `createBaseAutocompleteProvider`, and the three methods above `handleModelCommand`. Upstream carries the same methods with a `{ persist }` setter option; keep the fork's split-setter mapping on merge.

## 2026-09-27 - /session shows what failed provider requests cost (senpi#2198)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: `handleSessionCommand` appends `formatSessionFailureInfo(stats.failures)` (`session-failure-info.ts`, new) after the Cost block: failed requests with their errored/aborted split and share, time in failed requests, and retries after a failure (same user turn) that had no cache hit, with their uncached input tokens. Nothing is shown for a session without a failed request or a host that predates the report.

### Why

- Provider failures had no visible cost in the session stats surface (senpi#2198).

### Why an extension could not handle it

- `/session` is a builtin interactive command rendered inside `InteractiveMode`.

### Expected merge conflict zones

- LOW: the end of the Cost block in `handleSessionCommand` and one import in `interactive-mode.ts`.

## 2026-09-28 - The /computer introduction tip says computer use is experimental (senpi#2315)

### What changed

- `packages/coding-agent/src/modes/interactive/tips/catalog/computer-tips.ts`: the `computer.what-it-is` tip now opens with "Experimental:". The ids, the `requiresCommand: "computer"` gating and the other four tips are unchanged.

### Why

- OmO 5.1.0 ships computer use as experimental support, and every user-facing surface has to say so.

### Why an extension could not handle it

- The tip catalog is host-owned and has no extension registration API (see the senpi#2204 entry).

### Expected merge conflict zones

- LOW: the `computer.what-it-is` render string in `computer-tips.ts`.

## 2026-09-27 - Tips for the /computer command (senpi#2204)

### What changed

- `packages/coding-agent/src/modes/interactive/tips/catalog/computer-tips.ts` (new) adds five tips gated by `requiresCommand: "computer"`: what computer use does, the stop chord and user-only `/computer resume` (the chord is chosen by `process.platform`), background input, `--permission computer:exec=deny` for look-only work, and the macOS Screen Recording and Accessibility grants.
- `packages/coding-agent/src/modes/interactive/tips/registry.ts` appends `COMPUTER_TIPS` after `DAG_TIPS`.

### Why

- The `/computer` command comes from OmO's computer-use extension component; its users need the stop chord and permission facts where they already look, like the `/facts` and `/dag` tips.

### Why an extension could not handle it

- The tip catalog is host-owned and has no extension registration API; commands from extensions reach it only through `requiresCommand` gating, which keeps these tips invisible where `/computer` is not registered.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/interactive/tips/registry.ts`: the import list and the `TIP_DEFINITIONS` spread order.

## 2026-09-27 - /resume offers to move a moved repository's session here (senpi#2184)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: `showSessionSelector` loads the current-folder scope through `currentScopeSessions` (this project's sessions plus the moved sessions of its repository) and the all scope through `allScopeSessions` (moved ones marked), and resolves a pick through `chooseResumePath` (`resume-rebind.ts`, new): a session of this repository recorded at another path gets the #2181 rebind question in a Yes/No dialog, a failure (for example another process still holding the session) is shown as an error and the current session stays.
- `packages/coding-agent/src/modes/interactive/components/session-selector.ts`: a row with `session.moved` shows `moved from <old path>` on the right in every scope.

### Why

- Picking a moved repository's session from `/resume` either switched to a vanished cwd or offered a one-off "continue in current cwd" that was never persisted, and the session was invisible in the default current-folder view (senpi#2184).

### Why an extension could not handle it

- The session selector and its loaders are built inside `InteractiveMode`; no extension hook sits between a selector pick and the runtime switch.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: the two loaders and the `onSelect` callback in `showSessionSelector`, and one import.
- `packages/coding-agent/src/modes/interactive/components/session-selector.ts`: the `rightPart` cwd block, the `spacing` / `styledRight` computation in the session row render.

## 2026-09-26 - Run on Bun when installed and tell Node.js users once how to switch (senpi#2157)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: `init()` calls `maybeShowRuntimeNotice` right after the risky-model and subscription-auth startup warnings, rendering through `showNoticeBox`.
- `packages/coding-agent/src/modes/interactive/runtime-notice.ts` (new, pure): `runtimeNoticeSkipReason` hides the notice on Bun, for a user Node pin (`SENPI_RUNTIME=node`; under `OMO_NATIVE=1` only `OMO_RUNTIME=node`, because the OmO Native launcher always forwards its own runtime as `SENPI_RUNTIME`), for an inherited `--inspect*` option, for `*_SKIP_RUNTIME_NOTICE`, and when the engine version was already shown. `buildRuntimeNotice` names the Bun step (install, or `bun upgrade` below 1.4.0) and a clean reinstall (`npm uninstall -g` / `pnpm remove -g` / `yarn global remove`, then `bun add -g`) for senpi or for the brand's update package and dist-tag.
- `packages/coding-agent/src/modes/interactive/runtime-notice-presenter.ts` (new): reads the process facts, probes Bun through `bun-runtime.ts`, and records the shown engine version in `<agentDir>/runtime-notice.json`.

### Why

- A process still on Node.js after the launchers' Bun hand-off is one the user can fix (no Bun, an old Bun, or a Node-managed install), and nothing told them.

### Why an extension could not handle it

- The notice must appear with the other host-owned startup warnings, before extensions bind and for every brand of the engine.

### Expected merge conflict zones

- LOW: one import beside `risky-main-model-warning.ts` and one call after `maybeWarnAboutAnthropicSubscriptionAuth()` in `init()`.

## 2026-09-24 - Show switch timings on "Resumed session" under TIMING (senpi#2087)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: `rebindCurrentSession` marks `render` and `bindExtensions` in the `switch` timing namespace; `handleResumeSession` appends `| switch timings: ...` to the "Resumed session" status when `formatTimings("switch")` has entries, mirroring the reload status line. Without `TIMING=1` the status text is unchanged.

### Why

- Extension `session_start` handlers and the transcript render are the largest slices of a resume switch; the status line makes the breakdown visible on the real surface without a debugger.

### Why an extension could not handle it

- The rebind sequence and the status line are host-owned.

### Expected merge conflict zones

- LOW: two marks in `rebindCurrentSession` and the status call in `handleResumeSession`.

## 2026-09-24 - Keep /resume search and tree rebuilds off the per-keystroke path (senpi#2087)

### What changed

- `packages/coding-agent/src/modes/interactive/components/session-selector-search.ts`: each `SessionInfo`'s search text (`id name allMessagesText cwd`) is built once and kept in a module `WeakMap` keyed by the row object, together with its lower-cased form and, on the first phrase token, its whitespace-normalized form. Query tokens are lower-cased or normalized once per `filterAndSortSessions` call, and fuzzy tokens go through pi-tui `fuzzyMatchLower` against the cached lower-cased text. Regex, fuzzy and phrase results, scores and ordering are unchanged; `matchSession` keeps its signature.
- `packages/coding-agent/src/modes/interactive/components/session-selector-tree.ts` (new): `buildSessionTree` / `flattenSessionTree` and their node types moved out of `session-selector.ts`. `buildSessionTree` takes a `CanonicalPathResolver`; `createCanonicalPathResolver()` memoizes `canonicalizePath` per path.
- `packages/coding-agent/src/modes/interactive/components/session-selector.ts`: `SessionList` creates one resolver in its constructor and a fresh one in `setSessions`, and uses it for tree rebuilds and `isCurrentSessionPath`, which runs for every rendered row on every frame.
- Tests: `test/session-selector-search.test.ts` (mixed-case fuzzy tokens; a new row object for the same session is searched by its own text), `test/session-selector-tree.test.ts` (new; the resolver answers exactly what `canonicalizePath` answers), `test/session-selector-path-delete.test.ts` (a replaced session list re-resolves a retargeted symlink alias).

### Why

- With about 1,100 sessions whose transcript text totals tens of MB, every keystroke rebuilt and lower-cased the whole search text once per token: 75-150 ms per fuzzy query, 240-350 ms per quoted phrase, all synchronous inside `handleInput`. Every threaded rebuild also ran `realpathSync.native` twice per session (about 20 ms).

### Why an extension could not handle it

- The `/resume` picker's filtering and tree construction are private to the built-in session selector component. No extension hook reaches them.

### Expected merge conflict zones

- `session-selector-search.ts`: `getSessionSearchText`, `matchSession` and the two scoring loops in `filterAndSortSessions`.
- `session-selector.ts`: the imports, the removed tree block ahead of `class SessionList`, the `SessionList` constructor, `setSessions`, `filterSessions` and `isCurrentSessionPath`. Upstream edits to `buildSessionTree` / `flattenSessionTree` now land in `session-selector-tree.ts`.

## 2026-09-24 - Label skill-directory reads by skill in the exploration group (senpi#2082)

### What changed

- `packages/coding-agent/src/modes/interactive/components/exploration-call.ts`: a grouped `read` of a file inside a skill directory is labeled `<skill>/<path inside the skill>` via `getSkillReadPath` (`core/tools/renderers/skill-read-path.ts`) instead of its basename; other reads keep the basename.
- `packages/coding-agent/test/suite/exploration-semantic-reads.test.ts`: a skill reference outside the cwd shows `Read a.ts, demo/references/guide.md, loose.md` in one group and `read demo/references/guide.md` when expanded; a session running inside the skill directory keeps `Read guide.md` / `read references/guide.md`.

### Why

- A skill reference collapsed to its bare file name in the `Explored` cell, so the user could not tell which skill it came from.

### Why an extension could not handle it

- Exploration labels are computed by the interactive projection from the built-in read renderer's args; an extension has no hook into the group's label.

### Expected merge conflict zones

- The `read` branch of `explorationCall` in `exploration-call.ts`.

## 2026-09-23 - Render a resolved tool-call name as the resolved tool (senpi#2064)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: `createToolExecutionComponent` maps the requested name through `session.resolveToolCallName` before choosing the renderer. Every card path (streaming tool call, `tool_execution_start`, late `tool_execution_end`, and `replayAssistantTools`) goes through it, so a `mcp__<id>__Read` call renders, groups and replays as `read`.
- `packages/coding-agent/test/suite/regressions/issue-2064-tool-name-correction-invisible.test.ts` (new): a real session runs a faux `mcp__686f__Read` call; the start event names `read`, the tool result keeps the notice as model-only text, and both the live and replayed transcripts show `Read sample.ts` with no `mcp__686f__` or `auto-corrected` text, collapsed or expanded.

### Why

- The card used the requested name, which has no renderer: the user saw the raw JSON arguments under `mcp__686f__Edit` and the correction notice, even though the call ran as `edit`.

### Why an extension could not handle it

- Card construction and renderer choice are owned by the interactive transcript.

### Expected merge conflict zones

- LOW: the head of `createToolExecutionComponent`.

## 2026-09-23 - Keep skill and memory reads out of the exploration group (senpi#2060)

### What changed

- `packages/coding-agent/src/modes/interactive/components/exploration-call.ts`: `explorationCall` asks `getCompactReadClassification` (exported from `core/tools/renderers/read.ts`) about a `read` before grouping it; a `skill` or `memory` classification returns no exploration call, so the card renders on its own and ends the open group. `docs` and `resource` reads still group.
- `packages/coding-agent/test/suite/exploration-semantic-reads.test.ts` (new): a skill read splits the group and shows `[skill] <name>`; two skills show both names with no `Explored` cell; a registered memory classifier keeps `✦ Recalled <label>`; `AGENTS.md` stays grouped; live and replay text match.

### Why

- Since senpi#2042 every built-in `read` joined the `Explored` cell, including skill loads and memory recalls, which collapsed to `Read SKILL.md` and deduplicated several skills into one line. The compact `[skill]` / `✦ Recalled` cards predate the cell and carry the information the cell drops.

### Why an extension could not handle it

- Group membership is decided by the interactive projection; an extension only registers a classifier and has no view of the transcript's sibling cards.

### Expected merge conflict zones

- The `read` branch of `explorationCall` in `exploration-call.ts`.

## 2026-09-23 - Fold project-rules notices into the exploration group of their call (senpi#2057)

### What changed

- `packages/coding-agent/src/modes/interactive/components/exploration-transcript-container.ts`: a `rule-activation` card of kind `project-rules` whose `toolCallId` belongs to a call in the open group joins the group instead of closing it.
- `packages/coding-agent/src/modes/interactive/components/exploration-group.ts`: `setMembers` takes the absorbed rule paths; the collapsed cell adds `Applied N project rules` (distinct paths). Expanding shows the original cards.
- `packages/coding-agent/src/modes/interactive/components/exploration-rules.ts` (new): `projectRulesOfCall`.

### Why

- One run of reads split into several `Explored` cells with `Project rules` cards between them whenever a read matched a rule.

### Why an extension could not handle it

- The exploration projection is interactive-mode code; entry renderers cannot see sibling cards.

### Expected merge conflict zones

- The projection loop in `exploration-transcript-container.ts` and `setMembers`/`render` in `exploration-group.ts`.

## 2026-09-23 - Replace the previous custom-entry card in place when its renderer asks (senpi#2051)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: `addCustomEntryToChat` asks `getEntryRendererOptions` for the entry type and, when `replacedEntryCardIndex` reports a match, swaps the previous card instead of appending. The streaming insertion point is unchanged. Live `entry_appended` and `renderSessionItems` replay share the path.
- `packages/coding-agent/src/modes/interactive/components/custom-entry.ts`: `CustomEntryComponent.customEntry` getter and the exported `replacedEntryCardIndex(children, insertIndex, entry, options)` helper (only the child directly before the insertion point, same custom type, `replaces` accepts the pair).

### Why

- One Goal wait rendered as a stack of cache-warm cards (scheduled, reload re-arm, wake). The goal extension now opts into in-place replacement through the `replaces` renderer option.

### Why an extension could not handle it

- The transcript container and its insertion logic belong to interactive mode.

### Expected merge conflict zones

- `addCustomEntryToChat` in `interactive-mode.ts` (the streaming splice block) and the bottom of `custom-entry.ts`.

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

## 2026-09-30 - Keep progressive transcript hydration watermark private

### What changed

- `ProgressiveTranscriptContainer` now warms deferred transcript children behind a private cache watermark while retaining the initially painted tail boundary for every live render.
- Once warming completes, the fully cached history is published in one completion repaint rather than in geometry-changing chunks.

### Why

- A live assistant or tool render could previously expose each newly warmed chunk above the painted tail, visibly moving resumed transcripts while the user watched.

### Verification

- The progressive transcript container regression test appends a live child after exactly one warm macrotask and verifies that the first painted component remains unchanged.

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


## 2026-09-23 — Filter model-only text at the tool-renderer boundary

### What changed

`packages/coding-agent/src/modes/interactive/components/tool-execution.ts`: Filter marked parts in createRenderState only, before both custom and built-in renderers receive content. Retain the original stored result and all exploration hooks.

### Why

Custom renderers and fallback text joins must observe the same visibility contract without changing session persistence.

### Why an extension could not handle it

The interactive component controls the common render-state boundary for every tool definition.

### Expected merge conflict zones

The result field of createRenderState; exploration-container hooks belong to the sibling lane.

- Covered production paths: `packages/coding-agent/src/modes/interactive/components/tool-execution.ts`.

## 2026-09-28 - A bare /skill namespace never reaches the model (senpi#2249)

### What changed

`packages/coding-agent/src/modes/interactive/interactive-mode.ts`: the Enter submit handler and the Alt+Enter follow-up path treat a submitted `/skill` or `/skill:` as the skill namespace: the editor is reset to `/skill:` and `openAutocomplete()` lists the skills, or a warning explains that no skill is loaded or skill commands are disabled. Nothing is sent to `session.prompt`.

### Why

Users told to "type /skill: and pick a skill" submitted `/skill:` itself, and it reached the model as a user message.

### Why an extension could not handle it

An extension `input` handler runs inside `AgentSession.prompt`, after the TUI has already cleared the editor; only the submit handler can keep the user in the picker.

### Expected merge conflict zones

- LOW: the `isBareSkillNamespace` checks just before the `isExtensionCommand` branch of `setupEditorSubmitHandler` and at the top of `handleFollowUp`, and the new `openSkillPickerForBareNamespace` method beside `isExtensionCommand` in `packages/coding-agent/src/modes/interactive/interactive-mode.ts`.

- Covered production paths: `packages/coding-agent/src/modes/interactive/interactive-mode.ts`.

## 2026-10-02 - Upstream logo animation and Radius login not taken (upstream v1.0.0 sync)

### What changed

- `packages/coding-agent/src/modes/interactive/components/pi-logo-animation.lazy.ts`
- `packages/coding-agent/src/modes/interactive/components/pi-logo-animation.ts`
- `packages/coding-agent/src/modes/interactive/components/radius-login-selector.ts`

None of these upstream files are added to the fork.

### Why

The logo animation is upstream branding; the fork keeps its own header and branding. Radius sign-in is excluded from the fork on record (`core/radius.ts`).

### Why an extension could not handle it

Branding and the `/login` provider list are owned by the interactive mode and the excluded provider, not an extension.

### Expected merge conflict zones

Upstream changes to the startup header and the `/login` selector; keep the fork header and omit Radius.

## Adopted upstream v1.0.0 interactive mode rendering (2026-10-02)

### What changed

- `packages/coding-agent/src/modes/interactive/components/settings-selector.ts`
- `packages/coding-agent/src/modes/interactive/components/user-message.ts`
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- `packages/coding-agent/src/modes/interactive/theme/system-theme.ts`

Upstream interactive-mode fixes are kept: one copy of each rendered user-message line and pastel system-theme chroma, with the fork's tuiMode `regular` default preserved (D-5).

### Why

These are upstream rendering improvements that do not break fork behaviour; the fork's header and tuiMode defaults stay.

### Why an extension could not handle it

Interactive-mode components and theme are rendering internals below the extension API.

### Expected merge conflict zones

Upstream edits to interactive-mode components at the next sync.

## 2026-10-03 - Rate-limit (429) and 5xx errors take the quiet provider-error path (senpi#2652)

### What changed

- `packages/coding-agent/src/modes/interactive/provider-error-presentation.ts`: adds `isRetryableProviderError`, a presentation classifier that is true for any transient provider failure (network drop, 429 rate-limit, or 5xx) by delegating to the shared `isRetryableErrorMessage` classifier in `@earendil-works/pi-ai`, and false for hard auth/quota/billing failures.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: the retry-event paths (mid-retry `retrying`, fallback-exhausted `finish`, summarization retry, the retry-status indicator's trouble variant) now use `isRetryableProviderError` instead of the network-only `isNetworkProviderError`, so a 429 coalesces into one banner with a status-line countdown instead of printing its raw JSON on every retry. The general `showError` path is unchanged: it still only routes genuine network-envelope errors to the quiet presentation, so non-provider error text is never hidden behind the provider banner.

### Why

A 429 rate-limit was excluded from the quiet path by the auth/quota guard, so it printed raw `Error: 429: {...}` JSON once per automatic retry. Transient failures should retry quietly behind one banner; the change is scoped to the retry loop so unrelated errors still render verbatim.

### Why an extension could not handle it

The presentation classification and the retry-event render decision live in interactive-mode internals below the extension API.

### Expected merge conflict zones

Upstream edits to `provider-error-presentation.ts` or the provider-error event cases in interactive-mode.ts at the next sync.

## 2026-10-03 - Tool-card diff contrast raised to >= 7:1 (senpi#2655)

### What changed

- `packages/coding-agent/src/modes/interactive/theme/dark.json`
- `packages/coding-agent/src/modes/interactive/theme/light.json`

`packages/coding-agent/src/modes/interactive/theme/dark.json` and `light.json`: tool success/error/pending card backgrounds move from saturated dark-tinted blocks to muted near-plain tints that stay distinct per status (success green-tint, error red-tint, pending neutral), and the diff foreground colors are decoupled from the shared `success`/`error` roles into dedicated brighter values, so added and removed diff lines keep distinct backgrounds and read at >= 7:1 for the full line content. Dark: success `okhsl(158 26% 13%)`, error `okhsl(19 28% 14%)`, added `okhsl(159 58% 76%)` (9.1:1), removed `okhsl(20 70% 77%)` (8.5:1). Light: success `okhsl(156 25% 91%)`, error `okhsl(24 28% 91%)`, added `okhsl(159 85% 28%)` (7.8:1), removed `okhsl(20 100% 30%)` (8.2:1). Status is still visible from the card background; general text contrast on the card is unchanged or better.

### Why

The saturated card backgrounds dropped diff text contrast to 4.2-4.7:1, and flattening them to one shared background made added and removed lines indistinguishable. Distinct muted tints plus brighter diff foregrounds restore both readability and the added/removed distinction.

### Why an extension could not handle it

Theme color roles are interactive-mode assets resolved at startup; an extension cannot re-map the tool-card backgrounds or the diff foreground roles.

### Expected merge conflict zones

Upstream edits to `theme/dark.json` or `theme/light.json` color roles at the next sync.


## Deleting a session also deletes its tool images (2026-10-03)

### What changed

- `packages/coding-agent/src/modes/interactive/components/session-selector.ts`

`deleteSessionFile` reads the session id from the file header before the file is removed and, only once the file is gone, removes that session's `media/<durableSessionId>` directory next to it (the tool-result images the RPC host persisted for `media_placeholders` clients). A delete that fails removes nothing. When the images cannot be removed after the session file is gone (the id is unrecoverable from then on), `deleteSessionFile` still reports the session as deleted but returns `mediaError` naming the leftover directory, and the selector shows it as an error instead of a clean delete.

### Why

The RPC host keeps tool-result images next to the session files so a client can render them from a path; they must not outlive the session that owns them.

### Why an extension could not handle it

The session selector's delete action is interactive-mode UI code with no extension hook.

### Expected merge conflict zones

`deleteSessionFile` in `session-selector.ts`.

## 2026-10-03 - Fold the startup banner into one summary line (senpi#2651)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: the compact resource listing now truncates to a few names with a `+N more (ctrl+o)` hint when it would be long (a 69-skill list filled the whole first screen on an 80x24 terminal); short listings (<= 8 names) still show in full, and the full list always renders on Ctrl+O via the existing `setToolsExpanded` re-expansion. More than one startup model-runtime warning now collapses into a single expandable notice box (`N model warnings` with the first as the body and the rest as Ctrl+O-detail `extra` lines) when startup details are hidden (quiet startup); a single warning still shows in full, and verbose/detail-showing modes keep the per-warning lines.

### Why

The first screen was only the skill list plus up to 7 warning lines. A truncated listing and a single expandable warning notice keep the count and the first items visible without flooding the first frame, and every detail stays one keypress away.

### Why an extension could not handle it

The startup banner and the startup-warning loop are interactive-mode internals below the extension API; an extension cannot rewrite what `showLoadedResources` or the warning loop prints.

### Expected merge conflict zones

Upstream edits to `showLoadedResources` or the startup-warning block in interactive-mode.ts at the next sync.

## 2026-10-05 - A terminal's control endpoint registers without the work a sender does not need (senpi#2756)

### What changed

- `packages/coding-agent/src/modes/interactive/session-control-endpoint.ts`: `openEndpoint` starts `thisProcessStartTime()` at entry (the writer stamp's `ps` lookup overlaps the header write and the bind), starts `persistHeaderNow()` without awaiting it, resolves the socket, creates the secret and binds, and awaits the header only before `registerTuiEndpoint` - so `endpoint.json` still never appears before the session id is on disk. `gcHostEndpoints(agentDir, { kinds: ["tui"] })` no longer runs in front of the bind: it runs once on `setImmediate` after activation, and a failure is a notice (`control endpoint gc of dead terminals failed: <reason>`), never a failed registration. After the first `inbox` pass, one more `inbox` pass runs once the inbox watch's arming settled.
- `packages/coding-agent/src/modes/interactive/session-control-wake.ts`: `watchInbox` returns `InboxWatch { armed, stop }` as soon as the watch is created, instead of a stop function after the sentinel's event came back. The bounded sentinel re-touch runs in the background; `armed` settles when the sentinel's event arrives, or when the retry ran out (reported through `onError` as before) or the watch was stopped (which ends the retry and removes the sentinel, with no error).
- `packages/coding-agent/src/modes/interactive/session-control-registry.ts`: `registerTuiEndpoint` passes `{ fresh: true }` to `writeHostRegistration`, so a terminal's registration skips `pruneDeadGenerations`.
- Tests: `test/suite/tui-endpoint-deferred-gc.test.ts` (the 50-cycle reap test moved here from `test/interactive-session-control-lifecycle.test.ts`, now waiting for the deferred pass), `tui-endpoint-registration-order.test.ts`, `tui-endpoint-fresh-generation.test.ts`, `tui-endpoint-inbox-arm.test.ts`, `tui-endpoint-reach.test.ts`, helper `test/helpers/tui-endpoint-seams.ts`.

### Why

- A profile of the endpoint's startup cost put about 15.5 ms of registration after `settled`, spread over some 25 awaited filesystem round trips rather than one hot spot. Three of those steps are not on the path a sender takes (`endpoint.json` -> socket -> `wake`): reaping other terminals' dead records (about 2 ms per dead record, 0.6 ms with none), the dead-generation prune of a directory that is named by a fresh instance id and so cannot hold an older generation (0.24 ms), and the inbox watch's arming, which held `registerIncarnation` - and so admission - for 200 ms whenever the first sentinel event was missed (8 of 30 sends in the reach run). The writer stamp's `ps` lookup (2.5 ms) and the bind (about 1.6 ms) could run while the header is written.
- The post-arm pass is what keeps the reachability rule once arming no longer gates registration: an entry written after the first pass but before the watch can see it produces no event, and that pass drains it.

### Why an extension could not handle it

- The registration order, the inbox watch and the registry write are the engine's own control-endpoint implementation; an extension only calls `pi.session.registerControlEndpoint`.

### Expected merge conflict zones

- LOW: `openEndpoint` in `session-control-endpoint.ts`, `watchInbox` in `session-control-wake.ts`, and the `writeHostRegistration` call in `registerTuiEndpoint`. All three files are fork-only.

## 2026-10-08 - A later ask-user answer is shown with the user's words in place (senpi#2920)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: a user message whose first text block is an `[Answer to question <id>]` frame followed by labelled word blocks renders through `askUserAnswerDisplayText`, which puts each word back where the frame refers to it by label, so the answer chip and its expanded body read as before.
- `packages/coding-agent/src/modes/interactive/components/tree-selector.ts`: the `/tree` row of such a user message shows the same resolved text instead of the blocks run together.

### Why

- The ask-user builtin now sends the user's words as text blocks of their own after the frame (Claude Haiku 5.5 may ignore user text that sits beside a harness label). Without this the chat joined the blocks with no separator and the chip lost the comment.

### Why an extension could not handle it

- The chat's user-message rendering is the interactive mode's own code; an extension cannot replace how a user message is drawn.

### Expected merge conflict zones

- LOW: the `case "user"` branch of the message renderer (the `textContent` line) and the ask-user `format.ts` import in `interactive-mode.ts`; the `role === "user"` branch of the tree selector's entry label and its import.
