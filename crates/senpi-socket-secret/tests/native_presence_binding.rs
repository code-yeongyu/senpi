#[cfg(not(windows))]
#[test]
fn presence_binding_is_unavailable_off_windows() {
    let result = senpi_socket_secret::presence_binding::presence_acquire(
        "owner".to_string(),
        "/must/not/be/opened".to_string(),
    );
    assert_eq!(result.status, "unavailable");
    assert_eq!(result.reason.as_deref(), Some("unsupported_platform"));
}

#[cfg(windows)]
mod windows {
    use senpi_socket_secret::presence::{LockAttempt, PresenceBackend, PresenceRegistry, QuiescenceReceipt};
    use senpi_socket_secret::presence_binding::{
        presence_acquire, presence_probe, presence_release_after_quiescence, PresenceProbe, ReleasedReceipt,
    };
    use senpi_socket_secret::presence_windows::WindowsPresenceBackend;

    #[test]
    fn busy_probe_overrides_inadmissibility_and_release_allows_a_new_acquisition() {
        let dir = std::env::temp_dir().join(format!("senpi-binding-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("presence.lock");
        std::fs::write(&path, b"tag").unwrap();
        let path = path.to_str().unwrap().to_string();
        assert_eq!(
            presence_acquire("binding-holder".into(), path.clone()).status,
            "acquired"
        );
        let probe = PresenceProbe {
            presence_id: "binding-prober".into(),
            path: path.clone(),
            tag: b"wrong-tag".to_vec().into(),
            volume_serial: "0".into(),
            file_id: "0".into(),
            created_local: false,
            relocated: true,
            kernel_session: None,
        };
        assert_eq!(presence_probe(probe).status, "occupied");
        assert_eq!(
            presence_release_after_quiescence(ReleasedReceipt {
                presence_id: "binding-holder".into(),
                state: "released".into(),
            })
            .status,
            "released"
        );
        assert_eq!(presence_acquire("binding-after".into(), path).status, "acquired");
        presence_release_after_quiescence(ReleasedReceipt {
            presence_id: "binding-after".into(),
            state: "released".into(),
        });
    }

    #[test]
    fn inadmissible_success_is_released_but_admissible_success_is_retained() {
        let dir = std::env::temp_dir().join(format!("senpi-binding-probe-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("presence.lock");
        std::fs::write(&path, b"tag").unwrap();
        let path = path.to_str().unwrap().to_string();
        let mut backend = WindowsPresenceBackend;
        let handle = backend.open(&path).unwrap();
        let identity = backend.handle_identity(&handle).unwrap();
        drop(handle);
        let request = |created_local, relocated, kernel_session| PresenceProbe {
            presence_id: "binding-proof".into(),
            path: path.clone(),
            tag: b"tag".to_vec().into(),
            volume_serial: identity.volume_serial.to_string(),
            file_id: identity.file_id.to_string(),
            created_local,
            relocated,
            kernel_session,
        };
        for candidate in [
            request(false, false, None),
            request(true, true, None),
            request(true, true, Some("0".into())),
        ] {
            assert_eq!(presence_probe(candidate).status, "unknown");
            let mut independent = PresenceRegistry::new(WindowsPresenceBackend);
            assert_eq!(independent.acquire("independent", &path), LockAttempt::Acquired);
            independent.release_after_quiescence(QuiescenceReceipt {
                presence_id: "independent".into(),
            });
        }
        assert_eq!(presence_probe(request(true, false, None)).status, "acquired");
        let mut independent = PresenceRegistry::new(WindowsPresenceBackend);
        assert_eq!(independent.acquire("independent", &path), LockAttempt::Occupied);
        assert_eq!(
            presence_release_after_quiescence(ReleasedReceipt {
                presence_id: "binding-proof".into(),
                state: "active".into(),
            })
            .reason
            .as_deref(),
            Some("quiescence_required")
        );
        assert_eq!(independent.acquire("independent", &path), LockAttempt::Occupied);
        assert_eq!(
            presence_release_after_quiescence(ReleasedReceipt {
                presence_id: "binding-proof".into(),
                state: "released".into(),
            })
            .status,
            "released"
        );
        assert_eq!(independent.acquire("independent", &path), LockAttempt::Acquired);
    }
}
