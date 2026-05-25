//! `senpi-neo-tui` - native Rust + ratatui TUI for senpi.
//!
//! See [`README`](https://github.com/code-yeongyu/senpi/blob/main/packages/neo-tui/README.md)
//! and `packages/neo-tui/AGENTS.md` for the architecture and module layout.
//!
//! The crate exposes a thin library surface so integration tests and the
//! offline faux backend can drive individual subsystems without
//! constructing the full app.

#![doc(html_root_url = "https://docs.rs/senpi-neo-tui")]

pub mod anim;
pub mod app;
pub mod components;
pub mod compositor;
pub(crate) mod frame;
pub mod keymap;
pub mod layout;
pub mod overlay;
pub mod rpc;
pub mod term;
pub mod text;
/// Theme loading, bundled theme registry, and semantic color token resolution.
pub mod theme;

/// Crate version, mirrored from `Cargo.toml`.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Bundled default keymap JSON source (compile-time included).
pub const DEFAULT_KEYMAP_JSON: &str = include_str!("../assets/keymaps/default.json");

/// Bundled default dark theme JSON source in senpi's native schema.
pub const DEFAULT_DARK_THEME_JSON: &str = include_str!("../assets/themes/senpi-neo-dark.json");

/// Parse + resolve the bundled dark theme JSON into a [`theme::ResolvedTheme`].
///
/// Convenience for binaries and integration tests.
pub fn load_bundled_dark_theme() -> Result<theme::ResolvedTheme, theme::ThemeError> {
    theme::load(DEFAULT_DARK_THEME_JSON)
}
