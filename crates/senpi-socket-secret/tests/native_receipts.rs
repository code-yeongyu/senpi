//! Native receipts 27 and 28 of the #4199 design. They need a real Windows kernel; the `ci.yml`
//! job `socket-secret-native-windows` runs them, and its log lines starting with `RECEIPT_` are the
//! receipt. Fixture-dependent cases are `#[ignore]` and run there with `--ignored`; every case is
//! ignored off Windows, with the reason in its attribute.

#[cfg(windows)]
use senpi_socket_secret::{classify, probe_volume, Locality, NotLocalReason};
use senpi_socket_secret::{read_kernel_session_identity, SessionIdentity};

#[cfg(windows)]
fn receipt_volume(label: &str, path: &str) -> Locality {
    let facts = probe_volume(path).unwrap_or_else(|error| panic!("{label}: cannot open {path}: {error:?}"));
    let locality = classify(&facts);
    let codes = facts.codes;
    println!(
        "RECEIPT_28 {label} locality={locality:?} reported={:?} ntfs={:?} refs={:?} remote_device={:?} remote_protocol={:?} raw_ntfs_status={:#010x} raw_refs_status={:#010x} raw_device_status={:#010x} raw_remote_protocol_error={}",
        facts.reported_file_system,
        facts.ntfs_driver,
        facts.refs_driver,
        facts.remote_device,
        facts.remote_protocol,
        codes.ntfs_status.cast_unsigned(),
        codes.refs_status.cast_unsigned(),
        codes.device_status.cast_unsigned(),
        codes.remote_protocol_error
    );
    locality
}

#[cfg(windows)]
fn fixture(variable: &str) -> String {
    std::env::var(variable)
        .unwrap_or_else(|_| panic!("fixture {variable} is not set; see ci.yml socket-secret-native-windows"))
}

#[test]
#[cfg_attr(
    not(windows),
    ignore = "windows-only native receipt 27: PID-4 kernel-session identity"
)]
fn receipt_27_kernel_session_identity_is_verified_and_stable_within_a_session() {
    let first = read_kernel_session_identity();
    let second = read_kernel_session_identity();
    println!("RECEIPT_27 process_token first={first:?} second={second:?}");
    assert!(matches!(first, SessionIdentity::Verified(_)), "{first:?}");
    assert!(first.same_session(second));
}

#[test]
#[cfg_attr(
    not(windows),
    ignore = "windows-only native receipt 27: PID-4 read under a filtered token"
)]
fn receipt_27_filtered_token_read_is_the_same_session_or_unverified() {
    #[cfg(windows)]
    {
        let process = read_kernel_session_identity();
        let filtered = filtered_token::read_while_impersonating();
        println!("RECEIPT_27 filtered_token={filtered:?} process_token={process:?}");
        let unverified = matches!(filtered, SessionIdentity::Unverified(_));
        assert!(
            unverified || filtered.same_session(process),
            "{filtered:?} vs {process:?}"
        );
    }
}

#[test]
#[cfg_attr(
    not(windows),
    ignore = "windows-only native receipt 28: fixed NTFS system volume"
)]
fn receipt_28_fixed_ntfs_system_volume_is_local() {
    #[cfg(windows)]
    {
        let drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".to_string());
        assert_eq!(
            receipt_volume("fixed_ntfs", &format!("{drive}\\")),
            Locality::Local
        );
    }
}

macro_rules! fixture_receipt {
    ($name:ident, $variable:literal, $expected:expr) => {
        fixture_receipt!($name, stringify!($name), $variable, $expected);
    };
    ($name:ident, $label:expr, $variable:literal, $expected:expr) => {
        #[test]
        #[ignore = "native receipt 28: needs the Windows fixtures of ci.yml socket-secret-native-windows"]
        fn $name() {
            #[cfg(windows)]
            {
                let locality = receipt_volume($label, &fixture($variable));
                assert_eq!(locality, $expected);
            }
        }
    };
}

fixture_receipt!(
    receipt_28_winfsp_disk_volume_reporting_ntfs_is_not_local,
    "RECEIPT_WINFSP_DISK_NTFS",
    Locality::NotLocal(NotLocalReason::DriverNotInPath)
);
fixture_receipt!(
    receipt_28_winfsp_network_volume_is_not_local,
    "RECEIPT_WINFSP_NETWORK",
    Locality::NotLocal(NotLocalReason::RemoteDevice)
);
fixture_receipt!(
    receipt_28_dokany_disk_mirror_of_ntfs_is_not_local,
    "RECEIPT_DOKANY_DISK_MIRROR",
    Locality::NotLocal(NotLocalReason::DriverNotInPath)
);
fixture_receipt!(
    receipt_28_mapped_smb_drive_is_not_local,
    "RECEIPT_SMB_MAPPED_DRIVE",
    Locality::NotLocal(NotLocalReason::RemoteDevice)
);
fixture_receipt!(
    receipt_28_unc_path_is_not_local,
    "RECEIPT_SMB_UNC",
    Locality::NotLocal(NotLocalReason::RemoteDevice)
);
fixture_receipt!(
    receipt_28_vhdx_mounted_ntfs_volume_is_local,
    "RECEIPT_VHDX_NTFS",
    Locality::Local
);

fixture_receipt!(
    receipt_28_junction_to_a_winfsp_volume_is_classified_by_its_target,
    "junction_winfsp",
    "RECEIPT_JUNCTION_WINFSP",
    Locality::NotLocal(NotLocalReason::DriverNotInPath)
);
// The control for the junction above: source and target are both kernel NTFS volumes, so `Local`
// prints whether or not the handle follows the junction. `junction_winfsp` is the proof.
fixture_receipt!(
    receipt_28_junction_to_the_vhdx_ntfs_volume_is_local,
    "junction_vhdx",
    "RECEIPT_JUNCTION_VHDX",
    Locality::Local
);

/// senpi#4354: a real ReFS volume is local with the ReFS driver in its path. A runner image that
/// cannot format ReFS sets `RECEIPT_REFS_UNAVAILABLE` instead; the receipt line then states the gap.
#[test]
#[ignore = "native receipt 28: needs the Windows fixtures of ci.yml socket-secret-native-windows"]
fn receipt_28_refs_vhdx_volume_is_local() {
    #[cfg(windows)]
    {
        let Ok(path) = std::env::var("RECEIPT_REFS_VHDX") else {
            let why = std::env::var("RECEIPT_REFS_UNAVAILABLE")
                .unwrap_or_else(|_| panic!("neither RECEIPT_REFS_VHDX nor RECEIPT_REFS_UNAVAILABLE is set"));
            println!("RECEIPT_28 refs_vhdx unavailable: {why}");
            return;
        };
        let facts =
            probe_volume(&path).unwrap_or_else(|error| panic!("refs_vhdx: cannot open {path}: {error:?}"));
        assert_eq!(receipt_volume("refs_vhdx", &path), Locality::Local);
        assert_eq!(facts.refs_driver, senpi_socket_secret::DriverPath::InPath);
        assert_eq!(facts.reported_file_system.as_deref(), Some("ReFS"));
    }
}

#[cfg(windows)]
mod filtered_token {
    use senpi_socket_secret::{read_kernel_session_identity, SessionIdentity};
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{
        CreateRestrictedToken, CreateWellKnownSid, ImpersonateLoggedOnUser, RevertToSelf,
        WinBuiltinAdministratorsSid, DISABLE_MAX_PRIVILEGE, SID_AND_ATTRIBUTES, TOKEN_ASSIGN_PRIMARY,
        TOKEN_DUPLICATE, TOKEN_IMPERSONATE, TOKEN_QUERY,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    /// Reads the identity while this thread impersonates the process token with Administrators made
    /// deny-only and every privilege but SeChangeNotify removed: the shape of a UAC-filtered
    /// standard-user token. OpenProcess performs its access check against the impersonation token.
    pub fn read_while_impersonating() -> SessionIdentity {
        let mut token: HANDLE = std::ptr::null_mut();
        let access = TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_IMPERSONATE | TOKEN_ASSIGN_PRIMARY;
        // SAFETY: `token` is a writable HANDLE slot; GetCurrentProcess returns a pseudo-handle.
        assert_ne!(
            unsafe { OpenProcessToken(GetCurrentProcess(), access, &mut token) },
            0
        );
        let mut sid = [0u8; 68];
        let mut sid_size = sid.len() as u32;
        // SAFETY: `sid` is writable for `sid_size` bytes; a null domain SID is allowed for a builtin SID.
        let created = unsafe {
            CreateWellKnownSid(
                WinBuiltinAdministratorsSid,
                std::ptr::null_mut(),
                sid.as_mut_ptr().cast(),
                &mut sid_size,
            )
        };
        assert_ne!(created, 0);
        let deny = SID_AND_ATTRIBUTES {
            Sid: sid.as_mut_ptr().cast(),
            Attributes: 0,
        };
        let mut restricted: HANDLE = std::ptr::null_mut();
        // SAFETY: `deny` points at one valid SID that outlives the call; `restricted` is writable.
        let made = unsafe {
            CreateRestrictedToken(
                token,
                DISABLE_MAX_PRIVILEGE,
                1,
                &deny,
                0,
                std::ptr::null(),
                0,
                std::ptr::null(),
                &mut restricted,
            )
        };
        assert_ne!(made, 0);
        // SAFETY: `restricted` is a token handle created above with impersonation rights.
        assert_ne!(unsafe { ImpersonateLoggedOnUser(restricted) }, 0);
        let identity = read_kernel_session_identity();
        // SAFETY: ends the impersonation started above; the handles are closed exactly once.
        unsafe {
            RevertToSelf();
            CloseHandle(restricted);
            CloseHandle(token);
        }
        identity
    }
}
