//! Input editor frame. Real `tui-textarea` integration lands later;
//! today this draws a bordered Paragraph with the typed buffer + a
//! breathing accent border.

use ratatui::{
    Frame,
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, BorderType, Borders, Padding, Paragraph},
};

use crate::theme::{ResolvedTheme, Token};

/// Inputs to the input component.
#[derive(Clone, Debug, Default)]
pub struct InputState {
    pub buffer: String,
    pub placeholder: String,
    pub mode_label: String,
    /// 0..=255 - drives the breathing border accent (T15).
    pub focus_pulse: u8,
    /// Byte offset of the insertion caret into `buffer`. Always at a
    /// UTF-8 char boundary; methods on `InputState` maintain that
    /// invariant.
    pub cursor: usize,
    /// Sticky preferred column for vertical cursor moves. Set by
    /// horizontal moves; honoured by `cursor_up` / `cursor_down` so a
    /// short line in the middle of a wider buffer doesn't permanently
    /// clamp the column.
    pub preferred_column: Option<usize>,
    /// Single-entry kill ring used by `yank` / `yank_pop`. Populated by
    /// `delete_word_backward/forward`, `delete_to_line_start/end`, and
    /// the legacy `tui.input.copy` "clear" gesture.
    pub kill_ring: Vec<String>,
    /// Snapshot history for `undo`. Pushed on every mutation that
    /// produces a user-visible change; popped by `tui.editor.undo`.
    pub undo_stack: Vec<(String, usize)>,
}

impl InputState {
    /// Insert a single character at the cursor and advance.
    pub fn insert_char(&mut self, ch: char) {
        self.snapshot();
        self.buffer.insert(self.cursor, ch);
        self.cursor += ch.len_utf8();
        self.preferred_column = None;
    }

    /// Insert a literal newline at the cursor (shift+enter).
    pub fn insert_newline(&mut self) {
        self.insert_char('\n');
    }

    /// Delete the char before the cursor, if any.
    pub fn delete_char_backward(&mut self) {
        if self.cursor == 0 {
            return;
        }
        self.snapshot();
        let prev = self.buffer[..self.cursor]
            .chars()
            .next_back()
            .map_or(0, char::len_utf8);
        let start = self.cursor - prev;
        self.buffer.replace_range(start..self.cursor, "");
        self.cursor = start;
        self.preferred_column = None;
    }

    /// Delete the char at the cursor, if any.
    pub fn delete_char_forward(&mut self) {
        if self.cursor >= self.buffer.len() {
            return;
        }
        self.snapshot();
        let len = self.buffer[self.cursor..]
            .chars()
            .next()
            .map_or(0, char::len_utf8);
        self.buffer.replace_range(self.cursor..self.cursor + len, "");
        self.preferred_column = None;
    }

    pub fn cursor_left(&mut self) {
        if self.cursor == 0 {
            return;
        }
        let prev = self.buffer[..self.cursor]
            .chars()
            .next_back()
            .map_or(0, char::len_utf8);
        self.cursor -= prev;
        self.preferred_column = None;
    }

    pub fn cursor_right(&mut self) {
        if self.cursor >= self.buffer.len() {
            return;
        }
        let next = self.buffer[self.cursor..]
            .chars()
            .next()
            .map_or(0, char::len_utf8);
        self.cursor += next;
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

    pub fn cursor_word_left(&mut self) {
        let mut idx = self.cursor;
        let bytes = self.buffer.as_bytes();
        while idx > 0
            && let Some(b) = bytes.get(idx - 1)
            && !b.is_ascii_alphanumeric()
        {
            idx -= 1;
        }
        while idx > 0
            && let Some(b) = bytes.get(idx - 1)
            && b.is_ascii_alphanumeric()
        {
            idx -= 1;
        }
        self.cursor = idx;
        self.preferred_column = None;
    }

    pub fn cursor_word_right(&mut self) {
        let len = self.buffer.len();
        let mut idx = self.cursor;
        let bytes = self.buffer.as_bytes();
        while idx < len
            && let Some(b) = bytes.get(idx)
            && b.is_ascii_alphanumeric()
        {
            idx += 1;
        }
        while idx < len
            && let Some(b) = bytes.get(idx)
            && !b.is_ascii_alphanumeric()
        {
            idx += 1;
        }
        self.cursor = idx;
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

    /// Move the buffer out of the input and reset state for the next
    /// prompt. Used by submit / follow-up.
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

    fn column_of_cursor(&self) -> usize {
        let line_start = self.buffer[..self.cursor].rfind('\n').map_or(0, |i| i + 1);
        self.buffer[line_start..self.cursor].chars().count()
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

    fn move_to_line(&mut self, target_line: usize, desired_column: usize) {
        let Some(line_start) = self.nth_line_start(target_line) else {
            return;
        };
        let next_nl = self.buffer[line_start..].find('\n');
        let line_end = next_nl.map_or(self.buffer.len(), |off| line_start + off);
        let mut col = 0usize;
        let mut byte = line_start;
        for (idx, ch) in self.buffer[line_start..line_end].char_indices() {
            if col == desired_column {
                byte = line_start + idx;
                break;
            }
            col += 1;
            byte = line_start + idx + ch.len_utf8();
        }
        if col < desired_column {
            byte = line_end;
        }
        self.cursor = byte;
    }

    pub fn cursor_up(&mut self) {
        let line = self.current_line_index();
        if line == 0 {
            self.cursor = 0;
            return;
        }
        let desired = self.preferred_column.unwrap_or_else(|| self.column_of_cursor());
        self.preferred_column = Some(desired);
        self.move_to_line(line - 1, desired);
    }

    pub fn cursor_down(&mut self) {
        let line = self.current_line_index();
        let total_lines = self.buffer.bytes().filter(|&b| b == b'\n').count();
        if line >= total_lines {
            self.cursor = self.buffer.len();
            return;
        }
        let desired = self.preferred_column.unwrap_or_else(|| self.column_of_cursor());
        self.preferred_column = Some(desired);
        self.move_to_line(line + 1, desired);
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

    /// Paste the most recently killed text at the cursor. Legacy
    /// senpi treats `Ctrl+Y` as "yank latest kill", so we read the
    /// front of the ring without rotating it; `yank_pop` walks back
    /// in time.
    pub fn yank(&mut self) {
        if let Some(text) = self.kill_ring.last().cloned() {
            self.snapshot();
            self.buffer.insert_str(self.cursor, &text);
            self.cursor += text.len();
        }
    }

    /// Replace the most recently yanked text with the previous kill
    /// ring entry. Matches the emacs `M-y` (yank-pop) gesture the
    /// legacy TUI binds via `alt+y`.
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
pub fn render(frame: &mut Frame<'_>, area: Rect, theme: &ResolvedTheme, state: &InputState) {
    if area.height < 3 || area.width < 4 {
        return;
    }
    let border = theme.token(Token::BorderActive);
    let muted = theme.token(Token::TextMuted);
    let text = theme.token(Token::Text);
    let element_bg = theme.token(Token::BackgroundElement);
    let bg = theme.token(Token::Background);

    let title = Line::from(vec![
        Span::styled(
            format!(" {} ", state.mode_label),
            Style::default().fg(text).add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            "│ ↵ submit · ⇧↵ newline · @ files · / commands · ^P palette",
            Style::default().fg(muted),
        ),
    ]);
    let block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Plain)
        .border_style(Style::default().fg(border))
        .style(Style::default().bg(bg))
        .padding(Padding::horizontal(1))
        .title(title);

    let inner = block.inner(area);
    frame.render_widget(block, area);

    let body_style = Style::default().bg(element_bg);
    let cursor_glyph = Span::styled("█", Style::default().fg(border).add_modifier(Modifier::BOLD));
    let content: Vec<Line<'_>> = if state.buffer.is_empty() {
        vec![Line::from(vec![
            Span::styled(state.placeholder.clone(), Style::default().fg(muted)),
            cursor_glyph,
        ])]
    } else {
        let cursor = state.cursor.min(state.buffer.len());
        let mut byte_offset = 0usize;
        let mut lines: Vec<Line<'_>> = Vec::new();
        for raw in state.buffer.split('\n') {
            let line_start = byte_offset;
            let line_end = byte_offset + raw.len();
            let mut spans: Vec<Span<'_>> = Vec::new();
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
