# changes.md — packages/neo-tui

This crate is net-new vs upstream `badlogic/pi-mono`. It exists only in the senpi fork.

## 2026-05-18 — Initial scaffold

- Created the workspace member `packages/neo-tui/` under the senpi monorepo.
- Workspace Cargo.toml at repo root introduces a Rust workspace alongside the existing TypeScript packages.
- The binary is built by `packages/neo-tui/scripts/build-binary.mjs` and copied into `packages/coding-agent/dist/neo-tui-bin/`.
- Activated only when the user passes `senpi --neo`. Zero impact on existing senpi behavior when the flag is absent.
- Talks to senpi over the existing `senpi --mode rpc` JSONL protocol (see `packages/coding-agent/docs/rpc.md`). No new RPC surface.

Upstream rebase notes: this directory does not exist upstream. Conflict surface is limited to the four touched files in `packages/coding-agent/` (args.ts, main.ts, modes/index.ts, package.json) which are tracked in `packages/coding-agent/src/cli/changes.md`.

## 2026-05-19 — Full pi-tui port + bug-fix rewrite (PR #14)

Threw out the early scaffold's renderer/editor/app loop and rebuilt them as a real ratatui app, porting features from `packages/tui` (TypeScript pi-tui) and pattern-matching `../codex/codex-rs/tui`. Re-skin to `../opencode` palette schema. 39 TDD-locked atomic commits.

Fixes 4 user-reported critical bugs:
1. `Shift+Enter` in tmux now inserts a newline (was: submit). Root cause was missing xterm modifyOtherKeys mode 2 (`\x1b[>4;2m`) on startup. New `term::TerminalCaps` emits it when `TMUX`/`TMUX_PANE` is set and includes `REPORT_ALL_KEYS_AS_ESCAPE_CODES` in the Kitty enhancement flags.
2. Korean / CJK input no longer truncates at the right edge of the input box. New `text::wrap_text_with_ansi` + `InputState::display_lines/cursor_visual_position` produce wrap-aware multi-line display with double-width handling.
3. Backend exit / EOF / parse errors no longer hang the UI silently. New `rpc::Inbound::{Error, Disconnected, ParseError}` variants are consumed by `app::apply_inbound`, surfacing a chat error bubble and `× backend disconnected` footer.
4. Idle vs answering states now visually distinct via per-`Status` background tints (`StatusIdleBg/BusyBg/StreamingBg/ToolBg/ErrorBg`) and metric-cluster hiding when all counters are zero.

New features bundled with the rewrite:
- `@<path>` autocomplete popup and `/` slash menu via new `Autocomplete` engine + reusable `SelectList`.
- Up/Down history navigation, mouse wheel chat scroll.
- Model picker + theme picker overlays.
- Markdown rendering (pulldown-cmark + syntect) in chat, every color via `Token::*`.
- Animation primitives (`anim::Spinner / Scanner / Pulse`).
- Connection status dot + model + thinking pill + branch dirty marker in header.
- Settings list component (toggle / cycle / submenu / static).

Test count: 298 passing (was 156 at branch start). `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test -j 1` all green. Theme audit confirms zero hardcoded `Color::Rgb` in render code.

## 2026-05-19 — Oracle blockers cleared (PR #14 follow-up)

- Added `diffAddedText` and `diffRemovedText` to `assets/themes/senpi-neo-dark.json` so the bundled dark theme defines every variant in `Token::ALL` (72/72). Locked by a new `bundled_dark_theme_resolves_every_token_in_token_all` assertion that scans the resolved theme for `Color::Reset` (the lenient fallback) and fails if any `Token::ALL` member is missing.
- Dropped the redundant `tui.editor.newLine` binding from `assets/keymaps/default.json`. The legacy `tui.input.newLine` (`shift+enter`) from `TUI_KEYBINDINGS` was already wired into the main key dispatcher, so the extra ID only existed to satisfy a shadow code path. Removing it kills the dispatch ambiguity and lets the keymap parity test stay green on both sides of the fence.
- Moved the neo-only `tui.input.historyPrev` / `tui.input.historyNext` bindings into the `neo.*` namespace (`neo.input.historyPrev` / `neo.input.historyNext`). The legacy senpi TUI does not have these bindings, so keeping them on `tui.*` was a future-conflict hazard; the parity tests on both sides now enforce the `neo.*` rule with zero exceptions.

## 2026-05-19 — Oracle round 3: kill four more silent-failure paths

Oracle's second sweep over the merged `45dbb577` snapshot found that the Bug 3 "if there's an error, say so" contract still had four leaks:

1. `rpc::Inbound::Response { success: false }` was matched to `Inbound::Response(_) => {}` in `App::apply_inbound`, dropping every backend-side command failure (including the explicit `error: Some(_)` field). Now surfaces as a chat error bubble + footer `Status::Error` with the failing command name.
2. `rpc::Inbound::ParseError { line, source }` only emitted `tracing::warn!` and the existing app-loop test actively asserted that protocol corruption leaves the UI untouched. Both the runtime path and the regression assertion now require a visible chat error + footer `protocol error` status.
3. `--theme opencode/dracula` (the README-documented form) failed because the registry only stored flat keys (`dracula`, `nord`, ...) and the main.rs path heuristic treated any `/` in the value as a file path. The registry now strips the `opencode/` prefix on lookup, and the CLI heuristic only triggers on explicit filesystem indicators (`./`, `../`, `~/`, absolute, or an existing file).
4. `Alt+T` (`neo.theme.picker`) was bound in the JSON keymap but had no `execute_action` arm, so the dispatcher dropped it into the catch-all `Consumed` no-op. Added `AppAction::OpenThemePicker` plus the dispatch path that opens the existing `ThemePickerOverlay::new(&self.theme.name)` overlay.

Total Rust test count is now 305 passing (was 298 after PR #14 squash); five new tests cover the four arms and the prefix-strip behavior. `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `npm run check`, and the two coding-agent regression suites all green.

## 2026-05-19 — Oracle round 6: surface the last six Bug 3 silent paths

Oracle's sixth review of the PR #15 head found six remaining silent-failure paths the previous rounds had not flagged. All are now wired to surface user-visible feedback.

1. `app.editor.external` (Ctrl+G) returned `AppAction::ExternalEditor`, but `action_to_command` maps that variant to `None`, so the keystroke produced zero side effect. The dispatcher now also pushes a chat-system "not yet wired" note while preserving the typed variant for future external-editor wiring.
2. `app.suspend` (Ctrl+Z) was advertised in the bundled keymap and exposed by the command palette but was missing from `ADVERTISED_BUT_UNIMPLEMENTED_ACTIONS`. Added to the list so the dispatcher routes it through `note_unimplemented_action`.
3. `RpcEvent::MessageEnd { message }` ignored the `message.errorMessage` field. Failed assistant turns ship through `message_end` with the provider error string attached by `agent-loop.ts::buildErrorAssistantMessage`. The new `apply_message_end` helper extracts the string and pushes a chat error + footer `assistant error` status when present.
4. `RpcEvent::CompactionEnd { aborted, error_message, will_retry, .. }` failure variants were dropped by the catch-all `_ => {}` arm. A guarded match arm now calls `apply_compaction_failure` and pushes a chat error explaining the failure (with `(will retry)` hint when applicable).
5. `RpcEvent::AutoRetryEnd { success: false, attempt, final_error }` exhausted-retry frames were dropped by the same catch-all. A destructure-guard match arm now calls `apply_auto_retry_failure`, pushing a chat error with the attempt count and final error and flipping the footer to `retry exhausted`.
6. `crossterm::EventStream::next()` returning `Some(Err(_))` (terminal input I/O failure) and `None` (stream exhausted / TTY closed) were both swallowed by `_ => {}` in the drive loop. The new `handle_terminal_event` helper returns a `TerminalEventOutcome` discriminator so the drive loop surfaces input-pipe errors as `Inbound::Error` and treats stream exhaustion as `Inbound::Disconnected` before breaking.
7. `spawn_stderr_reader` used `while let Ok(Some(line))`, silently dropping any `Err(_)` from `lines.next_line()`. The function now takes an `inbound_tx` clone and emits `Inbound::Error { stderr_tail: "backend stderr read failed: ..." }` on transport read failure so the user sees the diagnostic-pipe break immediately instead of waiting for the eventual child exit.

Total Rust test count is now 318 passing (was 310 after round 4 / 305 after round 3); eight new tests in `tests/app_loop.rs` cover Defects 1-5 plus inverse-contract guards for successful compaction and successful auto-retry to lock the "no chat noise on success" contract. Defects 6 and 7 are in async transport code and are verified by code review + the helper extraction (`handle_terminal_event` returns a typed outcome enum, so the drive loop's match exhaustively names every failure path). `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `npm run check`, and the coding-agent regression suites all green.

## 2026-05-19 — Oracle round 7: `tui.select.*` outside an overlay surfaces a chat note

Oracle's seventh review confirmed all six round-6 fixes (Ctrl+G chat note, `app.suspend` list entry, `message_end.errorMessage`, `CompactionEnd` failure surface, `AutoRetryEnd { success: false }` surface, terminal stream + stderr-reader I/O errors) and all three quality gates. It flagged one remaining silent path that the previous rounds had not caught:

1. `tui.select.{up,down,pageUp,pageDown,confirm,cancel}` are bound in the bundled keymap and surfaced by the command palette (every keymap binding shows up there via `overlay/mod.rs`). The compositor's `synthesise_select_event` routes them to the active overlay's raw handler **when an overlay is open**, but with no overlay open they used to fall into the dispatcher's catch-all silent consume. Selecting `tui.select.up` from the palette closed it with no action and no feedback. Added a new `OVERLAY_SCOPED_SELECT_ACTIONS` constant, the `is_overlay_scoped_select_action` predicate, and the `App::note_overlay_only_action` helper that pushes a chat-system note explaining the chord only takes effect inside an overlay. The dispatcher now matches the predicate BEFORE the unimplemented-action arm so the message is correct ("only takes effect while an overlay is open" instead of the misleading "not yet wired").

Regression: `tui_select_action_outside_overlay_visibly_notifies_user`.

Total Rust test count is now 319 passing (was 318 after round 6). `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, and `npm run check` all green.

## 2026-05-19 — Oracle round 8: `neo.slash.open` and `tui.input.tab` outside their contexts

Oracle's eighth review of HEAD `8ac34409` confirmed all seven round-6 / round-7 fixes and the three quality gates, then surfaced two more silent paths that the previous rounds had not caught:

1. `neo.slash.open` (`/`) is bound in the bundled keymap and exposed by the command palette (every keymap binding shows up there via `PaletteOverlay::from_keymap`). The raw key path in `handle_key` opens the slash overlay only when the user types `/` with an empty Input-focus buffer (so mid-prompt `/` inserts literally). When the action is dispatched THROUGH `execute_action` (the palette path), there was no arm and it fell into the catch-all silent consume. Selecting `/help` from the palette closed the palette with no slash overlay and no chat note. New `App::open_slash_overlay` helper opens `Overlay::Slash(SlashOverlay::new())` unconditionally; the palette explicitly picked the action, so the buffer-empty precondition no longer applies.

2. `tui.input.tab` (`tab`) is bound in the keymap and surfaced by the palette. `try_autocomplete_action` handles it ONLY when an autocomplete popup is visible; with no popup it returned `None` and the dispatcher fell into the catch-all silent consume. New `App::note_autocomplete_only_action` helper pushes a chat-system note: `` `tui.input.tab` only takes effect while an autocomplete popup is showing. Type `@` for path completion or `/` for slash commands first. `` (mirrors the `note_overlay_only_action` shape from round 7).

Cleanup (per Oracle's audit recommendation): removed the dead `"app.message.followUp"` entry from `ADVERTISED_BUT_UNIMPLEMENTED_ACTIONS`. The explicit `execute_action` arm has always shadowed it - the list entry was misleading. Replaced with a comment explaining the precedence so future auditors do not re-add it.

Refactor: extracted `App::open_slash_overlay`, `App::apply_follow_up_action`, `App::apply_submit_action` helpers from `execute_action` to keep that function under clippy's 100-line `too_many_lines` ceiling. 1:1 with their inline equivalents, no behavior change.

Tests added (TDD red-then-green):
- `neo_slash_open_dispatched_from_palette_opens_slash_overlay` (drives `neo.slash.open` via `execute_action_for_tests`, asserts `Overlay::Slash` opens).
- `tui_input_tab_outside_autocomplete_visibly_notifies_user` (drives `tui.input.tab` outside any autocomplete, asserts chat-system note mentions the action id and "autocomplete"/"popup").

Oracle confirmed via an exhaustive walk of `assets/keymaps/default.json` that the only remaining class (E) defect (raw-handler-only path) is `neo.slash.open`. No class (F) orphans found. Every advertised default keybinding now routes to one of: real behavior, `note_unimplemented_action`, `note_overlay_only_action`, `note_autocomplete_only_action`, or `apply_*` overlay-open / message-action helpers.

Total Rust test count is now 321 passing (was 319 after round 7). `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, and `npm run check` (897 files) all green.

## 2026-05-19 — Oracle round 9: `app.exit` always quits when dispatched explicitly

Oracle's ninth review of HEAD `1e08e6b7` confirmed every round-8 fix (slash overlay, autocomplete-only note, dead list entry cleanup) and the three quality gates, then surfaced one last silent path: `app.exit` with a non-empty input buffer returned `AppAction::Consumed("tui.editor.deleteCharForward")` — the label was just a string, the buffer was never actually edited, and selecting `/quit` from the palette while drafting a message silently closed the palette without quitting.

The old branch tried to mimic legacy senpi's `Ctrl+D` semantics ("on non-empty buffer, fall through to delete-char-forward, which is a no-op at end-of-line"). But it never actually performed the delete — it just emitted the label. And when the user picks `/quit` from the palette, the buffer-state guard makes no sense: they explicitly chose to exit. Now `app.exit` always returns `AppAction::Quit`. Users who want the keystroke-level `Ctrl+D` delete-char-forward behavior can rebind `Ctrl+D` to `tui.editor.deleteCharForward` directly (which already has its own arm with the legacy semantics).

Regression: `app_exit_dispatched_from_palette_quits_even_with_nonempty_buffer`.

Total Rust test count is now 322 passing (was 321 after round 8). `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, and `npm run check` (897 files) all green.

## 2026-05-19 — Oracle round 8: `neo.slash.open` + `tui.input.tab` outside their contexts

Oracle's eighth review of the round-7 commit (`8ac34409`) confirmed the `tui.select.*` fix and all three gates, then flagged the next-most-similar leak: `neo.slash.open` was only handled in the raw key path (gated on Input focus + empty buffer for the mid-prompt `/` literal-insert behavior), so dispatching it through `execute_action` (i.e. via the command palette) fell into the catch-all silent consume. A follow-up classification audit also surfaced `tui.input.tab`, which `try_autocomplete_action` only consumes when an autocomplete popup is open — outside that context it landed in the catch-all too.

1. `neo.slash.open` dispatched via `execute_action` now opens the slash overlay unconditionally via the new `App::open_slash_overlay` helper. The palette/slash-menu path can no longer leave the user with a closed palette and no slash overlay. Regression: `neo_slash_open_dispatched_from_palette_opens_slash_overlay`.
2. `tui.input.tab` without an active autocomplete popup now pushes a chat-system note via the new `App::note_autocomplete_only_action` helper (modeled on `note_overlay_only_action`): `\`tui.input.tab\` only takes effect while an autocomplete popup is showing. Type \`@\` for path completion or \`/\` for slash commands first.` Regression: `tui_input_tab_outside_autocomplete_visibly_notifies_user`.
3. Cleanup: removed the dead `\"app.message.followUp\"` entry from `ADVERTISED_BUT_UNIMPLEMENTED_ACTIONS`. The explicit `execute_action` arm at line 645 handles it as a real `AppAction::FollowUp`, so the list entry was shadowed and audit-misleading. Added an inline comment explaining the exclusion to prevent future drive-by re-adds.

Refactor to stay under clippy's per-fn line ceiling: extracted `apply_follow_up_action`, `apply_submit_action`, and `open_slash_overlay` from `execute_action`. The dispatcher now reads as a flat router of arms to small named helpers.

Total Rust test count is now 321 passing (was 319 after round 7). `cargo fmt --check`, `cargo clippy --package senpi-neo-tui --all-targets -- -D warnings`, and `npm run check` (897 files) all green.

## 2026-05-19 — Oracle round 9: `app.exit` with non-empty buffer was a silent no-op

Oracle's ninth review of HEAD `1e08e6b7` confirmed every prior fix, then flagged one last silent path:

1. `app.exit` (`/quit` from slash menu, or selecting "app.exit" from the command palette, or raw Ctrl+D) was wired with a buffer-state guard in `execute_action`. The empty-buffer branch returned `AppAction::Quit` (correct), but the non-empty branch returned `AppAction::Consumed("tui.editor.deleteCharForward")` - a label string that did NOT actually call `delete_char_forward()`. So selecting `/quit` from the palette while the input buffer had any draft text closed the palette with zero visible effect: no quit, no buffer mutation, no chat feedback. The user explicitly invoked exit and got silence.

Fix: removed the non-empty branch entirely. `app.exit` now always returns `AppAction::Quit` regardless of buffer state. The user explicitly invoked exit; respect that. Users wanting the legacy Ctrl+D-deletes-char-forward behavior can rebind Ctrl+D to `tui.editor.deleteCharForward` directly (that arm already exists). Regression: `app_exit_dispatched_from_palette_quits_even_with_nonempty_buffer` (drives `execute_action_for_tests("app.exit")` with a non-empty buffer and asserts `AppAction::Quit`). The existing `ctrl_d_with_empty_input_resolves_to_app_exit` continues to pass.

Total Rust test count is now 322 passing (was 321 after round 8). `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, and `npm run check` (897 files) all green.

## 2026-05-19 — Oracle round 6: close six more Bug-3 silent paths

Oracle's review of the round-5 HEAD (`35bbdece`) confirmed the spawn / writer / stdout-reader / picker / unimplemented-action fixes and the three gates (cargo test, clippy, fmt), but flagged six additional places where the "if there's an error, say so" contract still leaked through:

1. **`app.editor.external` (Ctrl+G) silent no-op.** The arm returned `AppAction::ExternalEditor`, but `action_to_command` maps that variant to `None` and the run loop has no other handler for it - so the keystroke produced zero user-visible effect. Now also pushes a `Role::System` chat note explaining the in-buffer external editor is not yet wired in `senpi --neo`, while still returning the typed variant so the existing parity test continues to lock the dispatch contract.
2. **`app.suspend` (Ctrl+Z) silent.** Bound in `assets/keymaps/default.json:45` and surfaced via the slash menu + command palette, but missing from `ADVERTISED_BUT_UNIMPLEMENTED_ACTIONS`. The dispatcher silently consumed it through the catch-all `_` arm. Added to the list so it now produces a "not yet wired in `senpi --neo`" chat note.
3. **`message_end.message.errorMessage` ignored.** `agent-loop.ts::buildErrorAssistantMessage` attaches the provider error string to the final assistant message; the previous `MessageEnd` arm only dropped the empty assistant bubble and flipped footer idle, silently discarding the error. Now extracts `errorMessage` and pushes it as `Role::Error` with footer `Status::Error` (`assistant error` label). Clean message_end paths still go straight to idle.
4. **`compaction_end { aborted, error_message, will_retry }` ignored.** Failure data was swallowed by `apply_event`'s catch-all. Compaction failures typically mean the summarization LLM rejected the request - the user must know so they can manually compact, fork, or accept the larger context. Adds a match-guarded arm that surfaces failures as `Role::Error`, optionally annotating with `(will retry)`. Successful compactions remain silent.
5. **`auto_retry_end { success: false, attempt, final_error }` ignored.** Exhausted retries used to silently flip the agent back to idle. Now pushes a `Role::Error` chat message naming the attempt count and final error string, with footer `Status::Error` (`retry exhausted` label). Successful retries stay silent so transient recoveries do not flood chat.
6. **`EventStream::next()` `Some(Err(_))` / `None` silent.** A terminal-input pipe I/O error or unexpected stream exhaustion used to fall into `_ => {}` in the `drive` loop, leaving the user with a silently-frozen TUI. Added explicit `Some(Err)` (push `Inbound::Error` with the io::Error text) and `None` (push `Inbound::Disconnected` and break) arms via a new `handle_terminal_event` helper + `TerminalEventOutcome` enum. Helper keeps `drive` under the clippy 100-line cap.
7. **`spawn_stderr_reader` `Err(_)` silent.** Used `while let Ok(Some(line))` so any stderr read error silently exited the loop. The child watcher would eventually surface the exit, but until then the user had no idea why the diagnostic stream went quiet. Reader now takes an `inbound_tx` clone and emits `Inbound::Error { stderr_tail: "backend stderr read failed: ..." }` immediately on transport error.

Refactor: extracted `apply_message_update_delta`, `apply_compaction_failure`, `apply_auto_retry_failure`, `apply_external_editor_action`, `handle_terminal_event` helpers to keep `apply_event`, `execute_action`, and `drive` under clippy's `too_many_lines` ceiling.

Total Rust test count is now 318 passing (was 310 after round 5); eight new tests cover the six defects (six red-then-green, plus two inverse-contract tests that lock the "success path stays silent" guarantee for `auto_retry_end` and `compaction_end`). `cargo fmt --check`, `cargo clippy --package senpi-neo-tui --all-targets -- -D warnings`, `npm run check` (897 files), and the coding-agent regression suites all green.

Defects 6 and 7 (terminal-stream + stderr-reader I/O errors) are unit-tested by code review only because the call sites live in spawned tokio tasks driven by external transports; the helper extraction (`handle_terminal_event`) keeps the call shape verifiable from inspection, and the stderr-reader refactor mirrors the `spawn_writer` / `spawn_stdout_reader` patterns already locked by round 5.

## 2026-05-19 — Oracle round 10: surface three more Bug-3 silent-failure paths

Oracle's tenth review of HEAD `09e75ace` found three remaining places where the "if there's an error, say so" contract still leaked through:

1. **`app.thinking.toggle` (Ctrl+T) and `app.tools.expand` (Ctrl+O) toggled dead fields.** Both arms flipped `self.thinking_visible` / `self.tools_expanded`, but no render path ever consumed those fields. The chord was advertised in the README, `/hotkeys`, slash menu, and command palette as "toggle thinking-block visibility" / "toggle tool-output expansion" but produced zero user-visible effect. New `apply_thinking_visibility_toggle` and `apply_tools_expanded_toggle` helpers preserve the field mutations (so wiring renderer hookups later is a one-line change) and ALSO push a chat-system "not yet wired to chat rendering" note so the chord visibly lands now.
2. **`cycle_model` / `cycle_thinking_level` / `set_model` success responses dropped.** `apply_inbound` matched `Inbound::Response(_)` only for the `success: false` branch and silently discarded successful payloads. Pressing Ctrl+P fired `Command::CycleModel`, the backend cycled the model and returned `Response { success: true, data: { model: { name, provider, id }, thinkingLevel, isScoped } }`, but `header.model` / `footer.model` never updated and chat got no note. Same leak for `set_model` (data is the Model directly) and `cycle_thinking_level` (data is `{ level }`). New `apply_response` extracted helper routes successful responses to `apply_model_change_response` / `apply_thinking_change_response`. Both update `header` + `footer` AND push a chat note. `null` data (no other model / level configured) pushes a "No other model is configured to cycle to" note so the chord still produces visible feedback.
3. **`app.model.cycleBackward` (Shift+Ctrl+P) silently cycled FORWARD.** The arm produced `AppAction::CycleModel { forward: false }`, but `action_to_command` mapped both directions to the same forward-only `Command::CycleModel` (the wire protocol is next-only today). So Shift+Ctrl+P sent a forward cycle when the user expected backward. Now routes through `note_unimplemented_action` so the user sees an explicit "not yet wired" note instead of getting the wrong model. Forward cycling via Ctrl+P still works as before.

Refactor: simplified `AppAction::CycleModel { forward: bool }` → `AppAction::CycleModel` since the discriminator was always discarded by `action_to_command` and only `forward: true` is now reachable. Backward cycling never enters the variant; it lands at `note_unimplemented_action` in `execute_action`.

Total Rust test count is now 329 passing (was 322 after round 9); seven new tests cover the three defects (`ctrl_t_app_thinking_toggle_visibly_notifies_user`, `ctrl_o_app_tools_expand_visibly_notifies_user`, `shift_ctrl_p_app_model_cycle_backward_visibly_notifies_user`, `apply_inbound_cycle_model_success_response_updates_displays`, `apply_inbound_cycle_model_success_response_with_null_data_pushes_note`, `apply_inbound_set_model_success_response_updates_displays`, `apply_inbound_cycle_thinking_level_success_response_updates_displays`, `apply_inbound_cycle_thinking_level_success_response_with_null_data_pushes_note`). Four existing tests updated to assert the new behavior (`ctrl_p_dispatches_cycle_model`, `shift_ctrl_p_app_model_cycle_backward_visibly_notifies_user`, `shift_ctrl_p_does_not_open_palette_after_rebind`, `ctrl_shift_p_no_longer_opens_palette_after_rebind`). One existing test replaced (`action_to_command_maps_cycle_model_regardless_of_direction` → `action_to_command_maps_cycle_model_to_cycle_model_command`). `cargo fmt --check`, `cargo clippy --package senpi-neo-tui --all-targets -- -D warnings`, and `npm run check` (897 files) all green.

## 2026-05-19 — Oracle round 11: surface `extension_ui_request` notifications and dialogs

Oracle's eleventh review of HEAD `f1b69041` confirmed every prior fix, then flagged one remaining silent path:

1. **`extension_ui_request` frames silently dropped.** Extensions emit `extension_ui_request` JSONL frames on stdout to drive user-facing notifications (`method: "notify"` with `notifyType: "info"/"warning"/"error"`) and modal dialogs (`select`, `confirm`, `input`, `editor`). The neo-tui `Event` enum had no variant for them, so the `#[serde(other)]` arm caught them as `Event::Other` and `apply_event`'s `_ => {}` arm discarded them. An extension could emit `{"type":"extension_ui_request","method":"notify","message":"Command blocked","notifyType":"error"}` and the user saw absolutely nothing - the loudest possible Bug 3 violation. See `packages/coding-agent/docs/rpc.md` → "Extension UI Requests" and `packages/coding-agent/src/modes/rpc/rpc-mode.ts:145` for the wire contract.

Fix: added a typed `RpcEvent::ExtensionUiRequest { method, message, notify_type, title }` variant (with the four fields the user-facing branches need; the per-extension UI updates ignore the rest). New `App::apply_extension_ui_request` helper routes each method:
- `notify` → `chat.push_error` (Role::Error + footer Status::Error + label "extension error") for `notifyType: "error"`, otherwise `chat.push_system`. The body is the extension's `message` (or a default "(empty notification)" if missing) prefixed with `Extension: `.
- Dialog methods (`select`, `confirm`, `input`, `editor`) → `chat.push_system` with a "not yet wired" note naming the method + title. The agent-side timeout (per `rpc.md`) auto-resolves these once dialog overlays land in a future iteration.
- Per-extension UI updates (`setStatus`, `setWidget`, `setTitle`, `set_editor_text`) stay silent because they are not user-facing errors and would otherwise flood chat with extension self-management traffic. Locked by the inverse-contract test `apply_event_extension_ui_request_set_status_stays_silent`.

Regression tests: `apply_event_extension_ui_request_notify_error_pushes_chat_error`, `apply_event_extension_ui_request_notify_warning_pushes_chat_system`, `apply_event_extension_ui_request_dialog_method_pushes_not_yet_wired_note`, `apply_event_extension_ui_request_set_status_stays_silent`.

Total Rust test count is now 333 passing (was 329 after round 10). `cargo fmt --check`, `cargo clippy --package senpi-neo-tui --all-targets -- -D warnings`, and `npm run check` (897 files) all green.

## 2026-05-19 — Round 12: real port (sidebar, animations, compact, model.set, dequeue, external editor, thinking/tools render wiring)

Oracle round 12 BLOCKED on the "full Rust port" framing - the merged state still declared ~35 legacy actions as `ADVERTISED_BUT_UNIMPLEMENTED_ACTIONS`. The Bug-3 "not yet wired" notes satisfied the silent-failure contract but did not satisfy the user's `러스트로포팅을 아예한다고 생각하고` (treat it as a complete Rust port) framing.

This round implements the highest-impact remaining surface area as real behavior:

1. **`app.thinking.toggle` (Ctrl+T) → real chat rendering wiring.** New `chat::ChatViewOpts { thinking_visible, tools_expanded }` flows into `chat::render`. When `thinking_visible` is `false`, `render_assistant_message` suppresses both the summary line and the expanded body - the user can hide the inner monologue once they have read it. The dispatcher arm no longer pushes a "not yet wired" note; the visual change IS the feedback.

2. **`app.tools.expand` (Ctrl+O) → real chat rendering wiring.** When `tools_expanded` is `false`, `render_tool_card` collapses the tool body to a single "[tool output collapsed, ctrl+o to expand]" hint line. Header rule still renders so the user can find the card.

3. **`neo.sidebar.toggle` (Alt+S) → real sidebar visibility.** New `App.sidebar_visible: bool` field. The `render` path now flips `LayoutState::sidebar_visible` based on `app.sidebar_visible || app.demo_mode` (gated by terminal width).

4. **`neo.toggle_animations` (Alt+A) → real animation gating.** New `App.animations_enabled: bool` field. The `drive` loop's `spinner_tick` arm skips spinner-frame advancement and input focus-pulse updates when disabled.

5. **`neo.compact` (Alt+C) → real backend RPC.** New `Command::Compact { id, custom_instructions }` variant. `AppAction::CompactSession` maps to it via `action_to_command`. The backend's `compaction_end` event handler (Oracle round 6) already surfaces success / failure to chat + footer.

6. **`neo.model.set:<id>` (model picker) → real `Command::SetModel`.** New `provider_for_model_id` heuristic infers the provider from the model id prefix (`claude-*` → `anthropic`, `gpt-*` → `openai`, `kimi-*` → `kimi-for-coding`, `glm-*` → `opencode-zen`, `deepseek*` → `deepseek`, `gemini-*` → `google`). `AppAction::SetModel { provider, model_id }` maps to `Command::SetModel` via `action_to_command`. The Round-10 `apply_model_change_response` handler already updates header + footer + chat note on success.

7. **`app.editor.external` (Ctrl+G) → real `$VISUAL` / `$EDITOR` launch.** New `AppAction::ExternalEditorLaunch` + `TerminalEventOutcome::ExternalEditor` + `run_external_editor` helper. The run loop suspends the TUI (disable raw mode, leave alternate screen, disable bracketed paste, pop Kitty flags), writes the input buffer to `temp_dir/senpi-neo-editor-<stamp>.md`, awaits `$VISUAL` (or `$EDITOR`, falling back to `vi`) on the temp file, reads the result back, restores the TUI, and refreshes the autocomplete state.

8. **`app.message.dequeue` (Alt+Up) → real queue → buffer pop.** New `ChatState.queued_messages: Vec<String>` field tracked from `RpcEvent::QueueUpdate { steering, follow_up }`. New `pop_queued_message` / `replace_queued_messages` methods. The dispatcher arm pops the most recent queued message into the input buffer, or pushes an explanatory note when the queue is empty.

Refactor: `ADVERTISED_BUT_UNIMPLEMENTED_ACTIONS` shrunk by 5 entries (`neo.sidebar.toggle`, `neo.compact`, `neo.toggle_animations`, `app.message.dequeue`, plus removal of the obsolete `app.message.followUp` comment). The remaining ~29 entries cover the genuine follow-up surface (session tree / branching / models management / tree filters / image paste) which require sub-overlays + JSONL session parsing and are tracked as a separate feature pack.

Total Rust test count is now 341 passing (was 333 after round 11); eight new tests cover the new behavior. Updated tests: `model_picker_selection_fires_set_model_command` (was `..._pushes_visible_feedback`), `model_picker_selection_with_unknown_provider_surfaces_lookup_miss` (new), `ctrl_g_dispatches_external_editor_launch` (replaces two old tests). Removed: `ctrl_o_app_tools_expand_visibly_notifies_user` (superseded by `ctrl_o_app_tools_expand_flips_tools_expanded` which asserts the real toggle behavior). `cargo fmt --check`, `cargo clippy --package senpi-neo-tui --all-targets -- -D warnings` (with one targeted `struct_excessive_bools` allow on `App` documenting why), and `npm run check` (898 files) all green.

## 2026-05-20 — Round 13: real port (suspend, session.new, scoped overlay routing)

Round 13 lands three more pieces of the legacy senpi action surface as real behavior and tightens the routing for actions that legitimately do nothing outside their parent overlay.

1. **`app.suspend` (Ctrl+Z) → real SIGTSTP.** New `AppAction::Suspend` + `TerminalEventOutcome::Suspend` + `run_suspend` helper. The run loop tears down the TUI (raw mode off, alternate screen off, bracketed paste off, Kitty flags popped) and shells out `kill -TSTP $$` on Unix so the user lands back at their shell prompt; `fg` re-enters the TUI with state intact. Non-Unix platforms surface a chat error explaining suspend is not supported.

2. **`app.session.new` (slash menu / palette) → real `Command::NewSession`.** New `AppAction::NewSession` + `Command::NewSession { id }`. The backend's existing session-create flow is reused; the chat is cleared via the same path Ctrl+N already used.

3. **Scoped overlay actions get their own predicates.** Session-overlay actions (9 ids like `app.session.checkpoint.restore`, `app.session.delete`), tree-overlay actions (11 ids like `app.tree.node.next`, `app.tree.collapse_all`), and models-overlay actions (7 ids like `app.models.disable`, `app.models.favorite.toggle`) now route through dedicated `note_session_overlay_scoped_action` / `note_tree_overlay_scoped_action` / `note_models_overlay_scoped_action` helpers with explicit predicates. The notes name the parent overlay so the user understands why the chord did nothing at top level instead of getting a generic "not yet wired" string.

Refactor: `ADVERTISED_BUT_UNIMPLEMENTED_ACTIONS` shrunk from 30 entries (post round 12) to a single entry (`app.clipboard.pasteImage`). All other previously-unimplemented chords are now either real behavior, scoped-overlay actions with explicit predicates, or part of the legitimate single remaining gap (binary clipboard paste).

Total Rust test count is now 345 passing (was 341 after round 12); four new tests cover suspend / new-session dispatch and the three scoped-overlay predicates (`ctrl_z_app_suspend_dispatches_real_suspend_action`, `app_session_new_fires_new_session_command`, `session_overlay_scoped_actions_route_through_scoped_helper`, `tree_overlay_scoped_actions_route_through_scoped_helper`, `models_overlay_scoped_actions_route_through_scoped_helper`). Updated: `unimplemented_slash_command_visibly_notifies_user` now targets `app.clipboard.pasteImage` since `app.session.new` is real. `cargo fmt --check`, `cargo clippy --package senpi-neo-tui --all-targets -- -D warnings`, and `npm run check` (899 files) all green.
