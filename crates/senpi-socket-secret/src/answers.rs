//! Revisions 8.2 and 8.3 of the #4199 design: which raw answers of the Windows volume queries are read
//! as an answer rather than a failure. Only the exact codes listed here become an answer; every other
//! error stays `QueryFailed`, which the classifier rejects. The raw codes travel in [`ProbeCodes`] so a
//! receipt shows what the kernel actually returned.

use crate::classify::{DriverPath, RemoteProtocol};

/// `STATUS_OBJECT_NAME_NOT_FOUND` ("Object Name not found") from the driver-path query: the named driver
/// is not positively in the path. Read as `NotInPath`, which can only reject a volume that needs it.
pub const STATUS_OBJECT_NAME_NOT_FOUND: i32 = 0xC000_0034_u32.cast_signed();

/// `ERROR_INVALID_PARAMETER` from `FileRemoteProtocolInfo`: this query returned no remote-protocol
/// information. It is NOT evidence of locality (network and user-mode volumes return it too); it is
/// accepted only because `classify` also requires the kernel driver in path and `FILE_REMOTE_DEVICE`
/// clear, which are independently sufficient (design Revision 8.3).
pub const REMOTE_PROTOCOL_NO_INFORMATION_ERRORS: [u32; 1] = [87];

/// The raw answers one probe received, for receipts and diagnostics. NTSTATUS values are kept as
/// returned; `remote_protocol_error` is `GetLastError()` after a failed query and 0 after success.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ProbeCodes {
    pub ntfs_status: i32,
    pub refs_status: i32,
    pub device_status: i32,
    pub remote_protocol_error: u32,
}

/// `NtQueryVolumeInformationFile(FileFsDriverPathInformation)` for one driver name.
pub const fn driver_path_from_query(status: i32, driver_in_path: bool) -> DriverPath {
    if status == STATUS_OBJECT_NAME_NOT_FOUND {
        DriverPath::NotInPath
    } else if status < 0 {
        DriverPath::QueryFailed
    } else if driver_in_path {
        DriverPath::InPath
    } else {
        DriverPath::NotInPath
    }
}

/// `GetFileInformationByHandleEx(FileRemoteProtocolInfo)`: any successful answer is a redirector's.
pub fn remote_protocol_from_query(answered: bool, last_error: u32) -> RemoteProtocol {
    if answered {
        RemoteProtocol::Available
    } else if REMOTE_PROTOCOL_NO_INFORMATION_ERRORS.contains(&last_error) {
        RemoteProtocol::Unavailable
    } else {
        RemoteProtocol::QueryFailed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::classify::{classify, Locality, NotLocalReason, RemoteDevice, VolumeFacts};

    // Revision 8.2: the exact answers that mean "absent" map to an answer; every other error stays a
    // failure, so the classifier keeps failing closed on anything unexpected.
    #[test]
    fn a_driver_that_is_not_loaded_is_not_in_the_path_and_other_errors_fail() {
        assert_eq!(driver_path_from_query(0, true), DriverPath::InPath);
        assert_eq!(driver_path_from_query(0, false), DriverPath::NotInPath);
        assert_eq!(
            driver_path_from_query(STATUS_OBJECT_NAME_NOT_FOUND, false),
            DriverPath::NotInPath
        );
        assert_eq!(
            driver_path_from_query(STATUS_OBJECT_NAME_NOT_FOUND, true),
            DriverPath::NotInPath
        );
        for unexpected in [
            0xC000_0022_u32,
            0xC000_000D,
            0xC000_0003,
            0xC000_0010,
            0xC000_00BB,
            0xC000_003A,
        ] {
            assert_eq!(
                driver_path_from_query(unexpected.cast_signed(), true),
                DriverPath::QueryFailed,
                "{unexpected:#010x}"
            );
        }
    }

    // Revision 8.3: only ERROR_INVALID_PARAMETER is read as "this query returned no remote-protocol
    // information"; ERROR_INVALID_FUNCTION and ERROR_NOT_SUPPORTED have no class-specific contract and
    // stay failures. The expectations are literal, not read back from the production list.
    #[test]
    fn only_invalid_parameter_means_no_remote_protocol_information() {
        assert_eq!(remote_protocol_from_query(true, 0), RemoteProtocol::Available);
        assert_eq!(remote_protocol_from_query(true, 87), RemoteProtocol::Available);
        assert_eq!(remote_protocol_from_query(false, 87), RemoteProtocol::Unavailable);
        // ERROR_INVALID_FUNCTION, ERROR_NOT_SUPPORTED, ERROR_ACCESS_DENIED, ERROR_BAD_LENGTH,
        // ERROR_INSUFFICIENT_BUFFER, ERROR_MORE_DATA, ERROR_BAD_NETPATH, ERROR_NETNAME_DELETED,
        // ERROR_UNEXP_NET_ERR, and a failure that set no error.
        for failed in [1_u32, 50, 5, 24, 122, 234, 53, 64, 59, 0] {
            assert_eq!(
                remote_protocol_from_query(false, failed),
                RemoteProtocol::QueryFailed,
                "{failed}"
            );
        }
    }

    fn volume(name: &str, ntfs: (i32, bool), refs: (i32, bool)) -> VolumeFacts {
        VolumeFacts {
            reported_file_system: Some(name.to_string()),
            ntfs_driver: driver_path_from_query(ntfs.0, ntfs.1),
            refs_driver: driver_path_from_query(refs.0, refs.1),
            remote_device: RemoteDevice::Clear,
            remote_protocol: remote_protocol_from_query(false, 87),
            codes: ProbeCodes::default(),
        }
    }

    // A matching driver in path with the other driver not loaded (0xC0000034) is local: receipt 28's
    // fixed NTFS volume answered exactly this in CI run 40262475881.
    #[test]
    fn an_absent_non_matching_driver_does_not_reject_a_kernel_volume() {
        let absent = (STATUS_OBJECT_NAME_NOT_FOUND, false);
        assert_eq!(classify(&volume("NTFS", (0, true), absent)), Locality::Local);
        assert_eq!(classify(&volume("ReFS", absent, (0, true))), Locality::Local);
    }

    // Revision 8.3 (Astra r8.2 blocker 2): an unlisted error from EITHER issued driver query is
    // `not_local`, also when the driver selected by the reported name is in the path.
    #[test]
    fn an_unlisted_error_from_the_non_matching_driver_query_is_not_local() {
        let access_denied = (0xC000_0022_u32.cast_signed(), false);
        let invalid_device_request = (0xC000_0010_u32.cast_signed(), false);
        assert_eq!(
            classify(&volume("NTFS", (0, true), access_denied)),
            Locality::NotLocal(NotLocalReason::QueryFailed)
        );
        assert_eq!(
            classify(&volume("ReFS", invalid_device_request, (0, true))),
            Locality::NotLocal(NotLocalReason::QueryFailed)
        );
    }
}
