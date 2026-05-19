//! Status footer: spinner + status label, model, thinking, tps, ctx%,
//! tokens, elapsed time. Always one row.

use ratatui::{
    Frame,
    layout::{Alignment, Constraint, Direction, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::Paragraph,
};

use crate::theme::{ResolvedTheme, Token};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Idle,
    Busy,
    Streaming,
    ToolRunning,
    Error,
}

impl Status {
    const fn token(self) -> Token {
        match self {
            Self::Idle => Token::StatusIdle,
            Self::Busy => Token::StatusBusy,
            Self::Streaming => Token::StatusStreaming,
            Self::ToolRunning => Token::StatusTool,
            Self::Error => Token::StatusError,
        }
    }

    const fn bg_token(self) -> Token {
        match self {
            Self::Idle => Token::StatusIdleBg,
            Self::Busy => Token::StatusBusyBg,
            Self::Streaming => Token::StatusStreamingBg,
            Self::ToolRunning => Token::StatusToolBg,
            Self::Error => Token::StatusErrorBg,
        }
    }
}

#[derive(Clone, Debug)]
pub struct FooterState {
    pub status: Status,
    pub status_label: String,
    pub model: String,
    pub thinking: Option<String>,
    pub tps: Option<u32>,
    pub ctx_used_pct: u8,
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub elapsed_secs: u64,
    pub spinner_glyph: char,
    pub connected: bool,
    pub busy_label: Option<String>,
}

impl FooterState {
    pub const fn idle() -> Self {
        Self {
            status: Status::Idle,
            status_label: String::new(),
            model: String::new(),
            thinking: None,
            tps: None,
            ctx_used_pct: 0,
            tokens_in: 0,
            tokens_out: 0,
            elapsed_secs: 0,
            spinner_glyph: '\u{00b7}',
            connected: true,
            busy_label: None,
        }
    }

    pub fn busy(label: &'static str) -> Self {
        Self {
            status: Status::Busy,
            status_label: label.to_string(),
            model: String::new(),
            thinking: None,
            tps: None,
            ctx_used_pct: 0,
            tokens_in: 0,
            tokens_out: 0,
            elapsed_secs: 0,
            spinner_glyph: '\u{2802}',
            connected: true,
            busy_label: Some(label.to_string()),
        }
    }

    pub fn streaming() -> Self {
        Self {
            status: Status::Streaming,
            status_label: "streaming".to_string(),
            model: String::new(),
            thinking: None,
            tps: None,
            ctx_used_pct: 0,
            tokens_in: 0,
            tokens_out: 0,
            elapsed_secs: 0,
            spinner_glyph: '\u{2802}',
            connected: true,
            busy_label: None,
        }
    }

    pub fn tool_running() -> Self {
        Self {
            status: Status::ToolRunning,
            status_label: "tool".to_string(),
            model: String::new(),
            thinking: None,
            tps: None,
            ctx_used_pct: 0,
            tokens_in: 0,
            tokens_out: 0,
            elapsed_secs: 0,
            spinner_glyph: '\u{2802}',
            connected: true,
            busy_label: None,
        }
    }

    pub fn error() -> Self {
        Self {
            status: Status::Error,
            status_label: "error".to_string(),
            model: String::new(),
            thinking: None,
            tps: None,
            ctx_used_pct: 0,
            tokens_in: 0,
            tokens_out: 0,
            elapsed_secs: 0,
            spinner_glyph: '\u{00d7}',
            connected: true,
            busy_label: None,
        }
    }
}

pub fn render(frame: &mut Frame<'_>, area: Rect, theme: &ResolvedTheme, state: &FooterState) {
    if area.height == 0 || area.width == 0 {
        return;
    }
    let bg = theme.token(Token::BackgroundPanel);
    let text = theme.token(Token::Text);
    let muted = theme.token(Token::TextMuted);
    let status_color = theme.token(state.status.token());

    let chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Min(20),
            Constraint::Length(right_width(area.width, state.status)),
        ])
        .split(area);

    let left = chunks[0];
    let right = chunks[1];

    let glyph_char = if state.status == Status::Idle {
        '\u{00b7}'
    } else {
        state.spinner_glyph
    };
    let mut left_spans = vec![
        Span::styled(
            format!(" {glyph_char} "),
            Style::default().fg(status_color).add_modifier(Modifier::BOLD),
        ),
        Span::styled(state.status_label.clone(), Style::default().fg(status_color)),
    ];
    if !state.model.is_empty() {
        left_spans.push(Span::raw("  "));
        left_spans.push(Span::styled("model:", Style::default().fg(muted)));
        left_spans.push(Span::styled(state.model.clone(), Style::default().fg(text)));
        left_spans.push(thinking_span(state, text));
    }
    let left_line = Line::from(left_spans);
    let left_p = Paragraph::new(left_line).style(Style::default().bg(bg));
    frame.render_widget(left_p, left);

    let right_line = if state.status == Status::Idle {
        Line::from(Span::raw(""))
    } else {
        let mut spans: Vec<Span<'_>> = Vec::new();
        spans.push(Span::styled(
            format!("ctx {:>3}% ", state.ctx_used_pct),
            Style::default().fg(muted),
        ));
        if area.width >= 80 {
            spans.push(Span::raw("│ "));
            spans.push(Span::styled(
                format!(
                    "{}↓ {}↑ ",
                    short_count(state.tokens_in),
                    short_count(state.tokens_out)
                ),
                Style::default().fg(text),
            ));
        }
        if area.width >= 110 {
            spans.push(Span::raw("│ "));
            spans.push(Span::styled(
                state
                    .tps
                    .map_or_else(|| "  --t/s ".to_string(), |t| format!("{t:>3}t/s ")),
                Style::default().fg(theme.token(Token::Info)),
            ));
        }
        if area.width >= 130 {
            spans.push(Span::raw("│ "));
            spans.push(Span::styled(
                format_elapsed(state.elapsed_secs),
                Style::default().fg(muted),
            ));
            spans.push(Span::raw(" "));
        }
        Line::from(spans)
    };
    let right_p = Paragraph::new(right_line)
        .alignment(Alignment::Right)
        .style(Style::default().bg(bg));
    frame.render_widget(right_p, right);
}

fn thinking_span(state: &FooterState, text: ratatui::style::Color) -> Span<'_> {
    state.thinking.as_ref().map_or_else(
        || Span::raw(""),
        |level| {
            Span::styled(
                format!(":{level}"),
                Style::default().fg(text).add_modifier(Modifier::DIM),
            )
        },
    )
}

const fn right_width(area_width: u16, status: Status) -> u16 {
    if matches!(status, Status::Idle) {
        return 0;
    }
    if area_width >= 130 {
        56
    } else if area_width >= 110 {
        44
    } else if area_width >= 80 {
        28
    } else {
        12
    }
}

fn short_count(value: u64) -> String {
    if value >= 1_000_000 {
        let units = value / 100_000;
        let major = units / 10;
        let minor = units % 10;
        format!("{major}.{minor}M")
    } else if value >= 10_000 {
        let v = value / 1000;
        format!("{v}k")
    } else if value >= 1_000 {
        let units = value / 100;
        let major = units / 10;
        let minor = units % 10;
        format!("{major}.{minor}k")
    } else {
        value.to_string()
    }
}
fn format_elapsed(secs: u64) -> String {
    let m = secs / 60;
    let s = secs % 60;
    format!("{m:02}:{s:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_count_formats() {
        assert_eq!(short_count(50), "50");
        assert_eq!(short_count(900), "900");
        assert_eq!(short_count(1500), "1.5k");
        assert_eq!(short_count(12_400), "12k");
        assert_eq!(short_count(1_500_000), "1.5M");
    }

    #[test]
    fn elapsed_formats_mm_ss() {
        assert_eq!(format_elapsed(0), "00:00");
        assert_eq!(format_elapsed(45), "00:45");
        assert_eq!(format_elapsed(125), "02:05");
    }
}
