//! Chat view: scrollable markdown-aware message history with per-role bars,
//! thinking blocks, and inline tool cards.

use std::collections::{HashMap, HashSet};

use ratatui::{
    Frame,
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Padding, Paragraph, Wrap},
};

use crate::{
    components::markdown,
    text::{truncate_to_width, wrap_text_with_ansi},
    theme::{ResolvedTheme, Token},
};

/// Back-compatible message shape consumed by the app loop.
#[derive(Clone, Debug)]
pub struct Message {
    pub role: Role,
    pub body: String,
    /// Optional inline tool card.
    pub tool: Option<ToolCard>,
}

pub type ChatMessage = Message;
pub type MessageRole = Role;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    User,
    Assistant,
    System,
    Tool,
    Error,
}

#[derive(Clone, Debug)]
pub struct ToolCard {
    pub name: String,
    pub status: ToolStatus,
    pub summary: String,
}

#[derive(Clone, Debug)]
pub struct ToolCardData {
    pub name: String,
    pub status: ToolStatus,
    pub args: String,
    pub output: String,
}

impl From<ToolCardData> for ToolCard {
    fn from(value: ToolCardData) -> Self {
        let summary = if value.output.is_empty() {
            value.args
        } else if value.args.is_empty() {
            value.output
        } else {
            format!("{}\n{}", value.args, value.output)
        };
        Self {
            name: value.name,
            status: value.status,
            summary,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolStatus {
    Running,
    Success,
    Error,
    /// Compatibility with the pre-rewrite app event mapper.
    Failed,
}

/// Inputs to the chat component.
#[derive(Clone, Debug)]
pub struct ChatState {
    pub messages: Vec<Message>,
    /// Rows away from the bottom anchor. `0` means pinned to latest output.
    pub scroll_offset: usize,
    pub expanded_thinking: HashSet<u64>,
    pub next_id: u64,
    message_ids: Vec<u64>,
    thinking_by_id: HashMap<u64, String>,
    /// Pending steering / follow-up messages tracked from the backend's
    /// `QueueUpdate` events. Consumed by `app.message.dequeue`
    /// (Alt+Up) so the user can edit a queued message before
    /// resubmitting it.
    queued_messages: Vec<String>,
}

impl ChatState {
    #[must_use]
    pub fn new() -> Self {
        Self {
            messages: Vec::new(),
            scroll_offset: 0,
            expanded_thinking: HashSet::new(),
            next_id: 1,
            message_ids: Vec::new(),
            thinking_by_id: HashMap::new(),
            queued_messages: Vec::new(),
        }
    }

    pub fn push_user(&mut self, body: String) -> u64 {
        self.push_message(Role::User, body, None)
    }

    pub fn push_assistant(&mut self, body: String) -> u64 {
        self.push_message(Role::Assistant, body, None)
    }

    pub fn push_system(&mut self, body: String) -> u64 {
        self.push_message(Role::System, body, None)
    }

    pub fn push_tool<T>(&mut self, tool: T) -> u64
    where
        T: Into<ToolCard>,
    {
        self.push_message(Role::Tool, String::new(), Some(tool.into()))
    }

    pub fn push_error(&mut self, body: String) -> u64 {
        self.push_message(Role::Error, body, None)
    }

    pub fn stream_append(&mut self, id: u64, delta: &str) {
        if let Some(index) = self.message_ids.iter().position(|candidate| *candidate == id)
            && let Some(message) = self.messages.get_mut(index)
        {
            message.body.push_str(delta);
        }
    }

    pub const fn scroll_up(&mut self, n: usize) {
        self.scroll_offset = self.scroll_offset.saturating_add(n);
    }

    pub const fn scroll_down(&mut self, n: usize) {
        self.scroll_offset = self.scroll_offset.saturating_sub(n);
    }

    pub const fn scroll_to_bottom(&mut self) {
        self.scroll_offset = 0;
    }

    pub fn toggle_thinking(&mut self, id: u64) {
        if !self.expanded_thinking.remove(&id) {
            self.expanded_thinking.insert(id);
        }
    }

    pub fn set_thinking(&mut self, id: u64, thinking: String) {
        self.thinking_by_id.insert(id, thinking);
    }

    /// Replace the tracked queued messages with the latest
    /// `QueueUpdate` payload from the backend (steering + follow-up
    /// merged, source order preserved).
    pub fn replace_queued_messages(&mut self, queued: Vec<String>) {
        self.queued_messages = queued;
    }

    /// Pop the most recently queued message for `app.message.dequeue`
    /// (Alt+Up). Returns `None` when the queue is empty.
    pub fn pop_queued_message(&mut self) -> Option<String> {
        self.queued_messages.pop()
    }

    /// Read-only view of pending queued messages (used by tests +
    /// future status-line rendering).
    #[must_use]
    pub fn queued_messages(&self) -> &[String] {
        &self.queued_messages
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.messages.is_empty()
    }

    fn push_message(&mut self, role: Role, body: String, tool: Option<ToolCard>) -> u64 {
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        self.messages.push(Message { role, body, tool });
        self.message_ids.push(id);
        id
    }
}

impl Default for ChatState {
    fn default() -> Self {
        Self::new()
    }
}

/// Per-frame rendering options that toggle visibility of optional
/// chat content. Drives the legacy senpi Ctrl+T (thinking) and Ctrl+O
/// (tool output) chords.
#[derive(Clone, Copy, Debug)]
pub struct ChatViewOpts {
    /// `true` (default): assistant thinking blocks are shown (collapsed
    /// summary or expanded). `false`: thinking blocks are hidden
    /// entirely - the "ctrl+t to expand" line is suppressed and
    /// per-message expanded thinking is collapsed.
    pub thinking_visible: bool,
    /// `true` (default): tool cards render their full body output.
    /// `false`: tool cards collapse to a single header line so the
    /// chat stays compact during long tool runs.
    pub tools_expanded: bool,
}

impl Default for ChatViewOpts {
    fn default() -> Self {
        Self {
            thinking_visible: true,
            tools_expanded: true,
        }
    }
}

/// Render the chat list into the given rect.
pub fn render(
    frame: &mut Frame<'_>,
    area: Rect,
    theme: &ResolvedTheme,
    state: &ChatState,
    opts: ChatViewOpts,
) {
    if area.height == 0 || area.width == 0 {
        return;
    }

    let bg = theme.token(Token::Background);
    let block = Block::default()
        .style(Style::default().bg(bg))
        .padding(Padding::horizontal(1));
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let lines = render_lines(
        theme,
        state,
        opts,
        usize::from(inner.width.saturating_sub(2).max(1)),
    );
    let para = Paragraph::new(lines).wrap(Wrap { trim: false });
    let rendered_rows = para.line_count(inner.width);
    let bottom_anchor = rendered_rows.saturating_sub(usize::from(inner.height));
    let scroll_from_top = bottom_anchor.saturating_sub(state.scroll_offset.min(bottom_anchor));
    let scroll = u16::try_from(scroll_from_top).unwrap_or(u16::MAX);

    frame.render_widget(para.scroll((scroll, 0)), inner);
}

fn render_lines(
    theme: &ResolvedTheme,
    state: &ChatState,
    opts: ChatViewOpts,
    body_width: usize,
) -> Vec<Line<'static>> {
    if state.messages.is_empty() {
        return vec![empty_state_line(theme)];
    }

    let mut lines = Vec::new();
    for (index, message) in state.messages.iter().enumerate() {
        if index > 0 {
            lines.push(Line::from(""));
        }
        let id = state.message_ids.get(index).copied();
        lines.extend(render_message(theme, message, id, state, opts, body_width));
    }
    lines
}

fn render_message(
    theme: &ResolvedTheme,
    message: &Message,
    id: Option<u64>,
    state: &ChatState,
    opts: ChatViewOpts,
    body_width: usize,
) -> Vec<Line<'static>> {
    match message.role {
        Role::User => render_user_message(theme, &message.body, body_width),
        Role::Assistant => render_assistant_message(theme, message, id, state, opts, body_width),
        Role::System => render_system_message(theme, &message.body, body_width),
        Role::Tool => message
            .tool
            .as_ref()
            .map_or_else(Vec::new, |tool| render_tool_card(theme, tool, opts, body_width)),
        Role::Error => render_error_message(theme, &message.body, body_width),
    }
}

fn render_user_message(theme: &ResolvedTheme, body: &str, width: usize) -> Vec<Line<'static>> {
    let mut lines = vec![bar_line(
        theme,
        Token::UserMessageBar,
        vec![header_span(theme, " > you")],
    )];
    for line in wrap_text_with_ansi(body, width) {
        lines.push(bar_line(
            theme,
            Token::UserMessageBar,
            vec![Span::styled(
                format!("  {line}"),
                Style::default().fg(theme.token(Token::Text)),
            )],
        ));
    }
    lines
}

fn render_assistant_message(
    theme: &ResolvedTheme,
    message: &Message,
    id: Option<u64>,
    state: &ChatState,
    opts: ChatViewOpts,
    width: usize,
) -> Vec<Line<'static>> {
    let mut lines = vec![bar_line(
        theme,
        Token::AssistantMessageBar,
        vec![header_span(theme, " > senpi")],
    )];

    // Ctrl+T (`app.thinking.toggle`) toggles the global
    // `thinking_visible` flag. When false, every thinking block is
    // suppressed - neither the summary line nor the expanded body
    // renders. This matches the legacy senpi behavior where the user
    // can hide the inner monologue once they have read it.
    if opts.thinking_visible
        && let Some(id) = id
        && let Some(thinking) = state.thinking_by_id.get(&id)
    {
        if state.expanded_thinking.contains(&id) {
            lines.extend(render_expanded_thinking(theme, thinking, width));
        } else {
            let count = thinking.lines().count();
            lines.push(bar_line(
                theme,
                Token::AssistantMessageBar,
                vec![Span::styled(
                    format!("  [thinking {count} lines, ctrl+t to toggle visibility]"),
                    Style::default().fg(theme.token(Token::TextMuted)),
                )],
            ));
        }
    }

    for line in markdown::render(theme, &message.body, width) {
        lines.push(markdown_body_line(theme, Token::AssistantMessageBar, line));
    }
    if let Some(tool) = &message.tool {
        lines.extend(render_tool_card(theme, tool, opts, width));
    }
    lines
}

fn render_expanded_thinking(theme: &ResolvedTheme, thinking: &str, width: usize) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    for line in wrap_text_with_ansi(thinking, width.saturating_sub(2).max(1)) {
        lines.push(bar_line(
            theme,
            Token::AssistantMessageBar,
            vec![Span::styled(
                format!("  · {line}"),
                Style::default().fg(theme.token(Token::TextMuted)),
            )],
        ));
    }
    lines.push(bar_line(
        theme,
        Token::AssistantMessageBar,
        vec![Span::styled(
            "  ---".to_string(),
            Style::default().fg(theme.token(Token::TextMuted)),
        )],
    ));
    lines
}

fn render_system_message(theme: &ResolvedTheme, body: &str, width: usize) -> Vec<Line<'static>> {
    let style = Style::default()
        .fg(theme.token(Token::TextMuted))
        .add_modifier(Modifier::ITALIC);
    wrap_text_with_ansi(body, width)
        .into_iter()
        .map(|line| Line::from(Span::styled(line, style)))
        .collect()
}

fn render_error_message(theme: &ResolvedTheme, body: &str, width: usize) -> Vec<Line<'static>> {
    let mut lines = vec![bar_line(
        theme,
        Token::ErrorMessageBar,
        vec![header_span(theme, " > error")],
    )];
    for line in wrap_text_with_ansi(body, width) {
        lines.push(bar_line(
            theme,
            Token::ErrorMessageBar,
            vec![Span::styled(
                format!("  {line}"),
                Style::default().fg(theme.token(Token::Error)),
            )],
        ));
    }
    lines
}

fn render_tool_card(
    theme: &ResolvedTheme,
    card: &ToolCard,
    opts: ChatViewOpts,
    width: usize,
) -> Vec<Line<'static>> {
    let border_token = match card.status {
        ToolStatus::Running => Token::ToolBorderRunning,
        ToolStatus::Success => Token::ToolBorderSuccess,
        ToolStatus::Error | ToolStatus::Failed => Token::ToolBorderError,
    };
    let border = Style::default().fg(theme.token(border_token));
    let header = Style::default()
        .fg(theme.token(Token::ToolHeaderText))
        .add_modifier(Modifier::BOLD);
    let body = Style::default().fg(theme.token(Token::ToolBodyText));
    let inner_width = width.saturating_sub(4).max(1);
    let rule_width = inner_width.saturating_sub(card.name.len().saturating_add(7));
    let icon = match card.status {
        ToolStatus::Running => "⠂",
        ToolStatus::Success => "✓",
        ToolStatus::Error | ToolStatus::Failed => "✗",
    };

    let mut lines = vec![Line::from(vec![
        Span::styled("  ╭─[ ".to_string(), border),
        Span::styled(icon.to_string(), header),
        Span::styled(" ".to_string(), border),
        Span::styled(card.name.clone(), header),
        Span::styled(" ]".to_string(), border),
        Span::styled("─".repeat(rule_width), border),
    ])];

    // Ctrl+O (`app.tools.expand`) toggles whether tool body lines are
    // rendered. When false, the card collapses to its header rule so
    // long tool outputs do not flood the viewport. The user can
    // re-expand to inspect the output.
    if opts.tools_expanded {
        for line in card.summary.lines().take(6) {
            let truncated = truncate_to_width(line, inner_width, "…");
            lines.push(Line::from(vec![
                Span::styled("  │ ".to_string(), border),
                Span::styled(truncated, body),
            ]));
        }
    } else {
        // Render a compact one-line "collapsed" hint instead of the
        // tool body so the user knows there is hidden output and how
        // to expand it.
        let hint = "  │ [tool output collapsed, ctrl+o to expand]";
        let truncated = truncate_to_width(hint, inner_width.saturating_add(4), "…");
        lines.push(Line::from(Span::styled(
            truncated,
            Style::default().fg(theme.token(Token::TextMuted)),
        )));
    }
    lines.push(Line::from(Span::styled(
        format!("  ╰{}", "─".repeat(inner_width.saturating_add(1))),
        border,
    )));
    lines
}

fn markdown_body_line(theme: &ResolvedTheme, token: Token, line: Line<'static>) -> Line<'static> {
    let mut spans = Vec::with_capacity(line.spans.len().saturating_add(2));
    spans.push(Span::styled(
        "▏".to_string(),
        Style::default().fg(theme.token(token)),
    ));
    spans.push(Span::raw("  ".to_string()));
    spans.extend(line.spans);
    Line::from(spans)
}

fn bar_line(theme: &ResolvedTheme, token: Token, mut spans: Vec<Span<'static>>) -> Line<'static> {
    let mut out = Vec::with_capacity(spans.len().saturating_add(1));
    out.push(Span::styled(
        "▏".to_string(),
        Style::default().fg(theme.token(token)),
    ));
    out.append(&mut spans);
    Line::from(out)
}

fn header_span(theme: &ResolvedTheme, label: &str) -> Span<'static> {
    Span::styled(
        label.to_string(),
        Style::default()
            .fg(theme.token(Token::TextMuted))
            .add_modifier(Modifier::BOLD),
    )
}

fn empty_state_line(theme: &ResolvedTheme) -> Line<'static> {
    Line::from(Span::styled(
        "  type a prompt below to begin...",
        Style::default().fg(theme.token(Token::TextMuted)),
    ))
}

/// Build a sample chat for screenshots / dev.
#[must_use]
pub fn sample() -> ChatState {
    let mut state = ChatState::new();
    state.push_system("senpi --neo · ratatui frontend · backend: senpi --mode rpc".into());
    state.push_user("List all rust files in this crate and tell me what each top-level module does.".into());
    let assistant = state.push_assistant("I'll run a quick ls + grep to map the crate.".into());
    state.messages.push(Message {
        role: Role::Tool,
        body: String::new(),
        tool: Some(ToolCard {
            name: "bash".into(),
            status: ToolStatus::Success,
            summary: "$ rg --files -t rust packages/neo-tui/src\nsrc/lib.rs\nsrc/main.rs\nsrc/theme/mod.rs\nsrc/layout/mod.rs\nsrc/components/{header,footer,chat,input}.rs".into(),
        }),
    });
    state.message_ids.push(assistant.saturating_add(1));
    state.push_assistant("Mapped the native TUI modules. theme = JSON-driven semantic tokens. layout = pure compute. components = header / chat / input / footer / overlays. rpc = JSONL subprocess client. compositor = Component event/render helpers. anim = spinners + scanners.".into());
    state
}
