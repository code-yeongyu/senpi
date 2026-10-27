//! Presence placement natives (#4199 design 4.2a "Placement." and "Lifetime object and binding"): the private presence
//! root, the predeclared presence object created new beside it, and FOLDERID_LocalAppData. Real Windows only; elsewhere
//! every call is typed `unavailable`.

#[cfg(not(windows))]
#[test]
fn placement_natives_are_unavailable_off_windows() {
    use senpi_socket_secret::presence_placement::{
        local_app_data_path, presence_object_create, presence_root_open, PresenceObjectRequest,
    };
    let root = presence_root_open("/must/not/be/created".to_string(), true);
    assert_eq!(
        (root.status.as_str(), root.reason.as_deref()),
        ("unavailable", Some("unsupported_platform"))
    );
    let object = presence_object_create(PresenceObjectRequest {
        root_path: "/must/not/be/created".to_string(),
        root_volume_serial: "1".to_string(),
        root_file_id: "2".to_string(),
        name: "p.presence".to_string(),
        header: b"header".to_vec().into(),
    });
    assert_eq!(object.status, "unavailable");
    assert!(!std::path::Path::new("/must/not/be/created").exists());
    assert_eq!(local_app_data_path().status, "unavailable");
}

#[cfg(windows)]
mod windows {
    use senpi_socket_secret::presence::PresenceBackend;
    use senpi_socket_secret::presence_binding::{
        presence_probe, presence_release_after_quiescence, PresenceProbe, ReleasedReceipt,
    };
    use senpi_socket_secret::presence_placement::{
        local_app_data_path, presence_object_create, presence_root_open, PresenceObjectRequest, PresenceRoot,
    };
    use senpi_socket_secret::presence_windows::WindowsPresenceBackend;

    fn scratch(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("senpi-placement-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    fn opened(root: &PresenceRoot) -> (String, String, String) {
        assert_eq!(root.status, "opened", "root open failed: {root:?}");
        (
            root.path.clone().expect("canonical path"),
            root.volume_serial.clone().expect("volume serial"),
            root.file_id.clone().expect("file id"),
        )
    }

    fn request(root: &(String, String, String), name: &str, header: &[u8]) -> PresenceObjectRequest {
        PresenceObjectRequest {
            root_path: root.0.clone(),
            root_volume_serial: root.1.clone(),
            root_file_id: root.2.clone(),
            name: name.to_string(),
            header: header.to_vec().into(),
        }
    }

    #[test]
    fn the_root_is_created_private_and_reopened_with_the_same_canonical_path_and_identity() {
        let dir = scratch("root");
        let path = dir.join("endpoint.presence");
        let created = presence_root_open(path.to_str().unwrap().into(), true);
        println!("RECEIPT_PLACEMENT root_created={created:?}");
        let first = opened(&created);
        assert_eq!(created.locality.as_deref(), Some("local"));
        assert!(path.is_dir());
        let again = opened(&presence_root_open(path.to_str().unwrap().into(), false));
        assert_eq!(first, again);
        assert!(
            first.0.starts_with(r"\\?\"),
            "canonical path comes from the handle: {}",
            first.0
        );
        assert_eq!(
            presence_root_open(dir.join("absent").to_str().unwrap().into(), false).status,
            "failed"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_object_is_created_new_with_its_header_and_never_replaced() {
        let dir = scratch("object");
        let root = opened(&presence_root_open(
            dir.join("r.presence").to_str().unwrap().into(),
            true,
        ));
        let created = presence_object_create(request(&root, "p-1.presence", b"header-one"));
        println!("RECEIPT_PLACEMENT object_created={created:?}");
        assert_eq!(created.status, "created");
        assert_eq!(created.locality.as_deref(), Some("local"));
        let object = format!(r"{}\p-1.presence", root.0);
        assert_eq!(std::fs::read(&object).unwrap(), b"header-one");
        let mut backend = WindowsPresenceBackend;
        let handle = backend.open(&object).unwrap();
        let identity = backend.handle_identity(&handle).unwrap();
        drop(handle);
        assert_eq!(created.volume_serial, Some(identity.volume_serial.to_string()));
        assert_eq!(created.file_id, Some(identity.file_id.to_string()));
        let again = presence_object_create(request(&root, "p-1.presence", b"header-two"));
        assert_eq!(again.status, "exists");
        assert_eq!(
            std::fs::read(&object).unwrap(),
            b"header-one",
            "the original inode is untouched"
        );
        let probe = PresenceProbe {
            presence_id: "placement-probe".into(),
            path: object,
            tag: b"header-one".to_vec().into(),
            volume_serial: identity.volume_serial.to_string(),
            file_id: identity.file_id.to_string(),
            created_local: true,
            relocated: false,
            kernel_session: None,
        };
        assert_eq!(
            presence_probe(probe).status,
            "acquired",
            "the predeclared object is admissible evidence"
        );
        presence_release_after_quiescence(ReleasedReceipt {
            presence_id: "placement-probe".into(),
            state: "released".into(),
        });
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_different_physical_directory_at_the_recorded_path_is_refused() {
        let dir = scratch("mismatch");
        let path = dir.join("r.presence");
        let root = opened(&presence_root_open(path.to_str().unwrap().into(), true));
        std::fs::remove_dir(&path).unwrap();
        let _replacement = opened(&presence_root_open(path.to_str().unwrap().into(), true));
        let refused = presence_object_create(request(&root, "p-1.presence", b"header"));
        assert_eq!(refused.status, "root_mismatch");
        assert!(!path.join("p-1.presence").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_object_name_is_one_path_component() {
        let dir = scratch("name");
        let root = opened(&presence_root_open(
            dir.join("r.presence").to_str().unwrap().into(),
            true,
        ));
        for name in ["", "..", r"..\escape.presence", "a/b.presence", r"a\b.presence"] {
            let refused = presence_object_create(request(&root, name, b"header"));
            assert_eq!(
                (refused.status.as_str(), refused.step.as_deref()),
                ("failed", Some("name")),
                "{name:?}"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn local_app_data_resolves_to_an_existing_directory() {
        let folder = local_app_data_path();
        println!("RECEIPT_PLACEMENT local_app_data={folder:?}");
        assert_eq!(folder.status, "found");
        assert!(std::path::Path::new(&folder.path.expect("path")).is_dir());
    }
}
