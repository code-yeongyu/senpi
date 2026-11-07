use crate::session_input::{PtyInput, MAX_PENDING_INPUT_BYTES};
use std::io::Write;
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

struct GatedWriter {
    release: Receiver<()>,
}

impl Write for GatedWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let _ = self.release.recv();
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[test]
fn send_after_close_reports_a_closed_session() {
    let input = PtyInput::new(Box::new(Vec::new()));
    input.close();

    let error = input.send(b"late\n").unwrap_err();

    assert_eq!(error.to_string(), "pty session is closed");
}

#[test]
fn send_refuses_input_beyond_the_backlog_cap_while_the_writer_is_stalled() {
    let (release_tx, release_rx) = mpsc::channel();
    let input = PtyInput::new(Box::new(GatedWriter { release: release_rx }));

    input.send(&vec![b'x'; MAX_PENDING_INPUT_BYTES]).unwrap();
    let refused = input.send(b"y").unwrap_err();

    assert!(
        refused.to_string().starts_with("pty input backlog is full"),
        "unexpected error: {refused}"
    );
    drop(release_tx);
    input.close();
}

#[test]
fn closed_input_never_waits_for_a_stalled_writer() {
    let (release_tx, release_rx) = mpsc::channel();
    let input = PtyInput::new(Box::new(GatedWriter { release: release_rx }));
    input.send(b"queued").unwrap();
    let (closed_tx, closed_rx) = mpsc::channel();

    std::thread::spawn(move || {
        input.close();
        let _ = closed_tx.send(());
    });

    assert!(closed_rx.recv_timeout(Duration::from_secs(5)).is_ok());
    drop(release_tx);
}
