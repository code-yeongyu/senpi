use super::{PtySession, PtySessionOptions};
#[cfg(windows)]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
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
fn background_wait_does_not_complete_before_reader_drain() {
    let output = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&output);
    let reader_gate = Arc::new((Mutex::new(false), Condvar::new()));
    let callback_gate = Arc::clone(&reader_gate);
    let (reader_started_tx, reader_started_rx) = mpsc::channel();
    let mut session = PtySession::start(fast_exit_command(), move |chunk| {
        reader_started_tx.send(()).unwrap();
        let (lock, ready) = &*callback_gate;
        let mut released = lock.lock().unwrap();
        while !*released {
            released = ready.wait(released).unwrap();
        }
        seen.lock().unwrap().extend_from_slice(chunk);
    })
    .unwrap();

    reader_started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let waiter = session.wait_in_background().unwrap();
    let (wait_done_tx, wait_done_rx) = mpsc::channel();
    std::thread::spawn(move || wait_done_tx.send(waiter.join().unwrap()).unwrap());

    let early_result = wait_done_rx.recv_timeout(Duration::from_millis(100));
    let completed_before_drain = early_result.is_ok();
    let (lock, ready) = &*reader_gate;
    *lock.lock().unwrap() = true;
    ready.notify_one();

    let exit = match early_result {
        Ok(result) => result.unwrap(),
        Err(mpsc::RecvTimeoutError::Timeout) => wait_done_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap(),
        Err(mpsc::RecvTimeoutError::Disconnected) => panic!("background wait channel disconnected"),
    };

    assert!(
        !completed_before_drain,
        "background wait completed before the reader callback drained final output"
    );
    assert_eq!(exit.exit_code, Some(0));
    assert!(String::from_utf8_lossy(&output.lock().unwrap()).contains("fast-exit-final-output"));
}

#[cfg(unix)]
fn fast_exit_command() -> PtySessionOptions {
    PtySessionOptions::new("sh")
        .arg("-lc")
        .arg("printf fast-exit-final-output")
}

#[cfg(windows)]
fn fast_exit_command() -> PtySessionOptions {
    PtySessionOptions::new("cmd.exe")
        .arg("/d")
        .arg("/q")
        .arg("/c")
        .arg("echo fast-exit-final-output")
        .timeout(Duration::from_secs(120))
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

    // Fail fast with forensics if anything below blocks (e.g. a reader-thread join that never
    // returns): abort well before the 45-minute CI job timeout so the run stays diagnostic.
    let watchdog_done = Arc::new(AtomicBool::new(false));
    spawn_windows_test_watchdog(
        Duration::from_secs(240),
        Arc::clone(&watchdog_done),
        Arc::clone(&output),
    );

    session.resize(100, 30).unwrap();
    // The session answers ConPTY's startup cursor-position query itself (see session.rs), so the
    // withheld prompt is released without the test standing in for a terminal. Just wait for it.
    windows_wait(
        &output,
        Duration::from_secs(60),
        "initial cmd.exe prompt",
        |text| text.contains('>'),
    );
    session.write(b"echo windows-pty-round-trip\r\n").unwrap();
    windows_wait(
        &output,
        Duration::from_secs(30),
        "windows-pty-round-trip output",
        |text| text.contains("windows-pty-round-trip"),
    );
    session.kill().unwrap();
    let exit = session.wait().unwrap();
    watchdog_done.store(true, Ordering::SeqCst);

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

/// Wait until `ready` holds, or panic with forensic evidence (bytes received, lossy transcript, hex
/// head) on timeout so a Windows CI failure is diagnostic rather than opaque. ConPTY's startup
/// cursor-position query is answered by the session itself, so this only observes output.
#[cfg(windows)]
fn windows_wait(output: &Arc<Mutex<Vec<u8>>>, timeout: Duration, what: &str, ready: impl Fn(&str) -> bool) {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let text = String::from_utf8_lossy(&output.lock().unwrap()).into_owned();
        if ready(&text) {
            return;
        }
        if std::time::Instant::now() >= deadline {
            let raw = output.lock().unwrap();
            panic!(
                "timed out after {timeout:?} waiting for {what}: received {} bytes; \
                 lossy={:?}; hex_head=[{}]",
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

/// Spawn a detached watchdog that aborts the test process with forensic evidence if `done` is not
/// set within `limit`. This bounds any unexpected block (a hung reader-thread join, a stuck kill)
/// so a Windows CI failure surfaces a diagnostic dump instead of silently consuming the 45-minute
/// job timeout.
#[cfg(windows)]
fn spawn_windows_test_watchdog(limit: Duration, done: Arc<AtomicBool>, output: Arc<Mutex<Vec<u8>>>) {
    std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + limit;
        while std::time::Instant::now() < deadline {
            if done.load(Ordering::SeqCst) {
                return;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        if done.load(Ordering::SeqCst) {
            return;
        }
        let raw = output.lock().unwrap();
        eprintln!(
            "WATCHDOG: Windows PTY test exceeded {limit:?} without completing; \
             received {} bytes; lossy={:?}; hex_head=[{}]",
            raw.len(),
            String::from_utf8_lossy(&raw),
            windows_hex_head(&raw, 256),
        );
        std::process::abort();
    });
}

#[cfg(unix)]
fn process_exists(pid: u32) -> bool {
    // SAFETY: libc::kill with signal 0 performs existence/permission checking only. The pid comes
    // from test child output and no Rust memory is shared with libc.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}
