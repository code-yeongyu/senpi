//! Theme system: JSON-driven semantic color tokens.
//!
//! The theme spec ships as JSON with two halves:
//!   - `defs`: a flat map of named colors (`"amberLed": "#FF9E64"`).
//!   - `tokens`: a flat map of semantic token names (`"primary": "amberLed"`).
//!     A token value can either reference a def by name or be a direct hex.
//!
//! Parse with [`parse`]; resolve into concrete RGB colors with [`resolve`].

use std::collections::BTreeMap;

use ratatui::style::Color;
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub mod opencode_palette;
pub mod registry;

pub use opencode_palette::{OpencodeTheme, derive, parse_opencode};
pub use registry::{DEFAULT_THEME_ID, list_theme_ids, load_by_id};

/// Semantic color tokens consumed by the render code. Mirrors the design
/// brief plus extras the components need.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Token {
    Primary,
    Secondary,
    Accent,
    Error,
    Warning,
    Success,
    Info,

    Text,
    TextMuted,
    TextInverse,

    Background,
    BackgroundPanel,
    BackgroundElement,
    BackgroundMenu,

    Border,
    BorderActive,
    BorderSubtle,
    BorderError,
    BorderSuccess,
    BorderInfo,

    SelectionBg,
    SelectionFg,
    Cursor,
    Scrollbar,
    ScrollbarThumb,

    DiffAdded,
    DiffAddedBg,
    DiffRemoved,
    DiffRemovedBg,
    DiffLineNumber,
    DiffContext,

    MarkdownHeading,
    MarkdownCode,
    MarkdownLink,
    MarkdownQuote,
    MarkdownList,
    MarkdownEmphasis,
    MarkdownStrong,
    MarkdownRule,

    SyntaxComment,
    SyntaxKeyword,
    SyntaxFunction,
    SyntaxVariable,
    SyntaxString,
    SyntaxNumber,
    SyntaxType,
    SyntaxOperator,

    SpinnerActive,
    SpinnerScannerLeading,
    SpinnerScannerTrail,

    StatusIdle,
    StatusBusy,
    StatusStreaming,
    StatusTool,
    StatusError,
    StatusSuccess,

    StatusIdleBg,
    StatusBusyBg,
    StatusStreamingBg,
    StatusToolBg,
    StatusErrorBg,

    ToolBorderRunning,
    ToolBorderSuccess,
    ToolBorderError,
    ToolHeaderText,
    ToolBodyText,

    UserMessageBar,
    AssistantMessageBar,
    SystemMessageBar,
    ErrorMessageBar,

    DiffAddedText,
    DiffRemovedText,
}

impl Token {
    /// Every semantic token expected by the renderer.
    pub const ALL: [Self; 72] = [
        Self::Primary,
        Self::Secondary,
        Self::Accent,
        Self::Error,
        Self::Warning,
        Self::Success,
        Self::Info,
        Self::Text,
        Self::TextMuted,
        Self::TextInverse,
        Self::Background,
        Self::BackgroundPanel,
        Self::BackgroundElement,
        Self::BackgroundMenu,
        Self::Border,
        Self::BorderActive,
        Self::BorderSubtle,
        Self::BorderError,
        Self::BorderSuccess,
        Self::BorderInfo,
        Self::SelectionBg,
        Self::SelectionFg,
        Self::Cursor,
        Self::Scrollbar,
        Self::ScrollbarThumb,
        Self::DiffAdded,
        Self::DiffAddedBg,
        Self::DiffRemoved,
        Self::DiffRemovedBg,
        Self::DiffLineNumber,
        Self::DiffContext,
        Self::MarkdownHeading,
        Self::MarkdownCode,
        Self::MarkdownLink,
        Self::MarkdownQuote,
        Self::MarkdownList,
        Self::MarkdownEmphasis,
        Self::MarkdownStrong,
        Self::MarkdownRule,
        Self::SyntaxComment,
        Self::SyntaxKeyword,
        Self::SyntaxFunction,
        Self::SyntaxVariable,
        Self::SyntaxString,
        Self::SyntaxNumber,
        Self::SyntaxType,
        Self::SyntaxOperator,
        Self::SpinnerActive,
        Self::SpinnerScannerLeading,
        Self::SpinnerScannerTrail,
        Self::StatusIdle,
        Self::StatusBusy,
        Self::StatusStreaming,
        Self::StatusTool,
        Self::StatusError,
        Self::StatusSuccess,
        Self::StatusIdleBg,
        Self::StatusBusyBg,
        Self::StatusStreamingBg,
        Self::StatusToolBg,
        Self::StatusErrorBg,
        Self::ToolBorderRunning,
        Self::ToolBorderSuccess,
        Self::ToolBorderError,
        Self::ToolHeaderText,
        Self::ToolBodyText,
        Self::UserMessageBar,
        Self::AssistantMessageBar,
        Self::SystemMessageBar,
        Self::ErrorMessageBar,
        Self::DiffAddedText,
        Self::DiffRemovedText,
    ];
}

/// On-disk theme spec. Mirrors the JSON shape in `assets/themes/*.json`.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ThemeSpec {
    pub name: String,
    #[serde(rename = "type", default = "default_mode")]
    pub mode: ThemeMode,
    #[serde(default)]
    pub defs: BTreeMap<String, String>,
    pub tokens: BTreeMap<String, String>,
    #[serde(default)]
    pub options: Option<ThemeOptions>,
}

const fn default_mode() -> ThemeMode {
    ThemeMode::Dark
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeOptions {
    #[serde(default)]
    pub thinking_opacity_percent: Option<u8>,
    #[serde(default)]
    pub use_nerd_fonts: Option<bool>,
    #[serde(default)]
    pub supports_true_color: Option<bool>,
}

/// Dark vs light variant discriminator.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    Dark,
    Light,
}

/// A theme spec resolved into concrete RGB `Color`s per token.
#[derive(Clone, Debug)]
pub struct ResolvedTheme {
    pub name: String,
    pub mode: ThemeMode,
    pub thinking_opacity: f32,
    colors: BTreeMap<Token, Color>,
}

impl ResolvedTheme {
    pub(crate) const fn from_colors(
        name: String,
        mode: ThemeMode,
        thinking_opacity: f32,
        colors: BTreeMap<Token, Color>,
    ) -> Self {
        Self {
            name,
            mode,
            thinking_opacity,
            colors,
        }
    }

    /// Look up a token. Returns `Color::Reset` for unknown tokens; this is
    /// deliberate so callers can render even on incomplete themes without
    /// panicking. Tests assert that bundled themes resolve every token in
    /// [`Token::ALL`].
    pub fn token(&self, token: Token) -> Color {
        self.colors.get(&token).copied().unwrap_or(Color::Reset)
    }

    /// Expose the underlying map for tests and debug rendering.
    pub const fn colors(&self) -> &BTreeMap<Token, Color> {
        &self.colors
    }
}
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum ThemeError {
    #[error("invalid theme json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("unknown token name `{0}`")]
    UnknownToken(String),
    #[error("invalid hex color `{0}`")]
    InvalidColor(String),
    #[error("required token `{0}` missing from theme")]
    MissingRequiredToken(String),
    #[error("unknown bundled theme `{0}`")]
    UnknownTheme(String),
}

/// Parse a theme JSON document into a [`ThemeSpec`].
pub fn parse(input: &str) -> Result<ThemeSpec, ThemeError> {
    let spec: ThemeSpec = serde_json::from_str(input)?;
    Ok(spec)
}

/// Parse + resolve a JSON theme blob in a single shot.
pub fn load(input: &str) -> Result<ResolvedTheme, ThemeError> {
    resolve(&parse(input)?)
}

/// Resolve a [`ThemeSpec`] into a [`ResolvedTheme`].
pub fn resolve(spec: &ThemeSpec) -> Result<ResolvedTheme, ThemeError> {
    if spec.tokens.is_empty() {
        return Err(ThemeError::MissingRequiredToken("primary".into()));
    }
    let primary_value = spec
        .tokens
        .get("primary")
        .ok_or_else(|| ThemeError::MissingRequiredToken("primary".into()))?;
    if hex_string_for(primary_value, &spec.defs).is_err() {
        return Err(ThemeError::InvalidColor(primary_value.clone()));
    }

    let mut colors: BTreeMap<Token, Color> = BTreeMap::new();
    for (key, raw_value) in &spec.tokens {
        let Some(token) = parse_token_name(key) else {
            // Silent skips let theme typos slip through unnoticed. Emit a
            // warning on stderr so themers get fast feedback; once a
            // tracing subscriber is installed (T16) this becomes a
            // structured event instead.
            eprintln!(
                "senpi-neo-tui: warning: ignoring unknown theme token `{key}` (theme `{}`)",
                spec.name
            );
            continue;
        };
        let hex = hex_string_for(raw_value, &spec.defs)?;
        let color = parse_hex_color(&hex)?;
        colors.insert(token, color);
    }

    let thinking_opacity = spec
        .options
        .as_ref()
        .and_then(|o| o.thinking_opacity_percent)
        .map_or(0.6, |p| f32::from(p) / 100.0);

    Ok(ResolvedTheme {
        name: spec.name.clone(),
        mode: spec.mode,
        thinking_opacity,
        colors,
    })
}

fn parse_token_name(name: &str) -> Option<Token> {
    serde_json::from_value(serde_json::Value::String(name.to_string())).ok()
}

fn hex_string_for(value: &str, defs: &BTreeMap<String, String>) -> Result<String, ThemeError> {
    if value.starts_with('#') {
        Ok(value.to_string())
    } else if let Some(via_def) = defs.get(value) {
        Ok(via_def.clone())
    } else {
        Err(ThemeError::InvalidColor(value.to_string()))
    }
}

pub(crate) fn parse_hex_color(hex: &str) -> Result<Color, ThemeError> {
    let body = hex.strip_prefix('#').unwrap_or(hex);
    let (r, g, b) = match body.len() {
        6 => (
            u8::from_str_radix(&body[0..2], 16),
            u8::from_str_radix(&body[2..4], 16),
            u8::from_str_radix(&body[4..6], 16),
        ),
        3 => (
            u8::from_str_radix(&body[0..1].repeat(2), 16),
            u8::from_str_radix(&body[1..2].repeat(2), 16),
            u8::from_str_radix(&body[2..3].repeat(2), 16),
        ),
        _ => return Err(ThemeError::InvalidColor(hex.to_string())),
    };
    match (r, g, b) {
        (Ok(r), Ok(g), Ok(b)) => Ok(Color::Rgb(r, g, b)),
        _ => Err(ThemeError::InvalidColor(hex.to_string())),
    }
}
