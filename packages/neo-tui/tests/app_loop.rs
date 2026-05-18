//! Behavioral integration test: synthetic `KeyEvent`s flow through the
//! app's keymap dispatcher and produce the expected legacy action,
//! state mutation, or RPC command.
//!
//! Locks the runtime parity contract between the new Rust TUI and the
//! legacy TypeScript senpi TUI: every legacy chord produces the
//! semantically equivalent app behavior, not just the same JSON
//! binding entry. The user explicitly required this kind of TDD
//! coverage on keybinding equivalence.

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyEventState, KeyModifiers};
use senpi_neo_tui::app::{App, AppAction};
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
