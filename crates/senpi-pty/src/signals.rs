use crate::{PtyError, PtyResult};
use portable_pty::{ChildKiller, MasterPty};

#[cfg(unix)]
pub(crate) fn process_group(master: &dyn MasterPty) -> Option<i32> {
    master.process_group_leader()
}

#[cfg(not(unix))]
pub(crate) fn process_group(_master: &dyn MasterPty) -> Option<i32> {
    None
}

#[cfg(unix)]
pub(crate) fn send_signal(
    process_group: Option<i32>,
    signal: i32,
    fallback: &mut dyn ChildKiller,
) -> PtyResult<()> {
    if let Some(process_group) = process_group {
        // SAFETY: libc::kill does not dereference Rust pointers. The process group id and signal
        // are plain integers from portable-pty/libc constants, and the negative pid intentionally
        // targets the child process group.
        let result = unsafe { libc::kill(-process_group, signal) };
        if result == 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ESRCH) {
            return Err(PtyError::from(error));
        }
    }
    fallback.kill().map_err(PtyError::from)
}

#[cfg(not(unix))]
pub(crate) fn send_signal(
    _process_group: Option<i32>,
    _signal: i32,
    fallback: &mut dyn ChildKiller,
) -> PtyResult<()> {
    fallback.kill().map_err(PtyError::from)
}

#[cfg(unix)]
pub(crate) fn signal_signal(signal: &str) -> PtyResult<i32> {
    match signal.to_ascii_uppercase().as_str() {
        "HUP" | "SIGHUP" => Ok(libc::SIGHUP),
        "INT" | "SIGINT" => Ok(libc::SIGINT),
        "TERM" | "SIGTERM" => Ok(libc::SIGTERM),
        "KILL" | "SIGKILL" => Ok(libc::SIGKILL),
        other => Err(PtyError::new(format!("unsupported signal: {other}"))),
    }
}

#[cfg(not(unix))]
pub(crate) fn signal_signal(_signal: &str) -> PtyResult<i32> {
    Ok(0)
}

#[cfg(unix)]
pub(crate) fn kill_signal() -> i32 {
    libc::SIGKILL
}

#[cfg(not(unix))]
pub(crate) fn kill_signal() -> i32 {
    0
}
