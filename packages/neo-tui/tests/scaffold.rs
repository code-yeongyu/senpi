//! Scaffold-level tests that lock the public surface in place.
//!
//! These tests lock the bundled theme/keymap assets and the initial RPC
//! envelope contract.

use senpi_neo_tui::{
    DEFAULT_DARK_THEME_JSON, DEFAULT_KEYMAP_JSON, VERSION,
    rpc::envelope::{Envelope, parse_line},
};

#[test]
fn version_is_non_empty() {
    assert!(!VERSION.is_empty(), "crate version must be set");
}

#[test]
fn bundled_keymap_json_is_valid_json() {
    let value: serde_json::Value =
        serde_json::from_str(DEFAULT_KEYMAP_JSON).expect("bundled default keymap must parse as JSON");
    assert!(
        value.get("bindings").is_some(),
        "keymap must have a bindings field"
    );
    // The legacy pi-tui/senpi keybinding registry has no leader concept,
    // so the bundled keymap intentionally omits one for 1:1 parity.
}

#[test]
fn bundled_dark_theme_json_is_valid_json() {
    let value: serde_json::Value =
        serde_json::from_str(DEFAULT_DARK_THEME_JSON).expect("bundled dark theme must parse as JSON");
    assert_eq!(
        value.get("name").and_then(serde_json::Value::as_str),
        Some("senpi-neo-dark"),
    );
    assert!(value.get("tokens").is_some(), "theme must declare tokens");
}

#[test]
fn rpc_envelope_parses_response() {
    let line = r#"{"type":"response","id":"req-1","command":"prompt","success":true}"#;
    let env = parse_line(line).expect("response envelope must parse");
    match env {
        Envelope::Response(resp) => {
            assert_eq!(resp.command, "prompt");
            assert!(resp.success);
            assert_eq!(resp.id.as_deref(), Some("req-1"));
        }
        Envelope::Event(_) => panic!("expected response, got event"),
    }
}

#[test]
fn rpc_envelope_parses_event() {
    let line = r#"{"type":"event","event":"text_delta","data":{"delta":"hi"}}"#;
    let env = parse_line(line).expect("event envelope must parse");
    match env {
        Envelope::Event(ev) => {
            assert_eq!(ev.event, "text_delta");
        }
        Envelope::Response(_) => panic!("expected event, got response"),
    }
}

#[test]
fn rpc_envelope_strips_crlf() {
    let line = "{\"type\":\"event\",\"event\":\"tick\"}\r\n";
    let env = parse_line(line).expect("crlf-trimmed line must parse");
    assert!(matches!(env, Envelope::Event(_)));
}

#[test]
fn rpc_envelope_rejects_garbage() {
    let result = parse_line("not json");
    assert!(result.is_err());
}
