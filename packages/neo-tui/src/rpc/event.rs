//! Typed RPC events emitted by `senpi --mode rpc` on stdout.
//!
//! Mirrors the event taxonomy in
//! `packages/coding-agent/docs/rpc.md` ("Events" section).
//!
//! The TUI does NOT need to interpret every event payload as strongly
//! typed structs; for unfamiliar payload shapes the variant carries a
//! `serde_json::Value`. The TUI does need to discriminate cleanly
//! between the major kinds so it can update the right component
//! (chat stream, tool card, footer status, queue widget, ...).

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Top-level event discriminator.
///
/// The wire format uses `{"type": "<event_name>", ...payload}` (flat,
/// not nested), so we use `#[serde(tag = "type")]` and let each variant
/// hold its own structured fields.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    /// Agent began processing a prompt. No payload.
    AgentStart,
    /// Agent finished. Carries the list of generated messages.
    AgentEnd {
        #[serde(default)]
        messages: Vec<Value>,
    },
    /// New turn (assistant response + resulting tool calls/results) begins.
    TurnStart,
    /// Turn completes. Carries the assistant message + tool results.
    TurnEnd {
        #[serde(default)]
        message: Option<Value>,
        #[serde(default, rename = "toolResults")]
        tool_results: Vec<Value>,
    },
    /// A message begins streaming. Carries the partial message.
    MessageStart {
        #[serde(default)]
        message: Value,
    },
    /// A message finished streaming.
    MessageEnd {
        #[serde(default)]
        message: Value,
    },
    /// Streaming delta. The TUI uses `assistantMessageEvent.type` to decide
    /// whether it is text/thinking/toolcall/done/error.
    MessageUpdate {
        #[serde(default)]
        message: Value,
        #[serde(default, rename = "assistantMessageEvent")]
        assistant_message_event: Option<Value>,
    },
    /// Tool execution starts.
    ToolExecutionStart {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        #[serde(default)]
        args: Value,
    },
    /// Tool execution streams partial output.
    ToolExecutionUpdate {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(default, rename = "toolName")]
        tool_name: Option<String>,
        #[serde(default, rename = "partialResult")]
        partial_result: Value,
    },
    /// Tool execution completes.
    ToolExecutionEnd {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        #[serde(default)]
        result: Value,
        #[serde(default, rename = "isError")]
        is_error: bool,
    },
    /// The pending steering / follow-up queues changed.
    QueueUpdate {
        #[serde(default)]
        steering: Vec<String>,
        #[serde(default, rename = "followUp")]
        follow_up: Vec<String>,
    },
    /// Compaction begins.
    CompactionStart {
        #[serde(default)]
        reason: Option<String>,
    },
    /// Compaction completes.
    CompactionEnd {
        #[serde(default)]
        reason: Option<String>,
        #[serde(default)]
        result: Value,
        #[serde(default)]
        aborted: bool,
        #[serde(default, rename = "willRetry")]
        will_retry: bool,
        #[serde(default, rename = "errorMessage")]
        error_message: Option<String>,
    },
    /// Auto-retry begins.
    AutoRetryStart {
        attempt: u32,
        #[serde(rename = "maxAttempts")]
        max_attempts: u32,
        #[serde(rename = "delayMs")]
        delay_ms: u64,
        #[serde(default, rename = "errorMessage")]
        error_message: Option<String>,
    },
    /// Auto-retry finishes.
    AutoRetryEnd {
        success: bool,
        attempt: u32,
        #[serde(default, rename = "finalError")]
        final_error: Option<String>,
    },
    /// Extension threw an error.
    ExtensionError {
        #[serde(rename = "extensionPath")]
        extension_path: String,
        event: String,
        error: String,
    },
    /// Extension UI request. Extensions emit these to drive user-facing
    /// notifications (`notify`) and modal dialogs (`select`, `confirm`,
    /// `input`, `editor`). See `packages/coding-agent/docs/rpc.md` →
    /// "Extension UI Requests". Bug 3 (Oracle round 11): used to land
    /// in [`Event::Other`] and get silently discarded by `apply_event`,
    /// so `notifyType: "error"` extension warnings never reached chat.
    ExtensionUiRequest {
        /// Sub-method (`notify`, `select`, `confirm`, `input`, `editor`,
        /// `setStatus`, `setWidget`, `setTitle`, `set_editor_text`).
        method: String,
        /// Notification body (used by `notify` and `confirm`).
        #[serde(default)]
        message: Option<String>,
        /// `info` (default) / `warning` / `error`. Only `notify` uses
        /// this.
        #[serde(default, rename = "notifyType")]
        notify_type: Option<String>,
        /// Dialog title (used by `select`, `confirm`, `input`,
        /// `editor`).
        #[serde(default)]
        title: Option<String>,
    },
    /// Escape hatch for events we do not yet model. The full original
    /// payload is preserved so the TUI can still display it raw.
    #[serde(other)]
    Other,
}

/// Parse a single JSONL line into a typed [`Event`].
///
/// Strips a trailing `\r` (CRLF tolerance per the protocol).
pub fn parse_line(line: &str) -> Result<Event, serde_json::Error> {
    let trimmed = line.trim_end_matches(['\r', '\n']);
    serde_json::from_str(trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_agent_start() {
        let ev: Event = serde_json::from_str(r#"{"type":"agent_start"}"#).unwrap();
        assert!(matches!(ev, Event::AgentStart));
    }

    #[test]
    fn parses_message_update_with_text_delta() {
        let payload = r#"{
            "type": "message_update",
            "message": {"role": "assistant"},
            "assistantMessageEvent": {"type": "text_delta", "delta": "hi"}
        }"#;
        let ev: Event = serde_json::from_str(payload).unwrap();
        let Event::MessageUpdate {
            assistant_message_event,
            ..
        } = ev
        else {
            panic!("expected MessageUpdate, got {ev:?}");
        };
        assert_eq!(
            assistant_message_event.as_ref().and_then(|v| v["delta"].as_str()),
            Some("hi"),
        );
    }

    #[test]
    fn parses_tool_execution_start() {
        let payload = r#"{
            "type": "tool_execution_start",
            "toolCallId": "call_1",
            "toolName": "bash",
            "args": {"command": "ls"}
        }"#;
        let ev = parse_line(payload).unwrap();
        let Event::ToolExecutionStart {
            tool_call_id,
            tool_name,
            args,
        } = ev
        else {
            panic!("expected ToolExecutionStart");
        };
        assert_eq!(tool_call_id, "call_1");
        assert_eq!(tool_name, "bash");
        assert_eq!(args["command"], "ls");
    }

    #[test]
    fn parses_tool_execution_end_with_is_error_true() {
        let payload = r#"{
            "type": "tool_execution_end",
            "toolCallId": "x",
            "toolName": "bash",
            "result": {"content": [{"type":"text","text":"oops"}]},
            "isError": true
        }"#;
        let ev = parse_line(payload).unwrap();
        let Event::ToolExecutionEnd { is_error, .. } = ev else {
            panic!("expected ToolExecutionEnd");
        };
        assert!(is_error);
    }

    #[test]
    fn parses_queue_update_with_both_lists() {
        let payload = r#"{
            "type": "queue_update",
            "steering": ["a", "b"],
            "followUp": ["c"]
        }"#;
        let ev = parse_line(payload).unwrap();
        let Event::QueueUpdate { steering, follow_up } = ev else {
            panic!("expected QueueUpdate");
        };
        assert_eq!(steering, vec!["a", "b"]);
        assert_eq!(follow_up, vec!["c"]);
    }

    #[test]
    fn parses_auto_retry_start_with_attempt_metadata() {
        let payload = r#"{
            "type": "auto_retry_start",
            "attempt": 1,
            "maxAttempts": 3,
            "delayMs": 2000,
            "errorMessage": "overloaded"
        }"#;
        let ev = parse_line(payload).unwrap();
        let Event::AutoRetryStart {
            attempt,
            max_attempts,
            delay_ms,
            error_message,
        } = ev
        else {
            panic!("expected AutoRetryStart");
        };
        assert_eq!(attempt, 1);
        assert_eq!(max_attempts, 3);
        assert_eq!(delay_ms, 2000);
        assert_eq!(error_message.as_deref(), Some("overloaded"));
    }

    #[test]
    fn parses_crlf_terminated_line() {
        let payload = "{\"type\":\"agent_start\"}\r\n";
        let ev = parse_line(payload).unwrap();
        assert!(matches!(ev, Event::AgentStart));
    }

    #[test]
    fn unknown_event_type_becomes_other_variant() {
        let ev = parse_line(r#"{"type":"never_emitted","payload":42}"#).unwrap();
        assert!(matches!(ev, Event::Other));
    }
}
