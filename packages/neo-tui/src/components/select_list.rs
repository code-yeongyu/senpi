//! Reusable selection list: arrow nav, page nav, filter, scroll, cancel.
//! Used by overlays (model picker, theme picker, slash menu, etc.).

use crossterm::event::{Event as CrosstermEvent, KeyCode, KeyEvent};
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders, List, ListItem, ListState};

use crate::compositor::{Component, EventResult, RenderContext};
use crate::theme::Token;

#[derive(Clone, Debug)]
pub struct SelectList {
    items: Vec<String>,
    filter: String,
    filtered_indices: Vec<usize>,
    state: ListState,
    visible_height: usize,
    cancelled: bool,
    selection: Option<(String, usize)>,
}

impl SelectList {
    pub fn new<S: Into<String>>(items: impl IntoIterator<Item = S>) -> Self {
        let items: Vec<String> = items.into_iter().map(Into::into).collect();
        let filtered_indices: Vec<usize> = (0..items.len()).collect();
        let mut state = ListState::default();
        if !items.is_empty() {
            state.select(Some(0));
        }
        Self {
            items,
            filter: String::new(),
            filtered_indices,
            state,
            visible_height: 10,
            cancelled: false,
            selection: None,
        }
    }

    pub const fn selected_index(&self) -> Option<usize> {
        self.state.selected()
    }

    pub const fn was_cancelled(&self) -> bool {
        self.cancelled
    }

    pub const fn take_selection(&mut self) -> Option<(String, usize)> {
        self.selection.take()
    }

    pub fn visible_indices(&self) -> &[usize] {
        &self.filtered_indices
    }

    pub fn set_visible_height(&mut self, h: usize) {
        self.visible_height = h.max(1);
    }

    pub fn scroll_top_offset(&self) -> usize {
        // Standard "keep selection roughly centered" scroll.
        self.state.selected().map_or(0, |sel| {
            let half = self.visible_height / 2;
            sel.saturating_sub(half)
        })
    }

    pub fn set_filter(&mut self, q: &str) {
        self.filter = q.to_string();
        self.recompute_filter();
    }

    fn recompute_filter(&mut self) {
        if self.filter.is_empty() {
            self.filtered_indices = (0..self.items.len()).collect();
        } else {
            let q = self.filter.to_lowercase();
            self.filtered_indices = self
                .items
                .iter()
                .enumerate()
                .filter(|(_, s)| s.to_lowercase().contains(&q))
                .map(|(i, _)| i)
                .collect();
        }
        if self.filtered_indices.is_empty() {
            self.state.select(None);
        } else {
            self.state.select(Some(0));
        }
    }

    fn step_down(&mut self, n: usize) {
        let len = self.filtered_indices.len();
        if len == 0 {
            return;
        }
        let cur = self.state.selected().unwrap_or(0);
        self.state.select(Some((cur + n).min(len - 1)));
    }

    fn step_up(&mut self, n: usize) {
        let len = self.filtered_indices.len();
        if len == 0 {
            return;
        }
        let cur = self.state.selected().unwrap_or(0);
        self.state.select(Some(cur.saturating_sub(n)));
    }
}

impl Component for SelectList {
    fn name(&self) -> &'static str {
        "SelectList"
    }

    fn render(&mut self, frame: &mut Frame<'_>, area: Rect, ctx: &RenderContext<'_>) {
        let theme = ctx.theme;
        let items: Vec<ListItem> = self
            .filtered_indices
            .iter()
            .map(|&i| {
                let label = self.items.get(i).cloned().unwrap_or_default();
                ListItem::new(Line::from(Span::raw(label)))
            })
            .collect();
        let block = Block::default()
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(Style::default().fg(theme.token(Token::Border)))
            .style(Style::default().bg(theme.token(Token::BackgroundPanel)));
        let list = List::new(items)
            .block(block)
            .style(Style::default().fg(theme.token(Token::Text)))
            .highlight_style(
                Style::default()
                    .fg(theme.token(Token::SelectionFg))
                    .bg(theme.token(Token::SelectionBg))
                    .add_modifier(Modifier::BOLD),
            );
        frame.render_stateful_widget(list, area, &mut self.state);
    }

    fn handle_event(&mut self, event: &CrosstermEvent) -> EventResult {
        let CrosstermEvent::Key(KeyEvent { code, modifiers, .. }) = event else {
            return EventResult::Ignored;
        };
        let _ = modifiers;
        match code {
            KeyCode::Down => {
                self.step_down(1);
                EventResult::Consumed
            }
            KeyCode::Up => {
                self.step_up(1);
                EventResult::Consumed
            }
            KeyCode::PageDown => {
                self.step_down(self.visible_height);
                EventResult::Consumed
            }
            KeyCode::PageUp => {
                self.step_up(self.visible_height);
                EventResult::Consumed
            }
            KeyCode::Enter => {
                if let Some(sel) = self.state.selected() {
                    if let Some(&orig_idx) = self.filtered_indices.get(sel) {
                        if let Some(label) = self.items.get(orig_idx) {
                            self.selection = Some((label.clone(), orig_idx));
                        }
                    }
                }
                EventResult::Consumed
            }
            KeyCode::Esc => {
                self.cancelled = true;
                EventResult::Consumed
            }
            _ => EventResult::Ignored,
        }
    }
}
