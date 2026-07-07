use super::{PtySession, PtySessionOptions};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[cfg(unix)]
#[test]
fn pty_session_streams_raw_bytes_and_exit_code() {
    let output = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&output);
    let mut session = PtySession::start(
        PtySessionOptions::new("sh")
            .arg("-lc")
            .arg("printf 'hello-stream\\n'"),
        move |chunk| seen.lock().unwrap().extend_from_slice(chunk),
    )
    .unwrap();

    let exit = session.wait().unwrap();
    assert_eq!(exit.exit_code, Some(0));
    assert!(!exit.cancelled);
    assert!(!exit.timed_out);
    assert_eq!(
        String::from_utf8_lossy(&output.lock().unwrap()).as_ref(),
        "hello-stream\r\n"
    );
}

#[test]
fn pty_session_reports_nonexistent_command_error() {
    let result = PtySession::start(
        PtySessionOptions::new("__senpi_missing_command_for_pty_test__"),
        |_| {},
    );

    assert!(result.is_err());
}

#[cfg(unix)]
#[test]
fn pty_session_times_out_hung_command() {
    let mut session = PtySession::start(
        PtySessionOptions::new("sh")
            .arg("-lc")
            .arg("sleep 30")
            .timeout(Duration::from_millis(100)),
        |_| {},
    )
    .unwrap();

    let exit = session.wait().unwrap();
    assert!(exit.cancelled);
    assert!(exit.timed_out);
}

#[cfg(unix)]
#[test]
fn pty_session_writes_stdin_round_trip() {
    let output = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&output);
    let mut session = PtySession::start(PtySessionOptions::new("cat"), move |chunk| {
        seen.lock().unwrap().extend_from_slice(chunk);
    })
    .unwrap();

    session.write(b"cat-round-trip\n").unwrap();
    wait_until(Duration::from_secs(2), "cat-round-trip output", || {
        String::from_utf8_lossy(&output.lock().unwrap()).contains("cat-round-trip")
    });
    session.kill().unwrap();
    let _ = session.wait().unwrap();
    assert!(String::from_utf8_lossy(&output.lock().unwrap()).contains("cat-round-trip"));
}

#[cfg(unix)]
#[test]
fn pty_session_resizes_reported_terminal_size() {
    let output = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&output);
    let mut session = PtySession::start(
        PtySessionOptions::new("sh")
            .arg("-lc")
            .arg("sleep 0.2; stty size"),
        move |chunk| seen.lock().unwrap().extend_from_slice(chunk),
    )
    .unwrap();

    session.resize(101, 33).unwrap();
    let exit = session.wait().unwrap();
    assert_eq!(exit.exit_code, Some(0));
    assert!(String::from_utf8_lossy(&output.lock().unwrap()).contains("33 101"));
}

#[cfg(unix)]
#[test]
fn pty_session_sends_signal_to_process_group() {
    let output = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&output);
    let mut session = PtySession::start(
        PtySessionOptions::new("sh")
            .arg("-lc")
            .arg("trap 'echo got-term; exit 7' TERM; echo ready; sleep 30"),
        move |chunk| seen.lock().unwrap().extend_from_slice(chunk),
    )
    .unwrap();

    wait_until(Duration::from_secs(2), "ready output", || {
        String::from_utf8_lossy(&output.lock().unwrap()).contains("ready")
    });
    session.signal("term").unwrap();
    let exit = session.wait().unwrap();
    assert_eq!(exit.exit_code, Some(7));
    assert!(String::from_utf8_lossy(&output.lock().unwrap()).contains("got-term"));
}

#[cfg(unix)]
#[test]
fn pty_session_kill_removes_child_process_tree() {
    let output = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&output);
    let mut session = PtySession::start(
        PtySessionOptions::new("sh")
            .arg("-lc")
            .arg("sleep 30 & echo child=$!; wait"),
        move |chunk| seen.lock().unwrap().extend_from_slice(chunk),
    )
    .unwrap();

    let child_pid = wait_for_child_pid(&output);
    session.kill().unwrap();
    let exit = session.wait().unwrap();
    assert!(exit.cancelled);
    wait_until(Duration::from_secs(3), "child process exit", || {
        !process_exists(child_pid)
    });
    assert!(!process_exists(child_pid), "child pid {child_pid} still exists");
}

#[cfg(unix)]
#[test]
fn pty_session_write_after_exit_returns_benign_error() {
    let mut session = PtySession::start(PtySessionOptions::new("true"), |_| {}).unwrap();
    let exit = session.wait().unwrap();
    assert_eq!(exit.exit_code, Some(0));

    let error = session.write(b"late").unwrap_err();
    assert!(error.to_string().contains("closed"));
}

#[cfg(unix)]
fn wait_for_child_pid(output: &Arc<Mutex<Vec<u8>>>) -> u32 {
    let mut child_pid = None;
    wait_until(Duration::from_secs(2), "child pid output", || {
        let text = String::from_utf8_lossy(&output.lock().unwrap()).into_owned();
        child_pid = text
            .split_whitespace()
            .find_map(|part| part.strip_prefix("child=")?.parse().ok());
        child_pid.is_some()
    });
    child_pid.expect("child pid output")
}

#[cfg(windows)]
#[test]
fn windows_pty_session_writes_resizes_kills_and_reports_exit() {
    let output = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&output);
    // The timeout is only a hang guard: ConPTY startup on shared CI runners can take tens of
    // seconds, so it must stay far above the wait_until deadlines below.
    let mut session = PtySession::start(
        PtySessionOptions::new("cmd.exe")
            .arg("/d")
            .arg("/q")
            .timeout(Duration::from_secs(120)),
        move |chunk| seen.lock().unwrap().extend_from_slice(chunk),
    )
    .unwrap();

    session.resize(100, 30).unwrap();
    // portable-pty 0.9.0's ConPTY sets PSEUDOCONSOLE_INHERIT_CURSOR, so on startup ConPTY emits a
    // DSR cursor-position query (ESC[6n) and withholds cmd.exe's rendered prompt until a terminal
    // answers it. On a headless CI runner nothing answers, so the reader would see no prompt for the
    // whole timeout. We stand in for the terminal and reply with a cursor-position report, which is
    // what a real consumer (e.g. an xterm-style frontend) would do. See wezterm/wezterm#6783.
    let mut cursor_queries_answered = 0_usize;
    windows_drive(
        &mut session,
        &output,
        Duration::from_secs(60),
        "initial cmd.exe prompt",
        &mut cursor_queries_answered,
        |text| text.contains('>'),
    );
    session.write(b"echo windows-pty-round-trip\r\n").unwrap();
    windows_drive(
        &mut session,
        &output,
        Duration::from_secs(30),
        "windows-pty-round-trip output",
        &mut cursor_queries_answered,
        |text| text.contains("windows-pty-round-trip"),
    );
    session.kill().unwrap();
    let exit = session.wait().unwrap();

    assert!(exit.cancelled);
    assert!(String::from_utf8_lossy(&output.lock().unwrap()).contains("windows-pty-round-trip"));
}

#[cfg(unix)]
fn wait_until(timeout: Duration, what: &str, mut predicate: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if predicate() {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(predicate(), "timed out after {timeout:?} waiting for {what}");
}

// ESC[6n is ConPTY's DSR cursor-position query; ESC[1;1R is a terminal's cursor-position report.
#[cfg(windows)]
const DSR_CURSOR_QUERY: &str = "\u{1b}[6n";
#[cfg(windows)]
const CPR_RESPONSE: &[u8] = b"\x1b[1;1R";

/// Drive a Windows ConPTY session until `ready` holds, answering every ConPTY cursor-position query
/// so its withheld output is released. On timeout it panics with forensic evidence (bytes received,
/// lossy transcript, hex head, queries answered) so a CI failure is diagnostic rather than opaque.
#[cfg(windows)]
fn windows_drive(
    session: &mut PtySession,
    output: &Arc<Mutex<Vec<u8>>>,
    timeout: Duration,
    what: &str,
    cursor_queries_answered: &mut usize,
    ready: impl Fn(&str) -> bool,
) {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let text = String::from_utf8_lossy(&output.lock().unwrap()).into_owned();
        if ready(&text) {
            return;
        }
        // Answer each query exactly once, including any ConPTY repeats after the startup one.
        let queries_seen = text.matches(DSR_CURSOR_QUERY).count();
        while *cursor_queries_answered < queries_seen {
            let _ = session.write(CPR_RESPONSE);
            *cursor_queries_answered += 1;
        }
        if std::time::Instant::now() >= deadline {
            let raw = output.lock().unwrap();
            panic!(
                "timed out after {timeout:?} waiting for {what}: received {} bytes; \
                 answered {cursor_queries_answered} cursor queries; lossy={:?}; hex_head=[{}]",
                raw.len(),
                String::from_utf8_lossy(&raw),
                windows_hex_head(&raw, 256),
            );
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(windows)]
fn windows_hex_head(bytes: &[u8], max: usize) -> String {
    bytes
        .iter()
        .take(max)
        .map(|byte| format!("{byte:02x}"))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(unix)]
fn process_exists(pid: u32) -> bool {
    // SAFETY: libc::kill with signal 0 performs existence/permission checking only. The pid comes
    // from test child output and no Rust memory is shared with libc.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}
