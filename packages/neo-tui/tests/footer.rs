//! Footer render contract tests.
//!
//! Locks state-specific visual hierarchy: idle vs busy/streaming/tool/error
//! must be visually distinct (glyph, bg color, metrics visibility).

use ratatui::{Terminal, backend::TestBackend, buffer::Buffer, layout::Rect};
use senpi_neo_tui::{
    components::footer::{self, FooterState},
    load_bundled_dark_theme,
    theme::Token,
};

const BRAILLE_SPINNER_GLYPHS: &[char] = &[
    '\u{2802}', '\u{2804}', '\u{2806}', '\u{2826}', '\u{2827}', '\u{2837}', '\u{283F}', '\u{281F}',
    '\u{280F}', '\u{280B}', '\u{2809}', '\u{2808}',
];

fn render_footer(state: &FooterState, width: u16) -> Buffer {
    let backend = TestBackend::new(width, 1);
    let mut terminal = Terminal::new(backend).unwrap();
    let theme = load_bundled_dark_theme().unwrap();
    terminal
        .draw(|frame| footer::render(frame, Rect::new(0, 0, width, 1), &theme, state))
        .unwrap();
    terminal.backend().buffer().clone()
}

fn line_text(buffer: &Buffer, width: u16) -> String {
    (0..width)
        .map(|x| buffer.cell((x, 0)).unwrap().symbol().to_string())
        .collect()
}

fn all_cells_bg(buffer: &Buffer, width: u16) -> Vec<ratatui::style::Color> {
    (0..width).map(|x| buffer.cell((x, 0)).unwrap().bg).collect()
}

#[test]
fn footer_idle_shows_dot_glyph_not_spinner() {
    let mut state = FooterState::idle();
    state.status_label = "ready".to_string();
    let buffer = render_footer(&state, 80);
    let text = line_text(&buffer, 80);
    assert!(
        text.contains('\u{00b7}'),
        "idle footer must show dot glyph, got: {text}"
    );
    for glyph in BRAILLE_SPINNER_GLYPHS {
        assert!(
            !text.contains(*glyph),
            "idle footer must not contain braille spinner {glyph}, got: {text}"
        );
    }
}

#[test]
fn footer_idle_no_metrics_cluster() {
    let mut state = FooterState::idle();
    state.status_label = "ready".to_string();
    let buffer = render_footer(&state, 130);
    let text = line_text(&buffer, 130);
    assert!(!text.contains("ctx"), "idle must not show ctx, got: {text}");
    assert!(!text.contains("↓"), "idle must not show tokens_in, got: {text}");
    assert!(!text.contains("↑"), "idle must not show tokens_out, got: {text}");
    assert!(!text.contains("t/s"), "idle must not show tps, got: {text}");
    assert!(
        !text.contains(':'),
        "idle must not show elapsed time, got: {text}"
    );
}

#[test]
fn footer_busy_shows_spinner() {
    let mut state = FooterState::busy("waiting");
    state.spinner_glyph = '\u{2826}';
    let buffer = render_footer(&state, 80);
    let text = line_text(&buffer, 80);
    assert!(
        text.contains('\u{2826}'),
        "busy footer must show spinner glyph, got: {text}"
    );
}

#[test]
fn footer_busy_shows_busy_bg_token() {
    let state = FooterState::busy("waiting");
    let buffer = render_footer(&state, 80);
    let theme = load_bundled_dark_theme().unwrap();
    let expected = theme.token(Token::StatusBusyBg);
    let bgs = all_cells_bg(&buffer, 80);
    assert!(
        bgs.iter().all(|&bg| bg == expected),
        "busy footer bg must all be StatusBusyBg ({expected:?}), got mixed: {bgs:?}"
    );
}

#[test]
fn footer_streaming_shows_streaming_bg_token() {
    let state = FooterState::streaming();
    let buffer = render_footer(&state, 80);
    let theme = load_bundled_dark_theme().unwrap();
    let expected = theme.token(Token::StatusStreamingBg);
    let bgs = all_cells_bg(&buffer, 80);
    assert!(
        bgs.iter().all(|&bg| bg == expected),
        "streaming footer bg must all be StatusStreamingBg ({expected:?}), got mixed: {bgs:?}"
    );
}

#[test]
fn footer_error_shows_error_bg_token() {
    let state = FooterState::error();
    let buffer = render_footer(&state, 80);
    let theme = load_bundled_dark_theme().unwrap();
    let expected = theme.token(Token::StatusErrorBg);
    let bgs = all_cells_bg(&buffer, 80);
    assert!(
        bgs.iter().all(|&bg| bg == expected),
        "error footer bg must all be StatusErrorBg ({expected:?}), got mixed: {bgs:?}"
    );
}

#[test]
fn footer_tool_running_shows_tool_bg_token() {
    let state = FooterState::tool_running();
    let buffer = render_footer(&state, 80);
    let theme = load_bundled_dark_theme().unwrap();
    let expected = theme.token(Token::StatusToolBg);
    let bgs = all_cells_bg(&buffer, 80);
    assert!(
        bgs.iter().all(|&bg| bg == expected),
        "tool footer bg must all be StatusToolBg ({expected:?}), got mixed: {bgs:?}"
    );
}

#[test]
fn footer_metrics_hidden_when_zero() {
    let mut state = FooterState::busy("waiting");
    state.tokens_in = 0;
    state.tokens_out = 0;
    state.tps = None;
    state.ctx_used_pct = 0;
    state.elapsed_secs = 0;
    let buffer = render_footer(&state, 130);
    let text = line_text(&buffer, 130);
    assert!(
        !text.contains("ctx"),
        "metrics must be hidden when all zero, got: {text}"
    );
}

#[test]
fn footer_metrics_shown_when_nonzero() {
    let mut state = FooterState::busy("waiting");
    state.tokens_in = 100;
    state.tokens_out = 50;
    state.tps = Some(42);
    state.ctx_used_pct = 10;
    state.elapsed_secs = 65;
    let buffer = render_footer(&state, 130);
    let text = line_text(&buffer, 130);
    assert!(
        text.contains("ctx"),
        "metrics must show ctx when nonzero, got: {text}"
    );
    assert!(
        text.contains("↓"),
        "metrics must show tokens_in when nonzero, got: {text}"
    );
    assert!(
        text.contains("↑"),
        "metrics must show tokens_out when nonzero, got: {text}"
    );
    assert!(
        text.contains("t/s"),
        "metrics must show tps when nonzero, got: {text}"
    );
    assert!(
        text.contains("01:05"),
        "metrics must show elapsed when nonzero, got: {text}"
    );
}

#[test]
fn footer_streaming_disconnected_shows_error() {
    let mut state = FooterState::streaming();
    state.connected = false;
    let buffer = render_footer(&state, 80);
    let text = line_text(&buffer, 80);
    let theme = load_bundled_dark_theme().unwrap();
    let expected_bg = theme.token(Token::StatusErrorBg);
    let bgs = all_cells_bg(&buffer, 80);
    assert!(
        text.contains("disconnected"),
        "disconnected streaming must show disconnected message, got: {text}"
    );
    assert!(
        bgs.iter().all(|&bg| bg == expected_bg),
        "disconnected streaming must use error bg ({expected_bg:?}), got mixed: {bgs:?}"
    );
}
