//! `senpi-neo-faux`: offline JSONL backend used by the TUI's QA harness
//! and integration tests.
//!
//! Reads commands on stdin one JSONL line at a time. For each command,
//! emits a `response` envelope plus an optional stream of canned events
//! according to the selected scenario.
//!
//! Scenarios:
//! - `echo` (default): respond to any command with `success: true`. Used
//!   by simple roundtrip / framing tests.
//! - `streaming`: respond to `prompt`, then emit `agent_start` +
//!   `message_update` text deltas + `agent_end`. Used by the streaming
//!   UX QA.
//! - `tool-run`: respond to `prompt`, then emit `tool_execution_start`
//!   + `tool_execution_update` + `tool_execution_end`.
//! - `error`: respond to `prompt` with `success: false` + error message.
//!
//! Reads each command line, replies on stdout. Exits cleanly when
//! stdin is closed (the parent terminated).

use std::io::Write;
use std::process::ExitCode;
use std::str::FromStr;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum Scenario {
    #[default]
    Echo,
    Streaming,
    ToolRun,
    Error,
}

impl FromStr for Scenario {
    type Err = anyhow::Error;
    fn from_str(s: &str) -> Result<Self> {
        match s {
            "echo" => Ok(Self::Echo),
            "streaming" => Ok(Self::Streaming),
            "tool-run" => Ok(Self::ToolRun),
            "error" => Ok(Self::Error),
            other => bail!("unknown scenario `{other}`"),
        }
    }
}

fn main() -> ExitCode {
    let scenario = parse_scenario().unwrap_or_default();
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(err) => {
            eprintln!("senpi-neo-faux: failed to build tokio runtime: {err}");
            return ExitCode::FAILURE;
        }
    };
    match runtime.block_on(run(scenario)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("senpi-neo-faux: {err:?}");
            ExitCode::FAILURE
        }
    }
}

fn parse_scenario() -> Result<Scenario> {
    let mut scenario = Scenario::default();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--scenario" => {
                let value = args.next().context("--scenario expects a value")?;
                scenario = Scenario::from_str(&value)?;
            }
            other if other.starts_with("--scenario=") => {
                let value = other.trim_start_matches("--scenario=");
                scenario = Scenario::from_str(value)?;
            }
            _ => {
                // Tolerate unknown flags so the launcher can pass through
                // anything without breaking the faux backend.
            }
        }
    }
    Ok(scenario)
}

async fn run(scenario: Scenario) -> Result<()> {
    let stdin = tokio::io::stdin();
    let mut reader = BufReader::new(stdin).lines();

    while let Some(line) = reader.next_line().await? {
        let trimmed = line.trim_end_matches('\r');
        if trimmed.is_empty() {
            continue;
        }
        let value: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(err) => {
                emit(&json!({
                    "type": "response",
                    "command": "parse",
                    "success": false,
                    "error": format!("Failed to parse command: {err}"),
                }))?;
                continue;
            }
        };
        let command = value
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let id = value.get("id").cloned();
        handle_command(scenario, &command, id.as_ref(), &value).await?;
    }
    Ok(())
}

async fn handle_command(
    scenario: Scenario,
    command: &str,
    id: Option<&Value>,
    payload: &Value,
) -> Result<()> {
    match command {
        "prompt" => handle_prompt(scenario, id, payload).await,
        // All other commands acknowledge success unconditionally so
        // the TUI side can exercise them without scenario expansion.
        other => emit(&response(other, id, true, None, None)),
    }
}

async fn handle_prompt(scenario: Scenario, id: Option<&Value>, payload: &Value) -> Result<()> {
    let message = payload.get("message").and_then(|v| v.as_str()).unwrap_or("");

    match scenario {
        Scenario::Echo => {
            emit(&response("prompt", id, true, None, None))?;
            emit(&json!({"type": "agent_start"}))?;
            emit(&message_text_delta(0, &format!("echo: {message}")))?;
            emit(&message_text_end(0, &format!("echo: {message}")))?;
            emit(&json!({"type": "agent_end", "messages": []}))?;
        }
        Scenario::Streaming => {
            emit(&response("prompt", id, true, None, None))?;
            emit(&json!({"type": "agent_start"}))?;
            emit(&json!({"type": "turn_start"}))?;
            emit(&json!({
                "type": "message_start",
                "message": {"role": "assistant"},
            }))?;
            let chunks = [
                "Sure - here is the streamed response.\n",
                "First it tokenizes the request,\n",
                "then it emits text deltas in real time.\n",
                "Finally it stops.\n",
            ];
            let mut full = String::new();
            for (idx, chunk) in chunks.iter().enumerate() {
                emit(&message_text_delta(u32::try_from(idx).unwrap_or(0), chunk))?;
                full.push_str(chunk);
                tokio::time::sleep(Duration::from_millis(120)).await;
            }
            emit(&message_text_end(0, &full))?;
            emit(&json!({
                "type": "message_end",
                "message": {"role": "assistant", "content": [{"type": "text", "text": full}]}
            }))?;
            emit(&json!({"type": "turn_end"}))?;
            emit(&json!({"type": "agent_end", "messages": []}))?;
        }
        Scenario::ToolRun => {
            emit(&response("prompt", id, true, None, None))?;
            emit(&json!({"type": "agent_start"}))?;
            emit(&json!({
                "type": "tool_execution_start",
                "toolCallId": "call_demo",
                "toolName": "bash",
                "args": {"command": "ls -la"},
            }))?;
            for chunk in [
                "total 48\n",
                "drwxr-xr-x  Cargo.toml\n",
                "-rw-r--r--  README.md\n",
            ] {
                emit(&json!({
                    "type": "tool_execution_update",
                    "toolCallId": "call_demo",
                    "toolName": "bash",
                    "partialResult": {"content": [{"type": "text", "text": chunk}]},
                }))?;
                tokio::time::sleep(Duration::from_millis(80)).await;
            }
            emit(&json!({
                "type": "tool_execution_end",
                "toolCallId": "call_demo",
                "toolName": "bash",
                "result": {"content": [{"type": "text", "text": "ok"}]},
                "isError": false,
            }))?;
            emit(&json!({"type": "agent_end", "messages": []}))?;
        }
        Scenario::Error => {
            emit(&response(
                "prompt",
                id,
                false,
                None,
                Some("simulated error from --scenario=error"),
            ))?;
        }
    }
    Ok(())
}

fn response(
    command: &str,
    id: Option<&Value>,
    success: bool,
    data: Option<Value>,
    error: Option<&str>,
) -> Value {
    let mut v = serde_json::Map::new();
    v.insert("type".into(), Value::String("response".into()));
    if let Some(id) = id {
        v.insert("id".into(), id.clone());
    }
    v.insert("command".into(), Value::String(command.into()));
    v.insert("success".into(), Value::Bool(success));
    if let Some(d) = data {
        v.insert("data".into(), d);
    }
    if let Some(e) = error {
        v.insert("error".into(), Value::String(e.into()));
    }
    Value::Object(v)
}

fn message_text_delta(content_index: u32, delta: &str) -> Value {
    json!({
        "type": "message_update",
        "message": {"role": "assistant"},
        "assistantMessageEvent": {
            "type": "text_delta",
            "contentIndex": content_index,
            "delta": delta,
            "partial": {"role": "assistant"}
        }
    })
}

fn message_text_end(content_index: u32, content: &str) -> Value {
    json!({
        "type": "message_update",
        "message": {"role": "assistant"},
        "assistantMessageEvent": {
            "type": "text_end",
            "contentIndex": content_index,
            "content": content,
            "partial": {"role": "assistant"}
        }
    })
}

fn emit(value: &Value) -> Result<()> {
    let line = serde_json::to_string(value)?;
    let mut stdout = std::io::stdout().lock();
    writeln!(stdout, "{line}").context("writing JSONL frame")?;
    stdout.flush().context("flushing stdout")?;
    Ok(())
}
