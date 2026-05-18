//! Contract tests for the RPC envelope. RED until T6 fills in the full
//! event taxonomy; today we lock the response / event discriminator.

use senpi_neo_tui::rpc::envelope::{self, Envelope};

#[test]
fn parses_response_envelope() {
    let line = r#"{"type":"response","id":"req-1","command":"prompt","success":true}"#;
    match envelope::parse_line(line).expect("parse must succeed") {
        Envelope::Response(r) => {
            assert_eq!(r.id.as_deref(), Some("req-1"));
            assert_eq!(r.command, "prompt");
            assert!(r.success);
            assert!(r.error.is_none());
        }
        Envelope::Event(_) => panic!("expected Response, got Event"),
    }
}

#[test]
fn parses_event_envelope() {
    let line = r#"{"type":"event","event":"text_delta","content":"hello"}"#;
    match envelope::parse_line(line).expect("parse must succeed") {
        Envelope::Event(e) => {
            assert_eq!(e.event, "text_delta");
        }
        Envelope::Response(_) => panic!("expected Event, got Response"),
    }
}

#[test]
fn tolerates_crlf_line_endings() {
    let line = "{\"type\":\"event\",\"event\":\"tick\"}\r\n";
    let parsed = envelope::parse_line(line).expect("must accept crlf-terminated line");
    matches!(parsed, Envelope::Event(_))
        .then_some(())
        .expect("envelope is an event");
}

#[test]
fn rejects_malformed_json() {
    let line = "{not-json";
    let err = envelope::parse_line(line);
    assert!(err.is_err(), "malformed line must return an error");
}
