//! Input editor frame. Grapheme-aware cursor model + unicode-width based
//! render column so CJK / emoji / combining marks behave the way users
//! expect.

use ratatui::{
    Frame,
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, BorderType, Borders, Padding, Paragraph},
};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use crate::theme::{ResolvedTheme, Token};

/// Inputs to the input component.
#[derive(Clone, Debug, Default)]
pub struct InputState {
    pub buffer: String,
    pub placeholder: String,
    pub mode_label: String,
    /// 0..=255 - drives the breathing border accent (T15).
    pub focus_pulse: u8,
    /// Byte offset of the insertion caret into `buffer`. Always on a
    /// grapheme cluster boundary; the methods on `InputState` are
    /// responsible for keeping it there so callers can splice text in
    /// without splitting CJK / emoji / combining-mark sequences.
    pub cursor: usize,
    /// Sticky preferred display column for vertical cursor moves. Set
    /// by horizontal moves; honoured by `cursor_up` / `cursor_down` so
    /// a short line in the middle of a wider buffer does not
    /// permanently clamp the column.
    pub preferred_column: Option<usize>,
    /// Single-entry kill ring used by `yank` / `yank_pop`.
    pub kill_ring: Vec<String>,
    /// Snapshot history for `undo`. Pushed on every mutation that
    /// produces a user-visible change; popped by `tui.editor.undo`.
    pub undo_stack: Vec<(String, usize)>,
}

impl InputState {
    /// Insert a single character at the cursor and advance by its
    /// UTF-8 byte length. CJK / emoji that arrive as a single `char`
    /// land cleanly because each grapheme is a single character; IMEs
    /// that deliver pre-composition chars are still rendered as the
    /// user types and resolved when the IME commits.
    pub fn insert_char(&mut self, ch: char) {
        self.snapshot();
        self.buffer.insert(self.cursor, ch);
        self.cursor += ch.len_utf8();
        self.preferred_column = None;
    }

    pub fn insert_newline(&mut self) {
        self.insert_char('\n');
    }

    /// Insert a complete string (typically a paste-burst or a yank).
    pub fn insert_str(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        self.snapshot();
        self.buffer.insert_str(self.cursor, text);
        self.cursor += text.len();
        self.preferred_column = None;
    }

    pub fn delete_char_backward(&mut self) {
        let Some(start) = self.prev_grapheme_boundary() else {
            return;
        };
        self.snapshot();
        self.buffer.replace_range(start..self.cursor, "");
        self.cursor = start;
        self.preferred_column = None;
    }

    pub fn delete_char_forward(&mut self) {
        let Some(end) = self.next_grapheme_boundary() else {
            return;
        };
        self.snapshot();
        self.buffer.replace_range(self.cursor..end, "");
        self.preferred_column = None;
    }

    pub fn cursor_left(&mut self) {
        let Some(start) = self.prev_grapheme_boundary() else {
            return;
        };
        self.cursor = start;
        self.preferred_column = None;
    }

    pub fn cursor_right(&mut self) {
        let Some(end) = self.next_grapheme_boundary() else {
            return;
        };
        self.cursor = end;
        self.preferred_column = None;
    }

    pub fn cursor_line_start(&mut self) {
        let line_start = self.buffer[..self.cursor].rfind('\n').map_or(0, |i| i + 1);
        self.cursor = line_start;
        self.preferred_column = None;
    }

    pub fn cursor_line_end(&mut self) {
        let rel = self.buffer[self.cursor..].find('\n');
        self.cursor = match rel {
            Some(off) => self.cursor + off,
            None => self.buffer.len(),
        };
        self.preferred_column = None;
    }

    /// Move the cursor one Unicode word boundary to the left. Falls
    /// back to a single grapheme step if the search has nowhere to go,
    /// keeping the cursor responsive on buffers made entirely of
    /// punctuation or symbols.
    pub fn cursor_word_left(&mut self) {
        let prefix = &self.buffer[..self.cursor];
        let target = prefix
            .split_word_bound_indices()
            .rev()
            .find(|(_, w)| w.chars().any(char::is_alphanumeric))
            .map(|(i, _)| i);
        self.cursor = target.unwrap_or_else(|| self.prev_grapheme_boundary().unwrap_or(0));
        self.preferred_column = None;
    }

    /// Move the cursor one Unicode word boundary to the right.
    pub fn cursor_word_right(&mut self) {
        let suffix = &self.buffer[self.cursor..];
        let target = suffix
            .split_word_bound_indices()
            .find(|(_, w)| w.chars().any(char::is_alphanumeric))
            .map(|(i, w)| self.cursor + i + w.len());
        self.cursor = target.unwrap_or_else(|| self.next_grapheme_boundary().unwrap_or(self.buffer.len()));
        self.preferred_column = None;
    }

    pub fn delete_word_backward(&mut self) {
        let end = self.cursor;
        self.cursor_word_left();
        if self.cursor == end {
            return;
        }
        self.snapshot();
        let killed = self.buffer[self.cursor..end].to_string();
        self.buffer.replace_range(self.cursor..end, "");
        self.kill_ring.push(killed);
    }

    pub fn delete_word_forward(&mut self) {
        let start = self.cursor;
        self.cursor_word_right();
        if self.cursor == start {
            return;
        }
        self.snapshot();
        let killed = self.buffer[start..self.cursor].to_string();
        self.buffer.replace_range(start..self.cursor, "");
        self.cursor = start;
        self.kill_ring.push(killed);
    }

    pub fn delete_to_line_start(&mut self) {
        let line_start = self.buffer[..self.cursor].rfind('\n').map_or(0, |i| i + 1);
        if line_start == self.cursor {
            return;
        }
        self.snapshot();
        let killed = self.buffer[line_start..self.cursor].to_string();
        self.buffer.replace_range(line_start..self.cursor, "");
        self.cursor = line_start;
        self.kill_ring.push(killed);
        self.preferred_column = None;
    }

    pub fn delete_to_line_end(&mut self) {
        let rel = self.buffer[self.cursor..].find('\n');
        let end = match rel {
            Some(off) => self.cursor + off,
            None => self.buffer.len(),
        };
        if end == self.cursor {
            return;
        }
        self.snapshot();
        let killed = self.buffer[self.cursor..end].to_string();
        self.buffer.replace_range(self.cursor..end, "");
        self.kill_ring.push(killed);
    }

    pub fn clear(&mut self) {
        if self.buffer.is_empty() {
            return;
        }
        self.snapshot();
        self.kill_ring.push(std::mem::take(&mut self.buffer));
        self.cursor = 0;
        self.preferred_column = None;
    }

    pub fn take_buffer(&mut self) -> String {
        self.cursor = 0;
        self.preferred_column = None;
        self.undo_stack.clear();
        std::mem::take(&mut self.buffer)
    }

    fn snapshot(&mut self) {
        self.undo_stack.push((self.buffer.clone(), self.cursor));
        if self.undo_stack.len() > 100 {
            self.undo_stack.remove(0);
        }
    }

    fn prev_grapheme_boundary(&self) -> Option<usize> {
        if self.cursor == 0 {
            return None;
        }
        self.buffer[..self.cursor]
            .grapheme_indices(true)
            .next_back()
            .map(|(i, _)| i)
    }

    fn next_grapheme_boundary(&self) -> Option<usize> {
        if self.cursor >= self.buffer.len() {
            return None;
        }
        self.buffer[self.cursor..]
            .grapheme_indices(true)
            .nth(1)
            .map(|(i, _)| self.cursor + i)
            .or(Some(self.buffer.len()))
    }

    /// Display column of the cursor within its current line, in
    /// terminal cells. CJK / emoji contribute 2 cells each so the
    /// caret lands on the same column the user can see.
    fn display_column(&self) -> usize {
        let line_start = self.buffer[..self.cursor].rfind('\n').map_or(0, |i| i + 1);
        UnicodeWidthStr::width(&self.buffer[line_start..self.cursor])
    }

    fn nth_line_start(&self, target_line: usize) -> Option<usize> {
        if target_line == 0 {
            return Some(0);
        }
        let mut count = 0usize;
        for (idx, b) in self.buffer.bytes().enumerate() {
            if b == b'\n' {
                count += 1;
                if count == target_line {
                    return Some(idx + 1);
                }
            }
        }
        None
    }

    fn current_line_index(&self) -> usize {
        self.buffer[..self.cursor].bytes().filter(|&b| b == b'\n').count()
    }

    fn move_to_display_column(&mut self, target_line: usize, desired_column: usize) {
        let Some(line_start) = self.nth_line_start(target_line) else {
            return;
        };
        let next_nl = self.buffer[line_start..].find('\n');
        let line_end = next_nl.map_or(self.buffer.len(), |off| line_start + off);
        let mut col = 0usize;
        let mut byte = line_start;
        for (offset, grapheme) in self.buffer[line_start..line_end].grapheme_indices(true) {
            let grapheme_width = UnicodeWidthStr::width(grapheme);
            if col + grapheme_width > desired_column {
                byte = line_start + offset;
                self.cursor = byte;
                return;
            }
            col += grapheme_width;
            byte = line_start + offset + grapheme.len();
        }
        self.cursor = byte.min(line_end);
    }

    pub fn cursor_up(&mut self) {
        let line = self.current_line_index();
        if line == 0 {
            self.cursor = 0;
            return;
        }
        let desired = self.preferred_column.unwrap_or_else(|| self.display_column());
        self.preferred_column = Some(desired);
        self.move_to_display_column(line - 1, desired);
    }

    pub fn cursor_down(&mut self) {
        let line = self.current_line_index();
        let total_lines = self.buffer.bytes().filter(|&b| b == b'\n').count();
        if line >= total_lines {
            self.cursor = self.buffer.len();
            return;
        }
        let desired = self.preferred_column.unwrap_or_else(|| self.display_column());
        self.preferred_column = Some(desired);
        self.move_to_display_column(line + 1, desired);
    }

    pub fn page_up(&mut self) {
        for _ in 0..10 {
            self.cursor_up();
        }
    }

    pub fn page_down(&mut self) {
        for _ in 0..10 {
            self.cursor_down();
        }
    }

    pub fn yank(&mut self) {
        if let Some(text) = self.kill_ring.last().cloned() {
            self.snapshot();
            self.buffer.insert_str(self.cursor, &text);
            self.cursor += text.len();
        }
    }

    pub fn yank_pop(&mut self) {
        if self.kill_ring.len() < 2 {
            return;
        }
        let last = self.kill_ring.pop().expect("checked len >= 2");
        let prev = self.kill_ring.last().cloned().unwrap_or_default();
        if self.buffer[..self.cursor].ends_with(&last) {
            let start = self.cursor - last.len();
            self.buffer.replace_range(start..self.cursor, &prev);
            self.cursor = start + prev.len();
        } else {
            self.buffer.insert_str(self.cursor, &prev);
            self.cursor += prev.len();
        }
        self.kill_ring.insert(0, last);
    }

    pub fn undo(&mut self) {
        if let Some((buf, cur)) = self.undo_stack.pop() {
            self.buffer = buf;
            self.cursor = cur;
            self.preferred_column = None;
        }
    }
}

/// Render the input frame into the given rect.
///
/// Codex-inspired styling: flush left chevron prompt prefix, dim
/// placeholder hint that stays after the caret on empty input, and a
/// thin rounded border that becomes a breathing accent on focus.
pub fn render(frame: &mut Frame<'_>, area: Rect, theme: &ResolvedTheme, state: &InputState) {
    if area.height < 3 || area.width < 4 {
        return;
    }
    let border = theme.token(Token::BorderActive);
    let muted = theme.token(Token::TextMuted);
    let text = theme.token(Token::Text);
    let accent = theme.token(Token::Primary);
    let element_bg = theme.token(Token::BackgroundElement);
    let bg = theme.token(Token::Background);

    let title = Line::from(vec![Span::styled(
        "  shift+enter  newline · enter  send · /  commands · ctrl+p  palette · ?  help",
        Style::default().fg(muted),
    )]);
    let block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(Style::default().fg(border))
        .style(Style::default().bg(bg))
        .padding(Padding::horizontal(1))
        .title(title);

    let inner = block.inner(area);
    frame.render_widget(block, area);

    let prompt = Span::styled("› ", Style::default().fg(accent).add_modifier(Modifier::BOLD));
    let body_style = Style::default().bg(element_bg);
    let cursor_glyph = Span::styled(
        "▏",
        Style::default()
            .fg(accent)
            .add_modifier(Modifier::BOLD | Modifier::RAPID_BLINK),
    );

    let content: Vec<Line<'_>> = if state.buffer.is_empty() {
        vec![Line::from(vec![
            prompt.clone(),
            cursor_glyph.clone(),
            Span::styled(
                state.placeholder.clone(),
                Style::default().fg(muted).add_modifier(Modifier::ITALIC),
            ),
        ])]
    } else {
        let cursor = state.cursor.min(state.buffer.len());
        let mut byte_offset = 0usize;
        let mut lines: Vec<Line<'_>> = Vec::new();
        for (line_idx, raw) in state.buffer.split('\n').enumerate() {
            let line_start = byte_offset;
            let line_end = byte_offset + raw.len();
            let mut spans: Vec<Span<'_>> = Vec::new();
            if line_idx == 0 {
                spans.push(prompt.clone());
            } else {
                spans.push(Span::raw("  "));
            }
            if cursor >= line_start && cursor <= line_end {
                let split = cursor - line_start;
                if split > 0 {
                    spans.push(Span::styled(raw[..split].to_string(), Style::default().fg(text)));
                }
                spans.push(cursor_glyph.clone());
                if split < raw.len() {
                    spans.push(Span::styled(raw[split..].to_string(), Style::default().fg(text)));
                }
            } else {
                spans.push(Span::styled(raw.to_string(), Style::default().fg(text)));
            }
            lines.push(Line::from(spans));
            byte_offset = line_end + 1;
        }
        lines
    };

    frame.render_widget(Paragraph::new(content).style(body_style), inner);
}
