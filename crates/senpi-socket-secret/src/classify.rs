//! The Windows storage-locality rule of the #4199 design (Revision 8), as a pure function of what the
//! volume handle answered. Presence-lock evidence counts only on storage this kernel arbitrates, and
//! that is identified by the kernel driver in the volume's I/O path, never by the name the volume
//! reports: a user-mode file system (WinFsp, Dokany) chooses its reported name.

use crate::answers::ProbeCodes;

/// `NtQueryVolumeInformationFile(FileFsDriverPathInformation)` for one driver object name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DriverPath {
    InPath,
    NotInPath,
    QueryFailed,
}

/// `FILE_FS_DEVICE_INFORMATION.Characteristics & FILE_REMOTE_DEVICE`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RemoteDevice {
    Clear,
    Set,
    QueryFailed,
}

/// `GetFileInformationByHandleEx(FileRemoteProtocolInfo)`. `Unavailable` means only that the query
/// returned no remote-protocol information; it is not evidence of locality on its own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RemoteProtocol {
    Unavailable,
    Available,
    QueryFailed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VolumeFacts {
    /// `GetVolumeInformationByHandleW`'s file-system name; `None` when the call failed.
    pub reported_file_system: Option<String>,
    pub ntfs_driver: DriverPath,
    pub refs_driver: DriverPath,
    pub remote_device: RemoteDevice,
    pub remote_protocol: RemoteProtocol,
    /// The raw query answers behind the fields above (Revision 8.2); never consulted by [`classify`].
    pub codes: ProbeCodes,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotLocalReason {
    RemoteDevice,
    RemoteProtocol,
    UnlistedFileSystem,
    DriverNotInPath,
    QueryFailed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Locality {
    Local,
    NotLocal(NotLocalReason),
}

pub const NTFS_DRIVER: &str = "\\FileSystem\\Ntfs";
pub const REFS_DRIVER: &str = "\\FileSystem\\ReFS";

/// `local` only for the full conjunction: `FILE_REMOTE_DEVICE` clear, the remote-protocol query gave no
/// information, neither driver query failed, the reported name is NTFS or ReFS and that name's kernel
/// driver is in the volume's I/O path. The reported name only selects which driver to require; every
/// failure, from either driver query included, is `not_local` (design Revision 8.3).
pub fn classify(facts: &VolumeFacts) -> Locality {
    let not_local = Locality::NotLocal;
    match facts.remote_device {
        RemoteDevice::Clear => {}
        RemoteDevice::Set => return not_local(NotLocalReason::RemoteDevice),
        RemoteDevice::QueryFailed => return not_local(NotLocalReason::QueryFailed),
    }
    match facts.remote_protocol {
        RemoteProtocol::Unavailable => {}
        RemoteProtocol::Available => return not_local(NotLocalReason::RemoteProtocol),
        RemoteProtocol::QueryFailed => return not_local(NotLocalReason::QueryFailed),
    }
    if facts.ntfs_driver == DriverPath::QueryFailed || facts.refs_driver == DriverPath::QueryFailed {
        return not_local(NotLocalReason::QueryFailed);
    }
    let required = match facts.reported_file_system.as_deref() {
        Some("NTFS") => facts.ntfs_driver,
        Some("ReFS") => facts.refs_driver,
        Some(_) => return not_local(NotLocalReason::UnlistedFileSystem),
        None => return not_local(NotLocalReason::QueryFailed),
    };
    match required {
        DriverPath::InPath => Locality::Local,
        DriverPath::NotInPath => not_local(NotLocalReason::DriverNotInPath),
        DriverPath::QueryFailed => not_local(NotLocalReason::QueryFailed),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NAMES: [&str; 6] = ["NTFS", "ReFS", "FAT32", "exFAT", "WinFsp-FUSE", "CSVFS"];
    const DRIVER: [DriverPath; 3] = [DriverPath::InPath, DriverPath::NotInPath, DriverPath::QueryFailed];
    const DEVICE: [RemoteDevice; 3] = [RemoteDevice::Clear, RemoteDevice::Set, RemoteDevice::QueryFailed];
    const PROTOCOL: [RemoteProtocol; 3] = [
        RemoteProtocol::Unavailable,
        RemoteProtocol::Available,
        RemoteProtocol::QueryFailed,
    ];

    fn facts(name: &str, ntfs: DriverPath, refs: DriverPath) -> VolumeFacts {
        VolumeFacts {
            reported_file_system: Some(name.to_string()),
            ntfs_driver: ntfs,
            refs_driver: refs,
            remote_device: RemoteDevice::Clear,
            remote_protocol: RemoteProtocol::Unavailable,
            codes: ProbeCodes::default(),
        }
    }

    /// The Revision 7 rule (reported name plus the two remote checks), kept only as the negative
    /// control the design requires: it must accept the user-mode volume that Revision 8 refuses.
    fn revision7_is_local(facts: &VolumeFacts) -> bool {
        matches!(facts.reported_file_system.as_deref(), Some("NTFS" | "ReFS"))
            && facts.remote_device == RemoteDevice::Clear
            && facts.remote_protocol == RemoteProtocol::Unavailable
    }

    #[test]
    fn kernel_ntfs_and_refs_volumes_are_local() {
        assert_eq!(
            classify(&facts("NTFS", DriverPath::InPath, DriverPath::NotInPath)),
            Locality::Local
        );
        assert_eq!(
            classify(&facts("ReFS", DriverPath::NotInPath, DriverPath::InPath)),
            Locality::Local
        );
    }

    // Design test 22(g): a user-mode volume that reports NTFS, sets no remote flag and has no
    // redirector, but whose I/O path holds no NTFS driver.
    #[test]
    fn user_mode_volume_reporting_ntfs_is_not_local_and_revision7_would_accept_it() {
        let user_mode = facts("NTFS", DriverPath::NotInPath, DriverPath::NotInPath);
        assert_eq!(
            classify(&user_mode),
            Locality::NotLocal(NotLocalReason::DriverNotInPath)
        );
        assert!(
            revision7_is_local(&user_mode),
            "negative control: the Revision 7 rule must accept case (g)"
        );
    }

    #[test]
    fn a_reported_name_that_disagrees_with_the_driver_in_path_is_not_local() {
        let ntfs_name_refs_driver = facts("NTFS", DriverPath::NotInPath, DriverPath::InPath);
        let refs_name_ntfs_driver = facts("ReFS", DriverPath::InPath, DriverPath::NotInPath);
        assert_eq!(
            classify(&ntfs_name_refs_driver),
            Locality::NotLocal(NotLocalReason::DriverNotInPath)
        );
        assert_eq!(
            classify(&refs_name_ntfs_driver),
            Locality::NotLocal(NotLocalReason::DriverNotInPath)
        );
    }

    #[test]
    fn query_failures_and_unlisted_names_are_not_local() {
        let failed_driver = facts("NTFS", DriverPath::QueryFailed, DriverPath::QueryFailed);
        assert_eq!(
            classify(&failed_driver),
            Locality::NotLocal(NotLocalReason::QueryFailed)
        );
        let unnamed = VolumeFacts {
            reported_file_system: None,
            ..facts("NTFS", DriverPath::InPath, DriverPath::InPath)
        };
        assert_eq!(
            classify(&unnamed),
            Locality::NotLocal(NotLocalReason::QueryFailed)
        );
        let fat = facts("FAT32", DriverPath::InPath, DriverPath::InPath);
        assert_eq!(
            classify(&fat),
            Locality::NotLocal(NotLocalReason::UnlistedFileSystem)
        );
    }

    #[test]
    fn remote_device_or_redirector_is_not_local_even_with_the_ntfs_driver() {
        let base = facts("NTFS", DriverPath::InPath, DriverPath::NotInPath);
        let remote = VolumeFacts {
            remote_device: RemoteDevice::Set,
            ..base.clone()
        };
        let redirected = VolumeFacts {
            remote_protocol: RemoteProtocol::Available,
            ..base.clone()
        };
        let unknown = VolumeFacts {
            remote_protocol: RemoteProtocol::QueryFailed,
            ..base
        };
        assert_eq!(
            classify(&remote),
            Locality::NotLocal(NotLocalReason::RemoteDevice)
        );
        assert_eq!(
            classify(&redirected),
            Locality::NotLocal(NotLocalReason::RemoteProtocol)
        );
        assert_eq!(
            classify(&unknown),
            Locality::NotLocal(NotLocalReason::QueryFailed)
        );
    }

    // The decision table of design section 6, with the two driver answers varied independently
    // (Revision 8.3): six names, three remote-flag answers, three remote-protocol answers and three
    // answers for each driver query, 486 cases. The local set is listed explicitly.
    #[test]
    fn decision_table_with_independent_driver_answers() {
        use DriverPath::{InPath, NotInPath};
        let (mut revision7, mut total) = (0, 0);
        let mut local = Vec::new();
        for name in NAMES {
            for device in DEVICE {
                for protocol in PROTOCOL {
                    for ntfs in DRIVER {
                        for refs in DRIVER {
                            let case = VolumeFacts {
                                remote_device: device,
                                remote_protocol: protocol,
                                ..facts(name, ntfs, refs)
                            };
                            total += 1;
                            revision7 += usize::from(revision7_is_local(&case));
                            if classify(&case) == Locality::Local {
                                local.push((name, device, protocol, ntfs, refs));
                            }
                        }
                    }
                }
            }
        }
        let (clear, none) = (RemoteDevice::Clear, RemoteProtocol::Unavailable);
        assert_eq!((total, revision7), (486, 18));
        assert_eq!(
            local,
            vec![
                ("NTFS", clear, none, InPath, InPath),
                ("NTFS", clear, none, InPath, NotInPath),
                ("ReFS", clear, none, InPath, InPath),
                ("ReFS", clear, none, NotInPath, InPath),
            ]
        );
    }
}
