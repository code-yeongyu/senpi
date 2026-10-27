//! The N-API process-identity binding (`process_binding.rs`): typed `unavailable` off Windows; on Windows
//! one retained handle per handle ID, the facts read on it, a reread on the same handle after the process
//! exits, and `processClose` as the only release. The `ci.yml` job `socket-secret-native-windows` runs the
//! Windows half; it needs no fixture.

#[cfg(not(windows))]
#[test]
fn process_binding_is_unavailable_off_windows() {
    use senpi_socket_secret::process_binding::{process_close, process_observe, process_open};
    for result in [
        process_open("binding".into(), std::process::id()),
        process_observe("binding".into()),
        process_close("binding".into()),
    ] {
        assert_eq!(result.status, "unavailable");
        assert_eq!(result.reason.as_deref(), Some("unsupported_platform"));
        assert!(result.handle_pid.is_none() && result.creation_time.is_none() && result.user_sid.is_none());
    }
}

#[cfg(windows)]
mod windows {
    use senpi_socket_secret::process_binding::{process_close, process_observe, process_open};
    use std::process::{Command, Stdio};

    #[test]
    fn a_retained_handle_reads_the_facts_once_and_rereads_them_until_closed() {
        let mut child = Command::new("ping")
            .args(["-n", "60", "127.0.0.1"])
            .stdout(Stdio::null())
            .spawn()
            .expect("spawn a sleeper child");
        let pid = child.id();
        let opened = process_open("binding-child".into(), pid);
        assert_eq!(opened.status, "opened", "{opened:?}");
        assert_eq!(opened.handle_pid, Some(pid));
        let created = opened.creation_time.clone().expect("creation FILETIME");
        assert!(created.chars().all(|c| c.is_ascii_digit()) && created != "0");
        assert!(opened.user_sid.as_deref().unwrap_or("").starts_with("S-1-"));
        assert_eq!(opened.exited, Some(false));
        // The same handle ID cannot be opened twice while retained.
        assert_eq!(process_open("binding-child".into(), pid).status, "held");
        let again = process_observe("binding-child".into());
        assert_eq!(
            (again.handle_pid, again.creation_time.as_deref()),
            (Some(pid), Some(created.as_str()))
        );
        child.kill().expect("kill the child");
        child.wait().expect("reap the child");
        // The retained handle keeps the process object: after exit it is signalled, with the same identity.
        let after = process_observe("binding-child".into());
        assert_eq!(after.status, "opened");
        assert_eq!(after.exited, Some(true));
        assert_eq!(after.creation_time.as_deref(), Some(created.as_str()));
        assert_eq!(process_close("binding-child".into()).status, "closed");
        assert_eq!(process_observe("binding-child".into()).status, "not_held");
        assert_eq!(process_close("binding-child".into()).status, "not_held");
    }

    #[test]
    fn an_unused_pid_is_no_such_process_and_retains_nothing() {
        let result = process_open("binding-absent".into(), 0);
        assert_eq!(result.status, "no_such_process", "{result:?}");
        assert_eq!(process_observe("binding-absent".into()).status, "not_held");
    }
}
