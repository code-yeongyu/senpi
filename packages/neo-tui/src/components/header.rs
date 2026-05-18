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

    let banner = Paragraph::new(vec![
        Line::from(""),
        Line::from(vec![
            Span::styled("senpi", Style::default().fg(primary).add_modifier(Modifier::BOLD)),
            Span::styled(
                " neo",
                Style::default().fg(secondary).add_modifier(Modifier::BOLD),
            ),
        ]),
        Line::from(""),
    ]);
    frame.render_widget(banner, brand_area);

    let branch_label = state
        .branch
        .as_deref()
        .map(|b| format!(" git:{b}"))
        .unwrap_or_default();
    let meta = Paragraph::new(vec![
        Line::from(""),
        Line::from(vec![
            Span::styled(state.cwd.clone(), Style::default().fg(muted)),
            Span::raw(" "),
            Span::styled(state.session.clone(), Style::default().fg(primary)),
            Span::styled(branch_label, Style::default().fg(secondary)),
            Span::raw(" "),
        ]),
        Line::from(""),
    ])
    .alignment(Alignment::Right);
    frame.render_widget(meta, meta_area);
}

const fn brand_width(area_width: u16) -> u16 {
    if area_width >= 60 { 36 } else { area_width / 2 }
}
