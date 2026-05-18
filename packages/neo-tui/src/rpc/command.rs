//! Typed RPC commands sent from the TUI to `senpi --mode rpc`.
//!
//! Mirrors the protocol in [`packages/coding-agent/docs/rpc.md`]. The TUI
//! only models the subset of commands it actively issues. Adding a new
//! command is a one-variant addition to [`Command`] + a serde tag.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Allowed thinking levels per the RPC protocol.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ThinkingLevel {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
}

/// What to do with the prompt while the agent is mid-stream.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StreamingBehavior {
    /// Queue after the current assistant turn finishes tool calls.
    Steer,
    /// Wait until the agent is fully idle before delivering.
    FollowUp,
}

/// Typed command sent on stdin to the backend.
///
/// Every variant carries the optional `id` used for request/response
/// correlation. Pass `None` to skip correlation; the backend will still
/// emit a response.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    /// Submit a user message. See `prompt` in `rpc.md`.
    Prompt {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none", rename = "streamingBehavior")]
        streaming_behavior: Option<StreamingBehavior>,
    },
    /// Queue a steering message during streaming.
    Steer {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        message: String,
    },
    /// Queue a follow-up message after the agent finishes.
    FollowUp {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        message: String,
    },
    /// Abort the current agent run.
    Abort {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    /// Start a fresh session.
    NewSession {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    /// Get current session state (model, thinking, streaming flags, ...).
    GetState {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    /// Pick a specific model by provider + modelId.
    SetModel {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        provider: String,
        #[serde(rename = "modelId")]
        model_id: String,
    },
    /// Cycle to the next available model in the favorites list.
    CycleModel {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    /// List all configured models.
    GetAvailableModels {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    /// Set thinking level.
    SetThinkingLevel {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        level: ThinkingLevel,
    },
    /// Cycle through available thinking levels.
    CycleThinkingLevel {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    /// Get token/cost/context-usage stats.
    GetSessionStats {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    /// Escape hatch for commands not yet typed. Serializes as raw JSON
    /// with the `type` field already set by the caller.
    #[serde(untagged)]
    Raw(Value),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json_of(cmd: &Command) -> serde_json::Value {
        serde_json::to_value(cmd).expect("command serializes")
    }

    #[test]
    fn prompt_serializes_with_type_and_message() {
        let cmd = Command::Prompt {
            id: Some("req-1".into()),
            message: "hello".into(),
            streaming_behavior: None,
        };
        let v = json_of(&cmd);
        assert_eq!(v["type"], "prompt");
        assert_eq!(v["id"], "req-1");
        assert_eq!(v["message"], "hello");
        assert!(v.get("streamingBehavior").is_none(), "must not emit null");
    }

    #[test]
    fn prompt_omits_id_when_none() {
        let cmd = Command::Prompt {
            id: None,
            message: "hi".into(),
            streaming_behavior: Some(StreamingBehavior::Steer),
        };
        let v = json_of(&cmd);
        assert!(v.get("id").is_none(), "no id field when None");
        assert_eq!(v["streamingBehavior"], "steer");
    }

    #[test]
    fn abort_serializes_minimal() {
        let v = json_of(&Command::Abort { id: None });
        assert_eq!(v["type"], "abort");
        assert!(v.get("id").is_none());
    }

    #[test]
    fn set_model_serializes_provider_and_model_id() {
        let v = json_of(&Command::SetModel {
            id: None,
            provider: "anthropic".into(),
            model_id: "claude-opus-4-7".into(),
        });
        assert_eq!(v["type"], "set_model");
        assert_eq!(v["provider"], "anthropic");
        assert_eq!(v["modelId"], "claude-opus-4-7");
    }

    #[test]
    fn thinking_level_serializes_lowercase() {
        let v = json_of(&Command::SetThinkingLevel {
            id: None,
            level: ThinkingLevel::High,
        });
        assert_eq!(v["type"], "set_thinking_level");
        assert_eq!(v["level"], "high");
    }

    #[test]
    fn cycle_model_serializes_minimal() {
        let v = json_of(&Command::CycleModel { id: None });
        assert_eq!(v["type"], "cycle_model");
    }

    #[test]
    fn get_session_stats_serializes_minimal() {
        let v = json_of(&Command::GetSessionStats { id: None });
        assert_eq!(v["type"], "get_session_stats");
    }

    #[test]
    fn raw_escape_hatch_passes_through_verbatim() {
        let raw = serde_json::json!({"type": "exotic_extension_cmd", "foo": 42});
        let cmd = Command::Raw(raw.clone());
        assert_eq!(json_of(&cmd), raw);
    }
}
