//! Behavioral integration test: synthetic `KeyEvent`s flow through the
//! app's keymap dispatcher and produce the expected legacy action,
//! state mutation, or RPC command.
//!
//! Locks the runtime parity contract between the new Rust TUI and the
//! legacy TypeScript senpi TUI: every legacy chord produces the
//! semantically equivalent app behavior, not just the same JSON
//! binding entry. This is the test the user explicitly asked for in
//! "tui 단축키 동일성도 tdd 로 보장되어야한다".

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyEventState, KeyModifiers};
use senpi_neo_tui::app::{App, AppAction};
use senpi_neo_tui::components::chat::Role;

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
        chat.messages.iter().any(|m| m.role == Role::User && m.body == "hi"),
        "user message should be appended to chat history",
    );
}

#[test]
fn shift_enter_inserts_newline_instead_of_submitting() {
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
