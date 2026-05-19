//! Settings list: extends `SelectList` with value cycling, toggles, and submenus.

use crossterm::event::{Event as CrosstermEvent, KeyCode, KeyEvent};
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders, List, ListItem, ListState};

use crate::compositor::{Component, EventResult, RenderContext};
use crate::theme::Token;

/// The runtime value of a settings row.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SettingValue {
    /// Boolean on/off value.
    Toggle(bool),
    /// One-of-many value: list of options + current index.
    Cycle(Vec<String>, usize),
    /// Navigates to another settings page.
    Submenu(String),
    /// Read-only display value.
    Static(String),
}

/// A single row in the settings list.
#[derive(Clone, Debug)]
pub struct SettingsItem {
    /// Human-readable label shown on the left.
    pub label: String,
    /// Current value + kind of this row.
    pub value: SettingValue,
}

impl SettingsItem {
    /// Create a toggle row.
    pub fn toggle<S: Into<String>>(label: S, initial: bool) -> Self {
        Self {
            label: label.into(),
            value: SettingValue::Toggle(initial),
        }
    }

    /// Create a cycle row.
    pub fn cycle<S: Into<String>, V: Into<String> + Clone>(
        label: S,
        options: &[V],
        initial_index: usize,
    ) -> Self {
        Self {
            label: label.into(),
            value: SettingValue::Cycle(options.iter().map(|v| v.clone().into()).collect(), initial_index),
        }
    }

    /// Create a submenu row.
    pub fn submenu<S: Into<String>, I: Into<String>>(label: S, submenu_id: I) -> Self {
        Self {
            label: label.into(),
            value: SettingValue::Submenu(submenu_id.into()),
        }
    }

    /// Create a static read-only row.
    pub fn static_value<S: Into<String>, V: Into<String>>(label: S, value: V) -> Self {
        Self {
            label: label.into(),
            value: SettingValue::Static(value.into()),
        }
    }
}

/// Component that renders a list of settings rows with interactive values.
#[derive(Clone, Debug)]
pub struct SettingsList {
    items: Vec<SettingsItem>,
    state: ListState,
    cancelled: bool,
    submenu_request: Option<String>,
    changes: Vec<(usize, SettingValue)>,
    filter: String,
    filtered_indices: Vec<usize>,
    visible_height: usize,
}

impl SettingsList {
    /// Build a new settings list from a vector of items.
    pub fn from_items(items: Vec<SettingsItem>) -> Self {
        let filtered_indices: Vec<usize> = (0..items.len()).collect();
        let mut state = ListState::default();
        if !items.is_empty() {
            state.select(Some(0));
        }
        Self {
            items,
            state,
            cancelled: false,
            submenu_request: None,
            changes: Vec::new(),
            filter: String::new(),
            filtered_indices,
            visible_height: 10,
        }
    }

    /// Set the filter query; only rows whose labels contain the query remain visible.
    pub fn set_filter(&mut self, q: &str) {
        self.filter = q.to_string();
        self.recompute_filter();
    }

    /// Drain and return all value changes made since the last call.
    pub fn take_changes(&mut self) -> Vec<(usize, SettingValue)> {
        std::mem::take(&mut self.changes)
    }

    /// Drain and return a pending submenu request, if any.
    pub const fn take_submenu_request(&mut self) -> Option<String> {
        self.submenu_request.take()
    }

    /// Whether the user pressed Esc.
    pub const fn was_cancelled(&self) -> bool {
        self.cancelled
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
                .filter(|(_, item)| item.label.to_lowercase().contains(&q))
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

    fn value_display(value: &SettingValue) -> String {
        match value {
            SettingValue::Toggle(true) => "[x]".to_string(),
            SettingValue::Toggle(false) => "[ ]".to_string(),
            SettingValue::Cycle(opts, idx) => {
                let opt = opts.get(*idx).map_or("?", String::as_str);
                format!("< {opt} >")
            }
            SettingValue::Submenu(_) => ">".to_string(),
            SettingValue::Static(v) => v.clone(),
        }
    }

    fn modify_selected(&mut self, delta: isize) {
        let Some(sel) = self.state.selected() else {
            return;
        };
        let Some(&orig_idx) = self.filtered_indices.get(sel) else {
            return;
        };
        let item = self.items.get_mut(orig_idx);
        let Some(item) = item else {
            return;
        };
        match &mut item.value {
            SettingValue::Cycle(opts, idx) => {
                let len = opts.len();
                if len == 0 {
                    return;
                }
                let new_idx = if delta < 0 {
                    (*idx + len - delta.unsigned_abs()) % len
                } else {
                    (*idx + delta.unsigned_abs()) % len
                };
                *idx = new_idx;
                self.changes.push((orig_idx, item.value.clone()));
            }
            SettingValue::Toggle(b) => {
                *b = !*b;
                self.changes.push((orig_idx, item.value.clone()));
            }
            _ => {}
        }
    }
}

impl Component for SettingsList {
    fn name(&self) -> &'static str {
        "SettingsList"
    }

    fn render(&mut self, frame: &mut Frame<'_>, area: Rect, ctx: &RenderContext<'_>) {
        let theme = ctx.theme;
        let items: Vec<ListItem> = self
            .filtered_indices
            .iter()
            .map(|&i| {
                let item = self.items.get(i);
                let label = item.map_or("", |it| it.label.as_str());
                let value_str = item.map(|it| Self::value_display(&it.value)).unwrap_or_default();
                let text = format!("{label} ........ {value_str}");
                ListItem::new(Line::from(Span::raw(text)))
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
            KeyCode::Char(' ') | KeyCode::Right => {
                self.modify_selected(1);
                EventResult::Consumed
            }
            KeyCode::Left => {
                self.modify_selected(-1);
                EventResult::Consumed
            }
            KeyCode::Enter => {
                let Some(sel) = self.state.selected() else {
                    return EventResult::Ignored;
                };
                let Some(&orig_idx) = self.filtered_indices.get(sel) else {
                    return EventResult::Ignored;
                };
                if let Some(item) = self.items.get(orig_idx) {
                    match &item.value {
                        SettingValue::Submenu(id) => {
                            self.submenu_request = Some(id.clone());
                            return EventResult::Consumed;
                        }
                        SettingValue::Toggle(_) => {
                            self.modify_selected(0);
                            return EventResult::Consumed;
                        }
                        _ => {}
                    }
                }
                EventResult::Ignored
            }
            KeyCode::Esc => {
                self.cancelled = true;
                EventResult::Consumed
            }
            _ => EventResult::Ignored,
        }
    }
}
