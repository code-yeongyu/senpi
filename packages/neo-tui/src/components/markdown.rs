//! Markdown -> ratatui Line stream via pulldown-cmark events.
//! All styling flows through theme tokens. No hardcoded colors.

use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use syntect::easy::HighlightLines;
use syntect::highlighting::{FontStyle, Style as SynStyle, ThemeSet};
use syntect::parsing::SyntaxSet;

use crate::text::wrap_text_with_ansi;
use crate::theme::{ResolvedTheme, Token};

/// Render Markdown into ratatui lines using semantic theme tokens only.
pub fn render(theme: &ResolvedTheme, source: &str, width: usize) -> Vec<Line<'static>> {
    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    opts.insert(Options::ENABLE_TASKLISTS);

    let mut renderer = MdRenderer::new(theme, width);
    for event in Parser::new_ext(source, opts) {
        renderer.event(event);
    }
    renderer.finish()
}

#[derive(Debug)]
struct MdRenderer<'theme> {
    theme: &'theme ResolvedTheme,
    width: usize,
    current_spans: Vec<Span<'static>>,
    pending_lines: Vec<Line<'static>>,
    style_stack: Vec<Style>,
    in_code_block: Option<String>,
    code_block_body: String,
    list_indent: usize,
}

impl<'theme> MdRenderer<'theme> {
    const fn new(theme: &'theme ResolvedTheme, width: usize) -> Self {
        Self {
            theme,
            width,
            current_spans: Vec::new(),
            pending_lines: Vec::new(),
            style_stack: Vec::new(),
            in_code_block: None,
            code_block_body: String::new(),
            list_indent: 0,
        }
    }

    fn token_style(&self, token: Token) -> Style {
        Style::default().fg(self.theme.token(token))
    }

    fn text_style(&self) -> Style {
        Style::default().fg(self.theme.token(Token::Text))
    }

    fn push_text(&mut self, text: &str, style: Style) {
        if !text.is_empty() {
            self.current_spans.push(Span::styled(text.to_string(), style));
        }
    }

    fn flush_line(&mut self) {
        if self.current_spans.is_empty() {
            return;
        }
        self.pending_lines
            .push(Line::from(std::mem::take(&mut self.current_spans)));
    }

    fn event(&mut self, event: Event<'_>) {
        match event {
            Event::Start(Tag::Heading { level, .. }) => self.start_heading(level),
            Event::End(TagEnd::Heading(_)) => {
                self.style_stack.pop();
                self.flush_line();
                self.pending_lines.push(Line::from(""));
            }
            Event::Start(Tag::Strong) => self.style_stack.push(
                self.token_style(Token::MarkdownStrong)
                    .add_modifier(Modifier::BOLD),
            ),
            Event::End(TagEnd::Strong | TagEnd::Emphasis | TagEnd::Link) => {
                self.style_stack.pop();
            }
            Event::Start(Tag::Emphasis) => self.style_stack.push(
                self.token_style(Token::MarkdownEmphasis)
                    .add_modifier(Modifier::ITALIC),
            ),
            Event::Start(Tag::Link { .. }) => self.style_stack.push(
                self.token_style(Token::MarkdownLink)
                    .add_modifier(Modifier::UNDERLINED),
            ),
            Event::Start(Tag::BlockQuote(_)) => {
                self.push_text("> ", self.token_style(Token::MarkdownQuote));
                self.style_stack.push(self.token_style(Token::MarkdownQuote));
            }
            Event::End(TagEnd::BlockQuote(_)) => {
                self.style_stack.pop();
                self.flush_line();
            }
            Event::Start(Tag::List(_)) => {
                self.list_indent = self.list_indent.saturating_add(2);
            }
            Event::End(TagEnd::List(_)) => {
                self.list_indent = self.list_indent.saturating_sub(2);
                self.flush_line();
            }
            Event::Start(Tag::Item) => {
                let indent = " ".repeat(self.list_indent.saturating_sub(2));
                self.push_text(&indent, Style::default());
                self.push_text("- ", self.token_style(Token::MarkdownList));
            }
            Event::End(TagEnd::Item) | Event::SoftBreak | Event::HardBreak => self.flush_line(),
            Event::Start(Tag::CodeBlock(kind)) => {
                self.in_code_block = Some(code_block_language(kind));
                self.code_block_body.clear();
            }
            Event::End(TagEnd::CodeBlock) => {
                let lang = self.in_code_block.take().unwrap_or_default();
                let body = std::mem::take(&mut self.code_block_body);
                self.render_code_block(&lang, &body);
            }
            Event::Code(text) => {
                let style = self
                    .token_style(Token::MarkdownCode)
                    .bg(self.theme.token(Token::BackgroundElement));
                self.push_text(text.as_ref(), style);
            }
            Event::Text(text) => {
                if self.in_code_block.is_some() {
                    self.code_block_body.push_str(text.as_ref());
                } else {
                    self.push_wrapped_text(text.as_ref());
                }
            }
            Event::Rule => self.render_rule(),
            Event::End(TagEnd::Paragraph) => {
                self.flush_line();
                self.pending_lines.push(Line::from(""));
            }
            _ => {}
        }
    }

    fn start_heading(&mut self, level: HeadingLevel) {
        let modifier = match level {
            HeadingLevel::H1
            | HeadingLevel::H2
            | HeadingLevel::H3
            | HeadingLevel::H4
            | HeadingLevel::H5
            | HeadingLevel::H6 => Modifier::BOLD,
        };
        self.style_stack
            .push(self.token_style(Token::MarkdownHeading).add_modifier(modifier));
    }

    fn push_wrapped_text(&mut self, text: &str) {
        let style = self
            .style_stack
            .last()
            .copied()
            .unwrap_or_else(|| self.text_style());
        let wrapped = wrap_text_with_ansi(text, self.width.max(1));
        if wrapped.is_empty() && !text.is_empty() {
            self.push_text(text, style);
            return;
        }
        for (index, line) in wrapped.iter().enumerate() {
            if index > 0 {
                self.flush_line();
            }
            self.push_text(line, style);
        }
    }

    fn render_rule(&mut self) {
        self.current_spans.clear();
        let rule = "-".repeat(self.width.max(1));
        self.push_text(&rule, self.token_style(Token::MarkdownRule));
        self.flush_line();
    }

    fn render_code_block(&mut self, lang: &str, body: &str) {
        let syntax_set = SyntaxSet::load_defaults_newlines();
        let Some(syntax) = syntax_set
            .find_syntax_by_token(lang)
            .or_else(|| syntax_set.find_syntax_by_extension(lang))
        else {
            self.render_plain_code_block(body);
            return;
        };

        let theme_set = ThemeSet::load_defaults();
        let Some(syntect_theme) = theme_set.themes.get("base16-ocean.dark") else {
            self.render_plain_code_block(body);
            return;
        };

        let mut highlighter = HighlightLines::new(syntax, syntect_theme);
        for line in body.lines() {
            match highlighter.highlight_line(line, &syntax_set) {
                Ok(ranges) => self.push_highlighted_code_line(lang, ranges),
                Err(_) => self.push_plain_code_line(line),
            }
        }
    }

    fn render_plain_code_block(&mut self, body: &str) {
        for line in body.lines() {
            self.push_plain_code_line(line);
        }
    }

    fn push_plain_code_line(&mut self, line: &str) {
        self.pending_lines
            .push(Line::from(Span::styled(line.to_string(), self.text_style())));
    }

    fn push_highlighted_code_line(&mut self, lang: &str, ranges: Vec<(SynStyle, &str)>) {
        let spans = ranges
            .into_iter()
            .map(|(syn_style, segment)| {
                let token = map_syntect_to_token(lang, segment, syn_style);
                let mut style = Style::default().fg(self.theme.token(token));
                if syn_style.font_style.contains(FontStyle::BOLD) {
                    style = style.add_modifier(Modifier::BOLD);
                }
                if syn_style.font_style.contains(FontStyle::ITALIC) {
                    style = style.add_modifier(Modifier::ITALIC);
                }
                Span::styled(segment.to_string(), style)
            })
            .collect::<Vec<_>>();
        self.pending_lines.push(Line::from(spans));
    }

    fn finish(mut self) -> Vec<Line<'static>> {
        self.flush_line();
        self.pending_lines
    }
}

fn code_block_language(kind: CodeBlockKind<'_>) -> String {
    match kind {
        CodeBlockKind::Fenced(lang) => lang.into_string(),
        CodeBlockKind::Indented => String::new(),
    }
}

fn map_syntect_to_token(lang: &str, segment: &str, _style: SynStyle) -> Token {
    let trimmed = segment.trim();
    if is_keyword(lang, trimmed) {
        Token::SyntaxKeyword
    } else if is_comment(trimmed) {
        Token::SyntaxComment
    } else if is_string_literal(trimmed) {
        Token::SyntaxString
    } else if is_number_literal(trimmed) {
        Token::SyntaxNumber
    } else if is_operator(trimmed) {
        Token::SyntaxOperator
    } else if is_type_name(trimmed) {
        Token::SyntaxType
    } else {
        Token::SyntaxVariable
    }
}

fn is_keyword(lang: &str, text: &str) -> bool {
    matches!(
        (lang, text),
        (
            "rs" | "rust",
            "as" | "async"
                | "await"
                | "break"
                | "const"
                | "continue"
                | "crate"
                | "dyn"
                | "else"
                | "enum"
                | "extern"
                | "false"
                | "fn"
                | "for"
                | "if"
                | "impl"
                | "in"
                | "let"
                | "loop"
                | "match"
                | "mod"
                | "move"
                | "mut"
                | "pub"
                | "ref"
                | "return"
                | "self"
                | "Self"
                | "static"
                | "struct"
                | "super"
                | "trait"
                | "true"
                | "type"
                | "unsafe"
                | "use"
                | "where"
                | "while"
                | "yield"
        )
    )
}

fn is_comment(text: &str) -> bool {
    text.starts_with("//") || text.starts_with("/*") || text.starts_with('*')
}

fn is_string_literal(text: &str) -> bool {
    text.starts_with('"') || text.starts_with('\'') || text.starts_with('`')
}

fn is_number_literal(text: &str) -> bool {
    text.chars().next().is_some_and(|ch| ch.is_ascii_digit())
}

fn is_operator(text: &str) -> bool {
    !text.is_empty()
        && text.chars().all(|ch| {
            matches!(
                ch,
                '=' | '+' | '-' | '*' | '/' | '%' | '!' | '<' | '>' | '&' | '|'
            )
        })
}

fn is_type_name(text: &str) -> bool {
    text.chars().next().is_some_and(char::is_uppercase)
}
