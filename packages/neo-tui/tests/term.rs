use std::process::Command;

use crossterm::event::KeyboardEnhancementFlags;
use senpi_neo_tui::term::{InTmux, TerminalCaps, osc52_set_clipboard};

#[test]
fn term_emits_modify_other_keys_when_tmux_env_set() {
    let caps = TerminalCaps {
        in_tmux: true,
        kitty_keyboard_flags: KeyboardEnhancementFlags::empty(),
    };

    assert!(
        String::from_utf8(caps.init_writes())
            .unwrap()
            .contains("\x1b[>4;2m")
    );
}

#[test]
fn term_does_not_emit_modify_other_keys_when_tmux_absent() {
    let caps = TerminalCaps {
        in_tmux: false,
        kitty_keyboard_flags: KeyboardEnhancementFlags::empty(),
    };

    assert!(
        !String::from_utf8(caps.init_writes())
            .unwrap()
            .contains("\x1b[>4;2m")
    );
}

#[test]
fn term_cleanup_writes_disable_modify_other_keys() {
    let caps = TerminalCaps {
        in_tmux: true,
        kitty_keyboard_flags: KeyboardEnhancementFlags::empty(),
    };

    assert!(
        String::from_utf8(caps.cleanup_writes())
            .unwrap()
            .contains("\x1b[>4;0m")
    );
}

#[test]
fn osc52_clipboard_write_plain_terminal() {
    assert_eq!(
        osc52_set_clipboard(b"hello", InTmux::No),
        b"\x1b]52;c;aGVsbG8=\x07"
    );
}

#[test]
fn osc52_clipboard_write_in_tmux_passthrough() {
    assert_eq!(
        osc52_set_clipboard(b"hello", InTmux::Yes),
        b"\x1bPtmux;\x1b\x1b]52;c;aGVsbG8=\x07\x1b\\"
    );
}

#[test]
fn term_caps_detects_tmux_from_env() {
    let current_test_binary = std::env::current_exe().unwrap();
    let status = Command::new(current_test_binary)
        .arg("--exact")
        .arg("term_caps_detects_tmux_from_env_child")
        .arg("--ignored")
        .env("TMUX", "foo")
        .env_remove("TMUX_PANE")
        .status()
        .unwrap();

    assert!(status.success());
}

#[test]
#[ignore]
fn term_caps_detects_tmux_from_env_child() {
    assert!(TerminalCaps::detect().in_tmux);
}

#[test]
fn term_caps_kitty_keyboard_flags_default() {
    let caps = TerminalCaps::detect();

    assert!(
        caps.kitty_keyboard_flags
            .contains(KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES)
    );
    assert!(
        caps.kitty_keyboard_flags
            .contains(KeyboardEnhancementFlags::REPORT_ALL_KEYS_AS_ESCAPE_CODES)
    );
}
