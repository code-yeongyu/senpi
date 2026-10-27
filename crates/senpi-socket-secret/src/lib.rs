use napi_derive::napi;

pub mod answers;
pub mod classify;
mod owner_dacl;
pub mod publish;
pub mod session;
pub mod volume;

pub use answers::{
    driver_path_from_query, remote_protocol_from_query, ProbeCodes, REMOTE_PROTOCOL_NO_INFORMATION_ERRORS,
    STATUS_OBJECT_NAME_NOT_FOUND,
};
pub use classify::{
    classify, DriverPath, Locality, NotLocalReason, RemoteDevice, RemoteProtocol, VolumeFacts,
};
pub use publish::{publish_no_replace, Publication, PublishError, PublishOutcome};
pub use session::{read_kernel_session_identity, SessionIdentity, UnverifiedReason};
pub use volume::{probe_volume, ProbeError};

/// Native ABI version of this addon's exports, independent of the package CalVer. The loader checks
/// the `__senpiSocketSecretAbi<N>` sentinel and rejects a binary built for a different surface.
pub const NATIVE_SOCKET_SECRET_ABI_VERSION: &str = "1";

#[napi(js_name = "__senpiSocketSecretAbi1")]
pub fn senpi_socket_secret_abi_sentinel() -> String {
    NATIVE_SOCKET_SECRET_ABI_VERSION.to_string()
}

#[napi(object)]
pub struct KernelSessionIdentity {
    /// `verified` or `unverified`.
    pub status: String,
    /// The System process creation FILETIME as a decimal string, so JavaScript keeps all 64 bits.
    pub creation_time: Option<String>,
    pub reason: Option<String>,
}

#[napi(js_name = "kernelSessionIdentity")]
pub fn kernel_session_identity() -> KernelSessionIdentity {
    match read_kernel_session_identity() {
        SessionIdentity::Verified(value) => KernelSessionIdentity {
            status: "verified".to_string(),
            creation_time: Some(value.to_string()),
            reason: None,
        },
        SessionIdentity::Unverified(reason) => KernelSessionIdentity {
            status: "unverified".to_string(),
            creation_time: None,
            reason: Some(reason.code().to_string()),
        },
    }
}

#[napi(object)]
pub struct VolumeLocality {
    /// `local` or `not_local`.
    pub locality: String,
    pub reason: Option<String>,
    pub reported_file_system: Option<String>,
    /// The raw query codes behind the verdict, for the caller's log; never part of the verdict.
    pub codes: Option<VolumeCodes>,
}

/// senpi#4354: the raw answers a field report needs to say which query failed and why. NTSTATUS
/// values are `0x`-prefixed 8-digit hex strings (lossless, and how Windows documents them).
#[napi(object)]
#[derive(Debug, PartialEq, Eq)]
pub struct VolumeCodes {
    pub ntfs_status: Option<String>,
    pub refs_status: Option<String>,
    pub device_status: Option<String>,
    /// The Win32 error of the remote-protocol query (0 when it answered).
    pub remote_protocol_error: Option<u32>,
    /// The Win32 error of the open, when the path could not be opened at all.
    pub open_error: Option<u32>,
}

/// Classifies the volume that holds `path` (a directory or file, opened following reparse points).
#[napi(js_name = "classifyVolume")]
pub fn classify_volume(path: String) -> VolumeLocality {
    volume_locality(probe_volume(&path))
}

/// The N-API answer for one probe result; pure, so every host tests it with fakes.
pub fn volume_locality(probe: Result<VolumeFacts, ProbeError>) -> VolumeLocality {
    let facts = match probe {
        Ok(facts) => facts,
        Err(ProbeError::UnsupportedPlatform) => return not_local("unsupported_platform", None, None),
        Err(ProbeError::OpenFailed(code)) => {
            let codes = VolumeCodes {
                ntfs_status: None,
                refs_status: None,
                device_status: None,
                remote_protocol_error: None,
                open_error: Some(code),
            };
            return not_local("open_failed", None, Some(codes));
        }
    };
    let raw = facts.codes;
    let codes = Some(VolumeCodes {
        ntfs_status: Some(ntstatus(raw.ntfs_status)),
        refs_status: Some(ntstatus(raw.refs_status)),
        device_status: Some(ntstatus(raw.device_status)),
        remote_protocol_error: Some(raw.remote_protocol_error),
        open_error: None,
    });
    match classify(&facts) {
        Locality::Local => VolumeLocality {
            locality: "local".to_string(),
            reason: None,
            reported_file_system: facts.reported_file_system,
            codes,
        },
        Locality::NotLocal(reason) => not_local(reason_code(reason), facts.reported_file_system, codes),
    }
}

fn not_local(
    reason: &str,
    reported_file_system: Option<String>,
    codes: Option<VolumeCodes>,
) -> VolumeLocality {
    VolumeLocality {
        locality: "not_local".to_string(),
        reason: Some(reason.to_string()),
        reported_file_system,
        codes,
    }
}

fn ntstatus(status: i32) -> String {
    format!("{:#010x}", status.cast_unsigned())
}

const fn reason_code(reason: NotLocalReason) -> &'static str {
    match reason {
        NotLocalReason::RemoteDevice => "remote_device",
        NotLocalReason::RemoteProtocol => "remote_protocol",
        NotLocalReason::UnlistedFileSystem => "unlisted_file_system",
        NotLocalReason::DriverNotInPath => "driver_not_in_path",
        NotLocalReason::QueryFailed => "query_failed",
    }
}

#[napi(object)]
pub struct PublishFailure {
    /// The Windows call that failed (`dacl`, `create_staging`, `write`, `write_zero`, `flush`, `rename`).
    pub step: String,
    /// Its `GetLastError` value.
    pub code: u32,
}

/// A staging file this attempt could not delete. It is still at `path`; the caller removes it.
#[napi(object)]
pub struct LeftBehindStaging {
    pub path: String,
    /// `GetLastError` of the failed `FileDispositionInfo` delete.
    pub windows_error: u32,
}

#[napi(object)]
pub struct PublishResult {
    /// `published`, `collision` or `failed`.
    pub outcome: String,
    /// Set when `outcome` is `failed`.
    pub failure: Option<PublishFailure>,
    pub staging_left_behind: Option<LeftBehindStaging>,
}

/// Publishes `bytes` at `finalPath` without replacing an existing entry, through a private staging file
/// at `stagingPath` in the same directory. Resolves `published`, `collision` (read the winner) or
/// `failed` with the failed step and Windows error; the final path is never written directly. Any
/// outcome can carry `stagingLeftBehind`. Throws only on a platform without the primitive.
#[napi(js_name = "publishNoReplace")]
pub fn publish_no_replace_js(
    staging_path: String,
    final_path: String,
    bytes: napi::bindgen_prelude::Buffer,
) -> napi::Result<PublishResult> {
    publish_result(
        publish_no_replace(&staging_path, &final_path, &bytes),
        &staging_path,
    )
}

fn publish_result(publication: Publication, staging_path: &str) -> napi::Result<PublishResult> {
    let (outcome, failure) = match publication.result {
        Ok(PublishOutcome::Published) => ("published", None),
        Ok(PublishOutcome::Collision) => ("collision", None),
        Err(PublishError::UnsupportedPlatform) => {
            return Err(napi::Error::from_reason("publishNoReplace: unsupported platform"));
        }
        Err(PublishError::Os { step, code }) => (
            "failed",
            Some(PublishFailure {
                step: step.to_string(),
                code,
            }),
        ),
    };
    Ok(PublishResult {
        outcome: outcome.to_string(),
        failure,
        staging_left_behind: publication
            .staging_left_behind
            .map(|windows_error| LeftBehindStaging {
                path: staging_path.to_string(),
                windows_error,
            }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(ntfs_status: i32) -> VolumeFacts {
        VolumeFacts {
            reported_file_system: Some("NTFS".to_string()),
            ntfs_driver: driver_path_from_query(ntfs_status, false),
            refs_driver: DriverPath::NotInPath,
            remote_device: RemoteDevice::Clear,
            remote_protocol: RemoteProtocol::Unavailable,
            codes: ProbeCodes {
                ntfs_status,
                refs_status: STATUS_OBJECT_NAME_NOT_FOUND,
                device_status: 0,
                remote_protocol_error: 87,
            },
        }
    }

    /// senpi#4354: a `query_failed` verdict carries the raw codes of every query.
    #[test]
    fn a_query_failed_verdict_carries_every_probe_code() {
        let answer = volume_locality(Ok(facts(0xC000_0022_u32.cast_signed())));
        assert_eq!(answer.reason.as_deref(), Some("query_failed"));
        assert_eq!(
            answer.codes,
            Some(VolumeCodes {
                ntfs_status: Some("0xc0000022".to_string()),
                refs_status: Some("0xc0000034".to_string()),
                device_status: Some("0x00000000".to_string()),
                remote_protocol_error: Some(87),
                open_error: None,
            })
        );
    }

    #[test]
    fn an_open_failure_carries_its_win32_code() {
        let answer = volume_locality(Err(ProbeError::OpenFailed(5)));
        assert_eq!(answer.reason.as_deref(), Some("open_failed"));
        assert_eq!(
            answer.codes,
            Some(VolumeCodes {
                ntfs_status: None,
                refs_status: None,
                device_status: None,
                remote_protocol_error: None,
                open_error: Some(5),
            })
        );
    }

    #[test]
    fn an_unsupported_platform_has_no_codes() {
        assert_eq!(volume_locality(Err(ProbeError::UnsupportedPlatform)).codes, None);
    }

    const STAGING: &str = r"C:\Users\u\AppData\Local\senpi\rpc.sock.secret.stage-a";

    #[test]
    fn a_collision_whose_staging_delete_failed_reports_the_leftover_path() {
        let report = Publication {
            result: Ok(PublishOutcome::Collision),
            staging_left_behind: Some(5),
        };
        let result = publish_result(report, STAGING).expect("collision resolves");
        assert_eq!(result.outcome, "collision");
        assert!(result.failure.is_none());
        let left = result.staging_left_behind.expect("leftover staging reported");
        assert_eq!(left.path, STAGING);
        assert_eq!(left.windows_error, 5);
    }

    #[test]
    fn an_os_failure_resolves_as_failed_and_keeps_the_leftover_staging() {
        let report = Publication {
            result: Err(PublishError::Os {
                step: "rename",
                code: 32,
            }),
            staging_left_behind: Some(5),
        };
        let result = publish_result(report, STAGING).expect("an OS failure is a typed result");
        assert_eq!(result.outcome, "failed");
        let failure = result.failure.expect("failure carried");
        assert_eq!((failure.step.as_str(), failure.code), ("rename", 32));
        assert_eq!(result.staging_left_behind.expect("leftover").path, STAGING);
    }

    #[test]
    fn a_clean_publication_reports_no_leftover() {
        let report = Publication {
            result: Ok(PublishOutcome::Published),
            staging_left_behind: None,
        };
        let result = publish_result(report, STAGING).expect("published");
        assert_eq!(result.outcome, "published");
        assert!(result.failure.is_none() && result.staging_left_behind.is_none());
    }

    #[test]
    fn an_unsupported_platform_still_throws() {
        let report = Publication {
            result: Err(PublishError::UnsupportedPlatform),
            staging_left_behind: None,
        };
        assert!(publish_result(report, STAGING).is_err());
    }
}
