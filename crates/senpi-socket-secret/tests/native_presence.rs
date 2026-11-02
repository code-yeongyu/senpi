//! Native receipts for #4199 presence guards (design test 18, Windows `LockFileEx`; test 26 blocking wait).
//! Windows only; `ci.yml` `socket-secret-native-windows` runs them and prints `RECEIPT_PRESENCE` lines.

#[cfg(windows)]
mod windows {
    use senpi_socket_secret::presence::{
        CancelToken, LockAttempt, PresenceRegistry, QuiescenceReceipt, WaitOutcome,
    };
    use senpi_socket_secret::presence_windows::WindowsPresenceBackend;
    use std::path::PathBuf;

    fn presence_file(label: &str) -> String {
        let dir = std::env::temp_dir().join(format!("senpi-presence-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        let path: PathBuf = dir.join("p-1.lock");
        std::fs::write(&path, b"tag").expect("presence object");
        path.to_str().expect("utf-8 path").to_string()
    }

    #[test]
    fn a_second_handle_is_occupied_until_the_holder_releases() {
        let path = presence_file("contend");
        let mut holder = PresenceRegistry::new(WindowsPresenceBackend);
        let mut prober = PresenceRegistry::new(WindowsPresenceBackend);
        let first = holder.acquire("p-1", &path);
        let contended = prober.acquire("p-1", &path);
        println!("RECEIPT_PRESENCE contend holder={first:?} prober={contended:?}");
        assert_eq!(first, LockAttempt::Acquired);
        assert_eq!(contended, LockAttempt::Occupied);
        assert!(holder.release_after_quiescence(QuiescenceReceipt {
            presence_id: "p-1".to_string()
        }));
        let after = prober.acquire("p-1", &path);
        println!("RECEIPT_PRESENCE after_release prober={after:?}");
        assert_eq!(after, LockAttempt::Acquired);
        assert_eq!(prober.pre_action_check("p-1", true), Ok(()));
    }

    #[test]
    fn a_missing_presence_object_is_unknown() {
        let path = presence_file("missing");
        std::fs::remove_file(&path).expect("remove");
        let attempt = PresenceRegistry::new(WindowsPresenceBackend).acquire("p-1", &path);
        println!("RECEIPT_PRESENCE missing attempt={attempt:?}");
        assert_eq!(attempt, LockAttempt::Unknown(2));
        assert!(
            !std::path::Path::new(&path).exists(),
            "a missing object is never recreated"
        );
    }

    #[test]
    fn the_blocking_wait_acquires_when_the_holder_releases() {
        let path = presence_file("wait");
        let mut holder = PresenceRegistry::new(WindowsPresenceBackend);
        assert_eq!(holder.acquire("p-1", &path), LockAttempt::Acquired);
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let waiter = {
            let path = path.clone();
            std::thread::spawn(move || {
                let mut registry = PresenceRegistry::new(WindowsPresenceBackend);
                started_tx.send(()).expect("signal");
                let outcome = registry.wait_and_acquire("p-1", &path, &CancelToken::default());
                (outcome, registry.holds("p-1"))
            })
        };
        started_rx.recv().expect("waiter started");
        assert!(holder.release_after_quiescence(QuiescenceReceipt {
            presence_id: "p-1".to_string()
        }));
        let (outcome, held) = waiter.join().expect("waiter");
        println!("RECEIPT_PRESENCE wait_release outcome={outcome:?} held={held}");
        assert_eq!(outcome, WaitOutcome::Acquired);
        assert!(held);
    }

    #[test]
    fn a_cancelled_blocking_wait_returns_cancelled_and_holds_nothing() {
        let path = presence_file("cancel");
        let mut holder = PresenceRegistry::new(WindowsPresenceBackend);
        assert_eq!(holder.acquire("p-1", &path), LockAttempt::Acquired);
        let cancel = CancelToken::default();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let waiter = {
            let (path, cancel) = (path.clone(), cancel.clone());
            std::thread::spawn(move || {
                let mut registry = PresenceRegistry::new(WindowsPresenceBackend);
                started_tx.send(()).expect("signal");
                let outcome = registry.wait_and_acquire("p-1", &path, &cancel);
                (outcome, registry.holds("p-1"))
            })
        };
        started_rx.recv().expect("waiter started");
        // Cancel only once the lock is pending, so this receipt proves the CancelIoEx path and not the
        // pre-cancel check. Bounded: the waiter issues its lock right after signalling.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while !cancel.has_pending_wait() {
            assert!(
                std::time::Instant::now() < deadline,
                "the wait never became pending"
            );
            std::thread::yield_now();
        }
        cancel.cancel();
        let (outcome, held) = waiter.join().expect("waiter");
        println!("RECEIPT_PRESENCE wait_cancel outcome={outcome:?} held={held}");
        assert_eq!(outcome, WaitOutcome::Cancelled);
        assert!(!held);
        assert!(holder.holds("p-1"), "the holder keeps its guard");
    }
}
