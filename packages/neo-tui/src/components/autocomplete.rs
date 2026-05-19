//! Autocomplete engine: trigger detection + slash/path candidates + fuzzy ranking.
//!
//! Triggers:
//! - `/` at the start of the input buffer -> slash command suggestions.
//! - `@<path-prefix>` anywhere in the buffer -> file path suggestions
//!   relative to either cwd or the absolute path.

use std::fs;
use std::path::{Path, PathBuf};

use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};

use crate::text::visible_width;

const BUILTIN_SLASH_COMMANDS: &[(&str, &str)] = &[
    ("/help", "Show keybindings"),
    ("/quit", "Exit"),
    ("/model", "Pick model"),
    ("/theme", "Pick theme"),
    ("/clear", "Clear chat"),
    ("/copy", "Copy last message"),
    ("/export", "Export session"),
    ("/resume", "Resume session"),
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompletionItem {
    pub label: String,
    pub description: Option<String>,
    pub insert: String,
    pub score: u32,
}

impl CompletionItem {
    #[must_use]
    pub fn label_width(&self) -> usize {
        visible_width(&self.label)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AutocompleteResult {
    None,
    Slash(Vec<CompletionItem>),
    Path(Vec<CompletionItem>),
}

#[derive(Debug)]
pub struct Autocomplete {
    matcher: Matcher,
}

impl Autocomplete {
    #[must_use]
    pub fn new() -> Self {
        Self {
            matcher: Matcher::new(Config::DEFAULT),
        }
    }

    pub fn trigger(&mut self, input: &str, cwd: &Path) -> AutocompleteResult {
        if input.starts_with('/') {
            return AutocompleteResult::Slash(self.slash_completions(input));
        }

        if let Some(token) = last_at_token(input) {
            return AutocompleteResult::Path(self.path_completions(token, cwd));
        }

        AutocompleteResult::None
    }

    fn slash_completions(&mut self, prefix: &str) -> Vec<CompletionItem> {
        let mut items: Vec<CompletionItem> = BUILTIN_SLASH_COMMANDS
            .iter()
            .map(|(name, desc)| CompletionItem {
                label: (*name).to_owned(),
                description: Some((*desc).to_owned()),
                insert: (*name).to_owned(),
                score: 0,
            })
            .collect();

        if prefix.len() <= 1 {
            return items;
        }

        let prefix_matches: Vec<CompletionItem> = items
            .iter()
            .filter(|item| item.label.starts_with(prefix))
            .cloned()
            .collect();
        if !prefix_matches.is_empty() {
            return prefix_matches;
        }

        let needle = &prefix[1..];
        for item in &mut items {
            let haystack = item.label.strip_prefix('/').unwrap_or(&item.label);
            item.score = fuzzy_score(&mut self.matcher, haystack, needle).unwrap_or(0);
        }

        items.retain(|item| item.score > 0);
        items.sort_by(|a, b| {
            b.score
                .cmp(&a.score)
                .then_with(|| a.label_width().cmp(&b.label_width()))
                .then_with(|| a.label.cmp(&b.label))
        });
        items
    }

    fn path_completions(&mut self, at_token: &str, cwd: &Path) -> Vec<CompletionItem> {
        let raw = at_token.strip_prefix('@').unwrap_or(at_token);
        let (dir, file_prefix) = path_search_parts(raw, cwd);

        let Ok(read_dir) = fs::read_dir(&dir) else {
            return Vec::new();
        };

        let mut entries = Vec::new();
        for entry in read_dir.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }

            let score = if file_prefix.is_empty() {
                100
            } else if let Some(score) = fuzzy_score(&mut self.matcher, &name, file_prefix) {
                score
            } else {
                continue;
            };

            let is_dir = entry.file_type().ok().is_some_and(|file_type| file_type.is_dir());
            let label = if is_dir { format!("{name}/") } else { name };
            entries.push(CompletionItem {
                insert: path_insert(raw, &label),
                label,
                description: None,
                score,
            });
        }

        entries.sort_by(|a, b| {
            b.score
                .cmp(&a.score)
                .then_with(|| a.label_width().cmp(&b.label_width()))
                .then_with(|| a.label.cmp(&b.label))
        });
        entries
    }
}

impl Default for Autocomplete {
    fn default() -> Self {
        Self::new()
    }
}

fn last_at_token(input: &str) -> Option<&str> {
    let last = input.rsplit(char::is_whitespace).next()?;
    last.starts_with('@').then_some(last)
}

fn path_search_parts<'a>(raw: &'a str, cwd: &Path) -> (PathBuf, &'a str) {
    if raw.ends_with('/') || raw.is_empty() {
        return (resolve_cwd(raw, cwd), "");
    }

    if let Some((dir, file_prefix)) = raw.rsplit_once('/') {
        return (resolve_cwd(&format!("{dir}/"), cwd), file_prefix);
    }

    (cwd.to_path_buf(), raw)
}

fn resolve_cwd(raw: &str, cwd: &Path) -> PathBuf {
    let stripped = raw.trim_end_matches('/');
    if stripped.is_empty() {
        return cwd.to_path_buf();
    }
    if stripped == "." || stripped.starts_with("./") {
        return cwd.join(stripped.trim_start_matches("./"));
    }
    if stripped.starts_with('/') {
        return PathBuf::from(stripped);
    }
    cwd.join(stripped)
}

fn path_insert(raw: &str, label: &str) -> String {
    if raw.ends_with('/') || raw.is_empty() {
        return format!("@{raw}{label}");
    }
    if let Some((dir, _file_prefix)) = raw.rsplit_once('/') {
        return format!("@{dir}/{label}");
    }
    format!("@{label}")
}

fn fuzzy_score(matcher: &mut Matcher, haystack: &str, needle: &str) -> Option<u32> {
    let pattern = Pattern::parse(needle, CaseMatching::Smart, Normalization::Smart);
    let mut indices = Vec::new();
    let mut buf = Vec::new();
    pattern.indices(Utf32Str::new(haystack, &mut buf), matcher, &mut indices)
}
