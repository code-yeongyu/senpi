//! Header banner: senpi-neo wordmark + session + cwd. Three rows.

use ratatui::{
    Frame,
    layout::{Alignment, Constraint, Direction, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Paragraph},
};

use crate::theme::{ResolvedTheme, Token};

#[derive(Clone, Debug)]
pub struct HeaderState {
    pub cwd: String,
    pub session: String,
    pub branch: Option<String>,
    pub branch_dirty: bool,
    pub model: String,
    pub thinking_level: Option<String>,
    pub connected: bool,
}

pub fn render(frame: &mut Frame<'_>, area: Rect, theme: &ResolvedTheme, state: &HeaderState) {
    if area.height == 0 || area.width == 0 {
        return;
    }
    frame.render_widget(
        Block::default().style(Style::default().bg(theme.token(Token::Background))),
        area,
    );

    let chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Length(brand_width(area.width)), Constraint::Min(0)])
        .split(area);
    let brand_area = chunks[0];
    let meta_area = chunks[1];

    let primary = theme.token(Token::Primary);
    let secondary = theme.token(Token::Secondary);
    let muted = theme.token(Token::TextMuted);
    let success = theme.token(Token::Success);
    let error = theme.token(Token::Error);
    let warning = theme.token(Token::Warning);
    let emphasis = theme.token(Token::MarkdownEmphasis);

    let dot_color = if state.connected { success } else { error };
    let banner = Paragraph::new(vec![
        Line::from(""),
        Line::from(vec![
            Span::styled("● ", Style::default().fg(dot_color)),
            Span::styled("senpi", Style::default().fg(primary).add_modifier(Modifier::BOLD)),
            Span::styled(
                " neo",
                Style::default().fg(secondary).add_modifier(Modifier::BOLD),
            ),
        ]),
        Line::from(""),
    ]);
    frame.render_widget(banner, brand_area);

    let width = area.width;
    let mut meta_spans: Vec<Span> = Vec::new();

    meta_spans.push(Span::styled(state.cwd.clone(), Style::default().fg(muted)));
    meta_spans.push(Span::raw(" "));

    if width >= 100 {
        if let Some(ref level) = state.thinking_level {
            meta_spans.push(Span::styled(
                format!("[ think: {level} ]"),
                Style::default().fg(emphasis),
            ));
            meta_spans.push(Span::raw(" "));
        }
    }

    if width >= 80 && !state.model.is_empty() {
        meta_spans.push(Span::styled(
            format!("model: {}", state.model),
            Style::default().fg(primary),
        ));
        meta_spans.push(Span::raw(" "));
    }

    if width >= 100 && !state.session.is_empty() {
        meta_spans.push(Span::styled(state.session.clone(), Style::default().fg(primary)));
        meta_spans.push(Span::raw(" "));
    }

    if width >= 60 {
        if let Some(ref branch) = state.branch {
            meta_spans.push(Span::styled(
                format!("git:{branch}"),
                Style::default().fg(secondary),
            ));
            if state.branch_dirty {
                meta_spans.push(Span::styled("*", Style::default().fg(warning)));
            }
            meta_spans.push(Span::raw(" "));
        }
    }

    let meta = Paragraph::new(vec![Line::from(""), Line::from(meta_spans), Line::from("")])
        .alignment(Alignment::Right);
    frame.render_widget(meta, meta_area);
}

const fn brand_width(area_width: u16) -> u16 {
    if area_width >= 60 { 36 } else { area_width / 2 }
}
