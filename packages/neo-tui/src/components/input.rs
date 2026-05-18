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
}

impl InputState {
    /// Insert a single character at the cursor and advance.
    pub fn insert_char(&mut self, ch: char) {
        self.buffer.insert(self.cursor, ch);
        self.cursor += ch.len_utf8();
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
        let prev = self.buffer[..self.cursor]
            .chars()
            .next_back()
            .map_or(0, char::len_utf8);
        let start = self.cursor - prev;
        self.buffer.replace_range(start..self.cursor, "");
        self.cursor = start;
    }

    /// Delete the char at the cursor, if any.
    pub fn delete_char_forward(&mut self) {
        if self.cursor >= self.buffer.len() {
            return;
        }
        let len = self.buffer[self.cursor..]
            .chars()
            .next()
            .map_or(0, char::len_utf8);
        self.buffer.replace_range(self.cursor..self.cursor + len, "");
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
    }

    pub fn cursor_line_start(&mut self) {
        let line_start = self.buffer[..self.cursor].rfind('\n').map_or(0, |i| i + 1);
        self.cursor = line_start;
    }

    pub fn cursor_line_end(&mut self) {
        let rel = self.buffer[self.cursor..].find('\n');
        self.cursor = match rel {
            Some(off) => self.cursor + off,
            None => self.buffer.len(),
        };
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
    }

    pub fn delete_word_backward(&mut self) {
        let end = self.cursor;
        self.cursor_word_left();
        self.buffer.replace_range(self.cursor..end, "");
    }

    pub fn delete_word_forward(&mut self) {
        let start = self.cursor;
        self.cursor_word_right();
        self.buffer.replace_range(start..self.cursor, "");
        self.cursor = start;
    }

    pub fn delete_to_line_start(&mut self) {
        let line_start = self.buffer[..self.cursor].rfind('\n').map_or(0, |i| i + 1);
        self.buffer.replace_range(line_start..self.cursor, "");
        self.cursor = line_start;
    }

    pub fn delete_to_line_end(&mut self) {
        let rel = self.buffer[self.cursor..].find('\n');
        let end = match rel {
            Some(off) => self.cursor + off,
            None => self.buffer.len(),
        };
        self.buffer.replace_range(self.cursor..end, "");
    }

    pub fn clear(&mut self) {
        self.buffer.clear();
        self.cursor = 0;
    }

    /// Move the buffer out of the input and reset state for the next
    /// prompt. Used by submit / follow-up.
    pub fn take_buffer(&mut self) -> String {
        self.cursor = 0;
        std::mem::take(&mut self.buffer)
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
