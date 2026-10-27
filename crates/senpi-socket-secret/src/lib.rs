use napi_derive::napi;

pub mod answers;
pub mod classify;
pub mod session;
pub mod volume;

pub use answers::{
    driver_path_from_query, remote_protocol_from_query, ProbeCodes, REMOTE_PROTOCOL_NO_INFORMATION_ERRORS,
    STATUS_OBJECT_NAME_NOT_FOUND,
};
pub use classify::{
    classify, DriverPath, Locality, NotLocalReason, RemoteDevice, RemoteProtocol, VolumeFacts,
};
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
}

/// Classifies the volume that holds `path` (a directory or file, opened following reparse points).
#[napi(js_name = "classifyVolume")]
pub fn classify_volume(path: String) -> VolumeLocality {
    let facts = match probe_volume(&path) {
        Ok(facts) => facts,
        Err(ProbeError::UnsupportedPlatform) => return not_local("unsupported_platform", None),
        Err(ProbeError::OpenFailed(_)) => return not_local("open_failed", None),
    };
    match classify(&facts) {
        Locality::Local => VolumeLocality {
            locality: "local".to_string(),
            reason: None,
            reported_file_system: facts.reported_file_system,
        },
        Locality::NotLocal(reason) => not_local(reason_code(reason), facts.reported_file_system),
    }
}

fn not_local(reason: &str, reported_file_system: Option<String>) -> VolumeLocality {
    VolumeLocality {
        locality: "not_local".to_string(),
        reason: Some(reason.to_string()),
        reported_file_system,
    }
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
