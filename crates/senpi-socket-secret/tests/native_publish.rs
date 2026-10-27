//! Native receipts for #4199 first publication (design tests 1, 2 and the "Windows native primitive"
//! and "Permission boundary" rows). Windows only; `ci.yml` `socket-secret-native-windows` runs them and
//! prints `RECEIPT_PUBLISH` lines.

#[cfg(windows)]
mod windows {
    use senpi_socket_secret::{publish_no_replace, Publication, PublishError, PublishOutcome};
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Barrier};

    fn scratch(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("senpi-publish-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    /// Every receipt here expects the staging file to be gone, so none may report one left behind.
    fn publish(staging: &str, final_path: &str, bytes: &[u8]) -> Result<PublishOutcome, PublishError> {
        let Publication {
            result,
            staging_left_behind,
        } = publish_no_replace(staging, final_path, bytes);
        assert_eq!(staging_left_behind, None, "staging left behind for {result:?}");
        result
    }

    fn s(path: &Path) -> String {
        path.to_str().expect("utf-8 path").to_string()
    }

    fn only_final(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .expect("read dir")
            .map(|entry| entry.expect("entry").file_name().into_string().expect("name"))
            .collect();
        names.sort();
        names
    }

    #[test]
    fn publishes_to_an_absent_name_and_removes_nothing_else() {
        let dir = scratch("first");
        let final_path = dir.join("rpc.sock.secret");
        let bytes = [7u8; 32];
        let outcome = publish(&s(&dir.join("rpc.sock.secret.stage-a")), &s(&final_path), &bytes);
        println!("RECEIPT_PUBLISH first outcome={outcome:?}");
        assert_eq!(outcome, Ok(PublishOutcome::Published));
        assert_eq!(std::fs::read(&final_path).expect("read final"), bytes);
        assert_eq!(only_final(&dir), vec!["rpc.sock.secret".to_string()]);
    }

    #[test]
    fn a_collision_keeps_the_winner_and_deletes_only_its_own_staging() {
        let dir = scratch("collision");
        let final_path = dir.join("rpc.sock.secret");
        std::fs::write(&final_path, [1u8; 32]).expect("winner");
        let outcome = publish(
            &s(&dir.join("rpc.sock.secret.stage-b")),
            &s(&final_path),
            &[2u8; 32],
        );
        println!("RECEIPT_PUBLISH collision outcome={outcome:?}");
        assert_eq!(outcome, Ok(PublishOutcome::Collision));
        assert_eq!(std::fs::read(&final_path).expect("read final"), [1u8; 32]);
        assert_eq!(only_final(&dir), vec!["rpc.sock.secret".to_string()]);
    }

    #[test]
    fn a_collision_with_a_reader_holding_the_winner_open_is_still_a_collision() {
        let dir = scratch("reader");
        let final_path = dir.join("rpc.sock.secret");
        std::fs::write(&final_path, [3u8; 32]).expect("winner");
        let reader = std::fs::File::open(&final_path).expect("reader");
        let outcome = publish(
            &s(&dir.join("rpc.sock.secret.stage-c")),
            &s(&final_path),
            &[4u8; 32],
        );
        drop(reader);
        println!("RECEIPT_PUBLISH collision_with_reader outcome={outcome:?}");
        assert_eq!(outcome, Ok(PublishOutcome::Collision));
        assert_eq!(std::fs::read(&final_path).expect("read final"), [3u8; 32]);
    }

    #[test]
    fn concurrent_publishers_produce_exactly_one_winner() {
        const PUBLISHERS: usize = 16;
        let dir = Arc::new(scratch("race"));
        let barrier = Arc::new(Barrier::new(PUBLISHERS));
        let handles: Vec<_> = (0..PUBLISHERS)
            .map(|index| {
                let (dir, barrier) = (Arc::clone(&dir), Arc::clone(&barrier));
                std::thread::spawn(move || {
                    let bytes = [index as u8; 32];
                    barrier.wait();
                    let outcome = publish(
                        &s(&dir.join(format!("rpc.sock.secret.stage-{index}"))),
                        &s(&dir.join("rpc.sock.secret")),
                        &bytes,
                    );
                    (bytes, outcome)
                })
            })
            .collect();
        let results: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().expect("thread"))
            .collect();
        let winners: Vec<_> = results
            .iter()
            .filter(|(_, outcome)| *outcome == Ok(PublishOutcome::Published))
            .collect();
        let collisions = results
            .iter()
            .filter(|(_, outcome)| *outcome == Ok(PublishOutcome::Collision))
            .count();
        println!(
            "RECEIPT_PUBLISH race publishers={PUBLISHERS} winners={} collisions={collisions}",
            winners.len()
        );
        assert_eq!(winners.len(), 1);
        assert_eq!(collisions, PUBLISHERS - 1);
        assert_eq!(
            std::fs::read(dir.join("rpc.sock.secret")).expect("read final"),
            winners[0].0
        );
        assert_eq!(only_final(&dir), vec!["rpc.sock.secret".to_string()]);
    }

    #[test]
    fn an_existing_staging_name_fails_without_touching_the_final_name() {
        let dir = scratch("stage-exists");
        let staging = dir.join("rpc.sock.secret.stage-d");
        std::fs::write(&staging, b"someone else's").expect("staging");
        let outcome = publish(&s(&staging), &s(&dir.join("rpc.sock.secret")), &[5u8; 32]);
        println!("RECEIPT_PUBLISH staging_exists outcome={outcome:?}");
        assert_eq!(
            outcome,
            Err(PublishError::Os {
                step: "create_staging",
                code: 80
            }),
            "ERROR_FILE_EXISTS on the staging name is an error, never a collision"
        );
        assert!(!dir.join("rpc.sock.secret").exists());
        assert_eq!(std::fs::read(&staging).expect("staging kept"), b"someone else's");
    }

    #[test]
    fn the_published_secret_has_a_protected_owner_only_dacl() {
        let dir = scratch("dacl");
        let final_path = dir.join("rpc.sock.secret");
        assert_eq!(
            publish(
                &s(&dir.join("rpc.sock.secret.stage-e")),
                &s(&final_path),
                &[6u8; 32]
            ),
            Ok(PublishOutcome::Published)
        );
        let sddl = dacl_sddl(&final_path);
        let user = current_user_sid();
        println!("RECEIPT_PUBLISH dacl sddl={sddl} user={user}");
        let (flags, aces) = sddl
            .strip_prefix("D:")
            .and_then(|rest| rest.split_once('('))
            .map(|(flags, aces)| (flags.to_string(), format!("({aces}")))
            .unwrap_or_else(|| panic!("not a DACL SDDL: {sddl}"));
        assert!(flags.contains('P'), "DACL must be protected: {sddl}");
        let mut found: Vec<&str> = aces
            .trim_start_matches('(')
            .trim_end_matches(')')
            .split(")(")
            .collect();
        found.sort_unstable();
        // Windows prints a well-known account SID by its SDDL alias (the built-in Administrator, RID 500, is
        // `LA`), so the expected owner ACE is canonicalized through the same conversion as the file's DACL.
        let owner = canonical_owner_ace(&user);
        let mut expected = vec![owner.as_str(), "A;;FA;;;BA", "A;;FA;;;SY"];
        expected.sort_unstable();
        assert_eq!(
            found, expected,
            "exactly owner, SYSTEM and Administrators: {sddl}"
        );
    }

    fn current_user_sid() -> String {
        let output = std::process::Command::new("whoami")
            .args(["/user", "/fo", "csv", "/nh"])
            .output()
            .expect("whoami");
        assert!(output.status.success(), "whoami failed: {output:?}");
        let line = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let sid = line.rsplit(',').next().unwrap_or_default().trim_matches('"');
        assert!(sid.starts_with("S-1-"), "no SID in whoami output: {line}");
        sid.to_string()
    }

    /// `A;;FA;;;<sid>` as Windows itself prints that ACE: the round trip through a descriptor turns a
    /// well-known SID into its alias and leaves any other SID literal.
    fn canonical_owner_ace(sid: &str) -> String {
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Authorization::{
            ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
        };
        use windows_sys::Win32::Security::PSECURITY_DESCRIPTOR;

        let source: Vec<u16> = format!("D:(A;;FA;;;{sid})")
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        // SAFETY: `source` is NUL-terminated; only the descriptor out-pointer is requested.
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                source.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                std::ptr::null_mut(),
            )
        };
        assert_ne!(
            ok, 0,
            "ConvertStringSecurityDescriptorToSecurityDescriptorW failed for {sid}"
        );
        let sddl = descriptor_dacl_sddl(descriptor);
        // SAFETY: `descriptor` came from the conversion above and is freed exactly once.
        unsafe { LocalFree(descriptor.cast()) };
        sddl.strip_prefix("D:(")
            .and_then(|rest| rest.strip_suffix(')'))
            .unwrap_or_else(|| panic!("unexpected canonical SDDL: {sddl}"))
            .to_string()
    }

    /// The file's DACL as SDDL, read with `GetNamedSecurityInfoW` (no localized account names).
    fn dacl_sddl(path: &Path) -> String {
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Authorization::{GetNamedSecurityInfoW, SE_FILE_OBJECT};
        use windows_sys::Win32::Security::{DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR};

        let wide: Vec<u16> = s(path).encode_utf16().chain(std::iter::once(0)).collect();
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        // SAFETY: `wide` is NUL-terminated; only the descriptor out-pointer is requested.
        let status = unsafe {
            GetNamedSecurityInfoW(
                wide.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut descriptor,
            )
        };
        assert_eq!(status, 0, "GetNamedSecurityInfoW failed");
        let sddl = descriptor_dacl_sddl(descriptor);
        // SAFETY: `descriptor` came from GetNamedSecurityInfoW and is freed exactly once.
        unsafe { LocalFree(descriptor.cast()) };
        sddl
    }

    /// The DACL of `descriptor` as SDDL; the caller keeps ownership of `descriptor`.
    fn descriptor_dacl_sddl(descriptor: windows_sys::Win32::Security::PSECURITY_DESCRIPTOR) -> String {
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Authorization::{
            ConvertSecurityDescriptorToStringSecurityDescriptorW, SDDL_REVISION_1,
        };
        use windows_sys::Win32::Security::DACL_SECURITY_INFORMATION;

        let mut text: *mut u16 = std::ptr::null_mut();
        // SAFETY: `descriptor` is a valid security descriptor; `text` receives a LocalAlloc string.
        let ok = unsafe {
            ConvertSecurityDescriptorToStringSecurityDescriptorW(
                descriptor,
                SDDL_REVISION_1,
                DACL_SECURITY_INFORMATION,
                &mut text,
                std::ptr::null_mut(),
            )
        };
        assert_ne!(
            ok, 0,
            "ConvertSecurityDescriptorToStringSecurityDescriptorW failed"
        );
        // SAFETY: `text` is a NUL-terminated UTF-16 string from the conversion above.
        let length = (0..)
            .take_while(|&index| unsafe { *text.add(index) } != 0)
            .count();
        // SAFETY: `text` holds `length` readable units before its terminator.
        let sddl = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, length) });
        // SAFETY: `text` came from the conversion above and is freed exactly once.
        unsafe { LocalFree(text.cast()) };
        sddl
    }
}
