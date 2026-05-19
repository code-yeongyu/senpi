//! Contract tests for bundled opencode-format themes.

use ratatui::style::Color;
use senpi_neo_tui::theme::{self, ThemeMode, Token, opencode_palette::blend};
use std::process::Command;

const OPENCODE_THEMES: [(&str, &str); 15] = [
    (
        "tokyonight",
        include_str!("../assets/themes/opencode/tokyonight.json"),
    ),
    (
        "catppuccin",
        include_str!("../assets/themes/opencode/catppuccin.json"),
    ),
    (
        "catppuccin-frappe",
        include_str!("../assets/themes/opencode/catppuccin-frappe.json"),
    ),
    (
        "catppuccin-macchiato",
        include_str!("../assets/themes/opencode/catppuccin-macchiato.json"),
    ),
    ("gruvbox", include_str!("../assets/themes/opencode/gruvbox.json")),
    ("dracula", include_str!("../assets/themes/opencode/dracula.json")),
    ("nord", include_str!("../assets/themes/opencode/nord.json")),
    (
        "rosepine",
        include_str!("../assets/themes/opencode/rosepine.json"),
    ),
    (
        "kanagawa",
        include_str!("../assets/themes/opencode/kanagawa.json"),
    ),
    ("ayu", include_str!("../assets/themes/opencode/ayu.json")),
    ("github", include_str!("../assets/themes/opencode/github.json")),
    ("monokai", include_str!("../assets/themes/opencode/monokai.json")),
    ("vesper", include_str!("../assets/themes/opencode/vesper.json")),
    (
        "opencode",
        include_str!("../assets/themes/opencode/opencode.json"),
    ),
    (
        "everforest",
        include_str!("../assets/themes/opencode/everforest.json"),
    ),
];

#[test]
fn parses_all_bundled_opencode_themes() {
    for (id, source) in OPENCODE_THEMES {
        let parsed = theme::parse_opencode(source).unwrap_or_else(|error| panic!("{id}: {error}"));
        assert_eq!(parsed.id, id);
    }
}

#[test]
fn derives_all_tokens_for_each_bundled_variant() {
    for (id, source) in OPENCODE_THEMES {
        let parsed = theme::parse_opencode(source).unwrap_or_else(|error| panic!("{id}: {error}"));
        for mode in [ThemeMode::Dark, ThemeMode::Light] {
            let resolved = theme::derive(&parsed, mode);
            for token in Token::ALL {
                assert_ne!(
                    resolved.token(token),
                    Color::Reset,
                    "{id} {mode:?} must populate {token:?}"
                );
            }
        }
    }
}

#[test]
fn derives_expected_anchor_colors() {
    let tokyonight = theme::load_by_id("tokyonight", ThemeMode::Dark).expect("tokyonight loads");
    assert_eq!(tokyonight.token(Token::Background), Color::Rgb(0x1a, 0x1b, 0x26));

    let catppuccin = theme::load_by_id("catppuccin", ThemeMode::Dark).expect("catppuccin loads");
    assert_eq!(catppuccin.token(Token::Background), Color::Rgb(0x1e, 0x1e, 0x2e));

    let dracula = theme::load_by_id("dracula", ThemeMode::Dark).expect("dracula loads");
    assert_eq!(dracula.token(Token::Primary), Color::Rgb(0xbd, 0x93, 0xf9));
}

#[test]
fn blends_rgb_channels_linearly() {
    assert_eq!(
        blend(Color::Rgb(255, 0, 0), Color::Rgb(0, 0, 0), 0.5),
        Color::Rgb(127, 0, 0)
    );
}

#[test]
fn registry_lists_bundled_and_native_theme_ids() {
    let ids = theme::list_theme_ids();
    assert_eq!(ids.len(), 16);
    assert!(ids.contains(&"senpi-neo-dark"));
    for (id, _) in OPENCODE_THEMES {
        assert!(ids.contains(&id), "registry must include {id}");
    }
    assert!(theme::load_by_id("nonexistent", ThemeMode::Dark).is_err());
}

#[test]
fn registry_loads_id_and_native_file_path_equivalent_theme() {
    let by_id = theme::load_by_id("tokyonight", ThemeMode::Dark).expect("id loads");
    assert_eq!(by_id.token(Token::Background), Color::Rgb(0x1a, 0x1b, 0x26));

    let path_theme = theme::load(senpi_neo_tui::DEFAULT_DARK_THEME_JSON).expect("native path-style load");
    assert_eq!(path_theme.token(Token::Background), Color::Rgb(0x1A, 0x1B, 0x26));
}

#[test]
fn invalid_opencode_hex_is_rejected() {
    let bad = r##"{
        "$schema": "https://opencode.ai/desktop-theme.json",
        "name": "Broken",
        "id": "broken",
        "light": {
            "palette": {
                "neutral": "#fff",
                "ink": "#111",
                "primary": "#222",
                "accent": "#333",
                "success": "#444",
                "warning": "#555",
                "error": "#666",
                "info": "#777",
                "diffAdd": "#888",
                "diffDelete": "#999"
            }
        },
        "dark": {
            "palette": {
                "neutral": "not-a-color",
                "ink": "#111",
                "primary": "#222",
                "accent": "#333",
                "success": "#444",
                "warning": "#555",
                "error": "#666",
                "info": "#777",
                "diffAdd": "#888",
                "diffDelete": "#999"
            }
        }
    }"##;

    assert!(theme::parse_opencode(bad).is_err());
}

#[test]
fn list_themes_cli_prints_registry_ids() {
    let output = Command::new(env!("CARGO_BIN_EXE_senpi-neo-tui"))
        .arg("--list-themes")
        .output()
        .expect("list-themes command runs");
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).expect("stdout is utf8");
    let ids = stdout.lines().collect::<Vec<_>>();
    assert_eq!(ids.len(), 16);
    assert!(ids.contains(&"tokyonight"));
    assert!(ids.contains(&"catppuccin"));
    assert!(ids.contains(&"senpi-neo-dark"));
}
