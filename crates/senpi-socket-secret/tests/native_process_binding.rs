//! The N-API process-identity binding (`process_binding.rs`): typed `unavailable` off Windows; on Windows
//! one retained handle per handle ID, the facts read on it, a reread on the same handle after the process
//! exits, `processClose` as the only release, and the exit wait on the process object (signalled with the
//! exit code, cancelled by its wait ID or by the handle's close). The `ci.yml` job
//! `socket-secret-native-windows` runs the Windows half; it needs no fixture.

#[cfg(not(windows))]
#[test]
fn process_binding_is_unavailable_off_windows() {
    use senpi_socket_secret::process_binding::{
        begin_exit_wait, process_close, process_observe, process_open,
    };
    for result in [
        process_open("binding".into(), std::process::id()),
        process_observe("binding".into()),
        process_close("binding".into()),
        *begin_exit_wait("binding".into(), "wait".into()).expect_err("no wait off Windows"),
    ] {
        assert_eq!(result.status, "unavailable");
        assert_eq!(result.reason.as_deref(), Some("unsupported_platform"));
        assert!(result.handle_pid.is_none() && result.creation_time.is_none() && result.user_sid.is_none());
        assert!(result.exit_code.is_none());
    }
}

#[cfg(windows)]
mod windows {
    use senpi_socket_secret::process_binding::{
        begin_exit_wait, process_cancel_wait_exit, process_close, process_observe, process_open,
    };
    use std::process::{Command, Stdio};
    use std::time::Duration;

    fn sleeper() -> std::process::Child {
        Command::new("ping")
            .args(["-n", "60", "127.0.0.1"])
            .stdout(Stdio::null())
            .spawn()
            .expect("spawn a sleeper child")
    }

    #[test]
    fn an_exit_wait_on_the_retained_handle_answers_the_object_signal_with_the_exit_code() {
        let mut child = sleeper();
        assert_eq!(process_open("wait-exit".into(), child.id()).status, "opened");
        let waiter = begin_exit_wait("wait-exit".into(), "w1".into()).expect("registered");
        // The wait ID is taken until the wait ends; the handle is still observable beside the wait.
        assert_eq!(
            begin_exit_wait("wait-exit".into(), "w1".into())
                .expect_err("pending")
                .reason
                .as_deref(),
            Some("wait_pending")
        );
        assert_eq!(process_observe("wait-exit".into()).exited, Some(false));
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let waiting = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            waiter.wait()
        });
        started_rx.recv_timeout(Duration::from_secs(30)).unwrap();
        child.kill().expect("kill the child");
        child.wait().expect("reap the child");
        let result = waiting.join().unwrap();
        assert_eq!(result.status, "exited", "{result:?}");
        // `Child::kill` is `TerminateProcess(handle, 1)`.
        assert_eq!(result.exit_code, Some(1));
        assert_eq!(process_observe("wait-exit".into()).exited, Some(true));
        // The wait ID is free again, and a wait on a signalled object answers at once.
        let again = begin_exit_wait("wait-exit".into(), "w1".into()).expect("registered again");
        assert_eq!(again.wait().status, "exited");
        assert_eq!(process_close("wait-exit".into()).status, "closed");
    }

    #[test]
    fn an_exit_wait_ends_cancelled_by_its_wait_id_or_by_the_close_of_its_handle() {
        let mut child = sleeper();
        assert_eq!(process_open("wait-cancel".into(), child.id()).status, "opened");
        let cancelled = begin_exit_wait("wait-cancel".into(), "c1".into()).expect("registered");
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let waiting = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            cancelled.wait()
        });
        started_rx.recv_timeout(Duration::from_secs(30)).unwrap();
        process_cancel_wait_exit("c1".into());
        assert_eq!(waiting.join().unwrap().status, "cancelled");
        // The process is untouched by a cancelled wait.
        assert_eq!(process_observe("wait-cancel".into()).exited, Some(false));

        let closed = begin_exit_wait("wait-cancel".into(), "c2".into()).expect("registered");
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let waiting = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            closed.wait()
        });
        started_rx.recv_timeout(Duration::from_secs(30)).unwrap();
        assert_eq!(process_close("wait-cancel".into()).status, "closed");
        assert_eq!(waiting.join().unwrap().status, "cancelled");
        assert_eq!(
            begin_exit_wait("wait-cancel".into(), "c3".into())
                .expect_err("nothing retained")
                .status,
            "not_held"
        );
        child.kill().expect("kill the child");
        child.wait().expect("reap the child");
    }

    #[test]
    fn a_retained_handle_reads_the_facts_once_and_rereads_them_until_closed() {
        let mut child = sleeper();
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
