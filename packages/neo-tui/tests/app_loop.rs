//! Behavioral integration test: synthetic `KeyEvent`s flow through the
//! app's keymap dispatcher and produce the expected legacy action,
//! state mutation, or RPC command.
//!
//! Locks the runtime parity contract between the new Rust TUI and the
//! legacy TypeScript senpi TUI: every legacy chord produces the
//! semantically equivalent app behavior, not just the same JSON
//! binding entry. The user explicitly required this kind of TDD
//! coverage on keybinding equivalence.

use std::sync::Mutex;

use crossterm::event::{
    KeyCode, KeyEvent, KeyEventKind, KeyEventState, KeyModifiers, MouseEvent, MouseEventKind,
};
use senpi_neo_tui::app::{App, AppAction};
use senpi_neo_tui::components::autocomplete::AutocompleteResult;
use senpi_neo_tui::components::chat::{Role, ToolStatus};
use senpi_neo_tui::components::footer::Status;
use senpi_neo_tui::overlay::Overlay;
use senpi_neo_tui::rpc::client::Inbound;
use senpi_neo_tui::rpc::command::Command;
use senpi_neo_tui::rpc::event::Event as RpcEvent;

const fn ev(code: KeyCode, mods: KeyModifiers) -> KeyEvent {
    KeyEvent {
        code,
        modifiers: mods,
        kind: KeyEventKind::Press,
        state: KeyEventState::NONE,
    }
}

fn fresh_app() -> App {
    App::for_tests().expect("test fixture builds")
}

static ENV_LOCK: Mutex<()> = Mutex::new(());

fn with_tmux_env(run: impl FnOnce()) {
    let _guard = ENV_LOCK.lock().expect("env test lock must not be poisoned");
    let previous = std::env::var_os("TMUX");
    // SAFETY: this test serializes process-env mutation through ENV_LOCK and
    // restores TMUX before releasing the lock.
    unsafe { std::env::set_var("TMUX", "/tmp/senpi-neo-test-tmux") };
    run();
    match previous {
        Some(value) => {
            // SAFETY: this test serializes process-env mutation through ENV_LOCK
            // and is restoring the exact value captured before the test body.
            unsafe { std::env::set_var("TMUX", value) };
        }
        None => {
            // SAFETY: this test serializes process-env mutation through ENV_LOCK
            // and is restoring TMUX to its previously absent state.
            unsafe { std::env::remove_var("TMUX") };
        }
    }
}

#[test]
fn ctrl_d_with_empty_input_resolves_to_app_exit() {
    let mut app = fresh_app();
    let action = app.handle_key(ev(KeyCode::Char('d'), KeyModifiers::CONTROL));
    assert_eq!(action, AppAction::Quit);
}

#[test]
fn typing_a_character_appends_to_input_buffer() {
    let mut app = fresh_app();
    app.handle_key(ev(KeyCode::Char('h'), KeyModifiers::NONE));
    app.handle_key(ev(KeyCode::Char('i'), KeyModifiers::NONE));
    assert_eq!(app.input_buffer(), "hi");
}

#[test]
fn backspace_in_input_focus_deletes_previous_char() {
    let mut app = fresh_app();
    app.handle_key(ev(KeyCode::Char('a'), KeyModifiers::NONE));
    app.handle_key(ev(KeyCode::Char('b'), KeyModifiers::NONE));
    app.handle_key(ev(KeyCode::Backspace, KeyModifiers::NONE));
    assert_eq!(app.input_buffer(), "a");
}

#[test]
fn enter_in_input_focus_submits_prompt_and_clears_buffer() {
    let mut app = fresh_app();
    app.handle_key(ev(KeyCode::Char('h'), KeyModifiers::NONE));
    app.handle_key(ev(KeyCode::Char('i'), KeyModifiers::NONE));
    let action = app.handle_key(ev(KeyCode::Enter, KeyModifiers::NONE));

    // Submitting must surface as an explicit action (not a silent
    // local mutation) so the run loop can forward the prompt to RPC.
    let AppAction::SubmitPrompt(text) = action else {
        panic!("expected SubmitPrompt, got {action:?}");
    };
    assert_eq!(text, "hi");
    // Buffer is drained.
    assert_eq!(app.input_buffer(), "");
    // The submitted prompt appears as a user message in chat.
    let chat = app.chat_snapshot();
    assert!(
        chat.messages
            .iter()
            .any(|m| m.role == Role::User && m.body == "hi"),
        "user message should be appended to chat history",
    );
}

#[test]
fn editor_shift_enter_inserts_newline() {
    let mut app = fresh_app();
    app.handle_key(ev(KeyCode::Char('a'), KeyModifiers::NONE));
    let action = app.handle_key(ev(KeyCode::Enter, KeyModifiers::SHIFT));
    assert_eq!(action, AppAction::Consumed("tui.input.newLine".into()));
    assert_eq!(app.input_buffer(), "a\n");
}

#[test]
fn ctrl_l_dispatches_app_model_select_action() {
    let mut app = fresh_app();
    let action = app.handle_key(ev(KeyCode::Char('l'), KeyModifiers::CONTROL));
    assert_eq!(action, AppAction::OpenModelPicker);
}

#[test]
fn ctrl_l_actually_opens_the_model_picker_overlay() {
    // Oracle round 4: returning `AppAction::OpenModelPicker` is not
    // enough - the legacy senpi behavior, the README, and the help
    // overlay all promise that `Ctrl+L` brings up a visible model
    // picker. Previously the dispatch only sent
    // `Command::GetAvailableModels` to the backend and waited for a
    // response that nothing was wired to consume. Lock the overlay
    // open so a user actually sees something pop up.
    let mut app = fresh_app();
    app.handle_key(ev(KeyCode::Char('l'), KeyModifiers::CONTROL));
    assert!(
        matches!(app.overlay, Some(Overlay::ModelPicker(_))),
        "Ctrl+L must open the model picker overlay, got {:?}",
        app.overlay,
    );
}

#[test]
fn theme_picker_selection_applies_the_chosen_theme() {
    // Oracle round 4: `ThemePickerOverlay` emits
    // `OverlayResult::Selected("neo.theme.set:<id>")`, which the
    // dispatcher hands to `execute_action`. Previously the catch-all
    // arm just consumed the action with no effect - the overlay closed
    // and the theme stayed the same. The user got no error, no theme
    // change, no feedback at all (a textbook silent failure). Lock
    // the contract so picking a theme actually replaces `app.theme`.
    // The bundled opencode JSON uses display names like "Dracula"
    // while registry ids are lowercased (`dracula`), so the post-load
    // check is on the JSON `name` field as exposed by ResolvedTheme.
    let mut app = fresh_app();
    let before_name = app.theme.name.clone();
    assert_eq!(
        before_name, "senpi-neo-dark",
        "fresh app must boot on the bundled senpi-neo-dark theme",
    );

    let action = app.execute_action_for_tests("neo.theme.set:dracula");

    assert!(
        matches!(action, AppAction::Consumed(_)),
        "theme set must consume the action, got {action:?}",
    );
    assert_ne!(
        app.theme.name, before_name,
        "theme must change away from the boot default after the set action",
    );
    assert_eq!(
        app.theme.name, "Dracula",
        "loading the `dracula` registry id must land on the Dracula display name",
    );
}

#[test]
fn theme_picker_selection_with_unknown_id_pushes_a_chat_error() {
    // Oracle round 4 corollary: a malformed or unknown registry id
    // (`neo.theme.set:does-not-exist`) is itself a Bug-3 silent-failure
    // candidate. Surface the load error to chat + footer so the user
    // sees what went wrong instead of the overlay closing with no
    // visual change.
    let mut app = fresh_app();
    let before_name = app.theme.name.clone();
    let messages_before = app.chat.messages.len();

    let action = app.execute_action_for_tests("neo.theme.set:not-a-real-theme-id");

    assert!(
        matches!(action, AppAction::Consumed(_)),
        "even on failure the dispatch must consume the action so the loop continues",
    );
    assert_eq!(
        app.theme.name, before_name,
        "failure must not partially mutate the theme",
    );
    assert!(
        app.chat.messages.len() > messages_before,
        "an error chat message must be pushed for an unknown theme id",
    );
    let last = app.chat.messages.last().expect("error chat message");
    assert_eq!(last.role, Role::Error);
    assert!(
        last.body.contains("not-a-real-theme-id"),
        "error body must name the failing id, got {:?}",
        last.body,
    );
    assert_eq!(app.footer.status, Status::Error);
}

#[test]
fn model_picker_selection_pushes_visible_feedback() {
    // Oracle round 5: the model picker emits
    // `OverlayResult::Selected("neo.model.set:<id>")`. Previously the
    // dispatcher had no arm for that prefix and silently consumed it -
    // the overlay closed, no model changed on the backend, and the
    // user saw nothing happen. Until provider plumbing lands, surface
    // a chat-system note so the chord is visibly accounted for.
    let mut app = fresh_app();
    let messages_before = app.chat.messages.len();
    let action = app.execute_action_for_tests("neo.model.set:claude-opus-4-7");
    assert!(matches!(action, AppAction::Consumed(_)));
    assert!(
        app.chat.messages.len() > messages_before,
        "model selection must push a chat message",
    );
    let last = app.chat.messages.last().expect("message exists");
    assert_eq!(last.role, Role::System);
    assert!(
        last.body.contains("claude-opus-4-7"),
        "chat body must name the picked model, got {:?}",
        last.body,
    );
}

#[test]
fn unimplemented_slash_command_visibly_notifies_user() {
    // Oracle round 5: the slash menu and command palette advertise
    // `app.session.new`, `app.session.tree`, `app.tree.filter.*`,
    // `app.models.save`, `neo.compact`, etc., but the neo TUI has
    // no execute_action arm for them. Previously selecting one
    // silently closed the overlay with no feedback (Bug 3 leak).
    // Now the dispatcher detects the advertised-but-unimplemented
    // ids and pushes a chat note so the user knows the chord was
    // received AND that the feature is not yet wired in --neo.
    let mut app = fresh_app();
    let messages_before = app.chat.messages.len();
    let action = app.execute_action_for_tests("app.session.new");
    assert!(matches!(action, AppAction::Consumed(_)));
    assert!(
        app.chat.messages.len() > messages_before,
        "unimplemented action must push a chat message",
    );
    let last = app.chat.messages.last().expect("message exists");
    assert_eq!(last.role, Role::System);
    assert!(
        last.body.contains("app.session.new") && last.body.to_lowercase().contains("not yet"),
        "chat body must name the action and mark it as not yet wired, got {:?}",
        last.body,
    );
}

#[test]
fn alt_t_dispatches_open_theme_picker_and_opens_overlay() {
    // Bug-3 followup: the keymap defines `neo.theme.picker -> alt+t` and
    // the docs (README + help overlay) advertise Alt+T as the theme
    // picker shortcut, but the dispatcher previously fell into the
    // catch-all `Consumed` arm and the overlay never opened. Lock the
    // contract on the App side so it cannot silently regress to a no-op.
    let mut app = fresh_app();
    let action = app.handle_key(ev(KeyCode::Char('t'), KeyModifiers::ALT));
    assert_eq!(action, AppAction::OpenThemePicker);
    assert!(
        matches!(app.overlay, Some(Overlay::ThemePicker(_))),
        "expected the theme picker overlay to be open after Alt+T, got {:?}",
        app.overlay,
    );
}

#[test]
fn ctrl_p_dispatches_cycle_model_forward() {
    let mut app = fresh_app();
    let action = app.handle_key(ev(KeyCode::Char('p'), KeyModifiers::CONTROL));
    assert_eq!(action, AppAction::CycleModel { forward: true });
}

#[test]
fn shift_ctrl_p_dispatches_cycle_model_backward() {
    let mut app = fresh_app();
    let action = app.handle_key(ev(
        KeyCode::Char('p'),
        KeyModifiers::CONTROL | KeyModifiers::SHIFT,
    ));
    assert_eq!(action, AppAction::CycleModel { forward: false });
}

#[test]
fn shift_tab_dispatches_cycle_thinking_level() {
    let mut app = fresh_app();
    let action = app.handle_key(ev(KeyCode::BackTab, KeyModifiers::SHIFT));
    assert_eq!(action, AppAction::CycleThinkingLevel);
}

#[test]
fn escape_dispatches_app_interrupt() {
    let mut app = fresh_app();
    let action = app.handle_key(ev(KeyCode::Esc, KeyModifiers::NONE));
    assert_eq!(action, AppAction::Interrupt);
}

#[test]
fn alt_enter_dispatches_follow_up() {
    let mut app = fresh_app();
    app.handle_key(ev(KeyCode::Char('x'), KeyModifiers::NONE));
    let action = app.handle_key(ev(KeyCode::Enter, KeyModifiers::ALT));
    let AppAction::FollowUp(text) = action else {
        panic!("expected FollowUp, got {action:?}");
    };
    assert_eq!(text, "x");
    assert_eq!(app.input_buffer(), "");
}

#[test]
fn ctrl_g_dispatches_external_editor() {
    let mut app = fresh_app();
    let action = app.handle_key(ev(KeyCode::Char('g'), KeyModifiers::CONTROL));
    assert_eq!(action, AppAction::ExternalEditor);
}

#[test]
fn ctrl_g_app_editor_external_pushes_visible_feedback_note() {
    // Oracle round 6: `app.editor.external` (Ctrl+G) returns
    // `AppAction::ExternalEditor`, but the run loop has no handler
    // for that variant - the keystroke produced zero user-visible
    // effect. Bug 3 contract: surface a chat-system note so the
    // user sees that the chord landed AND that the external editor
    // is not yet wired in `senpi --neo`.
    let mut app = fresh_app();
    let messages_before = app.chat.messages.len();
    let action = app.execute_action_for_tests("app.editor.external");
    assert_eq!(
        action,
        AppAction::ExternalEditor,
        "must keep returning the typed variant for future wiring",
    );
    assert!(
        app.chat.messages.len() > messages_before,
        "external editor chord must push a visible chat message",
    );
    let last = app.chat.messages.last().expect("chat message exists");
    assert_eq!(last.role, Role::System);
    assert!(
        last.body.contains("app.editor.external") && last.body.to_lowercase().contains("not yet"),
        "chat body must name the action and flag it as not yet wired, got {:?}",
        last.body,
    );
}

#[test]
fn app_exit_dispatched_from_palette_quits_even_with_nonempty_buffer() {
    // Oracle round 9 defect: selecting `/quit` from the palette
    // routes through `execute_action("app.exit")`. The existing arm
    // returned `AppAction::Quit` when the buffer was empty but
    // otherwise returned `AppAction::Consumed("tui.editor.deleteCharForward")`
    // - a silent no-op (the label string did NOT actually invoke
    // delete-char-forward). When the user explicitly picks /quit,
    // they want to quit regardless of buffer state. Lock the
    // contract so the palette path always exits.
    let mut app = fresh_app();
    for ch in "draft prompt".chars() {
        app.handle_key(ev(KeyCode::Char(ch), KeyModifiers::NONE));
    }
    assert!(!app.input_buffer().is_empty());
    let action = app.execute_action_for_tests("app.exit");
    assert_eq!(
        action,
        AppAction::Quit,
        "app.exit dispatched explicitly (e.g. /quit from palette) must quit regardless of buffer state, got {action:?}",
    );
}

#[test]
fn neo_slash_open_dispatched_from_palette_opens_slash_overlay() {
    // Oracle round 8 defect: `neo.slash.open` is bound to `/` in the
    // bundled keymap and surfaced by the command palette via
    // `PaletteOverlay::from_keymap`. The raw key path at
    // `app/mod.rs:362` only opens the slash overlay when the user
    // types `/` with an empty Input-focus buffer. When the action
    // is dispatched THROUGH `execute_action` (the palette path) it
    // had no arm and fell into the silent catch-all - selecting
    // `neo.slash.open` from the palette closed the palette with no
    // slash overlay and no feedback. Bug 3: surface an explicit
    // overlay open when the action is dispatched directly, since
    // the user explicitly picked it from a list.
    let mut app = fresh_app();
    let action = app.execute_action_for_tests("neo.slash.open");
    assert!(
        matches!(action, AppAction::Consumed(_)),
        "neo.slash.open dispatched directly must produce a Consumed action, got {action:?}",
    );
    assert!(
        matches!(app.overlay, Some(Overlay::Slash(_))),
        "neo.slash.open dispatched from the palette must open the slash overlay, got {:?}",
        app.overlay,
    );
}

#[test]
fn tui_input_tab_outside_autocomplete_visibly_notifies_user() {
    // Oracle round 8 defect: `tui.input.tab` is bound to `tab` in
    // the bundled keymap and surfaced by the command palette.
    // `try_autocomplete_action` handles it ONLY when an autocomplete
    // popup is present; with no popup the action fell into the
    // catch-all silent consume. Bug 3: surface a chat-system note
    // explaining the autocomplete scoping so the chord is visibly
    // accounted for.
    let mut app = fresh_app();
    let messages_before = app.chat.messages.len();
    let action = app.execute_action_for_tests("tui.input.tab");
    assert!(matches!(action, AppAction::Consumed(_)));
    assert!(
        app.chat.messages.len() > messages_before,
        "tui.input.tab outside an autocomplete popup must push a visible chat note",
    );
    let last = app.chat.messages.last().expect("chat message exists");
    assert_eq!(last.role, Role::System);
    assert!(
        last.body.contains("tui.input.tab")
            && (last.body.to_lowercase().contains("autocomplete")
                || last.body.to_lowercase().contains("popup")),
        "chat body must name the action and explain the autocomplete scoping, got {:?}",
        last.body,
    );
}

#[test]
fn tui_select_action_outside_overlay_visibly_notifies_user() {
    // Oracle round 7 defect: `tui.select.{up,down,pageUp,pageDown,
    // confirm,cancel}` are advertised in the bundled keymap +
    // command palette but only do useful work while an overlay is
    // open (the compositor's `synthesise_select_event` routes them
    // to the active overlay's raw handler). Without an overlay the
    // dispatcher previously dropped them into the catch-all silent
    // consume - selecting `tui.select.up` from the palette produced
    // zero visible effect. Surface a chat-system note explaining the
    // overlay scoping so the chord is visibly accounted for.
    let mut app = fresh_app();
    let messages_before = app.chat.messages.len();
    let action = app.execute_action_for_tests("tui.select.up");
    assert!(matches!(action, AppAction::Consumed(_)));
    assert!(
        app.chat.messages.len() > messages_before,
        "tui.select.* outside an overlay must push a visible chat note",
    );
    let last = app.chat.messages.last().expect("chat message exists");
    assert_eq!(last.role, Role::System);
    assert!(
        last.body.contains("tui.select.up") && last.body.to_lowercase().contains("overlay"),
        "chat body must name the action and explain the overlay scoping, got {:?}",
        last.body,
    );
}

#[test]
fn ctrl_z_app_suspend_visibly_notifies_user() {
    // Oracle round 6: `app.suspend` (Ctrl+Z) is advertised in the
    // bundled keymap and exposed via the command palette, but the
    // dispatcher silently consumed it through the catch-all `_` arm.
    // Bug 3 contract: every advertised chord that lands must produce
    // visible feedback - either real behavior or an explicit "not
    // yet wired" chat note.
    let mut app = fresh_app();
    let messages_before = app.chat.messages.len();
    let action = app.execute_action_for_tests("app.suspend");
    assert!(matches!(action, AppAction::Consumed(_)));
    assert!(
        app.chat.messages.len() > messages_before,
        "app.suspend chord must push a visible chat message",
    );
    let last = app.chat.messages.last().expect("chat message exists");
    assert_eq!(last.role, Role::System);
    assert!(
        last.body.contains("app.suspend") && last.body.to_lowercase().contains("not yet"),
        "chat body must name the action and flag it as not yet wired, got {:?}",
        last.body,
    );
}

#[test]
fn ctrl_t_dispatches_toggle_thinking_visibility() {
    let mut app = fresh_app();
    let action = app.handle_key(ev(KeyCode::Char('t'), KeyModifiers::CONTROL));
    assert_eq!(action, AppAction::ToggleThinkingVisibility);
}

#[test]
fn ctrl_o_dispatches_toggle_tools_expanded() {
    let mut app = fresh_app();
    let action = app.handle_key(ev(KeyCode::Char('o'), KeyModifiers::CONTROL));
    assert_eq!(action, AppAction::ToggleToolsExpanded);
}

#[test]
fn neo_question_mark_opens_help_overlay() {
    let mut app = fresh_app();
    // `?` in normal mode opens help. In input mode it inserts the
    // character. Today input focus is the default, so we should see
    // the literal insert UNLESS the keymap declares `?` as `neo.help.open`
    // under `app.*` precedence. Test the contract however the keymap
    // resolves it.
    let action = app.handle_key(ev(KeyCode::Char('?'), KeyModifiers::NONE));
    // Default keymap binds `?` to `neo.help.open` under `app.*` so it
    // wins precedence even from Input focus.
    assert!(
        matches!(action, AppAction::OpenHelp | AppAction::Consumed(_)),
        "got {action:?}",
    );
}

#[test]
fn slash_on_empty_input_opens_slash_overlay() {
    let mut app = fresh_app();
    assert!(app.overlay.is_none(), "no overlay open at start");
    let action = app.handle_key(ev(KeyCode::Char('/'), KeyModifiers::NONE));
    assert_eq!(action, AppAction::Consumed("neo.slash.open".into()));
    assert!(
        matches!(app.overlay, Some(Overlay::Slash(_))),
        "slash overlay must be open, got {:?}",
        app.overlay.is_some(),
    );
    assert_eq!(
        app.input_buffer(),
        "",
        "`/` must not leak into the input buffer when it opens the menu",
    );
}

#[test]
fn slash_in_nonempty_input_inserts_literal_character() {
    let mut app = fresh_app();
    app.handle_key(ev(KeyCode::Char('h'), KeyModifiers::NONE));
    app.handle_key(ev(KeyCode::Char('i'), KeyModifiers::NONE));
    let action = app.handle_key(ev(KeyCode::Char('/'), KeyModifiers::NONE));
    assert_eq!(action, AppAction::Consumed("(literal)".into()));
    assert!(app.overlay.is_none(), "must not open slash overlay mid-prompt");
    assert_eq!(app.input_buffer(), "hi/");
}

#[test]
fn slash_overlay_enter_dispatches_selected_action() {
    let mut app = fresh_app();
    app.handle_key(ev(KeyCode::Char('/'), KeyModifiers::NONE));
    // First slash entry is `/help` -> action_id `neo.help`, which
    // opens the help overlay (replacing the slash one).
    let action = app.handle_key(ev(KeyCode::Enter, KeyModifiers::NONE));
    assert_eq!(action, AppAction::OpenHelp);
    assert!(
        matches!(app.overlay, Some(Overlay::Help(_))),
        "selecting /help must swap the slash overlay for the help overlay",
    );
}

#[test]
fn slash_overlay_filter_then_enter_dispatches_app_exit() {
    let mut app = fresh_app();
    app.handle_key(ev(KeyCode::Char('/'), KeyModifiers::NONE));
    for ch in "quit".chars() {
        app.handle_key(ev(KeyCode::Char(ch), KeyModifiers::NONE));
    }
    let action = app.handle_key(ev(KeyCode::Enter, KeyModifiers::NONE));
    // `/quit` maps to `app.exit`; with an empty buffer this resolves
    // to AppAction::Quit per the legacy Ctrl+D semantics.
    assert_eq!(action, AppAction::Quit);
}

#[test]
fn slash_overlay_esc_closes_and_releases_input() {
    let mut app = fresh_app();
    app.handle_key(ev(KeyCode::Char('/'), KeyModifiers::NONE));
    let action = app.handle_key(ev(KeyCode::Esc, KeyModifiers::NONE));
    assert_eq!(action, AppAction::Consumed("(overlay-closed)".into()));
    assert!(app.overlay.is_none());
    // The next keystroke should land in the input buffer, not in any
    // stale overlay state.
    app.handle_key(ev(KeyCode::Char('a'), KeyModifiers::NONE));
    assert_eq!(app.input_buffer(), "a");
}

#[test]
fn alt_p_opens_palette_overlay() {
    let mut app = fresh_app();
    let action = app.handle_key(ev(KeyCode::Char('p'), KeyModifiers::ALT));
    assert_eq!(action, AppAction::OpenPalette);
    assert!(
        matches!(app.overlay, Some(Overlay::Palette(_))),
        "Alt+P must open the command palette overlay",
    );
}

#[test]
fn shift_ctrl_p_does_not_open_palette_after_rebind() {
    let mut app = fresh_app();
    // After the chord rebind, shift+ctrl+p hits the legacy
    // app.model.cycleBackward binding and must NOT open the palette.
    let action = app.handle_key(ev(
        KeyCode::Char('p'),
        KeyModifiers::CONTROL | KeyModifiers::SHIFT,
    ));
    assert_eq!(action, AppAction::CycleModel { forward: false });
    assert!(app.overlay.is_none());
}

#[test]
fn palette_filter_then_enter_dispatches_interrupt_action() {
    let mut app = fresh_app();
    app.handle_key(ev(KeyCode::Char('p'), KeyModifiers::ALT));
    for ch in "app.interrupt".chars() {
        app.handle_key(ev(KeyCode::Char(ch), KeyModifiers::NONE));
    }
    let action = app.handle_key(ev(KeyCode::Enter, KeyModifiers::NONE));
    assert_eq!(action, AppAction::Interrupt);
    assert!(
        app.overlay.is_none(),
        "palette overlay must close after dispatching the selected action",
    );
}

#[test]
fn slash_typed_in_empty_buffer_opens_slash_overlay() {
    let mut app = fresh_app();
    let action = app.handle_key(ev(KeyCode::Char('/'), KeyModifiers::NONE));
    let AppAction::Consumed(label) = action else {
        panic!("expected Consumed(neo.slash.open), got {action:?}");
    };
    assert_eq!(label, "neo.slash.open");
    assert!(matches!(app.overlay, Some(Overlay::Slash(_))));
}

#[test]
fn slash_typed_in_nonempty_buffer_inserts_literally() {
    let mut app = fresh_app();
    app.handle_key(ev(KeyCode::Char('h'), KeyModifiers::NONE));
    app.handle_key(ev(KeyCode::Char('i'), KeyModifiers::NONE));
    let action = app.handle_key(ev(KeyCode::Char('/'), KeyModifiers::NONE));
    let AppAction::Consumed(label) = action else {
        panic!("expected literal Consumed, got {action:?}");
    };
    assert_eq!(label, "(literal)");
    assert!(app.overlay.is_none(), "must not open slash menu mid-prompt");
    assert_eq!(app.input_buffer(), "hi/");
}

#[test]
fn slash_overlay_enter_dispatches_first_command_via_selected() {
    let mut app = fresh_app();
    app.handle_key(ev(KeyCode::Char('/'), KeyModifiers::NONE));
    assert!(matches!(app.overlay, Some(Overlay::Slash(_))));
    // First slash command is `/help` -> `neo.help` -> opens the help overlay.
    let action = app.handle_key(ev(KeyCode::Enter, KeyModifiers::NONE));
    assert_eq!(action, AppAction::OpenHelp);
    assert!(matches!(app.overlay, Some(Overlay::Help(_))));
}

#[test]
fn alt_p_opens_command_palette() {
    let mut app = fresh_app();
    let action = app.handle_key(ev(KeyCode::Char('p'), KeyModifiers::ALT));
    assert_eq!(action, AppAction::OpenPalette);
    assert!(matches!(app.overlay, Some(Overlay::Palette(_))));
}

#[test]
fn ctrl_shift_p_no_longer_opens_palette_after_rebind() {
    let mut app = fresh_app();
    let action = app.handle_key(ev(
        KeyCode::Char('p'),
        KeyModifiers::CONTROL | KeyModifiers::SHIFT,
    ));
    assert_eq!(action, AppAction::CycleModel { forward: false });
    assert!(
        app.overlay.is_none(),
        "ctrl+shift+p must NOT open the palette after the rebind to alt+p",
    );
}

#[test]
fn esc_closes_open_overlay() {
    let mut app = fresh_app();
    app.handle_key(ev(KeyCode::Char('p'), KeyModifiers::ALT));
    assert!(matches!(app.overlay, Some(Overlay::Palette(_))));
    let action = app.handle_key(ev(KeyCode::Esc, KeyModifiers::NONE));
    assert_eq!(action, AppAction::Consumed("(overlay-closed)".into()));
    assert!(app.overlay.is_none());
}

#[test]
fn action_to_command_maps_submit_prompt_to_prompt_command() {
    let action = AppAction::SubmitPrompt("hello".into());
    let cmd = App::action_to_command(&action).expect("non-empty prompt must produce Prompt");
    let Command::Prompt { message, .. } = cmd else {
        panic!("expected Command::Prompt, got {cmd:?}");
    };
    assert_eq!(message, "hello");
}

#[test]
fn action_to_command_drops_empty_submit_prompt() {
    let action = AppAction::SubmitPrompt(String::new());
    assert!(App::action_to_command(&action).is_none());
}

#[test]
fn action_to_command_maps_follow_up_to_follow_up_command() {
    let action = AppAction::FollowUp("ping".into());
    let cmd = App::action_to_command(&action).expect("non-empty follow-up must map");
    let Command::FollowUp { message, .. } = cmd else {
        panic!("expected Command::FollowUp, got {cmd:?}");
    };
    assert_eq!(message, "ping");
}

#[test]
fn action_to_command_maps_interrupt_to_abort() {
    let cmd = App::action_to_command(&AppAction::Interrupt).expect("Interrupt must map");
    assert!(matches!(cmd, Command::Abort { .. }));
}

#[test]
fn action_to_command_maps_cycle_model_regardless_of_direction() {
    let forward = App::action_to_command(&AppAction::CycleModel { forward: true }).expect("forward must map");
    let backward =
        App::action_to_command(&AppAction::CycleModel { forward: false }).expect("backward must map");
    // The wire protocol only carries forward cycling today; both
    // directions reduce to the same Command. The forward flag is
    // preserved on AppAction for future UI use.
    assert!(matches!(forward, Command::CycleModel { .. }));
    assert!(matches!(backward, Command::CycleModel { .. }));
}

#[test]
fn action_to_command_maps_cycle_thinking_level() {
    let cmd = App::action_to_command(&AppAction::CycleThinkingLevel).expect("thinking cycle must map");
    assert!(matches!(cmd, Command::CycleThinkingLevel { .. }));
}

#[test]
fn action_to_command_maps_open_model_picker_to_get_available_models() {
    let cmd = App::action_to_command(&AppAction::OpenModelPicker).expect("model picker must map");
    assert!(matches!(cmd, Command::GetAvailableModels { .. }));
}

#[test]
fn action_to_command_returns_none_for_local_only_actions() {
    for action in [
        AppAction::Quit,
        AppAction::Consumed("anything".into()),
        AppAction::Ignored,
        AppAction::OpenHelp,
        AppAction::OpenPalette,
        AppAction::ExternalEditor,
        AppAction::ToggleThinkingVisibility,
        AppAction::ToggleToolsExpanded,
    ] {
        assert!(
            App::action_to_command(&action).is_none(),
            "expected None for {action:?}",
        );
    }
}

#[test]
fn apply_inbound_agent_start_marks_footer_busy() {
    let mut app = fresh_app();
    app.apply_inbound(Inbound::Event(RpcEvent::AgentStart));
    assert_eq!(app.footer.status, Status::Busy);
    assert_eq!(app.footer.status_label, "thinking");
}

#[test]
fn apply_inbound_message_start_updates_footer_only() {
    let mut app = fresh_app();
    let before = app.chat_snapshot().messages.len();
    app.apply_inbound(Inbound::Event(RpcEvent::MessageStart {
        message: serde_json::json!({"role": "assistant"}),
    }));
    let after = app.chat_snapshot().messages.len();
    assert_eq!(
        after, before,
        "MessageStart must not push a placeholder bubble; the bubble appears lazily on the first text_delta in MessageUpdate"
    );
    assert_eq!(app.footer.status, Status::Streaming);
    assert_eq!(app.footer.status_label, "streaming");
}

#[test]
fn apply_inbound_message_end_drops_empty_assistant_bubble() {
    let mut app = fresh_app();
    app.apply_inbound(Inbound::Event(RpcEvent::MessageStart {
        message: serde_json::json!({"role": "assistant"}),
    }));
    let after_start = app.chat_snapshot().messages.len();
    app.apply_inbound(Inbound::Event(RpcEvent::MessageEnd {
        message: serde_json::json!({"role": "assistant"}),
    }));
    let after_end = app.chat_snapshot().messages.len();
    assert_eq!(
        after_end, after_start,
        "MessageEnd with no text_delta in between must leave the chat untouched (no phantom empty senpi bubble)"
    );
    assert_eq!(app.footer.status, Status::Idle);
}

#[test]
fn apply_inbound_message_update_text_delta_appends_to_last_assistant_body() {
    let mut app = fresh_app();
    app.apply_inbound(Inbound::Event(RpcEvent::MessageStart {
        message: serde_json::json!({"role": "assistant"}),
    }));
    for chunk in ["he", "llo", " world"] {
        app.apply_inbound(Inbound::Event(RpcEvent::MessageUpdate {
            message: serde_json::json!({}),
            assistant_message_event: Some(serde_json::json!({
                "type": "text_delta",
                "delta": chunk,
            })),
        }));
    }
    let last = app.chat_snapshot().messages.last().expect("must have a message");
    assert_eq!(last.body, "hello world");
}

#[test]
fn apply_inbound_tool_execution_start_pushes_running_tool_card() {
    let mut app = fresh_app();
    app.apply_inbound(Inbound::Event(RpcEvent::ToolExecutionStart {
        tool_call_id: "call-1".into(),
        tool_name: "bash".into(),
        args: serde_json::json!({"command": "ls"}),
    }));
    let last = app.chat_snapshot().messages.last().expect("must have a message");
    let tool = last.tool.as_ref().expect("must have a tool card");
    assert_eq!(tool.name, "bash");
    assert_eq!(tool.status, ToolStatus::Running);
    assert_eq!(app.footer.status, Status::ToolRunning);
}

#[test]
fn apply_inbound_tool_execution_end_success_marks_tool_success() {
    let mut app = fresh_app();
    app.apply_inbound(Inbound::Event(RpcEvent::ToolExecutionStart {
        tool_call_id: "call-1".into(),
        tool_name: "bash".into(),
        args: serde_json::json!({"command": "ls"}),
    }));
    app.apply_inbound(Inbound::Event(RpcEvent::ToolExecutionEnd {
        tool_call_id: "call-1".into(),
        tool_name: "bash".into(),
        result: serde_json::json!({}),
        is_error: false,
    }));
    let tool = app
        .chat_snapshot()
        .messages
        .last()
        .and_then(|m| m.tool.as_ref())
        .expect("tool card must exist");
    assert_eq!(tool.status, ToolStatus::Success);
}

#[test]
fn apply_inbound_tool_execution_end_error_marks_tool_failed() {
    let mut app = fresh_app();
    app.apply_inbound(Inbound::Event(RpcEvent::ToolExecutionStart {
        tool_call_id: "call-1".into(),
        tool_name: "bash".into(),
        args: serde_json::json!({}),
    }));
    app.apply_inbound(Inbound::Event(RpcEvent::ToolExecutionEnd {
        tool_call_id: "call-1".into(),
        tool_name: "bash".into(),
        result: serde_json::json!({}),
        is_error: true,
    }));
    let tool = app
        .chat_snapshot()
        .messages
        .last()
        .and_then(|m| m.tool.as_ref())
        .expect("tool card must exist");
    assert_eq!(tool.status, ToolStatus::Failed);
}

#[test]
fn apply_inbound_message_end_with_error_message_surfaces_to_chat_and_footer() {
    // Oracle round 6: the agent loop ships assistant/provider
    // failures via `message_end` with `message.errorMessage` set
    // (see packages/agent/src/agent-loop.ts buildErrorAssistantMessage).
    // The neo TUI's `MessageEnd` arm previously only dropped empty
    // assistant bubbles and flipped the footer to idle - the error
    // string was silently discarded. Bug 3: surface it as a chat
    // error so the user sees WHY the turn ended.
    let mut app = fresh_app();
    app.apply_inbound(Inbound::Event(RpcEvent::MessageEnd {
        message: serde_json::json!({
            "role": "assistant",
            "stopReason": "error",
            "errorMessage": "rate limit exceeded; retry after 60s",
        }),
    }));
    let last = app
        .chat
        .messages
        .last()
        .expect("message_end with errorMessage must push a chat message");
    assert_eq!(last.role, Role::Error);
    assert!(
        last.body.contains("rate limit exceeded"),
        "chat body must include the assistant error message, got {:?}",
        last.body,
    );
    assert_eq!(app.footer.status, Status::Error);
}

#[test]
fn apply_inbound_compaction_end_aborted_surfaces_to_chat() {
    // Oracle round 6: `CompactionEnd { aborted: true }` was silently
    // dropped by the `_ => {}` catch-all in `apply_event`. The user
    // had no idea the compaction attempt failed.
    let mut app = fresh_app();
    app.apply_inbound(Inbound::Event(RpcEvent::CompactionEnd {
        reason: Some("auto-threshold".into()),
        result: serde_json::json!({}),
        aborted: true,
        will_retry: false,
        error_message: None,
    }));
    let last = app
        .chat
        .messages
        .last()
        .expect("aborted compaction must push a chat message");
    assert_eq!(last.role, Role::Error);
    assert!(
        last.body.to_lowercase().contains("compaction"),
        "chat body must mention compaction, got {:?}",
        last.body,
    );
}

#[test]
fn apply_inbound_compaction_end_with_error_message_surfaces_to_chat() {
    // Oracle round 6: same defect, error-message variant.
    let mut app = fresh_app();
    app.apply_inbound(Inbound::Event(RpcEvent::CompactionEnd {
        reason: None,
        result: serde_json::json!({}),
        aborted: false,
        will_retry: false,
        error_message: Some("context too large to summarize".into()),
    }));
    let last = app
        .chat
        .messages
        .last()
        .expect("compaction error must push a chat message");
    assert_eq!(last.role, Role::Error);
    assert!(
        last.body.contains("context too large to summarize"),
        "chat body must surface the compaction error, got {:?}",
        last.body,
    );
}

#[test]
fn apply_inbound_compaction_end_success_does_not_disturb_chat() {
    // Successful compaction is silent by design; only failure
    // paths must surface. Locks the contract so the round-6 fix
    // does not over-fire on clean compactions.
    let mut app = fresh_app();
    let before = app.chat.messages.len();
    app.apply_inbound(Inbound::Event(RpcEvent::CompactionEnd {
        reason: Some("auto-threshold".into()),
        result: serde_json::json!({}),
        aborted: false,
        will_retry: false,
        error_message: None,
    }));
    assert_eq!(app.chat.messages.len(), before);
}

#[test]
fn apply_inbound_auto_retry_end_failure_surfaces_to_chat() {
    // Oracle round 6: `AutoRetryEnd { success: false, final_error }`
    // was dropped by the catch-all `_ => {}`. When retries are
    // exhausted the user must see the final error.
    let mut app = fresh_app();
    app.apply_inbound(Inbound::Event(RpcEvent::AutoRetryEnd {
        success: false,
        attempt: 3,
        final_error: Some("upstream 5xx after 3 attempts".into()),
    }));
    let last = app
        .chat
        .messages
        .last()
        .expect("failed auto-retry must push a chat message");
    assert_eq!(last.role, Role::Error);
    assert!(
        last.body.contains("upstream 5xx after 3 attempts"),
        "chat body must surface the final retry error, got {:?}",
        last.body,
    );
    assert_eq!(app.footer.status, Status::Error);
}

#[test]
fn apply_inbound_auto_retry_end_success_does_not_disturb_chat() {
    // Successful retry recovery is silent; only failure surfaces.
    let mut app = fresh_app();
    let before = app.chat.messages.len();
    app.apply_inbound(Inbound::Event(RpcEvent::AutoRetryEnd {
        success: true,
        attempt: 2,
        final_error: None,
    }));
    assert_eq!(app.chat.messages.len(), before);
}

#[test]
fn apply_inbound_extension_error_pushes_error_message() {
    let mut app = fresh_app();
    app.apply_inbound(Inbound::Event(RpcEvent::ExtensionError {
        extension_path: "/tmp/x".into(),
        event: "agent_start".into(),
        error: "boom".into(),
    }));
    let last = app.chat_snapshot().messages.last().expect("must push a message");
    assert_eq!(last.role, Role::Error);
    assert_eq!(last.body, "boom");
    assert_eq!(app.footer.status, Status::Error);
}

#[test]
fn app_inbound_error_shows_error_message_in_chat() {
    let mut app = fresh_app();
    app.apply_inbound(Inbound::Error {
        exit_code: Some(2),
        stderr_tail: "panic: thing".into(),
    });

    let last = app.chat.messages.last().expect("must push error message");
    assert_eq!(last.role, Role::Error);
    assert!(last.body.contains("panic: thing"));
}

#[test]
fn app_inbound_error_sets_footer_error_state() {
    let mut app = fresh_app();
    app.apply_inbound(Inbound::Error {
        exit_code: Some(2),
        stderr_tail: "panic: thing".into(),
    });

    assert_eq!(app.footer.status, Status::Error);
    assert!(!app.footer.connected);
    assert!(app.footer.status_label.contains("backend") || app.footer.status_label.contains("error"));
}

#[test]
fn app_inbound_disconnected_pushes_system_message() {
    let mut app = fresh_app();
    app.apply_inbound(Inbound::Disconnected);

    let last = app.chat.messages.last().expect("must push system message");
    assert_eq!(last.role, Role::System);
    assert!(last.body.contains("disconnected"));
    assert!(!app.footer.connected);
}

#[test]
fn app_inbound_parse_error_surfaces_to_chat_and_footer() {
    // Bug 3 regression: protocol-level failures must NEVER be silent.
    // The user's exact complaint was "에러가났으면 났다 안났으면 안났다 전혀안되노"
    // ("if there's an error, say so; if there isn't, say so - it doesn't
    // work at all"). A `ParseError` means the backend sent something the
    // TUI cannot decode; that is an error condition and must show up in
    // chat + footer just like an `Inbound::Error`. The previous version
    // logged this to `tracing::warn!` only, which is invisible to a
    // user running `senpi --neo` in a terminal.
    let mut app = fresh_app();
    app.apply_inbound(Inbound::ParseError {
        line: "garbage{".into(),
        source: "expected `,` or `}` at line 1 column 8".into(),
    });

    let last = app
        .chat
        .messages
        .last()
        .expect("parse error must push a chat message");
    assert_eq!(last.role, Role::Error);
    assert!(
        last.body.contains("expected `,` or `}`"),
        "chat error body must surface the decoder error, got {:?}",
        last.body,
    );
    assert_eq!(app.footer.status, Status::Error);
    assert!(
        app.footer.status_label.contains("protocol") || app.footer.status_label.contains("parse"),
        "footer must label this as a protocol/parse error, got {:?}",
        app.footer.status_label,
    );
}

#[test]
fn app_inbound_failed_response_surfaces_to_chat_and_footer() {
    // Bug 3 regression: a `Response { success: false, error: Some(_) }`
    // is the backend explicitly telling the TUI "your command failed".
    // Previously `apply_inbound` matched `Inbound::Response(_)` to `{}`
    // and silently dropped it - so the user got no signal that, e.g.,
    // `Submit` or `GetAvailableModels` failed on the agent side.
    use senpi_neo_tui::rpc::envelope::Response;

    let mut app = fresh_app();
    app.apply_inbound(Inbound::Response(Response {
        id: Some("cmd-7".into()),
        command: "submit".into(),
        success: false,
        data: None,
        error: Some("model unavailable".into()),
    }));

    let last = app
        .chat
        .messages
        .last()
        .expect("failed response must push a chat message");
    assert_eq!(last.role, Role::Error);
    assert!(
        last.body.contains("model unavailable"),
        "chat error body must include the backend error string, got {:?}",
        last.body,
    );
    assert_eq!(app.footer.status, Status::Error);
}

#[test]
fn app_inbound_failed_response_without_error_message_still_surfaces() {
    // Same as above but the backend omitted the human-readable error
    // string. The TUI must STILL surface this as a failure - silently
    // dropping a `success: false` frame is the original Bug 3.
    use senpi_neo_tui::rpc::envelope::Response;

    let mut app = fresh_app();
    app.apply_inbound(Inbound::Response(Response {
        id: None,
        command: "cycle_model".into(),
        success: false,
        data: None,
        error: None,
    }));

    let last = app
        .chat
        .messages
        .last()
        .expect("failed response with no error message must still push a chat message");
    assert_eq!(last.role, Role::Error);
    assert!(
        last.body.contains("cycle_model") || last.body.to_lowercase().contains("failed"),
        "chat error must mention the failing command or that it failed, got {:?}",
        last.body,
    );
    assert_eq!(app.footer.status, Status::Error);
}

#[test]
fn app_inbound_successful_response_does_not_disturb_chat_or_footer() {
    // Successful responses are protocol acks (e.g. ID echo, no data).
    // They must NOT push noise into chat or flip the footer status.
    use senpi_neo_tui::rpc::envelope::Response;

    let mut app = fresh_app();
    let messages_before = app.chat.messages.len();
    let status_before = app.footer.status;

    app.apply_inbound(Inbound::Response(Response {
        id: Some("cmd-1".into()),
        command: "abort".into(),
        success: true,
        data: None,
        error: None,
    }));

    assert_eq!(app.chat.messages.len(), messages_before);
    assert_eq!(app.footer.status, status_before);
}

#[test]
fn app_recovers_from_error_on_next_message() {
    let mut app = fresh_app();
    app.apply_inbound(Inbound::Error {
        exit_code: Some(2),
        stderr_tail: "panic: thing".into(),
    });
    app.apply_inbound(Inbound::Event(RpcEvent::AgentStart));

    assert!(matches!(app.footer.status, Status::Busy | Status::Streaming));
    assert!(app.footer.connected);
    assert_ne!(app.footer.status_label, "backend error");
}

#[test]
fn cursor_left_then_insert_lands_mid_buffer() {
    let mut app = fresh_app();
    app.handle_key(ev(KeyCode::Char('a'), KeyModifiers::NONE));
    app.handle_key(ev(KeyCode::Char('c'), KeyModifiers::NONE));
    app.handle_key(ev(KeyCode::Left, KeyModifiers::NONE));
    app.handle_key(ev(KeyCode::Char('b'), KeyModifiers::NONE));
    assert_eq!(app.input_buffer(), "abc");
}

#[test]
fn home_jumps_to_line_start() {
    let mut app = fresh_app();
    for ch in "hello".chars() {
        app.handle_key(ev(KeyCode::Char(ch), KeyModifiers::NONE));
    }
    app.handle_key(ev(KeyCode::Home, KeyModifiers::NONE));
    app.handle_key(ev(KeyCode::Char('x'), KeyModifiers::NONE));
    assert_eq!(app.input_buffer(), "xhello");
}

#[test]
fn ctrl_w_deletes_previous_word() {
    let mut app = fresh_app();
    for ch in "foo bar baz".chars() {
        app.handle_key(ev(KeyCode::Char(ch), KeyModifiers::NONE));
    }
    app.handle_key(ev(KeyCode::Char('w'), KeyModifiers::CONTROL));
    assert_eq!(app.input_buffer(), "foo bar ");
}

#[test]
fn ctrl_c_in_input_focus_clears_buffer_when_nonempty() {
    let mut app = fresh_app();
    for ch in "hi".chars() {
        app.handle_key(ev(KeyCode::Char(ch), KeyModifiers::NONE));
    }
    let action = app.handle_key(ev(KeyCode::Char('c'), KeyModifiers::CONTROL));
    assert!(app.input_buffer().is_empty());
    assert!(matches!(action, AppAction::Consumed(_)));
}

#[test]
fn ctrl_c_in_input_focus_interrupts_when_empty() {
    let mut app = fresh_app();
    let action = app.handle_key(ev(KeyCode::Char('c'), KeyModifiers::CONTROL));
    assert_eq!(action, AppAction::Interrupt);
}

#[test]
fn question_mark_in_empty_buffer_opens_help_overlay() {
    let mut app = fresh_app();
    let action = app.handle_key(ev(KeyCode::Char('?'), KeyModifiers::NONE));
    assert_eq!(action, AppAction::OpenHelp);
}

#[test]
fn question_mark_in_nonempty_buffer_inserts_literal() {
    let mut app = fresh_app();
    for ch in "why".chars() {
        app.handle_key(ev(KeyCode::Char(ch), KeyModifiers::NONE));
    }
    let action = app.handle_key(ev(KeyCode::Char('?'), KeyModifiers::NONE));
    assert!(matches!(action, AppAction::Consumed(_)));
    assert_eq!(app.input_buffer(), "why?");
    assert!(app.overlay.is_none());
}

#[test]
fn cursor_up_traverses_lines_with_preferred_column() {
    let mut app = fresh_app();
    for ch in "hello".chars() {
        app.handle_key(ev(KeyCode::Char(ch), KeyModifiers::NONE));
    }
    app.handle_key(ev(KeyCode::Enter, KeyModifiers::SHIFT));
    for ch in "hi".chars() {
        app.handle_key(ev(KeyCode::Char(ch), KeyModifiers::NONE));
    }
    assert_eq!(app.input_buffer(), "hello\nhi");
    app.handle_key(ev(KeyCode::Up, KeyModifiers::NONE));
    app.handle_key(ev(KeyCode::Char('X'), KeyModifiers::NONE));
    assert_eq!(app.input_buffer(), "heXllo\nhi");
}

#[test]
fn ctrl_y_yanks_last_killed_word() {
    let mut app = fresh_app();
    for ch in "foo bar".chars() {
        app.handle_key(ev(KeyCode::Char(ch), KeyModifiers::NONE));
    }
    app.handle_key(ev(KeyCode::Char('w'), KeyModifiers::CONTROL));
    assert_eq!(app.input_buffer(), "foo ");
    app.handle_key(ev(KeyCode::Char('y'), KeyModifiers::CONTROL));
    assert_eq!(app.input_buffer(), "foo bar");
}

#[test]
fn ctrl_minus_undoes_last_edit() {
    let mut app = fresh_app();
    app.handle_key(ev(KeyCode::Char('a'), KeyModifiers::NONE));
    app.handle_key(ev(KeyCode::Char('b'), KeyModifiers::NONE));
    assert_eq!(app.input_buffer(), "ab");
    app.handle_key(ev(KeyCode::Char('-'), KeyModifiers::CONTROL));
    assert_eq!(app.input_buffer(), "a");
}

#[test]
fn ctrl_c_clear_pushes_buffer_to_kill_ring_for_yank() {
    let mut app = fresh_app();
    for ch in "hello".chars() {
        app.handle_key(ev(KeyCode::Char(ch), KeyModifiers::NONE));
    }
    app.handle_key(ev(KeyCode::Char('c'), KeyModifiers::CONTROL));
    assert!(app.input_buffer().is_empty());
    app.handle_key(ev(KeyCode::Char('y'), KeyModifiers::CONTROL));
    assert_eq!(app.input_buffer(), "hello");
}

#[test]
fn korean_hangul_inserts_at_cursor_and_backspace_deletes_one_grapheme() {
    let mut app = fresh_app();
    for ch in "한글".chars() {
        app.handle_key(ev(KeyCode::Char(ch), KeyModifiers::NONE));
    }
    assert_eq!(app.input_buffer(), "한글");
    app.handle_key(ev(KeyCode::Backspace, KeyModifiers::NONE));
    assert_eq!(app.input_buffer(), "한");
    app.handle_key(ev(KeyCode::Backspace, KeyModifiers::NONE));
    assert!(app.input_buffer().is_empty());
}

#[test]
fn cursor_left_steps_one_grapheme_through_cjk() {
    let mut app = fresh_app();
    for ch in "abc한국".chars() {
        app.handle_key(ev(KeyCode::Char(ch), KeyModifiers::NONE));
    }
    app.handle_key(ev(KeyCode::Left, KeyModifiers::NONE));
    app.handle_key(ev(KeyCode::Char('X'), KeyModifiers::NONE));
    assert_eq!(app.input_buffer(), "abc한X국");
}

#[test]
fn emoji_zwj_sequence_treated_as_one_grapheme() {
    let mut app = fresh_app();
    let family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F466}";
    for ch in family.chars() {
        app.handle_key(ev(KeyCode::Char(ch), KeyModifiers::NONE));
    }
    assert_eq!(app.input_buffer(), family);
    app.handle_key(ev(KeyCode::Backspace, KeyModifiers::NONE));
    assert!(
        app.input_buffer().is_empty(),
        "ZWJ family emoji must collapse in one backspace"
    );
}

#[test]
fn app_init_writes_modify_other_keys_when_tmux() {
    with_tmux_env(|| {
        let bytes = App::init_terminal_writes();

        assert!(
            bytes
                .windows(b"\x1b[>4;2m".len())
                .any(|window| window == b"\x1b[>4;2m"),
            "tmux init writes must enable modifyOtherKeys mode 2: {bytes:?}",
        );
    });
}

#[test]
fn app_cleanup_writes_disable_modify_other_keys() {
    with_tmux_env(|| {
        let bytes = App::cleanup_terminal_writes();

        assert!(
            bytes
                .windows(b"\x1b[>4;0m".len())
                .any(|window| window == b"\x1b[>4;0m"),
            "tmux cleanup writes must disable modifyOtherKeys: {bytes:?}",
        );
    });
}

#[test]
fn app_arrow_up_with_empty_buffer_recalls_history() {
    let mut app = fresh_app();
    for prompt in ["first prompt", "second prompt"] {
        for ch in prompt.chars() {
            app.handle_key(ev(KeyCode::Char(ch), KeyModifiers::NONE));
        }
        app.handle_key(ev(KeyCode::Enter, KeyModifiers::NONE));
    }

    assert!(app.input_buffer().is_empty());
    app.handle_key(ev(KeyCode::Up, KeyModifiers::NONE));

    assert_eq!(app.input_buffer(), "second prompt");
}

#[test]
fn app_arrow_up_with_nonempty_buffer_moves_cursor() {
    let mut app = fresh_app();
    app.input.push_history("history entry");
    app.input.insert_str("hello\nhi");

    app.handle_key(ev(KeyCode::Up, KeyModifiers::NONE));
    app.handle_key(ev(KeyCode::Char('X'), KeyModifiers::NONE));

    assert_eq!(app.input_buffer(), "heXllo\nhi");
}

#[test]
fn app_autocomplete_triggers_on_at_for_path_completion() {
    let mut app = fresh_app();
    app.header.cwd = env!("CARGO_MANIFEST_DIR").into();
    app.input.insert_str("@./Carg");

    let AutocompleteResult::Path(items) = app.compute_autocomplete() else {
        panic!("expected path autocomplete result");
    };

    assert!(
        items.iter().any(|item| item.label == "Cargo.toml"),
        "expected Cargo.toml in path autocomplete items: {items:?}",
    );
}

#[test]
fn app_mouse_wheel_scrolls_chat() {
    let mut app = fresh_app();

    app.handle_mouse(MouseEvent {
        kind: MouseEventKind::ScrollUp,
        column: 0,
        row: 0,
        modifiers: KeyModifiers::NONE,
    });

    assert!(app.chat.scroll_offset > 0);
}

#[test]
fn app_mouse_wheel_at_bottom_does_nothing() {
    let mut app = fresh_app();
    assert_eq!(app.chat.scroll_offset, 0);

    app.handle_mouse(MouseEvent {
        kind: MouseEventKind::ScrollDown,
        column: 0,
        row: 0,
        modifiers: KeyModifiers::NONE,
    });

    assert_eq!(app.chat.scroll_offset, 0);
}
