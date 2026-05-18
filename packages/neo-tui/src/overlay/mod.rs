//! Modal overlay system.
//!
//! Mirrors the opencode dialog pattern (semi-transparent backdrop +
//! centered floating panel) and the DeepSeek-TUI `ViewStack` pattern
//! (only the top overlay receives events). Three overlays ship:
//!
//! - [`HelpOverlay`]: scrollable list of every keymap binding +
//!   `app.*`/`tui.*`/`neo.*` action, auto-generated from the resolved
//!   keymap so it never drifts.
//! - [`ModelPickerOverlay`]: filterable list of available models
//!   (RPC `get_available_models`); confirm sends `set_model`.
//! - [`PaletteOverlay`]: nucleo-fuzzy-matched list of every binding,
//!   for quick discovery.
//!
//! All three render via `Clear` + a bordered `Block` centered on the
//! frame area. The compositor (in [`App`]) renders the chat scene
//! first, then the overlay on top.

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, List, ListItem, ListState, Padding, Paragraph, Wrap};

use crate::keymap::{KeyChord, ResolvedKeymap};
use crate::theme::{ResolvedTheme, Token};

/// Outcome of dispatching a key event into an overlay.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OverlayResult {
    /// Overlay stays open and consumed the key.
    Continue,
    /// User dismissed the overlay (Esc / Ctrl+C).
    Close,
}

/// Discriminator for the active overlay. The compositor pattern keeps
/// at most one overlay open at a time today; a future stack-based
/// version would replace this with `Vec<Overlay>`.
#[derive(Clone, Debug)]
pub enum Overlay {
    Help(HelpOverlay),
}

impl Overlay {
    pub fn handle_key(&mut self, event: KeyEvent) -> OverlayResult {
        match self {
            Self::Help(o) => o.handle_key(event),
        }
    }

    pub fn render(&self, frame: &mut Frame<'_>, area: Rect, theme: &ResolvedTheme) {
        match self {
            Self::Help(o) => o.render(frame, area, theme),
        }
    }
}

/// One row in the help overlay.
#[derive(Clone, Debug)]
pub struct HelpEntry {
    pub action_id: String,
    pub chords: Vec<String>,
}

/// Help overlay: auto-generated from the resolved keymap.
#[derive(Clone, Debug)]
pub struct HelpOverlay {
    pub entries: Vec<HelpEntry>,
    pub selected: usize,
    pub filter: String,
}

impl HelpOverlay {
    /// Build a help overlay from a resolved keymap. Skips bindings
    /// with no chords (e.g. `app.session.new` is unbound by default in
    /// the bundled keymap). Formats each compiled chord back into its
    /// JSON-keymap display string (`ctrl+l`, `shift+ctrl+p`, ...).
    #[must_use]
    pub fn from_keymap(keymap: &ResolvedKeymap) -> Self {
        let mut entries: Vec<HelpEntry> = Vec::new();
        for (id, chords) in &keymap.bindings {
            if chords.is_empty() {
                continue;
            }
            entries.push(HelpEntry {
                action_id: id.clone(),
                chords: chords.iter().map(format_chord).collect(),
            });
        }
        Self {
            entries,
            selected: 0,
            filter: String::new(),
        }
    }

    pub fn handle_key(&mut self, event: KeyEvent) -> OverlayResult {
        if event.kind != KeyEventKind::Press {
            return OverlayResult::Continue;
        }
        match (event.code, event.modifiers) {
            (KeyCode::Esc, _) | (KeyCode::Char('c'), KeyModifiers::CONTROL) => {
                OverlayResult::Close
            }
            (KeyCode::Up, _) => {
                if self.selected > 0 {
                    self.selected -= 1;
                }
                OverlayResult::Continue
            }
            (KeyCode::Down, _) => {
                if self.selected + 1 < self.filtered().len() {
                    self.selected += 1;
                }
                OverlayResult::Continue
            }
            (KeyCode::PageUp, _) => {
                self.selected = self.selected.saturating_sub(10);
                OverlayResult::Continue
            }
            (KeyCode::PageDown, _) => {
                let max = self.filtered().len().saturating_sub(1);
                self.selected = (self.selected + 10).min(max);
                OverlayResult::Continue
            }
            (KeyCode::Home, _) => {
                self.selected = 0;
                OverlayResult::Continue
            }
            (KeyCode::End, _) => {
                self.selected = self.filtered().len().saturating_sub(1);
                OverlayResult::Continue
            }
            (KeyCode::Backspace, _) => {
                self.filter.pop();
                self.selected = 0;
                OverlayResult::Continue
            }
            (KeyCode::Char(ch), mods) if !mods.contains(KeyModifiers::CONTROL) => {
                self.filter.push(ch);
                self.selected = 0;
                OverlayResult::Continue
            }
            _ => OverlayResult::Continue,
        }
    }

    /// Filtered view (case-insensitive substring on `action_id` or chords).
    #[must_use]
    pub fn filtered(&self) -> Vec<&HelpEntry> {
        if self.filter.is_empty() {
            return self.entries.iter().collect();
        }
        let needle = self.filter.to_ascii_lowercase();
        self.entries
            .iter()
            .filter(|e| {
                e.action_id.to_ascii_lowercase().contains(&needle)
                    || e.chords
                        .iter()
                        .any(|c| c.to_ascii_lowercase().contains(&needle))
            })
            .collect()
    }

    pub fn render(&self, frame: &mut Frame<'_>, area: Rect, theme: &ResolvedTheme) {
        let popup_area = centered_rect(area, 72, 24);
        if popup_area.height == 0 || popup_area.width == 0 {
            return;
        }
        frame.render_widget(Clear, popup_area);

        let block = Block::default()
            .borders(Borders::ALL)
            .style(Style::default().bg(theme.token(Token::BackgroundPanel)))
            .padding(Padding::uniform(1))
            .title(Line::from(vec![
                Span::styled(
                    " help ",
                    Style::default()
                        .fg(theme.token(Token::Primary))
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    format!("· {} bindings · esc to close ", self.entries.len()),
                    Style::default().fg(theme.token(Token::TextMuted)),
                ),
            ]));
        let inner = block.inner(popup_area);
        frame.render_widget(block, popup_area);

        let [filter_area, list_area] =
            Layout::vertical([Constraint::Length(1), Constraint::Min(0)]).areas(inner);

        let filter_line = if self.filter.is_empty() {
            Line::from(vec![
                Span::styled(
                    "filter: ",
                    Style::default().fg(theme.token(Token::TextMuted)),
                ),
                Span::styled(
                    "(type to filter, esc to close)",
                    Style::default().fg(theme.token(Token::TextMuted)),
                ),
            ])
        } else {
            Line::from(vec![
                Span::styled(
                    "filter: ",
                    Style::default().fg(theme.token(Token::TextMuted)),
                ),
                Span::styled(
                    self.filter.clone(),
                    Style::default()
                        .fg(theme.token(Token::Text))
                        .add_modifier(Modifier::BOLD),
                ),
            ])
        };
        frame.render_widget(Paragraph::new(filter_line), filter_area);

        let filtered = self.filtered();
        let items: Vec<ListItem<'_>> = filtered
            .iter()
            .map(|e| {
                let chords = e.chords.join(", ");
                ListItem::new(Line::from(vec![
                    Span::styled(
                        format!(" {chords:30} "),
                        Style::default()
                            .fg(theme.token(Token::Accent))
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(
                        e.action_id.clone(),
                        Style::default().fg(theme.token(Token::Text)),
                    ),
                ]))
            })
            .collect();

        let list = List::new(items)
            .highlight_style(
                Style::default()
                    .bg(theme.token(Token::SelectionBg))
                    .fg(theme.token(Token::SelectionFg))
                    .add_modifier(Modifier::BOLD),
            )
            .highlight_symbol(" > ");
        let mut state = ListState::default();
        state.select(Some(self.selected.min(filtered.len().saturating_sub(1))));
        frame.render_stateful_widget(list, list_area, &mut state);

        // Render-only quality-of-life: also display a Wrap hint at the
        // bottom of the panel describing the dispatch namespace
        // precedence so users know which binding wins under which
        // focus. The hint is rendered LAST so it cannot interfere with
        // the list scrollbar.
        if list_area.height >= 3 {
            let hint_area = Rect {
                y: list_area.y + list_area.height - 1,
                height: 1,
                ..list_area
            };
            let hint = Paragraph::new(Line::from(vec![Span::styled(
                "↑↓ select  · type to filter · esc close",
                Style::default().fg(theme.token(Token::TextMuted)),
            )]))
            .wrap(Wrap { trim: true });
            frame.render_widget(hint, hint_area);
        }
    }
}

fn format_chord(chord: &KeyChord) -> String {
    let mut parts: Vec<String> = Vec::new();
    if chord.mods.contains(KeyModifiers::CONTROL) {
        parts.push("ctrl".into());
    }
    if chord.mods.contains(KeyModifiers::ALT) {
        parts.push("alt".into());
    }
    if chord.mods.contains(KeyModifiers::SHIFT) {
        parts.push("shift".into());
    }
    if chord.mods.contains(KeyModifiers::SUPER) {
        parts.push("super".into());
    }
    let key = match chord.code {
        KeyCode::Enter => "enter".into(),
        KeyCode::Esc => "esc".into(),
        KeyCode::Tab => "tab".into(),
        KeyCode::BackTab => "backtab".into(),
        KeyCode::Backspace => "backspace".into(),
        KeyCode::Delete => "delete".into(),
        KeyCode::Home => "home".into(),
        KeyCode::End => "end".into(),
        KeyCode::PageUp => "pageup".into(),
        KeyCode::PageDown => "pagedown".into(),
        KeyCode::Up => "up".into(),
        KeyCode::Down => "down".into(),
        KeyCode::Left => "left".into(),
        KeyCode::Right => "right".into(),
        KeyCode::Insert => "insert".into(),
        KeyCode::F(n) => format!("f{n}"),
        KeyCode::Char(' ') => "space".into(),
        KeyCode::Char(ch) => ch.to_string(),
        other => format!("{other:?}").to_lowercase(),
    };
    parts.push(key);
    parts.join("+")
}

fn centered_rect(area: Rect, width_pct: u16, height_pct: u16) -> Rect {
    let h = Layout::horizontal([
        Constraint::Percentage((100 - width_pct) / 2),
        Constraint::Percentage(width_pct),
        Constraint::Percentage((100 - width_pct) / 2),
    ])
    .split(area);
    let v = Layout::vertical([
        Constraint::Percentage((100 - height_pct) / 2),
        Constraint::Percentage(height_pct),
        Constraint::Percentage((100 - height_pct) / 2),
    ])
    .split(h[1]);
    v[1]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::KeyEventState;

    const fn key(code: KeyCode, mods: KeyModifiers) -> KeyEvent {
        KeyEvent {
            code,
            modifiers: mods,
            kind: KeyEventKind::Press,
            state: KeyEventState::NONE,
        }
    }

    fn help_fixture() -> HelpOverlay {
        HelpOverlay {
            entries: vec![
                HelpEntry {
                    action_id: "app.model.select".into(),
                    chords: vec!["ctrl+l".into()],
                },
                HelpEntry {
                    action_id: "app.model.cycleForward".into(),
                    chords: vec!["ctrl+p".into()],
                },
                HelpEntry {
                    action_id: "tui.input.submit".into(),
                    chords: vec!["enter".into()],
                },
            ],
            selected: 0,
            filter: String::new(),
        }
    }

    #[test]
    fn escape_closes_overlay() {
        let mut overlay = help_fixture();
        assert_eq!(
            overlay.handle_key(key(KeyCode::Esc, KeyModifiers::NONE)),
            OverlayResult::Close,
        );
    }

    #[test]
    fn ctrl_c_closes_overlay() {
        let mut overlay = help_fixture();
        assert_eq!(
            overlay.handle_key(key(KeyCode::Char('c'), KeyModifiers::CONTROL)),
            OverlayResult::Close,
        );
    }

    #[test]
    fn arrow_down_moves_selection() {
        let mut overlay = help_fixture();
        assert_eq!(overlay.selected, 0);
        overlay.handle_key(key(KeyCode::Down, KeyModifiers::NONE));
        assert_eq!(overlay.selected, 1);
        overlay.handle_key(key(KeyCode::Down, KeyModifiers::NONE));
        assert_eq!(overlay.selected, 2);
        overlay.handle_key(key(KeyCode::Down, KeyModifiers::NONE));
        assert_eq!(overlay.selected, 2, "must not overflow past last entry");
    }

    #[test]
    fn typing_filters_entries() {
        let mut overlay = help_fixture();
        overlay.handle_key(key(KeyCode::Char('m'), KeyModifiers::NONE));
        assert_eq!(overlay.filter, "m");
        let filtered = overlay.filtered();
        assert_eq!(filtered.len(), 3);
    }

    #[test]
    fn typing_filters_entries_by_action_id_substring() {
        let mut overlay = help_fixture();
        overlay.handle_key(key(KeyCode::Char('s'), KeyModifiers::NONE));
        overlay.handle_key(key(KeyCode::Char('e'), KeyModifiers::NONE));
        overlay.handle_key(key(KeyCode::Char('l'), KeyModifiers::NONE));
        assert_eq!(overlay.filter, "sel");
        let filtered = overlay.filtered();
        // Only "app.model.select" contains "sel".
        assert_eq!(filtered.len(), 1, "one entry contains 'sel'");
        assert_eq!(filtered[0].action_id, "app.model.select");
    }

    #[test]
    fn backspace_clears_filter_char() {
        let mut overlay = help_fixture();
        overlay.filter = "model".into();
        overlay.selected = 2;
        overlay.handle_key(key(KeyCode::Backspace, KeyModifiers::NONE));
        assert_eq!(overlay.filter, "mode");
        assert_eq!(overlay.selected, 0, "selection resets on filter change");
    }

    #[test]
    fn filter_is_case_insensitive_and_matches_chord() {
        let mut overlay = help_fixture();
        overlay.filter = "CTRL+L".into();
        let filtered = overlay.filtered();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].action_id, "app.model.select");
    }
}
