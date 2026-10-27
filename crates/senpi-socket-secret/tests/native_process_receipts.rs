//! Native receipts for the Windows actual-target identity adapter of the #4199 design ("Windows
//! actual-target identity" row). They need a real Windows kernel; the `ci.yml` job
//! `socket-secret-native-windows` runs them in its fixture-free step, and its `RECEIPT_` lines are
//! the receipt. Every case is ignored off Windows, with the reason in its attribute.

#[cfg(windows)]
mod windows_receipts {
    use senpi_socket_secret::{
        observe, observe_pid, ExitWait, GoneReason, Liveness, Observation, ProcessRecord, RetainedProcess,
    };
    use std::process::{Child, Command, Stdio};

    fn sleeper() -> Child {
        Command::new("ping")
            .args(["-n", "60", "127.0.0.1"])
            .stdout(Stdio::null())
            .spawn()
            .expect("spawn a sleeper child")
    }

    fn record_of(process: &RetainedProcess, pid: u32) -> ProcessRecord {
        let facts = process.facts();
        println!("RECEIPT_IDENTITY facts pid={pid} {facts:?}");
        ProcessRecord {
            pid: facts.handle_pid.expect("GetProcessId"),
            creation_time: facts.creation_time.expect("creation FILETIME"),
            user_sid: facts.user_sid.expect("TokenUser SID"),
        }
    }

    pub fn a_live_child_matches_and_its_exit_is_observed_on_the_retained_handle() {
        let mut child = sleeper();
        let pid = child.id();
        let retained = RetainedProcess::open(pid).expect("open the child");
        let record = record_of(&retained, pid);
        assert_eq!(record.pid, pid);
        assert!(record.user_sid.starts_with("S-1-"), "{}", record.user_sid);
        let live = observe(&record, &observe_pid(pid));
        println!("RECEIPT_IDENTITY live_child={live:?}");
        assert_eq!(live, Liveness::Live);
        assert_eq!(retained.wait_for_exit(0), ExitWait::TimedOut);
        child.kill().expect("terminate the child");
        let waited = retained.wait_for_exit(10_000);
        println!("RECEIPT_IDENTITY exit_wait={waited:?}");
        assert_eq!(waited, ExitWait::Exited);
        let after = observe(&record, &Observation::Opened(retained.facts()));
        println!("RECEIPT_IDENTITY after_exit_retained={after:?}");
        assert_eq!(after, Liveness::Gone(GoneReason::Exited));
        child.wait().expect("reap the child");
    }

    pub fn a_different_creation_time_at_the_same_pid_is_gone_and_a_wrapper_is_not_the_target() {
        let mut child = sleeper();
        let pid = child.id();
        let retained = RetainedProcess::open(pid).expect("open the child");
        let mut stale = record_of(&retained, pid);
        stale.creation_time -= 1;
        let reused = observe(&stale, &observe_pid(pid));
        println!("RECEIPT_IDENTITY one_tick_older_record={reused:?}");
        assert_eq!(reused, Liveness::Gone(GoneReason::CreationTimeDiffers));
        let own = std::process::id();
        let wrapper = record_of(&RetainedProcess::open(own).expect("open self"), own);
        let wrong_target = ProcessRecord { pid, ..wrapper };
        let observed = observe(&wrong_target, &observe_pid(pid));
        println!("RECEIPT_IDENTITY wrapper_record_against_child={observed:?}");
        assert_ne!(observed, Liveness::Live);
        child.kill().expect("terminate the child");
        child.wait().expect("reap the child");
    }

    pub fn an_unused_pid_is_absent() {
        let observation = observe_pid(0xFFFF_FFFC);
        println!("RECEIPT_IDENTITY unused_pid={observation:?}");
        assert_eq!(observation, Observation::NoSuchProcess);
    }
}

#[test]
#[cfg_attr(
    not(windows),
    ignore = "windows-only native identity receipt: live child and process-object exit"
)]
fn identity_receipt_live_child_and_exit() {
    #[cfg(windows)]
    windows_receipts::a_live_child_matches_and_its_exit_is_observed_on_the_retained_handle();
}

#[test]
#[cfg_attr(
    not(windows),
    ignore = "windows-only native identity receipt: creation-time reuse and wrapper PID"
)]
fn identity_receipt_reuse_and_wrapper() {
    #[cfg(windows)]
    windows_receipts::a_different_creation_time_at_the_same_pid_is_gone_and_a_wrapper_is_not_the_target();
}

#[test]
#[cfg_attr(not(windows), ignore = "windows-only native identity receipt: unused PID")]
fn identity_receipt_unused_pid() {
    #[cfg(windows)]
    windows_receipts::an_unused_pid_is_absent();
}
