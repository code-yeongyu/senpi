//! Terminal capability detection + writes for setup/cleanup.
//!
//! Crossterm covers most of what we need, but tmux's xterm modifyOtherKeys
//! mode 2 (CSI `> 4 ; 2 m`) must be emitted EXPLICITLY for modified Enter
//! keys to flow through as CSI-u sequences. Without it, `Shift+Enter`
//! collapses to plain `Enter`.

use base64::{Engine as _, engine::general_purpose};
use crossterm::event::KeyboardEnhancementFlags;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InTmux {
    Yes,
    No,
}

#[derive(Clone, Debug)]
pub struct TerminalCaps {
    pub in_tmux: bool,
    pub kitty_keyboard_flags: KeyboardEnhancementFlags,
}

impl TerminalCaps {
    pub fn detect() -> Self {
        let in_tmux = std::env::var_os("TMUX").is_some() || std::env::var_os("TMUX_PANE").is_some();
        let kitty_keyboard_flags = KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES
            | KeyboardEnhancementFlags::REPORT_ALL_KEYS_AS_ESCAPE_CODES;
        Self {
            in_tmux,
            kitty_keyboard_flags,
        }
    }

    /// Bytes to write to stdout BEFORE `enable_raw_mode` returns.
    /// Includes xterm modifyOtherKeys mode 2 when running in tmux.
    pub fn init_writes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        if self.in_tmux {
            out.extend_from_slice(b"\x1b[>4;2m");
        }
        out
    }

    /// Bytes to write to stdout AFTER `disable_raw_mode`.
    pub fn cleanup_writes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        if self.in_tmux {
            out.extend_from_slice(b"\x1b[>4;0m");
        }
        out
    }
}

/// Encode bytes for OSC 52 clipboard write.
/// Returns ANSI sequence; caller writes to stdout.
pub fn osc52_set_clipboard(data: &[u8], in_tmux: InTmux) -> Vec<u8> {
    let encoded = general_purpose::STANDARD.encode(data);
    let inner = format!("\x1b]52;c;{encoded}\x07");
    match in_tmux {
        InTmux::No => inner.into_bytes(),
        InTmux::Yes => format!("\x1bPtmux;\x1b{inner}\x1b\\").into_bytes(),
    }
}
