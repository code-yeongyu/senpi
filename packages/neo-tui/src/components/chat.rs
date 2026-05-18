//! Chat view: scrollable list of user / assistant / tool messages with
//! per-role left-bar accents plus inline tool cards.

use ratatui::{
    Frame,
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Padding, Paragraph, Wrap},
};

use crate::theme::{ResolvedTheme, Token};

/// One rendered message in the chat list.
#[derive(Clone, Debug)]
pub struct Message {
    pub role: Role,
    pub body: String,
    /// Optional inline tool card.
    pub tool: Option<ToolCard>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    User,
    Assistant,
    System,
    Error,
}

#[derive(Clone, Debug)]
pub struct ToolCard {
    pub name: String,
    pub status: ToolStatus,
    pub summary: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolStatus {
    Running,
    Success,
    Failed,
}

/// Inputs to the chat component.
#[derive(Clone, Debug, Default)]
pub struct ChatState {
    pub messages: Vec<Message>,
    /// Vertical line offset applied to the rendered chat paragraph.
    /// `None` (the default) means "stick to the bottom" - the renderer
    /// computes the offset that pins the last line just above the input
    /// frame. `Some(n)` clamps the view to that absolute line and is
    /// driven by scroll keybinds (`ScrollUp` / `ScrollDown` / page keys).
    pub scroll_offset: Option<u16>,
}

/// Render the chat list into the given rect.
pub fn render(frame: &mut Frame<'_>, area: Rect, theme: &ResolvedTheme, state: &ChatState) {
    if area.height == 0 || area.width == 0 {
        return;
    }

    let bg = theme.token(Token::Background);
    let block = Block::default()
        .style(Style::default().bg(bg))
        .padding(Padding::horizontal(1));
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let mut lines: Vec<Line<'_>> = Vec::new();
    for (idx, msg) in state.messages.iter().enumerate() {
        if idx > 0 {
            lines.push(Line::from(""));
        }
        lines.extend(render_message(theme, msg));
    }
    if lines.is_empty() {
        lines.push(empty_state_line(theme));
    }

    // Long chats need to scroll. Because we use `Wrap { trim: false }`
    // the rendered row count is `Paragraph::line_count(width)`, NOT
    // `lines.len()`: long lines wrap across multiple rows and a naive
    // `lines.len()` underestimates the rendered height. ratatui's
    // `line_count` does the same wrap pass as the renderer.
    let para = Paragraph::new(lines).wrap(Wrap { trim: false });
    let rendered_rows = u16::try_from(para.line_count(inner.width)).unwrap_or(u16::MAX);
    let bottom_anchor = rendered_rows.saturating_sub(inner.height);
    let scroll = state
        .scroll_offset
        .map_or(bottom_anchor, |raw| raw.min(bottom_anchor));

    let para = para.scroll((scroll, 0));
    frame.render_widget(para, inner);
}

fn render_message<'a>(theme: &ResolvedTheme, msg: &'a Message) -> Vec<Line<'a>> {
    let accent_token = match msg.role {
        Role::User => Token::UserMessageBar,
        Role::Assistant => Token::AssistantMessageBar,
        Role::System => Token::SystemMessageBar,
        Role::Error => Token::ErrorMessageBar,
    };
    let (glyph, label) = match msg.role {
        Role::User => ("›", "you"),
        Role::Assistant => ("•", "senpi"),
        Role::System => ("·", "system"),
        Role::Error => ("!", "error"),
    };
    let accent = theme.token(accent_token);
    let text = theme.token(Token::Text);
    let muted = theme.token(Token::TextMuted);

    let mut out: Vec<Line<'a>> = Vec::new();
    let header_style = Style::default().fg(accent).add_modifier(Modifier::BOLD);
    let mut body_iter = msg.body.lines();
    let first_body = body_iter.next();
    let mut header_spans: Vec<Span<'a>> = vec![
        Span::styled(format!("{glyph} "), header_style),
        Span::styled(label, header_style),
    ];
    if let Some(first) = first_body {
        if !first.is_empty() {
            header_spans.push(Span::styled("  ", Style::default().fg(muted)));
            header_spans.push(Span::styled(first, Style::default().fg(text)));
        }
    }
    out.push(Line::from(header_spans));
    for body_line in body_iter {
        out.push(Line::from(vec![
            Span::raw("  "),
            Span::styled(body_line, Style::default().fg(text)),
        ]));
    }
    if let Some(card) = &msg.tool {
        out.extend(render_tool_card(theme, card));
    }
    out
}

fn render_tool_card<'a>(theme: &ResolvedTheme, card: &'a ToolCard) -> Vec<Line<'a>> {
    let (icon, icon_style, border_color) = match card.status {
        ToolStatus::Running => (
            "⠲",
            Style::default().fg(theme.token(Token::Info)),
            theme.token(Token::ToolBorderRunning),
        ),
        ToolStatus::Success => (
            "✓",
            Style::default()
                .fg(theme.token(Token::Success))
                .add_modifier(Modifier::BOLD),
            theme.token(Token::ToolBorderSuccess),
        ),
        ToolStatus::Failed => (
            "✗",
            Style::default()
                .fg(theme.token(Token::Error))
                .add_modifier(Modifier::BOLD),
            theme.token(Token::ToolBorderError),
        ),
    };
    let header_text = theme.token(Token::ToolHeaderText);
    let body_text = theme.token(Token::ToolBodyText);

    let mut lines: Vec<Line<'a>> = Vec::new();
    lines.push(Line::from(vec![
        Span::styled("┌─[ ", Style::default().fg(border_color)),
        Span::styled(icon, icon_style),
        Span::raw(" "),
        Span::styled(
            card.name.clone(),
            Style::default().fg(header_text).add_modifier(Modifier::BOLD),
        ),
        Span::styled(" ]─", Style::default().fg(border_color)),
        Span::styled("─".repeat(40), Style::default().fg(border_color)),
    ]));
    for line in card.summary.lines() {
        lines.push(Line::from(vec![
            Span::styled("│ ", Style::default().fg(border_color)),
            Span::styled(line, Style::default().fg(body_text)),
        ]));
    }
    lines.push(Line::from(Span::styled(
        format!("└{}", "─".repeat(60)),
        Style::default().fg(border_color),
    )));
    lines
}

fn empty_state_line(theme: &ResolvedTheme) -> Line<'static> {
    let muted = theme.token(Token::TextMuted);
    Line::from(Span::styled(
        "  type a prompt below to begin · ctrl+p for palette · ? for help",
        Style::default().fg(muted),
    ))
}

/// Build a sample chat for screenshots / dev.
#[must_use]
pub fn sample() -> ChatState {
    ChatState {
        scroll_offset: None,
        messages: vec![
            Message {
                role: Role::System,
                body: "senpi --neo · ratatui frontend · backend: senpi --mode rpc".into(),
                tool: None,
            },
            Message {
                role: Role::User,
                body: "List all rust files in this crate and tell me what each top-level module does.".into(),
                tool: None,
            },
            Message {
                role: Role::Assistant,
                body: "I'll run a quick ls + grep to map the crate.".into(),
                tool: Some(ToolCard {
                    name: "bash".into(),
                    status: ToolStatus::Success,
                    summary: "$ rg --files -t rust packages/neo-tui/src\nsrc/lib.rs\nsrc/main.rs\nsrc/theme/mod.rs\nsrc/layout/mod.rs\nsrc/components/{header,footer,chat,input}.rs".into(),
                }),
            },
            Message {
                role: Role::Assistant,
                body: "Mapped 12 module files. theme = JSON-driven semantic tokens. layout = pure compute. components = header / chat / input / footer. rpc = JSONL subprocess client (in progress). compositor = layered Component dispatch (stub). anim = spinners + scanners (stub).".into(),
                tool: None,
            },
        ],
    }
}
