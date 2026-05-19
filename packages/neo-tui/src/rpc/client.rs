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
//!                                                  │   (tail-buffered)
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

use std::collections::VecDeque;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;

use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command as ProcCommand};
use tokio::sync::{Mutex, mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::{Duration, timeout};

use crate::rpc::command::Command;
use crate::rpc::envelope::Response;
use crate::rpc::event::Event;

const CHANNEL_CAPACITY: usize = 64;
const STDERR_TAIL_LINES: usize = 32;

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
    Error {
        exit_code: Option<i32>,
        stderr_tail: String,
    },
    Disconnected,
    ParseError {
        line: String,
        source: String,
    },
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
    writer: JoinHandle<()>,
    reader: JoinHandle<()>,
    stderr_reader: JoinHandle<()>,
    child_watcher: JoinHandle<()>,
}

impl Drop for RpcClient {
    fn drop(&mut self) {
        self.writer.abort();
        self.reader.abort();
        self.stderr_reader.abort();
        self.child_watcher.abort();
    }
}

impl RpcClient {
    /// Spawn the backend binary at `bin` with `args`, wire up tokio
    /// tasks for both directions of JSONL traffic, and return a
    /// connected client.
    ///
    /// The tail of `stderr` is buffered so child-exit events can carry
    /// actionable diagnostics without flooding the TUI.
    pub fn spawn<P, S>(bin: P, args: &[S]) -> Result<Self, ClientError>
    where
        P: AsRef<Path>,
        S: AsRef<std::ffi::OsStr>,
    {
        let mut child = ProcCommand::new(bin.as_ref())
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;

        let stdin = child.stdin.take().ok_or(ClientError::NoStdin)?;
        let stdout = child.stdout.take().ok_or(ClientError::NoStdout)?;
        let stderr = child.stderr.take();

        let (command_tx, command_rx) = mpsc::channel::<Command>(CHANNEL_CAPACITY);
        let (inbound_tx, inbound_rx) = mpsc::channel::<Inbound>(CHANNEL_CAPACITY);

        let writer = spawn_writer(stdin, command_rx, inbound_tx.clone());
        let reader = spawn_stdout_reader(stdout, inbound_tx.clone());

        let stderr_tail = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_TAIL_LINES)));
        let (stderr_done_tx, stderr_done_rx) = oneshot::channel::<()>();
        let stderr_reader = spawn_stderr_reader(
            stderr,
            Arc::clone(&stderr_tail),
            stderr_done_tx,
            inbound_tx.clone(),
        );
        let child_watcher = spawn_child_watcher(child, inbound_tx, stderr_tail, stderr_done_rx);

        Ok(Self {
            command_tx,
            inbound_rx: Some(inbound_rx),
            writer,
            reader,
            stderr_reader,
            child_watcher,
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

fn spawn_writer(
    mut stdin: ChildStdin,
    mut command_rx: mpsc::Receiver<Command>,
    inbound_tx: mpsc::Sender<Inbound>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(cmd) = command_rx.recv().await {
            // Serialization is a logic bug, not a transport failure;
            // surface it as a `ParseError`-style inbound and skip the
            // command. Without this the command was previously dropped
            // with no feedback, violating Bug 3.
            let line = match serde_json::to_string(&cmd) {
                Ok(line) => line,
                Err(err) => {
                    tracing::warn!(error = %err, "failed to serialize outbound RPC command");
                    let _ = send_inbound(
                        &inbound_tx,
                        Inbound::Error {
                            exit_code: None,
                            stderr_tail: format!("outbound command serialization failed: {err}"),
                        },
                    )
                    .await;
                    continue;
                }
            };
            if let Err(err) = write_command_line(&mut stdin, &line).await {
                // Pipe is broken (child died or closed stdin). Bug 3:
                // surface to the UI. The child watcher will follow up
                // with its own `Disconnected` / `Error` event once the
                // process is reaped, but the user gets immediate
                // feedback that THIS command did not land.
                tracing::warn!(error = %err, "failed to write outbound RPC command");
                let _ = send_inbound(
                    &inbound_tx,
                    Inbound::Error {
                        exit_code: None,
                        stderr_tail: format!("backend stdin write failed: {err}"),
                    },
                )
                .await;
                break;
            }
        }

        let _ = stdin.shutdown().await;
    })
}

async fn write_command_line(stdin: &mut ChildStdin, line: &str) -> std::io::Result<()> {
    stdin.write_all(line.as_bytes()).await?;
    stdin.write_all(b"\n").await?;
    stdin.flush().await
}

fn spawn_stdout_reader(stdout: ChildStdout, inbound_tx: mpsc::Sender<Inbound>) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    let inbound = match Inbound::parse_line(&line) {
                        Ok(inbound) => inbound,
                        Err(error) => {
                            tracing::warn!(line = %line, source = %error, "failed to parse RPC stdout line");
                            Inbound::ParseError {
                                line,
                                source: error.to_string(),
                            }
                        }
                    };
                    if send_inbound(&inbound_tx, inbound).await.is_err() {
                        break;
                    }
                }
                Ok(None) => break,
                Err(err) => {
                    // Bug 3: transport-level read failure (invalid
                    // UTF-8, pipe error, ...) was previously silently
                    // dropped here. The child watcher will report the
                    // eventual exit, but the user has no idea WHY the
                    // stream went quiet. Surface it.
                    tracing::warn!(error = %err, "RPC stdout reader hit io error");
                    let _ = send_inbound(
                        &inbound_tx,
                        Inbound::Error {
                            exit_code: None,
                            stderr_tail: format!("backend stdout read failed: {err}"),
                        },
                    )
                    .await;
                    break;
                }
            }
        }
    })
}

fn spawn_stderr_reader(
    stderr: Option<ChildStderr>,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
    stderr_done_tx: oneshot::Sender<()>,
    inbound_tx: mpsc::Sender<Inbound>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let Some(stderr) = stderr else {
            let _ = stderr_done_tx.send(());
            return;
        };
        let mut lines = BufReader::new(stderr).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    let mut tail = stderr_tail.lock().await;
                    if tail.len() == STDERR_TAIL_LINES {
                        tail.pop_front();
                    }
                    tail.push_back(line);
                }
                Ok(None) => break,
                Err(err) => {
                    // Bug 3 (Oracle round 6): a stderr read I/O error
                    // used to silently exit the loop via the
                    // `while let Ok(Some(_))` pattern. The child
                    // watcher would still surface the eventual exit,
                    // but until that point the user had no idea why
                    // the diagnostic stream went quiet. Push an
                    // immediate `Inbound::Error` so the user sees
                    // the transport failure right away.
                    tracing::warn!(error = %err, "RPC stderr reader hit io error");
                    let _ = send_inbound(
                        &inbound_tx,
                        Inbound::Error {
                            exit_code: None,
                            stderr_tail: format!("backend stderr read failed: {err}"),
                        },
                    )
                    .await;
                    break;
                }
            }
        }
        let _ = stderr_done_tx.send(());
    })
}

fn spawn_child_watcher(
    mut child: Child,
    inbound_tx: mpsc::Sender<Inbound>,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
    stderr_done_rx: oneshot::Receiver<()>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let status = child.wait().await;
        let _ = timeout(Duration::from_millis(50), stderr_done_rx).await;
        let stderr_tail = stderr_tail
            .lock()
            .await
            .iter()
            .cloned()
            .collect::<Vec<_>>()
            .join("\n");

        match status {
            Ok(status) if status.success() => {
                let _ = send_inbound(&inbound_tx, Inbound::Disconnected).await;
            }
            Ok(status) => {
                let _ = send_inbound(
                    &inbound_tx,
                    Inbound::Error {
                        exit_code: status.code(),
                        stderr_tail,
                    },
                )
                .await;
            }
            Err(_) => {
                let _ = send_inbound(
                    &inbound_tx,
                    Inbound::Error {
                        exit_code: None,
                        stderr_tail,
                    },
                )
                .await;
            }
        }
    })
}

async fn send_inbound(
    tx: &mpsc::Sender<Inbound>,
    inbound: Inbound,
) -> Result<(), mpsc::error::SendError<Inbound>> {
    match tx.try_send(inbound) {
        Ok(()) => Ok(()),
        Err(mpsc::error::TrySendError::Closed(inbound)) => Err(mpsc::error::SendError(inbound)),
        Err(mpsc::error::TrySendError::Full(inbound)) => {
            tracing::warn!("RPC inbound channel full; waiting to send frame");
            tx.send(inbound).await
        }
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
