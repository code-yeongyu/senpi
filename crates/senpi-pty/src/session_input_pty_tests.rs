#![cfg(unix)]

use super::{PtySession, PtySessionOptions};
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const PAYLOAD_LINES: usize = 16_384;
const PAYLOAD_BYTES: usize = PAYLOAD_LINES * 64;
const GATE_SCRIPT: &str = "stty -echo; printf GATED; read -r _ < \"$1\"; head -c \"$2\" | wc -c";

struct Fifo(PathBuf);

impl Fifo {
    fn create() -> Self {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("senpi-pty-gate-{}-{nanos}", std::process::id()));
        assert!(Command::new("mkfifo").arg(&path).status().unwrap().success());
        Self(path)
    }

    fn release(&self) {
        std::fs::OpenOptions::new()
            .write(true)
            .open(&self.0)
            .unwrap()
            .write_all(b"go\n")
            .unwrap();
    }
}

impl Drop for Fifo {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[test]
fn write_returns_while_the_child_stops_reading_and_delivers_everything_later() {
    let fifo = Fifo::create();
    let output = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&output);
    let gated = Arc::new(AtomicBool::new(false));
    let (gated_tx, gated_rx) = mpsc::channel();
    let session = PtySession::start(
        PtySessionOptions::new("sh")
            .arg("-c")
            .arg(GATE_SCRIPT)
            .arg("sh")
            .arg(fifo.0.to_string_lossy().into_owned())
            .arg(PAYLOAD_BYTES.to_string()),
        move |chunk| {
            let mut buffer = seen.lock().unwrap();
            buffer.extend_from_slice(chunk);
            if !gated.load(Ordering::SeqCst) && String::from_utf8_lossy(&buffer).contains("GATED") {
                gated.store(true, Ordering::SeqCst);
                let _ = gated_tx.send(());
            }
        },
    )
    .unwrap();
    gated_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    let pid = session.pid().unwrap();

    let (returned_tx, returned_rx) = mpsc::channel();
    let writer = std::thread::spawn(move || {
        let mut session = session;
        let line = format!("{}\n", "x".repeat(63));
        let result = session.write(line.repeat(PAYLOAD_LINES).as_bytes());
        let _ = returned_tx.send(());
        (session, result)
    });
    let returned_while_gated = returned_rx.recv_timeout(Duration::from_secs(5)).is_ok();
    let (finished_tx, finished_rx) = mpsc::channel();
    std::thread::spawn(move || {
        fifo.release();
        let (mut session, result) = writer.join().unwrap();
        let _ = finished_tx.send((result, session.wait()));
    });
    let Ok((result, exit)) = finished_rx.recv_timeout(Duration::from_secs(30)) else {
        let _ = Command::new("kill").arg("-9").arg(pid.to_string()).status();
        panic!("the gated child did not receive all queued input and exit within 30 s");
    };
    let exit = exit.unwrap();

    assert!(
        returned_while_gated,
        "PtySession::write blocked its caller while the child was not reading input"
    );
    result.unwrap();
    assert_eq!(exit.exit_code, Some(0));
    let text = String::from_utf8_lossy(&output.lock().unwrap()).into_owned();
    let count = text.split_whitespace().last().unwrap_or_default().to_string();
    assert_eq!(count, PAYLOAD_BYTES.to_string(), "child output: {text:?}");
}
