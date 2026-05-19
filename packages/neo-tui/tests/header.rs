//! Header component snapshot tests.
//!
//! Locks the connection dot, model display, thinking pill, branch dirty
//! marker, and responsive width dropping.

use ratatui::{
    Terminal,
    backend::TestBackend,
    layout::Rect,
    style::Color,
};
use senpi_neo_tui::{
    components::header::{self, HeaderState},
    load_bundled_dark_theme,
    theme::Token,
};

fn setup() -> (Terminal<TestBackend>, senpi_neo_tui::theme::ResolvedTheme) {
    let backend = TestBackend::new(120, 3);
    let terminal = Terminal::new(backend).unwrap();
    let theme = load_bundled_dark_theme().unwrap();
    (terminal, theme)
}

fn find_symbol(buffer: &ratatui::buffer::Buffer, symbol: &str) -> Vec<(u16, u16, Color)> {
    let mut hits = Vec::new();
    for y in 0..buffer.area.height {
        for x in 0..buffer.area.width {
            if let Some(cell) = buffer.cell(ratatui::layout::Position { x, y }) {
                if cell.symbol() == symbol {
                    hits.push((x, y, cell.style().fg.unwrap_or(Color::Reset)));
                }
            }
        }
    }
    hits
}

fn find_text(buffer: &ratatui::buffer::Buffer, text: &str) -> Option<(u16, u16)> {
    for y in 0..buffer.area.height {
        let mut line = String::new();
        for x in 0..buffer.area.width {
            line.push_str(
                buffer
                    .cell(ratatui::layout::Position { x, y })
                    .map(|c| c.symbol())
                    .unwrap_or(" "),
            );
        }
        if let Some(pos) = line.find(text) {
            return Some((pos as u16, y));
        }
    }
    None
}

fn color_at(buffer: &ratatui::buffer::Buffer, x: u16, y: u16) -> Option<Color> {
    buffer
        .cell(ratatui::layout::Position { x, y })
        .and_then(|c| c.style().fg)
}

#[test]
fn header_connected_renders_green_dot() {
    let (mut terminal, theme) = setup();
    let state = HeaderState {
        cwd: "/home/senpi".into(),
        session: "abc123".into(),
        branch: Some("main".into()),
        branch_dirty: false,
        model: "claude-opus-4-7".into(),
        thinking_level: Some("max".into()),
        connected: true,
    };
    terminal
        .draw(|frame| header::render(frame, Rect::new(0, 0, 120, 3), &theme, &state))
        .unwrap();
    let buffer = terminal.backend().buffer();
    let hits = find_symbol(buffer, "●");
    assert!(!hits.is_empty(), "expected ● glyph in header");
    let success_color = theme.token(Token::Success);
    assert!(
        hits.iter().any(|(_, _, c)| *c == success_color),
        "expected at least one ● with Success color, got {hits:?}"
    );
}

#[test]
fn header_disconnected_renders_red_dot() {
    let (mut terminal, theme) = setup();
    let state = HeaderState {
        cwd: "/home/senpi".into(),
        session: "abc123".into(),
        branch: Some("main".into()),
        branch_dirty: false,
        model: "claude-opus-4-7".into(),
        thinking_level: Some("max".into()),
        connected: false,
    };
    terminal
        .draw(|frame| header::render(frame, Rect::new(0, 0, 120, 3), &theme, &state))
        .unwrap();
    let buffer = terminal.backend().buffer();
    let hits = find_symbol(buffer, "●");
    assert!(!hits.is_empty(), "expected ● glyph in header");
    let error_color = theme.token(Token::Error);
    assert!(
        hits.iter().any(|(_, _, c)| *c == error_color),
        "expected at least one ● with Error color, got {hits:?}"
    );
}

#[test]
fn header_displays_model_when_set() {
    let (mut terminal, theme) = setup();
    let state = HeaderState {
        cwd: "/home/senpi".into(),
        session: "abc123".into(),
        branch: Some("main".into()),
        branch_dirty: false,
        model: "claude-opus-4-7".into(),
        thinking_level: None,
        connected: true,
    };
    terminal
        .draw(|frame| header::render(frame, Rect::new(0, 0, 120, 3), &theme, &state))
        .unwrap();
    let buffer = terminal.backend().buffer();
    assert!(
        find_text(buffer, "claude-opus-4-7").is_some(),
        "expected model name in header"
    );
}

#[test]
fn header_hides_model_when_empty() {
    let (mut terminal, theme) = setup();
    let state = HeaderState {
        cwd: "/home/senpi".into(),
        session: "abc123".into(),
        branch: Some("main".into()),
        branch_dirty: false,
        model: "".into(),
        thinking_level: None,
        connected: true,
    };
    terminal
        .draw(|frame| header::render(frame, Rect::new(0, 0, 120, 3), &theme, &state))
        .unwrap();
    let buffer = terminal.backend().buffer();
    assert!(
        find_text(buffer, "model:").is_none(),
        "expected no model label when model is empty"
    );
}

#[test]
fn header_thinking_level_pill() {
    let (mut terminal, theme) = setup();
    let state = HeaderState {
        cwd: "/home/senpi".into(),
        session: "abc123".into(),
        branch: Some("main".into()),
        branch_dirty: false,
        model: "".into(),
        thinking_level: Some("max".into()),
        connected: true,
    };
    terminal
        .draw(|frame| header::render(frame, Rect::new(0, 0, 120, 3), &theme, &state))
        .unwrap();
    let buffer = terminal.backend().buffer();
    let pos = find_text(buffer, "[ think: max ]")
        .or_else(|| find_text(buffer, "think: max"))
        .expect("expected thinking pill in header");
    let emphasis_color = theme.token(Token::MarkdownEmphasis);
    let actual = color_at(buffer, pos.0, pos.1);
    assert_eq!(
        actual, Some(emphasis_color),
        "expected thinking pill to use MarkdownEmphasis color"
    );
}

#[test]
fn header_branch_dirty_marker() {
    let (mut terminal, theme) = setup();
    let state = HeaderState {
        cwd: "/home/senpi".into(),
        session: "abc123".into(),
        branch: Some("main".into()),
        branch_dirty: true,
        model: "".into(),
        thinking_level: None,
        connected: true,
    };
    terminal
        .draw(|frame| header::render(frame, Rect::new(0, 0, 120, 3), &theme, &state))
        .unwrap();
    let buffer = terminal.backend().buffer();
    let (x, y) = find_text(buffer, "main*").expect("expected main* in header");
    let star_x = x + 4; // 'm' 'a' 'i' 'n' '*'
    let warning_color = theme.token(Token::Warning);
    assert_eq!(
        color_at(buffer, star_x, y),
        Some(warning_color),
        "expected * to be Warning color"
    );
}

#[test]
fn header_minimal_width_drops_branch() {
    let backend = TestBackend::new(40, 3);
    let mut terminal = Terminal::new(backend).unwrap();
    let theme = load_bundled_dark_theme().unwrap();
    let state = HeaderState {
        cwd: "/home/senpi".into(),
        session: "abc123".into(),
        branch: Some("main".into()),
        branch_dirty: true,
        model: "claude-opus-4-7".into(),
        thinking_level: Some("max".into()),
        connected: true,
    };
    terminal
        .draw(|frame| header::render(frame, Rect::new(0, 0, 40, 3), &theme, &state))
        .unwrap();
    let buffer = terminal.backend().buffer();
    assert!(
        find_text(buffer, "git:").is_none() && find_text(buffer, "main").is_none(),
        "expected branch cluster dropped at width 40"
    );
}

#[test]
fn header_minimal_width_drops_model() {
    let backend = TestBackend::new(30, 3);
    let mut terminal = Terminal::new(backend).unwrap();
    let theme = load_bundled_dark_theme().unwrap();
    let state = HeaderState {
        cwd: "/home/senpi".into(),
        session: "abc123".into(),
        branch: Some("main".into()),
        branch_dirty: true,
        model: "claude-opus-4-7".into(),
        thinking_level: Some("max".into()),
        connected: true,
    };
    terminal
        .draw(|frame| header::render(frame, Rect::new(0, 0, 30, 3), &theme, &state))
        .unwrap();
    let buffer = terminal.backend().buffer();
    assert!(
        find_text(buffer, "claude-opus-4-7").is_none(),
        "expected model dropped at width 30"
    );
    assert!(
        find_text(buffer, "think:").is_none(),
        "expected thinking pill dropped at width 30"
    );
    assert!(
        find_text(buffer, "senpi").is_some(),
        "expected wordmark to remain at width 30"
    );
    assert!(
        find_text(buffer, "●").is_some(),
        "expected connection dot to remain at width 30"
    );
}
