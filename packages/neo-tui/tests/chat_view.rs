use ratatui::{Terminal, backend::TestBackend, buffer::Buffer, layout::Rect, style::Color};
use senpi_neo_tui::{
    components::chat::{self, ChatState, ChatViewOpts, ToolCardData, ToolStatus},
    load_bundled_dark_theme,
    theme::{ResolvedTheme, Token},
};

fn theme() -> ResolvedTheme {
    load_bundled_dark_theme().expect("bundled dark theme must resolve")
}

fn render_chat(state: &ChatState, width: u16, height: u16) -> (Buffer, ResolvedTheme) {
    let backend = TestBackend::new(width, height);
    let mut terminal = Terminal::new(backend).expect("test terminal must initialize");
    let theme = theme();
    terminal
        .draw(|frame| {
            chat::render(
                frame,
                Rect::new(0, 0, width, height),
                &theme,
                state,
                ChatViewOpts::default(),
            );
        })
        .expect("chat render must complete");
    (terminal.backend().buffer().clone(), theme)
}

fn buffer_text(buffer: &Buffer) -> String {
    let area = buffer.area;
    let mut text = String::new();
    for y in area.y..area.y + area.height {
        for x in area.x..area.x + area.width {
            if let Some(cell) = buffer.cell((x, y)) {
                text.push_str(cell.symbol());
            }
        }
        text.push('\n');
    }
    text
}

fn has_cell_with_fg(buffer: &Buffer, expected: Color) -> bool {
    let area = buffer.area;
    (area.y..area.y + area.height).any(|y| {
        (area.x..area.x + area.width).any(|x| {
            buffer
                .cell((x, y))
                .is_some_and(|cell| cell.fg == expected && cell.symbol() != " ")
        })
    })
}

#[test]
fn chat_assistant_message_renders_through_markdown() {
    let mut state = ChatState::new();
    state.push_assistant("# Heading\n\n**bold** text".to_string());

    let (buffer, theme) = render_chat(&state, 80, 12);

    assert!(has_cell_with_fg(&buffer, theme.token(Token::MarkdownHeading)));
}

#[test]
fn chat_user_message_renders_as_plain_text() {
    let mut state = ChatState::new();
    state.push_user("# literal\n**bold** text".to_string());

    let (buffer, theme) = render_chat(&state, 80, 12);
    let text = buffer_text(&buffer);

    assert!(text.contains("# literal"));
    assert!(text.contains("**bold** text"));
    assert!(!has_cell_with_fg(&buffer, theme.token(Token::MarkdownHeading)));
}

#[test]
fn chat_scroll_sticks_to_bottom_during_streaming() {
    let mut state = ChatState::new();
    let id = state.push_assistant("start".to_string());

    state.stream_append(id, "\nmore");
    assert_eq!(state.scroll_offset, 0);

    state.scroll_up(1);
    assert!(state.scroll_offset > 0);
    let offset = state.scroll_offset;

    state.stream_append(id, "\nnew tail");
    assert_eq!(state.scroll_offset, offset);
}

#[test]
fn chat_tool_card_running_shows_blue_border() {
    let mut state = ChatState::new();
    state.push_tool(ToolCardData {
        name: "bash".to_string(),
        status: ToolStatus::Running,
        args: "ls".to_string(),
        output: String::new(),
    });

    let (buffer, theme) = render_chat(&state, 80, 12);

    assert!(has_cell_with_fg(&buffer, theme.token(Token::ToolBorderRunning)));
}

#[test]
fn chat_tool_card_success_shows_subtle_border() {
    let mut state = ChatState::new();
    state.push_tool(ToolCardData {
        name: "bash".to_string(),
        status: ToolStatus::Success,
        args: "ls".to_string(),
        output: "ok".to_string(),
    });

    let (buffer, theme) = render_chat(&state, 80, 12);

    assert!(has_cell_with_fg(&buffer, theme.token(Token::ToolBorderSuccess)));
}

#[test]
fn chat_tool_card_error_shows_red_border() {
    let mut state = ChatState::new();
    state.push_tool(ToolCardData {
        name: "bash".to_string(),
        status: ToolStatus::Error,
        args: "ls missing".to_string(),
        output: "no such file".to_string(),
    });

    let (buffer, theme) = render_chat(&state, 80, 12);

    assert!(has_cell_with_fg(&buffer, theme.token(Token::ToolBorderError)));
}

#[test]
fn chat_thinking_block_collapsed_by_default() {
    let mut state = ChatState::new();
    let id = state.push_assistant("answer".to_string());
    state.set_thinking(
        id,
        (1..=12)
            .map(|n| format!("line {n}"))
            .collect::<Vec<_>>()
            .join("\n"),
    );

    let (buffer, _) = render_chat(&state, 80, 16);
    let text = buffer_text(&buffer);

    assert!(text.contains("[thinking 12 lines, ctrl+t to toggle visibility]"));
    assert!(!text.contains("line 12"));
}

#[test]
fn chat_thinking_visible_false_hides_summary_and_body() {
    // Round 12 / real port: `ChatViewOpts::thinking_visible = false`
    // suppresses the entire thinking block - neither the summary
    // line nor the expanded body renders. Driven by Ctrl+T.
    let mut state = ChatState::new();
    let id = state.push_assistant("answer".to_string());
    state.set_thinking(id, "secret monologue".to_string());

    let backend = TestBackend::new(80, 12);
    let mut terminal = Terminal::new(backend).expect("test terminal");
    let theme = theme();
    terminal
        .draw(|frame| {
            chat::render(
                frame,
                Rect::new(0, 0, 80, 12),
                &theme,
                &state,
                ChatViewOpts {
                    thinking_visible: false,
                    tools_expanded: true,
                },
            );
        })
        .expect("render");
    let buffer = terminal.backend().buffer().clone();
    let text = buffer_text(&buffer);

    assert!(
        !text.contains("thinking 1 lines"),
        "thinking summary must be hidden when thinking_visible=false, got:\n{text}",
    );
    assert!(!text.contains("secret monologue"));
    assert!(
        text.contains("answer"),
        "assistant body must still render when thinking is hidden",
    );
}

#[test]
fn chat_tools_expanded_false_collapses_tool_card_body() {
    // Round 12 / real port: `ChatViewOpts::tools_expanded = false`
    // collapses each tool card body to a single "collapsed" hint,
    // keeping only the header rule. Driven by Ctrl+O.
    let mut state = ChatState::new();
    state.push_tool(ToolCardData {
        name: "bash".to_string(),
        status: ToolStatus::Success,
        args: "ls".to_string(),
        output: "file1\nfile2\nfile3".to_string(),
    });

    let backend = TestBackend::new(80, 12);
    let mut terminal = Terminal::new(backend).expect("test terminal");
    let theme = theme();
    terminal
        .draw(|frame| {
            chat::render(
                frame,
                Rect::new(0, 0, 80, 12),
                &theme,
                &state,
                ChatViewOpts {
                    thinking_visible: true,
                    tools_expanded: false,
                },
            );
        })
        .expect("render");
    let buffer = terminal.backend().buffer().clone();
    let text = buffer_text(&buffer);

    assert!(
        text.contains("collapsed") && text.contains("ctrl+o to expand"),
        "collapsed hint must appear when tools_expanded=false, got:\n{text}",
    );
    assert!(
        !text.contains("file1"),
        "tool body must NOT render when tools_expanded=false, got:\n{text}",
    );
}

#[test]
fn chat_thinking_block_toggle_expands() {
    let mut state = ChatState::new();
    let id = state.push_assistant("answer".to_string());
    state.set_thinking(id, "hidden body".to_string());

    state.toggle_thinking(id);
    let (buffer, _) = render_chat(&state, 80, 12);
    let text = buffer_text(&buffer);

    assert!(text.contains("hidden body"));
}

#[test]
fn chat_empty_state_shows_hint() {
    let state = ChatState::new();

    let (buffer, _) = render_chat(&state, 80, 6);
    let text = buffer_text(&buffer);

    assert!(text.contains("type a prompt below to begin..."));
    assert!(!text.contains("> senpi"));
    assert!(!text.contains("> you"));
}

#[test]
fn chat_error_message_renders_with_error_token() {
    let mut state = ChatState::new();
    state.push_error("boom".to_string());

    let (buffer, theme) = render_chat(&state, 80, 12);

    assert!(
        has_cell_with_fg(&buffer, theme.token(Token::ErrorMessageBar))
            || has_cell_with_fg(&buffer, theme.token(Token::Error))
    );
}
