//! Opencode desktop theme palette support.

use std::collections::BTreeMap;

use ratatui::style::Color;
use serde::{Deserialize, Serialize};

use super::{ResolvedTheme, ThemeError, ThemeMode, Token, parse_hex_color};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct OpencodeTheme {
    pub name: String,
    pub id: String,
    pub light: OpencodeVariant,
    pub dark: OpencodeVariant,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct OpencodeVariant {
    pub palette: OpencodePalette,
    #[serde(default)]
    pub overrides: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpencodePalette {
    pub neutral: String,
    pub ink: String,
    pub primary: String,
    pub accent: String,
    pub success: String,
    pub warning: String,
    pub error: String,
    pub info: String,
    #[serde(default)]
    pub diff_add: String,
    #[serde(default)]
    pub diff_delete: String,
}

pub fn parse_opencode(input: &str) -> Result<OpencodeTheme, ThemeError> {
    let theme: OpencodeTheme = serde_json::from_str(input)?;
    validate_variant(&theme.light)?;
    validate_variant(&theme.dark)?;
    Ok(theme)
}

pub fn derive(theme: &OpencodeTheme, mode: ThemeMode) -> ResolvedTheme {
    let variant = match mode {
        ThemeMode::Dark => &theme.dark,
        ThemeMode::Light => &theme.light,
    };
    let palette = ParsedPalette::from(&variant.palette);
    let context = DerivedColorsContext {
        text_muted: blend(palette.ink, palette.neutral, 0.5),
        border: blend(palette.ink, palette.neutral, 0.7),
        background_panel: blend(palette.neutral, palette.ink, 0.08),
    };

    let mut colors = BTreeMap::new();
    insert_base_tokens(&mut colors, palette, context);
    insert_diff_markdown_tokens(&mut colors, palette, context);
    insert_syntax_tokens(&mut colors, variant, palette, context);
    insert_status_tool_tokens(&mut colors, palette, context);

    ResolvedTheme::from_colors(theme.name.clone(), mode, 0.6, colors)
}

fn insert_base_tokens(
    colors: &mut BTreeMap<Token, Color>,
    palette: ParsedPalette,
    context: DerivedColorsContext,
) {
    colors.insert(Token::Background, palette.neutral);
    colors.insert(Token::BackgroundPanel, context.background_panel);
    colors.insert(
        Token::BackgroundElement,
        blend(palette.neutral, palette.ink, 0.14),
    );
    colors.insert(Token::BackgroundMenu, blend(palette.neutral, palette.ink, 0.04));
    colors.insert(Token::Text, palette.ink);
    colors.insert(Token::TextMuted, context.text_muted);
    colors.insert(Token::TextInverse, palette.neutral);
    colors.insert(Token::Primary, palette.primary);
    colors.insert(Token::Secondary, palette.info);
    colors.insert(Token::Accent, palette.accent);
    colors.insert(Token::Error, palette.error);
    colors.insert(Token::Warning, palette.warning);
    colors.insert(Token::Success, palette.success);
    colors.insert(Token::Info, palette.info);
    colors.insert(Token::Border, context.border);
    colors.insert(Token::BorderActive, palette.accent);
    colors.insert(Token::BorderSubtle, blend(palette.ink, palette.neutral, 0.85));
    colors.insert(Token::BorderError, palette.error);
    colors.insert(Token::BorderSuccess, palette.success);
    colors.insert(Token::BorderInfo, palette.info);
    colors.insert(Token::SelectionBg, blend(palette.ink, palette.neutral, 0.75));
    colors.insert(Token::SelectionFg, palette.ink);
    colors.insert(Token::Cursor, palette.accent);
    colors.insert(Token::Scrollbar, blend(palette.ink, palette.neutral, 0.7));
    colors.insert(Token::ScrollbarThumb, palette.accent);
}

fn insert_diff_markdown_tokens(
    colors: &mut BTreeMap<Token, Color>,
    palette: ParsedPalette,
    context: DerivedColorsContext,
) {
    colors.insert(Token::DiffAdded, palette.diff_add);
    colors.insert(Token::DiffAddedBg, blend(palette.diff_add, palette.neutral, 0.75));
    colors.insert(Token::DiffAddedText, palette.diff_add);
    colors.insert(Token::DiffRemoved, palette.diff_delete);
    colors.insert(
        Token::DiffRemovedBg,
        blend(palette.diff_delete, palette.neutral, 0.75),
    );
    colors.insert(Token::DiffRemovedText, palette.diff_delete);
    colors.insert(Token::DiffLineNumber, context.text_muted);
    colors.insert(Token::DiffContext, context.text_muted);
    colors.insert(Token::MarkdownHeading, palette.info);
    colors.insert(Token::MarkdownCode, context.text_muted);
    colors.insert(Token::MarkdownLink, palette.primary);
    colors.insert(Token::MarkdownQuote, context.text_muted);
    colors.insert(Token::MarkdownList, palette.accent);
    colors.insert(Token::MarkdownEmphasis, palette.ink);
    colors.insert(Token::MarkdownStrong, palette.accent);
    colors.insert(Token::MarkdownRule, context.border);
}

fn insert_syntax_tokens(
    colors: &mut BTreeMap<Token, Color>,
    variant: &OpencodeVariant,
    palette: ParsedPalette,
    context: DerivedColorsContext,
) {
    colors.insert(
        Token::SyntaxComment,
        override_color(variant, "syntax-comment", context.text_muted),
    );
    colors.insert(
        Token::SyntaxKeyword,
        override_color(variant, "syntax-keyword", palette.accent),
    );
    colors.insert(
        Token::SyntaxFunction,
        override_color(variant, "syntax-property", palette.info),
    );
    colors.insert(Token::SyntaxVariable, palette.ink);
    colors.insert(
        Token::SyntaxString,
        override_color(variant, "syntax-string", palette.success),
    );
    colors.insert(
        Token::SyntaxNumber,
        override_color(variant, "syntax-constant", palette.warning),
    );
    colors.insert(
        Token::SyntaxType,
        override_color(variant, "syntax-primitive", palette.primary),
    );
    colors.insert(
        Token::SyntaxOperator,
        override_color(variant, "syntax-builtin", palette.info),
    );
}

fn insert_status_tool_tokens(
    colors: &mut BTreeMap<Token, Color>,
    palette: ParsedPalette,
    context: DerivedColorsContext,
) {
    colors.insert(Token::SpinnerActive, palette.accent);
    colors.insert(Token::SpinnerScannerLeading, palette.accent);
    colors.insert(Token::SpinnerScannerTrail, context.background_panel);
    colors.insert(Token::StatusIdle, context.text_muted);
    colors.insert(Token::StatusBusy, palette.accent);
    colors.insert(Token::StatusError, palette.error);
    colors.insert(Token::StatusSuccess, palette.success);
    colors.insert(Token::ToolBorderRunning, palette.info);
    colors.insert(Token::ToolBorderSuccess, context.border);
    colors.insert(Token::ToolBorderError, palette.error);
    colors.insert(Token::ToolHeaderText, palette.ink);
    colors.insert(Token::ToolBodyText, context.text_muted);
    colors.insert(Token::UserMessageBar, palette.accent);
    colors.insert(Token::AssistantMessageBar, palette.info);
    colors.insert(Token::SystemMessageBar, context.text_muted);
    colors.insert(Token::ErrorMessageBar, palette.error);
}

// CLIPPY-ALLOW: RGB blending necessarily converts bounded float channels back to u8.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
pub fn blend(a: Color, b: Color, weight_b: f32) -> Color {
    let Color::Rgb(ar, ag, ab) = a else {
        return a;
    };
    let Color::Rgb(br, bg, bb) = b else {
        return a;
    };
    let weight = weight_b.clamp(0.0, 1.0);
    let weight_a = 1.0 - weight;
    Color::Rgb(
        (f32::from(ar).mul_add(weight_a, f32::from(br) * weight)).floor() as u8,
        (f32::from(ag).mul_add(weight_a, f32::from(bg) * weight)).floor() as u8,
        (f32::from(ab).mul_add(weight_a, f32::from(bb) * weight)).floor() as u8,
    )
}

#[derive(Clone, Copy, Debug)]
struct ParsedPalette {
    neutral: Color,
    ink: Color,
    primary: Color,
    accent: Color,
    success: Color,
    warning: Color,
    error: Color,
    info: Color,
    diff_add: Color,
    diff_delete: Color,
}

#[derive(Clone, Copy, Debug)]
struct DerivedColorsContext {
    text_muted: Color,
    border: Color,
    background_panel: Color,
}

impl From<&OpencodePalette> for ParsedPalette {
    fn from(palette: &OpencodePalette) -> Self {
        Self {
            neutral: parse_known_hex(&palette.neutral),
            ink: parse_known_hex(&palette.ink),
            primary: parse_known_hex(&palette.primary),
            accent: parse_known_hex(&palette.accent),
            success: parse_known_hex(&palette.success),
            warning: parse_known_hex(&palette.warning),
            error: parse_known_hex(&palette.error),
            info: parse_known_hex(&palette.info),
            diff_add: parse_known_hex_or(&palette.diff_add, parse_known_hex(&palette.success)),
            diff_delete: parse_known_hex_or(&palette.diff_delete, parse_known_hex(&palette.error)),
        }
    }
}

fn validate_variant(variant: &OpencodeVariant) -> Result<(), ThemeError> {
    for value in [
        &variant.palette.neutral,
        &variant.palette.ink,
        &variant.palette.primary,
        &variant.palette.accent,
        &variant.palette.success,
        &variant.palette.warning,
        &variant.palette.error,
        &variant.palette.info,
    ] {
        parse_hex_color(value)?;
    }
    for value in [&variant.palette.diff_add, &variant.palette.diff_delete] {
        if !value.is_empty() {
            parse_hex_color(value)?;
        }
    }
    for value in variant.overrides.values() {
        parse_hex_color(value)?;
    }
    Ok(())
}

fn override_color(variant: &OpencodeVariant, key: &str, fallback: Color) -> Color {
    variant
        .overrides
        .get(key)
        .map_or(fallback, |value| parse_known_hex(value))
}

fn parse_known_hex(value: &str) -> Color {
    parse_hex_color(value).unwrap_or(Color::Reset)
}

fn parse_known_hex_or(value: &str, fallback: Color) -> Color {
    if value.is_empty() {
        fallback
    } else {
        parse_known_hex(value)
    }
}
