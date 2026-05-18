//! Subprocess JSONL RPC client.
//!
//! Spawns the senpi backend (or any drop-in JSONL-speaking child like
//! `senpi-neo-faux` in tests), pipes its stdio, and exchanges JSONL
//! frames asynchronously via two tokio tasks plus a pair of mpsc
//! channels.
//!
//! Architecture:
//! ```text
//!  TUI app loop ──┐                                ┌── child stdin
//!                 │   command_tx → command_rx ─→   │   (writer task)
//!                 │                                │
//!                 │   inbound_rx ← inbound_tx  ←   │── child stdout
//!                 │                                │   (reader task)
//!                 └──                              │── child stderr
//!                                                  │   (inherited)
//! ```
//!
//! - Writer task: drains `command_rx`, serializes each [`Command`] as
//!   one JSONL line, writes + flushes to child stdin.
//! - Reader task: line-buffers child stdout via `BufReader::lines`,
//!   discriminates each line as response vs event by the `"type"`
//!   field, parses into [`Inbound`], pushes onto the inbound channel.
//! - Cleanup: `kill_on_drop(true)` on the child kills the backend
//!   when the client is dropped. The reader task ends on EOF; the
//!   writer task ends when `command_tx` is dropped.

use std::path::Path;
use std::process::Stdio;

use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command as ProcCommand};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::rpc::command::Command;
use crate::rpc::envelope::Response;
use crate::rpc::event::Event;

/// Errors surfaced by [`RpcClient`].
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum ClientError {
    #[error("failed to spawn backend: {0}")]
    Spawn(#[from] std::io::Error),
    #[error("backend stdin not piped")]
    NoStdin,
    #[error("backend stdout not piped")]
    NoStdout,
    #[error("command channel closed")]
    ChannelClosed,
}

/// One framed inbound JSONL message from the backend, after wire-level
/// discrimination by the `type` field.
#[derive(Clone, Debug)]
pub enum Inbound {
    Response(Response),
    Event(Event),
}

impl Inbound {
    /// Parse a single JSONL line into either a [`Response`] (when
    /// `type == "response"`) or an [`Event`] (everything else). Lines
    /// that do not parse as either are returned as `Err`.
    pub fn parse_line(line: &str) -> Result<Self, serde_json::Error> {
        let trimmed = line.trim_end_matches(['\r', '\n']);
        let value: serde_json::Value = serde_json::from_str(trimmed)?;
        match value.get("type").and_then(serde_json::Value::as_str) {
            Some("response") => Ok(Self::Response(serde_json::from_value(value)?)),
            _ => Ok(Self::Event(serde_json::from_value(value)?)),
        }
    }
}

/// Subprocess RPC client. Spawn it with [`Self::spawn`], drive it by
/// pushing [`Command`]s with [`Self::send`], consume responses + events
/// via the inbound channel obtained from [`Self::take_inbound`].
#[derive(Debug)]
pub struct RpcClient {
    command_tx: mpsc::Sender<Command>,
    inbound_rx: Option<mpsc::Receiver<Inbound>>,
    _writer: JoinHandle<()>,
    _reader: JoinHandle<()>,
    // Kept alive so kill_on_drop can reap the backend cleanly.
    _child: Child,
}

impl RpcClient {
    /// Spawn the backend binary at `bin` with `args`, wire up tokio
    /// tasks for both directions of JSONL traffic, and return a
    /// connected client.
    ///
    /// `stderr` is inherited so backend panic traces reach the user
    /// console - useful in dev and harmless in production where the
    /// real senpi backend logs to its own files.
    pub fn spawn<P, S>(bin: P, args: &[S]) -> Result<Self, ClientError>
    where
        P: AsRef<Path>,
        S: AsRef<std::ffi::OsStr>,
    {
        let mut child = ProcCommand::new(bin.as_ref())
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()?;

        let mut stdin = child.stdin.take().ok_or(ClientError::NoStdin)?;
        let stdout = child.stdout.take().ok_or(ClientError::NoStdout)?;

        let (command_tx, mut command_rx) = mpsc::channel::<Command>(64);
        let (inbound_tx, inbound_rx) = mpsc::channel::<Inbound>(256);

        // Writer task. One JSONL frame per command. On any write
        // failure (child died), drain the channel without writing so
        // upstream awaits do not hang.
        let writer = tokio::spawn(async move {
            while let Some(cmd) = command_rx.recv().await {
                let Ok(line) = serde_json::to_string(&cmd) else {
                    continue;
                };
                if stdin.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
                if stdin.write_all(b"\n").await.is_err() {
                    break;
                }
                if stdin.flush().await.is_err() {
                    break;
                }
            }
            // Best-effort close; ignored if already dead.
            let _ = stdin.shutdown().await;
        });

        // Reader task. Line-buffered stdout → typed Inbound. Lines that
        // fail to parse are dropped silently (the backend should never
        // emit them; if it does, that is a backend bug, not a client
        // bug). We keep going to remain resilient to garbage from
        // misbehaving extensions.
        let reader = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(inbound) = Inbound::parse_line(&line) else {
                    continue;
                };
                if inbound_tx.send(inbound).await.is_err() {
                    break;
                }
            }
        });

        Ok(Self {
            command_tx,
            inbound_rx: Some(inbound_rx),
            _writer: writer,
            _reader: reader,
            _child: child,
        })
    }

    /// Queue a command for the backend. Returns once the command has
    /// been accepted by the writer task (not when the backend has
    /// processed it - watch the inbound stream for that).
    pub async fn send(&self, cmd: Command) -> Result<(), ClientError> {
        self.command_tx
            .send(cmd)
            .await
            .map_err(|_| ClientError::ChannelClosed)
    }

    /// Hand the inbound channel to the caller. Returns `None` after
    /// the first call - the channel is single-consumer.
    pub const fn take_inbound(&mut self) -> Option<mpsc::Receiver<Inbound>> {
        self.inbound_rx.take()
    }

    /// Cheap clone of the command sender for plumbing into multiple
    /// app loops or tests.
    pub fn command_sender(&self) -> mpsc::Sender<Command> {
        self.command_tx.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_line_discriminates_response() {
        let s = r#"{"type":"response","command":"prompt","success":true,"id":"x"}"#;
        let inbound = Inbound::parse_line(s).expect("must parse");
        let Inbound::Response(resp) = inbound else {
            panic!("expected response, got {inbound:?}");
        };
        assert_eq!(resp.command, "prompt");
        assert!(resp.success);
    }

    #[test]
    fn parse_line_discriminates_event() {
        let s = r#"{"type":"agent_start"}"#;
        let inbound = Inbound::parse_line(s).expect("must parse");
        assert!(matches!(inbound, Inbound::Event(Event::AgentStart)));
    }

    #[test]
    fn parse_line_strips_crlf() {
        let s = "{\"type\":\"agent_start\"}\r\n";
        let inbound = Inbound::parse_line(s).expect("must parse");
        assert!(matches!(inbound, Inbound::Event(Event::AgentStart)));
    }
}
