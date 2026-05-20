//! Concrete TUI components: header, chat, input, footer.
//!
//! Wave-3 components. Each renders into a `Rect` against a `ResolvedTheme`
//! and a piece of typed application state. All components are pure
//! widgets - no terminal I/O, no async - so they snapshot-test cleanly.

pub mod autocomplete;
pub mod chat;
pub mod footer;
pub mod header;
pub mod input;
pub mod markdown;
pub mod select_list;
pub mod settings_list;
pub mod working_indicator;
