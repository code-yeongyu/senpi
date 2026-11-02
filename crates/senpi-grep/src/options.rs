use napi_derive::napi;
use std::fmt;

#[napi(string_enum = "lowercase")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GrepMode {
    Content,
    Count,
    Files,
}

/// The frozen engine request. Pattern recovery and facade defaults belong in TS.
#[napi(object)]
#[derive(Clone, Debug, Default)]
pub struct GrepOptions {
    pub pattern: String,
    pub paths: Vec<String>,
    pub cwd: String,
    pub glob: Option<Vec<String>>,
    pub r#type: Option<String>,
    pub ignore_case: Option<bool>,
    pub literal: Option<bool>,
    pub multiline: Option<bool>,
    pub hidden: Option<bool>,
    pub gitignore: Option<bool>,
    pub max_count: Option<u32>,
    pub max_count_per_file: Option<u32>,
    pub context_before: Option<u32>,
    pub context_after: Option<u32>,
    pub max_columns: Option<u32>,
    pub mode: Option<GrepMode>,
    pub timeout_ms: Option<u32>,
    pub line_start: Option<u32>,
    pub line_end: Option<u32>,
    pub pcre2: Option<bool>,
}

impl GrepOptions {
    pub(crate) fn mode(&self) -> GrepMode {
        self.mode.unwrap_or(GrepMode::Content)
    }

    pub(crate) fn includes_line(&self, line: u32) -> bool {
        line >= self.line_start.unwrap_or(1) && line <= self.line_end.unwrap_or(u32::MAX)
    }
}

#[napi(object)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GrepMatch {
    pub path: String,
    pub line: u32,
    pub column: Option<u32>,
    pub text: String,
    pub is_context: bool,
    pub truncated: bool,
}

#[napi(object, use_nullable = true)]
#[derive(Clone, Debug)]
pub struct GrepFileCount {
    pub path: String,
    pub count: Option<u32>,
    pub limit_reached: bool,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct GrepWarning {
    pub path: Option<String>,
    pub code: String,
    pub message: String,
}

#[napi(object, use_nullable = true)]
#[derive(Clone, Debug)]
pub struct GrepCounts {
    pub matches: Option<u32>,
    pub files: u32,
    pub exact: bool,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct GrepResult {
    pub matches: Vec<GrepMatch>,
    pub file_counts: Vec<GrepFileCount>,
    pub counts: GrepCounts,
    pub files_searched: u32,
    pub limit_reached: bool,
    pub per_file_limit_reached: bool,
    pub skipped_oversized: u32,
    pub prefix_searched: u32,
    pub skipped_binary: u32,
    pub missing_paths: Vec<String>,
    pub warnings: Vec<GrepWarning>,
    pub timed_out: bool,
    pub elapsed_ms: f64,
    pub effective_pattern: String,
    #[napi(ts_type = "'regex' | 'sanitized' | 'literal'")]
    pub pattern_kind: String,
    #[napi(ts_type = "'rust' | 'pcre2'")]
    pub regex_engine: String,
}

impl GrepResult {
    pub(crate) fn empty(options: &GrepOptions) -> Self {
        Self {
            matches: Vec::new(),
            file_counts: Vec::new(),
            counts: GrepCounts {
                matches: (options.mode() != GrepMode::Files).then_some(0),
                files: 0,
                exact: true,
            },
            files_searched: 0,
            limit_reached: false,
            per_file_limit_reached: false,
            skipped_oversized: 0,
            prefix_searched: 0,
            skipped_binary: 0,
            missing_paths: Vec::new(),
            warnings: Vec::new(),
            timed_out: false,
            elapsed_ms: 0.0,
            effective_pattern: options.pattern.clone(),
            pattern_kind: if options.literal.unwrap_or(false) {
                "literal"
            } else {
                "regex"
            }
            .into(),
            regex_engine: "rust".into(),
        }
    }
}

#[derive(Debug)]
pub enum GrepError {
    UnsupportedRegex(String),
    InvalidPattern(String),
    InvalidGlob(String),
    UnknownType(String),
    PathNotFound(String),
    Aborted,
    EngineUnavailable(String),
}

impl GrepError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::UnsupportedRegex(_) => "UNSUPPORTED_REGEX",
            Self::InvalidPattern(_) => "INVALID_PATTERN",
            Self::InvalidGlob(_) => "INVALID_GLOB",
            Self::UnknownType(_) => "UNKNOWN_TYPE",
            Self::PathNotFound(_) => "PATH_NOT_FOUND",
            Self::Aborted => "ABORTED",
            Self::EngineUnavailable(_) => "ENGINE_UNAVAILABLE",
        }
    }
}

impl fmt::Display for GrepError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedRegex(message)
            | Self::InvalidPattern(message)
            | Self::InvalidGlob(message)
            | Self::UnknownType(message)
            | Self::PathNotFound(message)
            | Self::EngineUnavailable(message) => f.write_str(message),
            Self::Aborted => f.write_str("Search aborted"),
        }
    }
}

impl std::error::Error for GrepError {}
