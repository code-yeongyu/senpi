//! Compile-time registry of bundled themes.

use super::{ResolvedTheme, ThemeError, ThemeMode, derive, load, parse_opencode};

pub const DEFAULT_THEME_ID: &str = "senpi-neo-dark";

const OPENCODE_THEMES: [(&str, &str); 15] = [
    (
        "tokyonight",
        include_str!("../../assets/themes/opencode/tokyonight.json"),
    ),
    (
        "catppuccin",
        include_str!("../../assets/themes/opencode/catppuccin.json"),
    ),
    (
        "catppuccin-frappe",
        include_str!("../../assets/themes/opencode/catppuccin-frappe.json"),
    ),
    (
        "catppuccin-macchiato",
        include_str!("../../assets/themes/opencode/catppuccin-macchiato.json"),
    ),
    (
        "gruvbox",
        include_str!("../../assets/themes/opencode/gruvbox.json"),
    ),
    (
        "dracula",
        include_str!("../../assets/themes/opencode/dracula.json"),
    ),
    ("nord", include_str!("../../assets/themes/opencode/nord.json")),
    (
        "rosepine",
        include_str!("../../assets/themes/opencode/rosepine.json"),
    ),
    (
        "kanagawa",
        include_str!("../../assets/themes/opencode/kanagawa.json"),
    ),
    ("ayu", include_str!("../../assets/themes/opencode/ayu.json")),
    ("github", include_str!("../../assets/themes/opencode/github.json")),
    (
        "monokai",
        include_str!("../../assets/themes/opencode/monokai.json"),
    ),
    ("vesper", include_str!("../../assets/themes/opencode/vesper.json")),
    (
        "opencode",
        include_str!("../../assets/themes/opencode/opencode.json"),
    ),
    (
        "everforest",
        include_str!("../../assets/themes/opencode/everforest.json"),
    ),
];

pub fn list_theme_ids() -> Vec<&'static str> {
    let mut ids = Vec::with_capacity(OPENCODE_THEMES.len() + 1);
    ids.push(DEFAULT_THEME_ID);
    ids.extend(OPENCODE_THEMES.iter().map(|(id, _)| *id));
    ids
}

pub fn load_by_id(id: &str, mode: ThemeMode) -> Result<ResolvedTheme, ThemeError> {
    if id == DEFAULT_THEME_ID {
        return load(include_str!("../../assets/themes/senpi-neo-dark.json"));
    }

    // Accept both `dracula` and `opencode/dracula` for ergonomics: the
    // README + `--theme` CLI documentation lean on the namespaced form,
    // but the underlying registry uses flat keys keyed off the JSON
    // file basename. Stripping the prefix here keeps both spellings
    // working without duplicating the table.
    let lookup_id = id.strip_prefix("opencode/").unwrap_or(id);

    let Some((_, source)) = OPENCODE_THEMES
        .iter()
        .find(|(theme_id, _)| *theme_id == lookup_id)
    else {
        return Err(ThemeError::UnknownTheme(id.to_string()));
    };

    let theme = parse_opencode(source)?;
    Ok(derive(&theme, mode))
}
