//! Single-row "Working" indicator that materializes above the input while the
//! agent is busy or streaming.

use ratatui::{
    Frame,
    layout::Rect,
    style::Style,
    text::{Line, Span},
    widgets::Paragraph,
};

use crate::anim::shimmer;
use crate::theme::{ResolvedTheme, Token};

#[derive(Clone, Copy, Debug, Default)]
pub struct WorkingIndicatorState {
    pub visible: bool,
    pub elapsed_secs: u64,
}

#[must_use]
pub fn fmt_elapsed_compact(secs: u64) -> String {
    if secs < 60 {
        format!("{secs}s")
    } else if secs < 3600 {
        let m = secs / 60;
        let s = secs % 60;
        format!("{m}m {s:02}s")
    } else {
        let h = secs / 3600;
        let m = (secs % 3600) / 60;
        let s = secs % 60;
        format!("{h}h {m:02}m {s:02}s")
    }
}

pub fn render(
    frame: &mut Frame<'_>,
    area: Rect,
    theme: &ResolvedTheme,
    state: &WorkingIndicatorState,
    now_ms: u64,
) {
    if !state.visible || area.height == 0 || area.width == 0 {
        return;
    }
    let fg = theme.token(Token::Text);
    let highlight = theme.token(Token::Primary);
    let muted = theme.token(Token::TextMuted);
    let mut spans: Vec<Span<'static>> = shimmer::shimmer_spans("Working", fg, highlight, now_ms);
    spans.push(Span::raw(" "));
    spans.push(Span::styled(
        format!(
            "({elapsed} \u{00b7} esc to interrupt)",
            elapsed = fmt_elapsed_compact(state.elapsed_secs)
        ),
        Style::default().fg(muted),
    ));
    frame.render_widget(Paragraph::new(Line::from(spans)), area);
}

#[cfg(test)]
mod tests {
    use ratatui::{Terminal, backend::TestBackend};

    use super::*;
    use crate::load_bundled_dark_theme;

    fn render_line(state: &WorkingIndicatorState, width: u16, now_ms: u64) -> String {
        let backend = TestBackend::new(width, 1);
        let mut terminal = Terminal::new(backend).unwrap();
        let theme = load_bundled_dark_theme().unwrap();
        terminal
            .draw(|frame| render(frame, Rect::new(0, 0, width, 1), &theme, state, now_ms))
            .unwrap();
        let buf = terminal.backend().buffer();
        (0..buf.area.width)
            .map(|x| buf.cell((x, 0)).unwrap().symbol().to_owned())
            .collect()
    }

    #[test]
    fn hidden_when_not_visible() {
        let state = WorkingIndicatorState {
            visible: false,
            elapsed_secs: 0,
        };
        let text = render_line(&state, 80, 0);
        assert_eq!(text.len(), 80);
        for ch in text.chars() {
            assert_eq!(ch, ' ', "expected only spaces, got {ch:?} in {text:?}");
        }
    }

    #[test]
    fn shows_working_text_when_visible() {
        let state = WorkingIndicatorState {
            visible: true,
            elapsed_secs: 5,
        };
        let text = render_line(&state, 80, 0);
        assert!(text.contains("Working"), "missing Working: {text:?}");
    }

    #[test]
    fn shows_elapsed_time() {
        let state = WorkingIndicatorState {
            visible: true,
            elapsed_secs: 65,
        };
        let text = render_line(&state, 80, 0);
        assert!(text.contains("1m 05s"), "missing 1m 05s: {text:?}");
    }

    #[test]
    fn shows_interrupt_hint() {
        let state = WorkingIndicatorState {
            visible: true,
            elapsed_secs: 5,
        };
        let text = render_line(&state, 80, 0);
        assert!(
            text.contains("esc to interrupt"),
            "missing esc to interrupt: {text:?}"
        );
    }

    #[test]
    fn fmt_elapsed_compact_seconds() {
        assert_eq!(fmt_elapsed_compact(0), "0s");
        assert_eq!(fmt_elapsed_compact(59), "59s");
    }

    #[test]
    fn fmt_elapsed_compact_minutes() {
        assert_eq!(fmt_elapsed_compact(60), "1m 00s");
        assert_eq!(fmt_elapsed_compact(125), "2m 05s");
    }

    #[test]
    fn fmt_elapsed_compact_hours() {
        assert_eq!(fmt_elapsed_compact(3661), "1h 01m 01s");
    }
}
