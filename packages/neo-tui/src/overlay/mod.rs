//! Modal overlay system.
//!
//! Mirrors the opencode dialog pattern (semi-transparent backdrop +
//! centered floating panel) and the DeepSeek-TUI `ViewStack` pattern
//! (only the top overlay receives events). Three overlays ship:
//!
//! - [`HelpOverlay`]: scrollable list of every keymap binding +
//!   `app.*`/`tui.*`/`neo.*` action, auto-generated from the resolved
//!   keymap so it never drifts.
//! - [`SlashOverlay`]: grok-CLI-style `/` menu opened when `/` is
//!   typed into an empty input buffer.
//! - [`PaletteOverlay`]: opencode-style fuzzy command palette (Alt+P)
//!   matched via `nucleo-matcher`.
//!
//! All three render via `Clear` + a bordered `Block` centered on the
//! frame area. The compositor (in [`App`]) renders the chat scene
//! first, then the overlay on top.

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};
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
    /// User confirmed a selection; payload is the action ID to
    /// dispatch through `App::execute_action`. The app is responsible
    /// for closing the overlay before dispatching.
    Selected(String),
}

/// Discriminator for the active overlay. The compositor pattern keeps
/// at most one overlay open at a time today; a future stack-based
/// version would replace this with `Vec<Overlay>`.
#[derive(Clone, Debug)]
pub enum Overlay {
    Help(HelpOverlay),
    Slash(SlashOverlay),
    Palette(PaletteOverlay),
}

impl Overlay {
    pub fn handle_key(&mut self, event: KeyEvent) -> OverlayResult {
        match self {
            Self::Help(o) => o.handle_key(event),
            Self::Slash(o) => o.handle_key(event),
            Self::Palette(o) => o.handle_key(event),
        }
    }

    pub fn render(&self, frame: &mut Frame<'_>, area: Rect, theme: &ResolvedTheme) {
        match self {
            Self::Help(o) => o.render(frame, area, theme),
            Self::Slash(o) => o.render(frame, area, theme),
            Self::Palette(o) => o.render(frame, area, theme),
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
            (KeyCode::Esc, _) | (KeyCode::Char('c'), KeyModifiers::CONTROL) => OverlayResult::Close,
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
                    || e.chords.iter().any(|c| c.to_ascii_lowercase().contains(&needle))
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
                Span::styled("filter: ", Style::default().fg(theme.token(Token::TextMuted))),
                Span::styled(
                    "(type to filter, esc to close)",
                    Style::default().fg(theme.token(Token::TextMuted)),
                ),
            ])
        } else {
            Line::from(vec![
                Span::styled("filter: ", Style::default().fg(theme.token(Token::TextMuted))),
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
                    Span::styled(e.action_id.clone(), Style::default().fg(theme.token(Token::Text))),
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

/// Static catalog of slash commands; each entry maps the user-visible
/// `/foo` token to the legacy action id that the app dispatches when
/// the entry is picked.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SlashCommand {
    pub display: &'static str,
    pub action_id: &'static str,
    pub description: &'static str,
}

/// Default slash-command catalog. `&'static` so the slash overlay
/// does not allocate when opened.
pub const SLASH_COMMANDS: &[SlashCommand] = &[
    SlashCommand {
        display: "/help",
        action_id: "neo.help",
        description: "show keybinding help",
    },
    SlashCommand {
        display: "/model",
        action_id: "app.model.select",
        description: "open the model picker",
    },
    SlashCommand {
        display: "/new",
        action_id: "app.session.new",
        description: "start a new session",
    },
    SlashCommand {
        display: "/clear",
        action_id: "app.clear",
        description: "clear input buffer",
    },
    SlashCommand {
        display: "/quit",
        action_id: "app.exit",
        description: "quit senpi --neo",
    },
    SlashCommand {
        display: "/tree",
        action_id: "app.session.tree",
        description: "open the session tree",
    },
    SlashCommand {
        display: "/resume",
        action_id: "app.session.resume",
        description: "resume a previous session",
    },
    SlashCommand {
        display: "/fork",
        action_id: "app.session.fork",
        description: "fork the current session",
    },
];

/// Grok-CLI-style slash menu opened when `/` is typed into an empty
/// input buffer.
///
/// Substring-filtered, arrow-navigated. Enter selects the focused
/// entry's `action_id`, which the app then dispatches through the
/// normal `execute_action` path.
#[derive(Clone, Debug, Default)]
pub struct SlashOverlay {
    pub selected: usize,
    pub filter: String,
}

impl SlashOverlay {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn handle_key(&mut self, event: KeyEvent) -> OverlayResult {
        if event.kind != KeyEventKind::Press {
            return OverlayResult::Continue;
        }
        match (event.code, event.modifiers) {
            (KeyCode::Esc, _) | (KeyCode::Char('c'), KeyModifiers::CONTROL) => OverlayResult::Close,
            (KeyCode::Enter, _) => {
                let filtered = self.filtered();
                if filtered.is_empty() {
                    OverlayResult::Close
                } else {
                    let idx = self.selected.min(filtered.len() - 1);
                    OverlayResult::Selected(filtered[idx].action_id.to_owned())
                }
            }
            (KeyCode::Up, _) => {
                self.selected = self.selected.saturating_sub(1);
                OverlayResult::Continue
            }
            (KeyCode::Down, _) => {
                if self.selected + 1 < self.filtered().len() {
                    self.selected += 1;
                }
                OverlayResult::Continue
            }
            (KeyCode::Backspace, _) => {
                self.filter.pop();
                self.selected = 0;
                OverlayResult::Continue
            }
            (KeyCode::Char(ch), mods) if !mods.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) => {
                self.filter.push(ch);
                self.selected = 0;
                OverlayResult::Continue
            }
            _ => OverlayResult::Continue,
        }
    }

    #[must_use]
    pub fn filtered(&self) -> Vec<&'static SlashCommand> {
        if self.filter.is_empty() {
            return SLASH_COMMANDS.iter().collect();
        }
        let needle = self.filter.to_ascii_lowercase();
        SLASH_COMMANDS
            .iter()
            .filter(|c| {
                c.display.to_ascii_lowercase().contains(&needle)
                    || c.description.to_ascii_lowercase().contains(&needle)
            })
            .collect()
    }

    pub fn render(&self, frame: &mut Frame<'_>, area: Rect, theme: &ResolvedTheme) {
        let popup = centered_rect(area, 60, 18);
        if popup.height == 0 || popup.width == 0 {
            return;
        }
        frame.render_widget(Clear, popup);

        let block = Block::default()
            .borders(Borders::ALL)
            .style(Style::default().bg(theme.token(Token::BackgroundPanel)))
            .padding(Padding::uniform(1))
            .title(Line::from(vec![
                Span::styled(
                    " slash commands ",
                    Style::default()
                        .fg(theme.token(Token::Primary))
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    " · enter run · esc close ",
                    Style::default().fg(theme.token(Token::TextMuted)),
                ),
            ]));
        let inner = block.inner(popup);
        frame.render_widget(block, popup);

        let [filter_area, list_area] =
            Layout::vertical([Constraint::Length(1), Constraint::Min(0)]).areas(inner);

        let filter_text = if self.filter.is_empty() {
            "(type to filter)".to_string()
        } else {
            self.filter.clone()
        };
        let filter_style = if self.filter.is_empty() {
            Style::default().fg(theme.token(Token::TextMuted))
        } else {
            Style::default()
                .fg(theme.token(Token::Text))
                .add_modifier(Modifier::BOLD)
        };
        let filter_line = Line::from(vec![
            Span::styled(
                "/",
                Style::default()
                    .fg(theme.token(Token::Accent))
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(filter_text, filter_style),
        ]);
        frame.render_widget(Paragraph::new(filter_line), filter_area);

        let filtered = self.filtered();
        let items: Vec<ListItem<'_>> = filtered
            .iter()
            .map(|c| {
                ListItem::new(Line::from(vec![
                    Span::styled(
                        format!(" {:10} ", c.display),
                        Style::default()
                            .fg(theme.token(Token::Accent))
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(c.description, Style::default().fg(theme.token(Token::Text))),
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
    }
}

/// One entry in the command palette. `display` is the user-visible
/// label (action id + bound chords); `action_id` is what the app
/// dispatches on Enter.
#[derive(Clone, Debug)]
pub struct PaletteEntry {
    pub action_id: String,
    pub display: String,
}

/// Fuzzy command palette (opencode style), opened by `Alt+P`. Lists
/// every action in the active keymap plus the slash-command catalog
/// and ranks them with `nucleo-matcher`.
#[derive(Clone, Debug)]
pub struct PaletteOverlay {
    pub entries: Vec<PaletteEntry>,
    pub selected: usize,
    pub query: String,
}

impl PaletteOverlay {
    /// Build a palette overlay seeded from the resolved keymap plus
    /// the static slash-command catalog. Entries are sorted by action
    /// id so the unfiltered view is deterministic.
    #[must_use]
    pub fn from_keymap(keymap: &ResolvedKeymap) -> Self {
        let mut entries: Vec<PaletteEntry> = Vec::new();
        for (id, chords) in &keymap.bindings {
            let display = if chords.is_empty() {
                format!("{id} (unbound)")
            } else {
                let chord_strs: Vec<String> = chords.iter().map(format_chord).collect();
                format!("{id} ({})", chord_strs.join(", "))
            };
            entries.push(PaletteEntry {
                action_id: id.clone(),
                display,
            });
        }
        for cmd in SLASH_COMMANDS {
            entries.push(PaletteEntry {
                action_id: cmd.action_id.to_owned(),
                display: format!("{} - {}", cmd.display, cmd.description),
            });
        }
        entries.sort_by(|a, b| a.action_id.cmp(&b.action_id));
        Self {
            entries,
            selected: 0,
            query: String::new(),
        }
    }

    pub fn handle_key(&mut self, event: KeyEvent) -> OverlayResult {
        if event.kind != KeyEventKind::Press {
            return OverlayResult::Continue;
        }
        match (event.code, event.modifiers) {
            (KeyCode::Esc, _) | (KeyCode::Char('c'), KeyModifiers::CONTROL) => OverlayResult::Close,
            (KeyCode::Enter, _) => {
                let filtered = self.filtered();
                if filtered.is_empty() {
                    OverlayResult::Close
                } else {
                    let idx = self.selected.min(filtered.len() - 1);
                    OverlayResult::Selected(filtered[idx].action_id.clone())
                }
            }
            (KeyCode::Up, _) => {
                self.selected = self.selected.saturating_sub(1);
                OverlayResult::Continue
            }
            (KeyCode::Down, _) => {
                if self.selected + 1 < self.filtered().len() {
                    self.selected += 1;
                }
                OverlayResult::Continue
            }
            (KeyCode::Backspace, _) => {
                self.query.pop();
                self.selected = 0;
                OverlayResult::Continue
            }
            (KeyCode::Char(ch), mods) if !mods.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) => {
                self.query.push(ch);
                self.selected = 0;
                OverlayResult::Continue
            }
            _ => OverlayResult::Continue,
        }
    }

    /// Returns matching entries ranked by nucleo score (descending).
    /// With an empty query the pre-sorted entry list is returned
    /// verbatim, so behavioral tests can rely on it.
    #[must_use]
    pub fn filtered(&self) -> Vec<&PaletteEntry> {
        if self.query.is_empty() {
            return self.entries.iter().collect();
        }
        let mut matcher = Matcher::new(Config::DEFAULT);
        let pattern = Pattern::parse(&self.query, CaseMatching::Ignore, Normalization::Smart);
        let mut scored: Vec<(u32, &PaletteEntry)> = Vec::with_capacity(self.entries.len());
        for entry in &self.entries {
            let mut buf: Vec<char> = Vec::new();
            let haystack = Utf32Str::new(&entry.display, &mut buf);
            if let Some(score) = pattern.score(haystack, &mut matcher) {
                scored.push((score, entry));
            }
        }
        scored.sort_by_key(|s| std::cmp::Reverse(s.0));
        scored.into_iter().map(|(_, e)| e).collect()
    }

    pub fn render(&self, frame: &mut Frame<'_>, area: Rect, theme: &ResolvedTheme) {
        let popup = centered_rect(area, 72, 24);
        if popup.height == 0 || popup.width == 0 {
            return;
        }
        frame.render_widget(Clear, popup);

        let block = Block::default()
            .borders(Borders::ALL)
            .style(Style::default().bg(theme.token(Token::BackgroundPanel)))
            .padding(Padding::uniform(1))
            .title(Line::from(vec![
                Span::styled(
                    " command palette ",
                    Style::default()
                        .fg(theme.token(Token::Primary))
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    format!(" · {} actions · esc close ", self.entries.len()),
                    Style::default().fg(theme.token(Token::TextMuted)),
                ),
            ]));
        let inner = block.inner(popup);
        frame.render_widget(block, popup);

        let [query_area, list_area] =
            Layout::vertical([Constraint::Length(1), Constraint::Min(0)]).areas(inner);

        let query_text = if self.query.is_empty() {
            "(fuzzy filter)".to_string()
        } else {
            self.query.clone()
        };
        let query_style = if self.query.is_empty() {
            Style::default().fg(theme.token(Token::TextMuted))
        } else {
            Style::default()
                .fg(theme.token(Token::Text))
                .add_modifier(Modifier::BOLD)
        };
        let query_line = Line::from(vec![
            Span::styled(
                "> ",
                Style::default()
                    .fg(theme.token(Token::Accent))
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(query_text, query_style),
        ]);
        frame.render_widget(Paragraph::new(query_line), query_area);

        let filtered = self.filtered();
        let items: Vec<ListItem<'_>> = filtered
            .iter()
            .map(|e| {
                ListItem::new(Span::styled(
                    e.display.clone(),
                    Style::default().fg(theme.token(Token::Text)),
                ))
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

    #[test]
    fn slash_default_entries_match_static_catalog() {
        let overlay = SlashOverlay::new();
        let filtered = overlay.filtered();
        assert_eq!(filtered.len(), SLASH_COMMANDS.len());
        assert!(filtered.iter().any(|c| c.display == "/help"));
        assert!(filtered.iter().any(|c| c.display == "/model"));
    }

    #[test]
    fn slash_typing_filters_by_substring() {
        let mut overlay = SlashOverlay::new();
        overlay.handle_key(key(KeyCode::Char('h'), KeyModifiers::NONE));
        assert_eq!(overlay.filter, "h");
        let filtered = overlay.filtered();
        assert!(filtered.iter().any(|c| c.display == "/help"));
        assert!(filtered.iter().any(|c| c.display == "/fork"));
    }

    #[test]
    fn slash_enter_returns_selected_action_id() {
        let mut overlay = SlashOverlay::new();
        let result = overlay.handle_key(key(KeyCode::Enter, KeyModifiers::NONE));
        let OverlayResult::Selected(id) = result else {
            panic!("expected Selected, got {result:?}");
        };
        assert_eq!(id, SLASH_COMMANDS[0].action_id);
    }

    #[test]
    fn slash_enter_with_filter_dispatches_filtered_choice() {
        let mut overlay = SlashOverlay::new();
        overlay.handle_key(key(KeyCode::Char('q'), KeyModifiers::NONE));
        overlay.handle_key(key(KeyCode::Char('u'), KeyModifiers::NONE));
        let result = overlay.handle_key(key(KeyCode::Enter, KeyModifiers::NONE));
        let OverlayResult::Selected(id) = result else {
            panic!("expected Selected, got {result:?}");
        };
        assert_eq!(id, "app.exit", "quit slash command must dispatch app.exit");
    }

    #[test]
    fn slash_escape_closes_without_selecting() {
        let mut overlay = SlashOverlay::new();
        assert_eq!(
            overlay.handle_key(key(KeyCode::Esc, KeyModifiers::NONE)),
            OverlayResult::Close,
        );
    }

    fn palette_fixture() -> PaletteOverlay {
        PaletteOverlay {
            entries: vec![
                PaletteEntry {
                    action_id: "app.model.select".into(),
                    display: "app.model.select (ctrl+l)".into(),
                },
                PaletteEntry {
                    action_id: "app.exit".into(),
                    display: "app.exit (ctrl+d)".into(),
                },
                PaletteEntry {
                    action_id: "neo.help".into(),
                    display: "neo.help (?)".into(),
                },
            ],
            selected: 0,
            query: String::new(),
        }
    }

    #[test]
    fn palette_empty_query_returns_all_entries() {
        let overlay = palette_fixture();
        assert_eq!(overlay.filtered().len(), 3);
    }

    #[test]
    fn palette_query_filters_via_nucleo() {
        let mut overlay = palette_fixture();
        overlay.query = "exit".into();
        let filtered = overlay.filtered();
        assert!(!filtered.is_empty());
        assert_eq!(filtered[0].action_id, "app.exit");
    }

    #[test]
    fn palette_enter_returns_selected_action_id() {
        let mut overlay = palette_fixture();
        overlay.query = "exit".into();
        let result = overlay.handle_key(key(KeyCode::Enter, KeyModifiers::NONE));
        let OverlayResult::Selected(id) = result else {
            panic!("expected Selected, got {result:?}");
        };
        assert_eq!(id, "app.exit");
    }

    #[test]
    fn palette_escape_closes_without_selecting() {
        let mut overlay = palette_fixture();
        assert_eq!(
            overlay.handle_key(key(KeyCode::Esc, KeyModifiers::NONE)),
            OverlayResult::Close,
        );
    }

    #[test]
    fn palette_from_keymap_includes_slash_commands() {
        use crate::keymap::{ResolvedKeymap, parse};
        let spec = parse(crate::DEFAULT_KEYMAP_JSON).unwrap();
        let resolved = ResolvedKeymap::compile(&spec).unwrap();
        let overlay = PaletteOverlay::from_keymap(&resolved);
        assert!(overlay.entries.iter().any(|e| e.display.contains("/help")));
        assert!(overlay.entries.iter().any(|e| e.display.contains("/quit")));
    }
}
