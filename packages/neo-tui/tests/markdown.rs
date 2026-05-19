use std::process::Command;

use ratatui::style::Modifier;
use ratatui::text::{Line, Span};
use senpi_neo_tui::components::markdown::render;
use senpi_neo_tui::load_bundled_dark_theme;
use senpi_neo_tui::text::visible_width;
use senpi_neo_tui::theme::{ResolvedTheme, Token};

fn theme() -> ResolvedTheme {
    load_bundled_dark_theme().unwrap()
}

fn span_text(line: &Line<'_>) -> String {
    line.spans
        .iter()
        .map(|span| span.content.as_ref())
        .collect::<String>()
}

fn find_span<'a>(lines: &'a [Line<'a>], text: &str) -> &'a Span<'a> {
    lines
        .iter()
        .flat_map(|line| line.spans.iter())
        .find(|span| span.content.as_ref() == text)
        .unwrap()
}

#[test]
fn markdown_renders_h1_with_heading_token() {
    let theme = theme();
    let lines = render(&theme, "# Hello", 80);
    let first = lines.first().unwrap();

    assert_eq!(span_text(first), "Hello");
    assert!(
        first
            .spans
            .iter()
            .all(|span| span.style.fg == Some(theme.token(Token::MarkdownHeading)))
    );
    assert!(
        first
            .spans
            .iter()
            .all(|span| span.style.add_modifier.contains(Modifier::BOLD))
    );
}

#[test]
fn markdown_renders_bold_with_strong_token() {
    let theme = theme();
    let lines = render(&theme, "this is **bold**", 80);
    let bold = find_span(&lines, "bold");

    assert_eq!(bold.style.fg, Some(theme.token(Token::MarkdownStrong)));
    assert!(bold.style.add_modifier.contains(Modifier::BOLD));
}

#[test]
fn markdown_renders_inline_code_with_code_token() {
    let theme = theme();
    let lines = render(&theme, "use `foo()` here", 80);
    let code = find_span(&lines, "foo()");

    assert_eq!(code.style.fg, Some(theme.token(Token::MarkdownCode)));
    assert_eq!(code.style.bg, Some(theme.token(Token::BackgroundElement)));
}

#[test]
fn markdown_renders_code_block_with_syntect_highlighting() {
    let theme = theme();
    let lines = render(&theme, "```rust\nfn main() {}\n```", 80);
    let keyword = find_span(&lines, "fn");

    assert_eq!(keyword.style.fg, Some(theme.token(Token::SyntaxKeyword)));
}

#[test]
fn markdown_renders_unknown_language_code_block_without_highlighting() {
    let theme = theme();
    let lines = render(&theme, "```unknownlang\nlol\n```", 80);
    let body = find_span(&lines, "lol");

    assert_eq!(body.style.fg, Some(theme.token(Token::Text)));
}

#[test]
fn markdown_renders_list_with_list_token() {
    let theme = theme();
    let lines = render(&theme, "- one\n- two", 80);
    let markers: Vec<&Span<'_>> = lines
        .iter()
        .flat_map(|line| line.spans.iter())
        .filter(|span| span.content.as_ref() == "- ")
        .collect();

    assert_eq!(markers.len(), 2);
    assert!(
        markers
            .iter()
            .all(|span| span.style.fg == Some(theme.token(Token::MarkdownList)))
    );
}

#[test]
fn markdown_renders_link_with_link_token() {
    let theme = theme();
    let lines = render(&theme, "[label](https://example.com)", 80);
    let label = find_span(&lines, "label");

    assert_eq!(label.style.fg, Some(theme.token(Token::MarkdownLink)));
    assert!(label.style.add_modifier.contains(Modifier::UNDERLINED));
}

#[test]
fn markdown_renders_blockquote_with_quote_token() {
    let theme = theme();
    let lines = render(&theme, "> quoted", 80);

    assert!(
        lines
            .iter()
            .flat_map(|line| line.spans.iter())
            .filter(|span| !span.content.is_empty())
            .all(|span| span.style.fg == Some(theme.token(Token::MarkdownQuote)))
    );
}

#[test]
fn markdown_renders_hr_with_rule_token() {
    let theme = theme();
    let lines = render(&theme, "---", 80);
    let first = lines.first().unwrap();

    assert_eq!(visible_width(&span_text(first)), 80);
    assert!(
        first
            .spans
            .iter()
            .all(|span| span.style.fg == Some(theme.token(Token::MarkdownRule)))
    );
}

#[test]
fn markdown_wraps_long_paragraph_to_width() {
    let theme = theme();
    let paragraph = "word ".repeat(60);
    let lines = render(&theme, &paragraph, 40);
    let non_empty: Vec<String> = lines
        .iter()
        .map(span_text)
        .filter(|line| !line.is_empty())
        .collect();

    assert!(non_empty.len() > 1);
    assert!(non_empty.iter().all(|line| visible_width(line) <= 40));
}

#[test]
fn markdown_no_hardcoded_colors() {
    let output = Command::new("rg")
        .args(["Color::Rgb", "packages/neo-tui/src/components/markdown.rs"])
        .output()
        .unwrap();

    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
}
