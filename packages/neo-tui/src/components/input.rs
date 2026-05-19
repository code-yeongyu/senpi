//! Input editor frame. Grapheme-aware cursor model + unicode-width based
//! render column so CJK / emoji / combining marks behave the way users
//! expect.

use std::ops::Range;

use ratatui::{
    Frame,
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, BorderType, Borders, Padding, Paragraph},
};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use crate::{
    text::{slice_by_column, visible_width, wrap_text_with_ansi},
    theme::{ResolvedTheme, Token},
};

const PASTE_MARKER_THRESHOLD: usize = 10;
const HISTORY_MAX_ENTRIES: usize = 1_000;

#[derive(Clone, Debug)]
struct PasteSegment {
    id: u32,
    content: String,
    lines: usize,
    byte_range: Range<usize>,
}

#[derive(Clone, Debug, Default)]
struct History {
    entries: Vec<String>,
    cursor: Option<usize>,
}

#[derive(Clone, Copy, Debug)]
enum PasteReplacement {
    Marker,
    Content,
}

/// Inputs to the input component.
#[derive(Clone, Debug)]
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
    paste_segments: Vec<PasteSegment>,
    next_paste_id: u32,
    history: History,
}

impl Default for InputState {
    fn default() -> Self {
        Self {
            buffer: String::new(),
            placeholder: String::new(),
            mode_label: String::new(),
            focus_pulse: 0,
            cursor: 0,
            preferred_column: None,
            kill_ring: Vec::new(),
            undo_stack: Vec::new(),
            paste_segments: Vec::new(),
            next_paste_id: 1,
            history: History::default(),
        }
    }
}

impl InputState {
    pub fn new(placeholder: impl Into<String>, mode_label: impl Into<String>) -> Self {
        Self {
            placeholder: placeholder.into(),
            mode_label: mode_label.into(),
            ..Self::default()
        }
    }

    #[must_use]
    pub fn display_lines(&self, wrap_width: usize) -> Vec<String> {
        wrap_display_text(&self.display_buffer(), wrap_width)
    }

    #[must_use]
    pub fn cursor_visual_position(&self, wrap_width: usize) -> (usize, usize) {
        let prefix = self.display_buffer_until(self.cursor);
        let lines = wrap_display_text(&prefix, wrap_width);
        let row = lines.len().saturating_sub(1);
        let col = lines.last().map_or(0, |line| visible_width(line));
        (row, col)
    }

    pub fn handle_paste(&mut self, text: &str) {
        let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
        let lines = logical_line_count(&normalized);
        if lines <= PASTE_MARKER_THRESHOLD {
            self.insert_str(&normalized);
            return;
        }

        self.snapshot();
        let id = self.next_paste_id;
        self.next_paste_id = self.next_paste_id.checked_add(1).unwrap_or(1);
        let sentinel = paste_sentinel(id);
        let start = self.cursor;
        self.buffer.insert_str(self.cursor, &sentinel);
        self.cursor += sentinel.len();
        self.paste_segments.push(PasteSegment {
            id,
            content: normalized,
            lines,
            byte_range: start..self.cursor,
        });
        self.after_user_edit();
    }

    pub fn push_history(&mut self, text: &str) {
        if text.is_empty() || self.history.entries.last().is_some_and(|entry| entry == text) {
            return;
        }
        self.history.entries.push(text.to_string());
        let excess = self.history.entries.len().saturating_sub(HISTORY_MAX_ENTRIES);
        if excess > 0 {
            self.history.entries.drain(..excess);
        }
        self.history.cursor = None;
    }

    #[must_use]
    pub fn recall_prev_history(&mut self) -> Option<String> {
        if self.history.entries.is_empty() || (!self.buffer.is_empty() && self.history.cursor.is_none()) {
            return None;
        }

        let next = match self.history.cursor {
            None => self.history.entries.len() - 1,
            Some(0) => return None,
            Some(cursor) => cursor - 1,
        };
        self.history.cursor = Some(next);
        let entry = self.history.entries[next].clone();
        self.replace_with_history_entry(&entry);
        Some(entry)
    }

    #[must_use]
    pub fn recall_next_history(&mut self) -> Option<String> {
        let current = self.history.cursor?;
        let next = current + 1;
        if next >= self.history.entries.len() {
            self.history.cursor = None;
            return None;
        }

        self.history.cursor = Some(next);
        let entry = self.history.entries[next].clone();
        self.replace_with_history_entry(&entry);
        Some(entry)
    }

    /// Insert a single character at the cursor and advance by its
    /// UTF-8 byte length. CJK / emoji that arrive as a single `char`
    /// land cleanly because each grapheme is a single character; IMEs
    /// that deliver pre-composition chars are still rendered as the
    /// user types and resolved when the IME commits.
    pub fn insert_char(&mut self, ch: char) {
        self.snapshot();
        self.buffer.insert(self.cursor, ch);
        self.cursor += ch.len_utf8();
        self.after_user_edit();
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
        self.after_user_edit();
    }

    pub fn delete_char_backward(&mut self) {
        if let Some(range) = self.paste_range_before_or_containing_cursor() {
            self.snapshot();
            self.buffer.replace_range(range.clone(), "");
            self.cursor = range.start;
            self.after_user_edit();
            return;
        }
        let Some(start) = self.prev_grapheme_boundary() else {
            return;
        };
        self.snapshot();
        self.buffer.replace_range(start..self.cursor, "");
        self.cursor = start;
        self.after_user_edit();
    }

    pub fn delete_char_forward(&mut self) {
        if let Some(range) = self.paste_range_at_or_containing_cursor() {
            self.snapshot();
            self.buffer.replace_range(range.clone(), "");
            self.cursor = range.start;
            self.after_user_edit();
            return;
        }
        let Some(end) = self.next_grapheme_boundary() else {
            return;
        };
        self.snapshot();
        self.buffer.replace_range(self.cursor..end, "");
        self.after_user_edit();
    }

    pub fn cursor_left(&mut self) {
        if let Some(range) = self.paste_range_before_or_containing_cursor() {
            self.cursor = range.start;
            self.preferred_column = None;
            return;
        }
        let Some(start) = self.prev_grapheme_boundary() else {
            return;
        };
        self.cursor = start;
        self.preferred_column = None;
    }

    pub fn cursor_right(&mut self) {
        if let Some(range) = self.paste_range_at_or_containing_cursor() {
            self.cursor = range.end;
            self.preferred_column = None;
            return;
        }
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
        if let Some(range) = self.paste_range_containing_offset(self.cursor) {
            self.cursor = range.start;
        }
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
        if let Some(range) = self.paste_range_containing_offset(self.cursor) {
            self.cursor = range.end;
        }
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
        self.after_user_edit();
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
        self.after_user_edit();
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
        self.after_user_edit();
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
        self.after_user_edit();
    }

    pub fn clear(&mut self) {
        if self.buffer.is_empty() {
            return;
        }
        self.snapshot();
        self.kill_ring.push(std::mem::take(&mut self.buffer));
        self.cursor = 0;
        self.after_user_edit();
    }

    pub fn take_buffer(&mut self) -> String {
        let text = self.expanded_buffer();
        self.buffer.clear();
        self.paste_segments.clear();
        self.cursor = 0;
        self.preferred_column = None;
        self.undo_stack.clear();
        self.history.cursor = None;
        text
    }

    fn snapshot(&mut self) {
        self.undo_stack.push((self.buffer.clone(), self.cursor));
        if self.undo_stack.len() > 100 {
            self.undo_stack.remove(0);
        }
    }

    fn after_user_edit(&mut self) {
        self.preferred_column = None;
        self.history.cursor = None;
        self.refresh_paste_ranges();
    }

    fn replace_with_history_entry(&mut self, entry: &str) {
        self.buffer.clear();
        self.buffer.push_str(entry);
        self.cursor = self.buffer.len();
        self.preferred_column = None;
        self.paste_segments.clear();
    }

    fn refresh_paste_ranges(&mut self) {
        let buffer = self.buffer.as_str();
        for segment in &mut self.paste_segments {
            let sentinel = paste_sentinel(segment.id);
            segment.byte_range = buffer
                .find(&sentinel)
                .map_or(0..0, |start| start..start + sentinel.len());
        }
    }

    fn paste_range_before_or_containing_cursor(&self) -> Option<Range<usize>> {
        self.paste_segments
            .iter()
            .find(|segment| {
                segment.byte_range.start < segment.byte_range.end
                    && segment.byte_range.start < self.cursor
                    && self.cursor <= segment.byte_range.end
            })
            .map(|segment| segment.byte_range.clone())
    }

    fn paste_range_at_or_containing_cursor(&self) -> Option<Range<usize>> {
        self.paste_segments
            .iter()
            .find(|segment| {
                segment.byte_range.start < segment.byte_range.end
                    && segment.byte_range.start <= self.cursor
                    && self.cursor < segment.byte_range.end
            })
            .map(|segment| segment.byte_range.clone())
    }

    fn paste_range_containing_offset(&self, offset: usize) -> Option<Range<usize>> {
        self.paste_segments
            .iter()
            .find(|segment| {
                segment.byte_range.start < segment.byte_range.end
                    && segment.byte_range.start < offset
                    && offset < segment.byte_range.end
            })
            .map(|segment| segment.byte_range.clone())
    }

    fn display_buffer(&self) -> String {
        self.buffer_with_paste_replacements(self.buffer.len(), PasteReplacement::Marker)
    }

    fn display_buffer_until(&self, end: usize) -> String {
        self.buffer_with_paste_replacements(end, PasteReplacement::Marker)
    }

    fn expanded_buffer(&self) -> String {
        self.buffer_with_paste_replacements(self.buffer.len(), PasteReplacement::Content)
    }

    fn buffer_with_paste_replacements(&self, end: usize, replacement: PasteReplacement) -> String {
        let end = end.min(self.buffer.len());
        let mut result = String::new();
        let mut cursor = 0usize;

        for (range, segment) in self.present_paste_segments() {
            if range.start >= end {
                break;
            }
            if range.start < cursor {
                continue;
            }
            result.push_str(&self.buffer[cursor..range.start.min(end)]);
            if range.end <= end {
                match replacement {
                    PasteReplacement::Marker => result.push_str(&paste_marker(segment.id, segment.lines)),
                    PasteReplacement::Content => result.push_str(&segment.content),
                }
                cursor = range.end;
            } else {
                if matches!(replacement, PasteReplacement::Marker) {
                    result.push_str(&paste_marker(segment.id, segment.lines));
                }
                cursor = end;
            }
        }

        if cursor < end {
            result.push_str(&self.buffer[cursor..end]);
        }
        result
    }

    fn present_paste_segments(&self) -> Vec<(Range<usize>, &PasteSegment)> {
        let mut segments = Vec::new();
        for segment in &self.paste_segments {
            let sentinel = paste_sentinel(segment.id);
            if let Some(start) = self.buffer.find(&sentinel) {
                segments.push((start..start + sentinel.len(), segment));
            }
        }
        segments.sort_by_key(|(range, _)| range.start);
        segments
    }

    fn prev_grapheme_boundary(&self) -> Option<usize> {
        if self.cursor == 0 {
            return None;
        }
        if let Some(range) = self.paste_range_before_or_containing_cursor() {
            return Some(range.start);
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
        if let Some(range) = self.paste_range_at_or_containing_cursor() {
            return Some(range.end);
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
        let prefix = self.display_buffer_until(self.cursor);
        let line_start = prefix.rfind('\n').map_or(0, |i| i + 1);
        visible_width(&prefix[line_start..])
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
            self.after_user_edit();
        }
    }

    pub fn yank_pop(&mut self) {
        if self.kill_ring.len() < 2 {
            return;
        }
        let Some(last) = self.kill_ring.pop() else {
            return;
        };
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
        self.after_user_edit();
    }

    pub fn undo(&mut self) {
        if let Some((buf, cur)) = self.undo_stack.pop() {
            self.buffer = buf;
            self.cursor = cur;
            self.preferred_column = None;
            self.history.cursor = None;
            self.refresh_paste_ranges();
        }
    }
}

fn logical_line_count(text: &str) -> usize {
    if text.is_empty() {
        0
    } else {
        text.chars().filter(|&ch| ch == '\n').count() + 1
    }
}

fn paste_sentinel(id: u32) -> String {
    format!("\0PASTE-{id}\0")
}

fn paste_marker(id: u32, lines: usize) -> String {
    format!("[paste #{id} +{lines} lines]")
}

fn wrap_display_text(text: &str, wrap_width: usize) -> Vec<String> {
    let wrap_width = wrap_width.max(1);
    let mut lines = Vec::new();

    for raw in text.split('\n') {
        if raw.is_empty() {
            lines.push(String::new());
            continue;
        }
        let line_wrap_width = if visible_width(raw) >= wrap_width
            && raw
                .graphemes(true)
                .any(|grapheme| UnicodeWidthStr::width(grapheme) > 1)
        {
            wrap_width.saturating_sub(1).max(1)
        } else {
            wrap_width
        };
        let wrapped = wrap_text_with_ansi(raw, line_wrap_width);
        if wrapped.is_empty() {
            lines.push(String::new());
        } else {
            lines.extend(wrapped);
        }
    }

    if lines.is_empty() {
        lines.push(String::new());
    }
    lines
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
        let wrap_width = usize::from(inner.width.saturating_sub(2).max(1));
        let display_lines = state.display_lines(wrap_width);
        let (cursor_row, cursor_col) = state.cursor_visual_position(wrap_width);
        let cursor_row = cursor_row.min(display_lines.len().saturating_sub(1));
        let mut lines: Vec<Line<'_>> = Vec::with_capacity(display_lines.len());
        for (line_idx, raw) in display_lines.iter().enumerate() {
            let mut spans: Vec<Span<'_>> = Vec::new();
            if line_idx == 0 {
                spans.push(prompt.clone());
            } else {
                spans.push(Span::raw("  "));
            }
            if line_idx == cursor_row {
                let line_width = visible_width(raw);
                let split_col = cursor_col.min(line_width);
                let prefix = slice_by_column(raw, 0, split_col);
                if !prefix.is_empty() {
                    spans.push(Span::styled(prefix, Style::default().fg(text)));
                }
                spans.push(cursor_glyph.clone());
                let suffix = slice_by_column(raw, split_col, line_width);
                if !suffix.is_empty() {
                    spans.push(Span::styled(suffix, Style::default().fg(text)));
                }
            } else {
                spans.push(Span::styled(raw.clone(), Style::default().fg(text)));
            }
            lines.push(Line::from(spans));
        }
        lines
    };

    frame.render_widget(Paragraph::new(content).style(body_style), inner);
}
