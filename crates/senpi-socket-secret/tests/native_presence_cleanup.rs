//! Presence cleanup natives (#4199 design 4.2a Revision 7 "Presence cleanup", test 24): the exclusive hold that fails
//! with a sharing violation while any other handle is open, delete-on-close through the held handle, and the root
//! listing. Real Windows only; elsewhere every call is typed `unavailable`.

#[cfg(not(windows))]
#[test]
fn cleanup_natives_are_unavailable_off_windows() {
    use senpi_socket_secret::presence_cleanup::{
        presence_object_hold, presence_object_release, presence_root_list, PresenceHoldRequest,
    };
    let listing = presence_root_list("/must/not/be/read".to_string());
    assert_eq!(
        (listing.status.as_str(), listing.reason.as_deref()),
        ("unavailable", Some("unsupported_platform"))
    );
    let hold = presence_object_hold(PresenceHoldRequest {
        hold_id: "h".to_string(),
        path: "/must/not/be/opened".to_string(),
    });
    assert_eq!(hold.status, "unavailable");
    assert_eq!(
        presence_object_release("h".to_string(), true).status,
        "unavailable"
    );
}

#[cfg(windows)]
mod windows {
    use senpi_socket_secret::presence::PresenceBackend;
    use senpi_socket_secret::presence_binding::{
        presence_probe, presence_release_after_quiescence, PresenceProbe, ReleasedReceipt,
    };
    use senpi_socket_secret::presence_cleanup::{
        presence_object_hold, presence_object_release, presence_root_list, PresenceHoldRequest,
    };
    use senpi_socket_secret::presence_placement::{
        presence_object_create, presence_root_open, PresenceObjectRequest,
    };
    use senpi_socket_secret::presence_windows::WindowsPresenceBackend;

    fn scratch(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("senpi-cleanup-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    /// A private root with one predeclared object in it, as an offer leaves them.
    fn root_with_object(label: &str, header: &[u8]) -> (std::path::PathBuf, String, String) {
        let dir = scratch(label);
        let root = presence_root_open(dir.join("r.presence").to_str().unwrap().into(), true);
        assert_eq!(root.status, "opened", "{root:?}");
        let root_path = root.path.clone().unwrap();
        let created = presence_object_create(PresenceObjectRequest {
            root_path: root_path.clone(),
            root_volume_serial: root.volume_serial.clone().unwrap(),
            root_file_id: root.file_id.clone().unwrap(),
            name: "p-1.presence".to_string(),
            header: header.to_vec().into(),
        });
        assert_eq!(created.status, "created", "{created:?}");
        (dir, root_path.clone(), format!(r"{root_path}\p-1.presence"))
    }

    fn hold(id: &str, path: &str) -> senpi_socket_secret::presence_cleanup::PresenceHold {
        presence_object_hold(PresenceHoldRequest {
            hold_id: id.to_string(),
            path: path.to_string(),
        })
    }

    #[test]
    fn an_exclusive_hold_reports_identity_and_content_and_deletes_on_close_only_when_asked() {
        let (dir, root_path, object) = root_with_object("delete", b"header-one");
        let mut backend = WindowsPresenceBackend;
        let identity = {
            let handle = backend.open(&object).unwrap();
            backend.handle_identity(&handle).unwrap()
        };
        let held = hold("keep", &object);
        println!(
            "RECEIPT_CLEANUP held status={} volume_serial={:?} file_id={:?} header_len={:?}",
            held.status,
            held.volume_serial,
            held.file_id,
            held.header.as_deref().map(<[u8]>::len)
        );
        assert_eq!(held.status, "held");
        assert_eq!(held.volume_serial, Some(identity.volume_serial.to_string()));
        assert_eq!(held.file_id, Some(identity.file_id.to_string()));
        assert_eq!(
            held.header.as_deref().map(|h| h.to_vec()),
            Some(b"header-one".to_vec())
        );
        // A second hold on the same object is a sharing violation, and a probe's open fails too.
        assert_eq!(hold("second", &object).status, "busy");
        let probe = presence_probe(PresenceProbe {
            presence_id: "cleanup-probe".into(),
            path: object.clone(),
            header: b"header-one".to_vec().into(),
            volume_serial: identity.volume_serial.to_string(),
            file_id: identity.file_id.to_string(),
            created_local: true,
            relocated: false,
            kernel_session: None,
        });
        assert_eq!(
            (probe.status.as_str(), probe.reason.as_deref()),
            ("unknown", Some("os_error"))
        );
        assert_eq!(probe.code, Some(32));
        assert_eq!(
            presence_object_release("keep".to_string(), false).status,
            "closed"
        );
        assert!(
            std::path::Path::new(&object).exists(),
            "a close without deletion keeps the object"
        );
        let listed = presence_root_list(root_path.clone());
        assert_eq!(listed.status, "listed");
        assert_eq!(listed.names, Some(vec!["p-1.presence".to_string()]));
        assert_eq!(hold("delete", &object).status, "held");
        let released = presence_object_release("delete".to_string(), true);
        println!("RECEIPT_CLEANUP released={released:?}");
        assert_eq!(released.status, "deleted");
        assert!(
            !std::path::Path::new(&object).exists(),
            "delete-on-close removed the object"
        );
        assert_eq!(presence_root_list(root_path).names, Some(Vec::new()));
        assert_eq!(hold("again", &object).status, "missing");
        assert_eq!(
            presence_object_release("unknown".to_string(), true)
                .step
                .as_deref(),
            Some("hold_id")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_live_lock_holder_makes_the_exclusive_open_a_sharing_violation() {
        let (dir, _root_path, object) = root_with_object("busy", b"header-two");
        let mut backend = WindowsPresenceBackend;
        let identity = {
            let handle = backend.open(&object).unwrap();
            backend.handle_identity(&handle).unwrap()
        };
        let probe = presence_probe(PresenceProbe {
            presence_id: "cleanup-holder".into(),
            path: object.clone(),
            header: b"header-two".to_vec().into(),
            volume_serial: identity.volume_serial.to_string(),
            file_id: identity.file_id.to_string(),
            created_local: true,
            relocated: false,
            kernel_session: None,
        });
        assert_eq!(probe.status, "acquired");
        let busy = hold("while-held", &object);
        println!(
            "RECEIPT_CLEANUP busy status={} step={:?} code={:?}",
            busy.status, busy.step, busy.code
        );
        assert_eq!(busy.status, "busy");
        assert!(
            std::path::Path::new(&object).exists(),
            "a live lock is never deleted"
        );
        presence_release_after_quiescence(ReleasedReceipt {
            presence_id: "cleanup-holder".into(),
            state: "released".into(),
        });
        assert_eq!(hold("after-release", &object).status, "held");
        assert_eq!(
            presence_object_release("after-release".to_string(), true).status,
            "deleted"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// senpi#4480 review LOW: the exclusive open names the entry itself (`FILE_FLAG_OPEN_REPARSE_POINT`) and refuses a
    /// reparse point, so nothing follows a link to hold or delete its target. A file symbolic link needs
    /// `SeCreateSymbolicLinkPrivilege` (or Developer Mode); where the runner lacks it the receipt says so.
    #[test]
    fn a_reparse_point_is_refused_and_its_target_is_never_deleted() {
        let (dir, _root_path, object) = root_with_object("reparse", b"header-link");
        let link = dir.join("link.presence");
        if let Err(error) = std::os::windows::fs::symlink_file(&object, &link) {
            println!(
                "RECEIPT_CLEANUP reparse_point skipped: symlink_file failed with {:?} ({error})",
                error.raw_os_error()
            );
            return;
        }
        let held = hold("link", link.to_str().unwrap());
        println!(
            "RECEIPT_CLEANUP reparse_point status={} step={:?} code={:?}",
            held.status, held.step, held.code
        );
        assert_eq!(
            (held.status.as_str(), held.step.as_deref()),
            ("failed", Some("reparse_point"))
        );
        assert_eq!(
            presence_object_release("link".to_string(), true).status,
            "failed",
            "a refused open leaves no hold to release"
        );
        assert!(std::path::Path::new(&object).exists(), "the link's target is untouched");
        assert!(link.exists(), "the link itself is untouched");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
