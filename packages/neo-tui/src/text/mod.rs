//! ANSI-aware text width, truncation, wrapping, and slicing utilities.

use unicode_segmentation::UnicodeSegmentation;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

const ANSI_RESET: &str = "\x1b[0m";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Token<'a> {
    Text(&'a str),
    Ansi(&'a str),
}

#[derive(Clone, Debug)]
struct AnsiScan<'a> {
    input: &'a str,
    offset: usize,
}

const fn ansi_scan(input: &str) -> AnsiScan<'_> {
    AnsiScan { input, offset: 0 }
}

impl<'a> Iterator for AnsiScan<'a> {
    type Item = Token<'a>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.offset >= self.input.len() {
            return None;
        }

        if let Some(end) = ansi_end(self.input, self.offset) {
            let start = self.offset;
            self.offset = end;
            return Some(Token::Ansi(&self.input[start..end]));
        }

        let start = self.offset;
        let mut cursor = self.offset;
        while let Some(relative) = self.input[cursor..].find('\x1b') {
            let escape = cursor + relative;
            if ansi_end(self.input, escape).is_some() {
                self.offset = escape;
                return Some(Token::Text(&self.input[start..escape]));
            }
            cursor = escape + 1;
        }

        self.offset = self.input.len();
        Some(Token::Text(&self.input[start..]))
    }
}

fn ansi_end(input: &str, offset: usize) -> Option<usize> {
    let bytes = input.as_bytes();
    if bytes.get(offset) != Some(&0x1b) {
        return None;
    }

    match bytes.get(offset + 1) {
        Some(b'[') => csi_end(bytes, offset + 2),
        Some(b']') => osc_end(bytes, offset + 2),
        _ => None,
    }
}

fn csi_end(bytes: &[u8], mut offset: usize) -> Option<usize> {
    while let Some(byte) = bytes.get(offset) {
        if (0x40..=0x7e).contains(byte) {
            return Some(offset + 1);
        }
        offset += 1;
    }
    None
}

fn osc_end(bytes: &[u8], mut offset: usize) -> Option<usize> {
    while let Some(byte) = bytes.get(offset) {
        if *byte == b'\x07' {
            return Some(offset + 1);
        }
        if *byte == 0x1b && bytes.get(offset + 1) == Some(&b'\\') {
            return Some(offset + 2);
        }
        offset += 1;
    }
    None
}

/// Return the display width of `input` in terminal cells, ignoring ANSI escape sequences.
pub fn visible_width(input: &str) -> usize {
    ansi_scan(input)
        .map(|token| match token {
            Token::Text(text) => text_width(text),
            Token::Ansi(_) => 0,
        })
        .sum()
}

/// Truncate `input` to at most `max_width` visible cells, appending `ellipsis` when truncated.
pub fn truncate_to_width(input: &str, max_width: usize, ellipsis: &str) -> String {
    if max_width == 0 {
        return String::new();
    }
    if visible_width(input) <= max_width {
        return input.to_string();
    }

    let ellipsis_width = visible_width(ellipsis);
    if ellipsis_width >= max_width {
        return take_prefix_to_width(ellipsis, max_width);
    }

    let target_width = max_width - ellipsis_width;
    let mut truncated = take_prefix_to_width(input, target_width);
    let saw_style = ansi_scan(input).any(|token| matches!(token, Token::Ansi(code) if is_sgr(code)));

    truncated.push_str(ellipsis);
    if saw_style && !truncated.ends_with(ANSI_RESET) {
        truncated.push_str(ANSI_RESET);
    }
    truncated
}

/// Wrap `input` into lines no wider than `width`, preserving active ANSI SGR styles across wraps.
pub fn wrap_text_with_ansi(input: &str, width: usize) -> Vec<String> {
    if input.is_empty() || width == 0 {
        return Vec::new();
    }

    let mut lines = Vec::new();
    for raw_line in input.split('\n') {
        wrap_single_line(raw_line, width, &mut lines);
    }
    lines
}

/// Return visible columns in `[start, end_exclusive)`, without carrying ANSI state from skipped text.
pub fn slice_by_column(input: &str, start: usize, end_exclusive: usize) -> String {
    if start >= end_exclusive {
        return String::new();
    }

    let ansi_start = start;
    let ansi_end = end_exclusive;
    let ansi_skip_offset = usize::from(has_ansi_before_column(input, start));
    let start = start.saturating_sub(ansi_skip_offset);
    let end_exclusive = end_exclusive.saturating_sub(ansi_skip_offset);

    let mut result = String::new();
    let mut column = 0usize;
    for token in ansi_scan(input) {
        match token {
            Token::Ansi(code) => {
                if column >= ansi_start && column < ansi_end {
                    result.push_str(code);
                }
            }
            Token::Text(text) => {
                for grapheme in text.graphemes(true) {
                    let width = grapheme_width(grapheme);
                    let grapheme_end = column + width;
                    let in_range = if width == 0 {
                        column >= start && column < end_exclusive
                    } else {
                        column >= start && grapheme_end <= end_exclusive
                    };
                    if in_range {
                        result.push_str(grapheme);
                    }
                    column = grapheme_end;
                    if column >= end_exclusive {
                        break;
                    }
                }
            }
        }
        if column >= end_exclusive {
            break;
        }
    }

    result
}

fn has_ansi_before_column(input: &str, target: usize) -> bool {
    if target == 0 {
        return false;
    }

    let mut column = 0usize;
    for token in ansi_scan(input) {
        match token {
            Token::Ansi(_) if column < target => return true,
            Token::Ansi(_) => {}
            Token::Text(text) => {
                for grapheme in text.graphemes(true) {
                    if column >= target {
                        return false;
                    }
                    column += grapheme_width(grapheme);
                }
            }
        }
    }

    false
}

fn text_width(text: &str) -> usize {
    text.graphemes(true).map(grapheme_width).sum()
}

fn grapheme_width(grapheme: &str) -> usize {
    if grapheme == "\t" {
        1
    } else {
        UnicodeWidthStr::width(grapheme)
    }
}

fn take_prefix_to_width(input: &str, max_width: usize) -> String {
    if max_width == 0 {
        return String::new();
    }

    let mut result = String::new();
    let mut width = 0usize;
    let mut saw_style = false;

    'scan: for token in ansi_scan(input) {
        match token {
            Token::Ansi(code) => {
                saw_style |= is_sgr(code);
                result.push_str(code);
            }
            Token::Text(text) => {
                for grapheme in text.graphemes(true) {
                    let grapheme_width = grapheme_width(grapheme);
                    if width + grapheme_width > max_width {
                        break 'scan;
                    }
                    result.push_str(grapheme);
                    width += grapheme_width;
                }
            }
        }
    }

    if saw_style && !result.ends_with(ANSI_RESET) {
        result.push_str(ANSI_RESET);
    }
    result
}

#[derive(Clone, Debug, Default)]
struct AnsiTracker {
    active_sgr: Vec<String>,
}

impl AnsiTracker {
    fn process(&mut self, code: &str) {
        let Some(params) = sgr_params(code) else {
            return;
        };
        let mut saw_reset = params.is_empty();
        let mut saw_non_reset = false;
        for part in params.split(';').filter(|part| !part.is_empty()) {
            if part == "0" {
                saw_reset = true;
            } else {
                saw_non_reset = true;
            }
        }

        if saw_reset {
            self.active_sgr.clear();
        }
        if saw_non_reset {
            self.active_sgr.push(code.to_string());
        }
    }

    fn active_codes(&self) -> String {
        self.active_sgr.concat()
    }

    fn has_active_codes(&self) -> bool {
        !self.active_sgr.is_empty()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WrapTokenKind {
    Word,
    Whitespace,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct WrapToken {
    raw: String,
    width: usize,
    kind: WrapTokenKind,
}

fn wrap_single_line(input: &str, width: usize, lines: &mut Vec<String>) {
    let mut tracker = AnsiTracker::default();
    let mut current = String::new();
    let mut current_width = 0usize;

    for token in split_wrap_tokens(input) {
        match token.kind {
            WrapTokenKind::Whitespace => {
                handle_whitespace_token(
                    &token,
                    &mut tracker,
                    &mut current,
                    &mut current_width,
                    lines,
                    width,
                );
            }
            WrapTokenKind::Word if token.width > width => {
                append_long_word(
                    &token.raw,
                    width,
                    &mut tracker,
                    &mut current,
                    &mut current_width,
                    lines,
                );
            }
            WrapTokenKind::Word => {
                append_word_token(
                    &token,
                    width,
                    &mut tracker,
                    &mut current,
                    &mut current_width,
                    lines,
                );
            }
        }
    }

    push_current_line(lines, &mut current, &mut current_width, &tracker);
}

fn split_wrap_tokens(input: &str) -> Vec<WrapToken> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut current_kind: Option<WrapTokenKind> = None;
    let mut pending_ansi = String::new();

    for token in ansi_scan(input) {
        match token {
            Token::Ansi(code) if current.is_empty() => pending_ansi.push_str(code),
            Token::Ansi(code) => current.push_str(code),
            Token::Text(text) => {
                for grapheme in text.graphemes(true) {
                    let kind = if grapheme.chars().all(char::is_whitespace) {
                        WrapTokenKind::Whitespace
                    } else {
                        WrapTokenKind::Word
                    };
                    if current_kind.is_some_and(|existing| existing != kind) && !current.is_empty() {
                        push_wrap_token(&mut tokens, &mut current, current_kind);
                        current_kind = None;
                    }
                    if current.is_empty() {
                        current.push_str(&pending_ansi);
                        pending_ansi.clear();
                        current_kind = Some(kind);
                    }
                    current.push_str(grapheme);
                }
            }
        }
    }

    if !pending_ansi.is_empty() {
        current.push_str(&pending_ansi);
    }
    push_wrap_token(&mut tokens, &mut current, current_kind);
    tokens
}

fn push_wrap_token(tokens: &mut Vec<WrapToken>, current: &mut String, kind: Option<WrapTokenKind>) {
    if current.is_empty() {
        return;
    }

    let raw = std::mem::take(current);
    tokens.push(WrapToken {
        width: visible_width(&raw),
        kind: kind.unwrap_or(WrapTokenKind::Word),
        raw,
    });
}

fn handle_whitespace_token(
    token: &WrapToken,
    tracker: &mut AnsiTracker,
    current: &mut String,
    current_width: &mut usize,
    lines: &mut Vec<String>,
    width: usize,
) {
    if *current_width == 0 {
        update_tracker_from_ansi(&token.raw, tracker);
        reset_current_prefix(current, tracker);
        return;
    }

    if *current_width + token.width <= width {
        current.push_str(&token.raw);
        *current_width += token.width;
        update_tracker_from_ansi(&token.raw, tracker);
    } else {
        push_current_line(lines, current, current_width, tracker);
        update_tracker_from_ansi(&token.raw, tracker);
        reset_current_prefix(current, tracker);
    }
}

fn append_word_token(
    token: &WrapToken,
    width: usize,
    tracker: &mut AnsiTracker,
    current: &mut String,
    current_width: &mut usize,
    lines: &mut Vec<String>,
) {
    if *current_width > 0 && *current_width + token.width > width {
        push_current_line(lines, current, current_width, tracker);
    }
    if current.is_empty() {
        current.push_str(&tracker.active_codes());
    }
    current.push_str(&token.raw);
    *current_width += token.width;
    update_tracker_from_ansi(&token.raw, tracker);
}

fn append_long_word(
    raw: &str,
    width: usize,
    tracker: &mut AnsiTracker,
    current: &mut String,
    current_width: &mut usize,
    lines: &mut Vec<String>,
) {
    if *current_width > 0 {
        push_current_line(lines, current, current_width, tracker);
    }
    if current.is_empty() {
        current.push_str(&tracker.active_codes());
    }

    for token in ansi_scan(raw) {
        match token {
            Token::Ansi(code) => {
                current.push_str(code);
                tracker.process(code);
            }
            Token::Text(text) => {
                for grapheme in text.graphemes(true) {
                    let grapheme_width = grapheme_width(grapheme);
                    if *current_width > 0 && *current_width + grapheme_width > width {
                        push_current_line(lines, current, current_width, tracker);
                    }
                    if current.is_empty() {
                        current.push_str(&tracker.active_codes());
                    }
                    current.push_str(grapheme);
                    *current_width += grapheme_width;
                }
            }
        }
    }
}

fn push_current_line(
    lines: &mut Vec<String>,
    current: &mut String,
    current_width: &mut usize,
    tracker: &AnsiTracker,
) {
    trim_trailing_whitespace(current, current_width);
    if current.is_empty() || visible_width(current) == 0 {
        current.clear();
        *current_width = 0;
        return;
    }

    if tracker.has_active_codes() && !current.ends_with(ANSI_RESET) {
        current.push_str(ANSI_RESET);
    }
    lines.push(std::mem::take(current));
    *current_width = 0;
    reset_current_prefix(current, tracker);
}

fn trim_trailing_whitespace(current: &mut String, current_width: &mut usize) {
    while let Some(ch) = current.chars().next_back() {
        if !ch.is_whitespace() {
            break;
        }
        current.pop();
        *current_width = current_width.saturating_sub(char_width(ch));
    }
}

fn reset_current_prefix(current: &mut String, tracker: &AnsiTracker) {
    current.clear();
    if tracker.has_active_codes() {
        current.push_str(&tracker.active_codes());
    }
}

fn update_tracker_from_ansi(input: &str, tracker: &mut AnsiTracker) {
    for token in ansi_scan(input) {
        if let Token::Ansi(code) = token {
            tracker.process(code);
        }
    }
}

fn char_width(ch: char) -> usize {
    if ch == '\t' {
        1
    } else {
        UnicodeWidthChar::width(ch).unwrap_or(0)
    }
}

fn is_sgr(code: &str) -> bool {
    sgr_params(code).is_some()
}

fn sgr_params(code: &str) -> Option<&str> {
    if code.starts_with("\x1b[") && code.ends_with('m') {
        Some(&code[2..code.len() - 1])
    } else {
        None
    }
}
