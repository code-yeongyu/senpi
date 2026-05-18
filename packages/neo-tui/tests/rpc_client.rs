//! Integration tests for the subprocess RPC client.
//!
//! Drives the real client against the `senpi-neo-faux` binary across
//! every scenario. Asserts that commands serialize to JSONL and reach
//! the child, that responses + events parse into typed `Inbound`
//! frames, and that the event ordering matches the protocol spec.

use std::path::PathBuf;
use std::time::Duration;

use senpi_neo_tui::rpc::{Inbound, RpcClient, command::Command, event::Event};
use tokio::time::timeout;

const T: Duration = Duration::from_secs(5);

fn faux_bin() -> PathBuf {
    env!("CARGO_BIN_EXE_senpi-neo-faux").into()
}

async fn recv(rx: &mut tokio::sync::mpsc::Receiver<Inbound>) -> Inbound {
    timeout(T, rx.recv())
        .await
        .expect("inbound recv timed out")
        .expect("inbound channel closed unexpectedly")
}

#[tokio::test]
async fn echo_scenario_roundtrip_response_then_stream() {
    let mut client = RpcClient::spawn(faux_bin(), &["--scenario", "echo"]).expect("spawn faux");
    let mut rx = client.take_inbound().expect("inbound channel");

    client
        .send(Command::Prompt {
            id: Some("rt-1".into()),
            message: "hello".into(),
            streaming_behavior: None,
        })
        .await
        .expect("send prompt");

    // 1. Response: prompt accepted.
    let Inbound::Response(resp) = recv(&mut rx).await else {
        panic!("expected Response first");
    };
    assert_eq!(resp.command, "prompt");
    assert!(resp.success);
    assert_eq!(resp.id.as_deref(), Some("rt-1"));

    // 2. agent_start lifecycle event.
    let Inbound::Event(ev) = recv(&mut rx).await else {
        panic!("expected agent_start event");
    };
    assert!(matches!(ev, Event::AgentStart));

    // 3. Streaming text delta with our prompt echoed.
    let Inbound::Event(Event::MessageUpdate {
        assistant_message_event,
        ..
    }) = recv(&mut rx).await
    else {
        panic!("expected MessageUpdate text_delta");
    };
    let delta = assistant_message_event
        .as_ref()
        .and_then(|v| v.get("delta"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    assert!(
        delta.contains("hello"),
        "delta should contain prompt text, got: {delta}"
    );

    // 4. Drain until agent_end. Tolerate intermediate frames.
    let mut saw_agent_end = false;
    for _ in 0..6 {
        let frame = recv(&mut rx).await;
        if let Inbound::Event(Event::AgentEnd { .. }) = frame {
            saw_agent_end = true;
            break;
        }
    }
    assert!(saw_agent_end, "should see agent_end terminating the stream");
}

#[tokio::test]
async fn abort_scenario_acknowledges_command() {
    let mut client = RpcClient::spawn(faux_bin(), &["--scenario", "echo"]).expect("spawn faux");
    let mut rx = client.take_inbound().expect("inbound channel");

    client
        .send(Command::Abort {
            id: Some("ab-1".into()),
        })
        .await
        .expect("send abort");

    let Inbound::Response(resp) = recv(&mut rx).await else {
        panic!("expected response");
    };
    assert_eq!(resp.command, "abort");
    assert!(resp.success);
    assert_eq!(resp.id.as_deref(), Some("ab-1"));
}

#[tokio::test]
async fn cycle_model_scenario_returns_alt_model() {
    let mut client = RpcClient::spawn(faux_bin(), &["--scenario", "echo"]).expect("spawn faux");
    let mut rx = client.take_inbound().expect("inbound channel");

    client
        .send(Command::CycleModel {
            id: Some("cm-1".into()),
        })
        .await
        .expect("send cycle_model");

    let Inbound::Response(resp) = recv(&mut rx).await else {
        panic!("expected response");
    };
    assert_eq!(resp.command, "cycle_model");
    assert!(resp.success);
}

#[tokio::test]
async fn tool_run_scenario_emits_tool_execution_events() {
    let mut client = RpcClient::spawn(faux_bin(), &["--scenario", "tool-run"]).expect("spawn faux");
    let mut rx = client.take_inbound().expect("inbound channel");

    client
        .send(Command::Prompt {
            id: Some("tr-1".into()),
            message: "go".into(),
            streaming_behavior: None,
        })
        .await
        .expect("send prompt");

    let mut saw_tool_start = false;
    let mut saw_tool_end = false;
    let mut saw_agent_end = false;
    for _ in 0..32 {
        match recv(&mut rx).await {
            Inbound::Event(Event::ToolExecutionStart { tool_name, .. }) => {
                assert_eq!(tool_name, "bash");
                saw_tool_start = true;
            }
            Inbound::Event(Event::ToolExecutionEnd { is_error, .. }) => {
                assert!(!is_error);
                saw_tool_end = true;
            }
            Inbound::Event(Event::AgentEnd { .. }) => {
                saw_agent_end = true;
                break;
            }
            _ => {}
        }
    }
    assert!(saw_tool_start, "expected tool_execution_start");
    assert!(saw_tool_end, "expected tool_execution_end");
    assert!(saw_agent_end, "expected agent_end");
}

#[tokio::test]
async fn error_scenario_returns_failed_response() {
    let mut client = RpcClient::spawn(faux_bin(), &["--scenario", "error"]).expect("spawn faux");
    let mut rx = client.take_inbound().expect("inbound channel");

    client
        .send(Command::Prompt {
            id: Some("err-1".into()),
            message: "boom".into(),
            streaming_behavior: None,
        })
        .await
        .expect("send prompt");

    let Inbound::Response(resp) = recv(&mut rx).await else {
        panic!("expected response");
    };
    assert_eq!(resp.command, "prompt");
    assert!(!resp.success);
    assert!(resp.error.as_deref().is_some_and(|s| s.contains("simulated")),);
}
