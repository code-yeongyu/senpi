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
