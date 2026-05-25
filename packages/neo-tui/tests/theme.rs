//! Contract tests for the theme system.
//!
//! These tests lock parse errors, resolve errors, and bundled token
//! coverage for the JSON-driven theme system.

use ratatui::style::Color;
use senpi_neo_tui::theme::{self, Token};

const DARK_JSON: &str = senpi_neo_tui::DEFAULT_DARK_THEME_JSON;

#[test]
fn parses_bundled_dark_theme() {
    let spec = theme::parse(DARK_JSON).expect("dark theme must parse");
    let resolved = theme::resolve(&spec).expect("dark theme must resolve");

    for token in [
        Token::Primary,
        Token::Secondary,
        Token::Error,
        Token::Warning,
        Token::Success,
        Token::Info,
        Token::Text,
        Token::TextMuted,
        Token::Background,
        Token::BackgroundPanel,
        Token::Border,
        Token::BorderActive,
        Token::BorderSubtle,
        Token::MarkdownHeading,
        Token::SyntaxKeyword,
    ] {
        let color = resolved.token(token);
        assert_ne!(
            color,
            ratatui::style::Color::Reset,
            "token {token:?} must resolve to a concrete color"
        );
    }
}

#[test]
fn opencode_themes_are_resolvable_by_both_flat_id_and_opencode_prefix() {
    // Bug-3 followup: the README and `senpi --neo -- --theme <id>`
    // documentation both invite `opencode/dracula`-style ids, but the
    // bundled registry stores flat keys (`dracula`, `nord`, ...). Strip
    // the `opencode/` prefix on lookup so users can type either form
    // without hitting `UnknownTheme`.
    let flat = theme::load_by_id("dracula", theme::ThemeMode::Dark).expect("flat id must resolve");
    let prefixed = theme::load_by_id("opencode/dracula", theme::ThemeMode::Dark)
        .expect("`opencode/` prefix must resolve to the same theme");
    assert_eq!(flat.name, prefixed.name);
    assert_eq!(flat.colors(), prefixed.colors());
}

#[test]
fn bundled_dark_theme_resolves_every_token_in_token_all() {
    // Regression: the bundled `senpi-neo-dark` theme MUST define every
    // semantic token the renderer consumes. `Token::ALL` is the source of
    // truth; if a future Token variant is added without updating the
    // bundled JSON, this test fails loudly instead of silently rendering
    // with `Color::Reset` for the missing token.
    let spec = theme::parse(DARK_JSON).expect("dark theme must parse");
    let resolved = theme::resolve(&spec).expect("dark theme must resolve");

    let missing: Vec<Token> = Token::ALL
        .iter()
        .copied()
        .filter(|tok| resolved.token(*tok) == Color::Reset)
        .collect();

    assert!(
        missing.is_empty(),
        "bundled senpi-neo-dark theme is missing concrete colors for tokens: {missing:?}"
    );
}

#[test]
fn resolves_core_tokens_in_dark_theme() {
    let spec = theme::parse(DARK_JSON).expect("parse");
    let resolved = theme::resolve(&spec).expect("resolve");

    // Primary is the Tactile Monolith amber LED, defined via amberLed def.
    assert_eq!(resolved.token(Token::Primary), Color::Rgb(0xFF, 0x9E, 0x64));
    // Background is the deep espresso base.
    assert_eq!(resolved.token(Token::Background), Color::Rgb(0x1A, 0x1B, 0x26));
    // Secondary is the cyan LED.
    assert_eq!(resolved.token(Token::Secondary), Color::Rgb(0x7D, 0xCF, 0xFF));
}

#[test]
fn defaults_thinking_opacity() {
    let spec = theme::parse(DARK_JSON).expect("parse");
    let resolved = theme::resolve(&spec).expect("resolve");
    // bundled dark theme sets thinkingOpacityPercent: 60
    assert!((resolved.thinking_opacity - 0.6).abs() < 1e-4);
}

#[test]
fn rejects_invalid_hex_in_resolve() {
    let bad = r#"{
        "name": "broken",
        "type": "dark",
        "tokens": { "primary": "not-a-hex" }
    }"#;
    let spec = theme::parse(bad).expect("parses raw json");
    let err = theme::resolve(&spec).expect_err("must reject invalid hex");
    let msg = err.to_string().to_lowercase();
    assert!(
        msg.contains("not-a-hex") || msg.contains("invalid hex") || msg.contains("invalid"),
        "expected invalid-hex error, got: {msg}"
    );
}

#[test]
fn rejects_empty_tokens_at_resolve() {
    let bad = r#"{
        "name": "empty",
        "type": "dark",
        "tokens": {}
    }"#;
    let spec = theme::parse(bad).expect("parses raw json");
    let err = theme::resolve(&spec).expect_err("must reject missing tokens");
    let msg = err.to_string().to_lowercase();
    assert!(
        msg.contains("missing") || msg.contains("required"),
        "expected missing-token error, got: {msg}"
    );
}
