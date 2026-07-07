use senpi_pty::{PtySession, PtySessionOptions};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[cfg(unix)]
#[test]
fn manual_cat_resize_kill_transcript() {
    let cat_output = Arc::new(Mutex::new(Vec::new()));
    let cat_seen = Arc::clone(&cat_output);
    let mut cat = PtySession::start(PtySessionOptions::new("cat"), move |chunk| {
        cat_seen.lock().unwrap().extend_from_slice(chunk);
    })
    .unwrap();
    cat.write(b"manual-cat-round-trip\n").unwrap();
    wait_until(Duration::from_secs(2), "manual-cat-round-trip output", || {
        text(&cat_output).contains("manual-cat-round-trip")
    });
    eprintln!("cat bytes: {:?}", text(&cat_output));
    cat.kill().unwrap();
    let cat_exit = cat.wait().unwrap();
    eprintln!(
        "cat exit: exit_code={:?} cancelled={} timed_out={}",
        cat_exit.exit_code, cat_exit.cancelled, cat_exit.timed_out
    );

    let resize_output = Arc::new(Mutex::new(Vec::new()));
    let resize_seen = Arc::clone(&resize_output);
    let mut resized = PtySession::start(
        PtySessionOptions::new("sh")
            .arg("-lc")
            .arg("sleep 0.2; stty size"),
        move |chunk| resize_seen.lock().unwrap().extend_from_slice(chunk),
    )
    .unwrap();
    resized.resize(123, 42).unwrap();
    let resize_exit = resized.wait().unwrap();
    let resize_text = text(&resize_output);
    eprintln!("resize bytes: {:?}", resize_text);
    assert_eq!(resize_exit.exit_code, Some(0));
    assert!(resize_text.contains("42 123"));

    let kill_output = Arc::new(Mutex::new(Vec::new()));
    let kill_seen = Arc::clone(&kill_output);
    let mut session = PtySession::start(
        PtySessionOptions::new("sh")
            .arg("-lc")
            .arg("sleep 30 & echo child=$!; wait"),
        move |chunk| kill_seen.lock().unwrap().extend_from_slice(chunk),
    )
    .unwrap();
    let child_pid = wait_for_child_pid(&kill_output);
    eprintln!("spawned child pid: {child_pid}");
    session.kill().unwrap();
    let kill_exit = session.wait().unwrap();
    wait_until(Duration::from_secs(3), "child process exit", || {
        !process_exists(child_pid)
    });
    eprintln!(
        "kill exit: exit_code={:?} cancelled={} timed_out={} child_alive={}",
        kill_exit.exit_code,
        kill_exit.cancelled,
        kill_exit.timed_out,
        process_exists(child_pid)
    );
    assert!(kill_exit.cancelled);
    assert!(!process_exists(child_pid));
}

#[cfg(windows)]
#[test]
fn manual_windows_cmd_lifecycle_transcript() {
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
    // answers it. On a headless CI runner nothing answers, so we stand in for the terminal and reply
    // with a cursor-position report, which is what a real consumer would do. See wezterm/wezterm#6783.
    let mut cursor_queries_answered = 0_usize;
    windows_drive(
        &mut session,
        &output,
        Duration::from_secs(60),
        "initial cmd.exe prompt",
        &mut cursor_queries_answered,
        |text| text.contains('>'),
    );
    session.write(b"echo manual-windows-round-trip\r\n").unwrap();
    windows_drive(
        &mut session,
        &output,
        Duration::from_secs(30),
        "manual-windows-round-trip output",
        &mut cursor_queries_answered,
        |text| text.contains("manual-windows-round-trip"),
    );
    eprintln!("windows bytes: {:?}", text(&output));
    session.kill().unwrap();
    let exit = session.wait().unwrap();
    eprintln!(
        "windows exit: exit_code={:?} cancelled={} timed_out={}",
        exit.exit_code, exit.cancelled, exit.timed_out
    );

    assert!(exit.cancelled);
    assert!(text(&output).contains("manual-windows-round-trip"));
}

fn text(output: &Arc<Mutex<Vec<u8>>>) -> String {
    String::from_utf8_lossy(&output.lock().unwrap()).into_owned()
}

#[cfg(unix)]
fn wait_for_child_pid(output: &Arc<Mutex<Vec<u8>>>) -> u32 {
    let mut child_pid = None;
    wait_until(Duration::from_secs(2), "child pid output", || {
        child_pid = text(output)
            .split_whitespace()
            .find_map(|part| part.strip_prefix("child=")?.parse().ok());
        child_pid.is_some()
    });
    child_pid.expect("child pid output")
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
        let transcript = text(output);
        if ready(&transcript) {
            return;
        }
        // Answer each query exactly once, including any ConPTY repeats after the startup one.
        let queries_seen = transcript.matches(DSR_CURSOR_QUERY).count();
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
    // from the spawned manual QA child and no Rust memory is shared with libc.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}
