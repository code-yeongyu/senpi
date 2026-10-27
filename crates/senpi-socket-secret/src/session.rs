//! The Windows kernel-session identity of the #4199 design: the creation FILETIME of the System
//! process (PID 4). It is fixed for the life of a kernel session, survives hibernate and Fast Startup
//! like the kernel's lock table, and changes after a full restart. A value that cannot be read or
//! verified is `Unverified`, which never equals anything (design clause (iv)).

/// Deliberately not `PartialEq`: a derived equality would make two `Unverified` values equal.
#[derive(Clone, Copy, Debug)]
pub enum SessionIdentity {
    /// The complete 64-bit creation FILETIME, kept lossless.
    Verified(u64),
    Unverified(UnverifiedReason),
}

impl SessionIdentity {
    /// True only when both identities are verified and equal; `Unverified` matches nothing,
    /// another `Unverified` included.
    pub const fn same_session(self, other: Self) -> bool {
        match (self, other) {
            (Self::Verified(left), Self::Verified(right)) => left == right,
            _ => false,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnverifiedReason {
    UnsupportedPlatform,
    AccessDenied,
    OpenFailed,
    ProcessIdMismatch,
    TimesUnreadable,
    ZeroCreationTime,
}

impl UnverifiedReason {
    pub const fn code(self) -> &'static str {
        match self {
            Self::UnsupportedPlatform => "unsupported_platform",
            Self::AccessDenied => "access_denied",
            Self::OpenFailed => "open_failed",
            Self::ProcessIdMismatch => "process_id_mismatch",
            Self::TimesUnreadable => "times_unreadable",
            Self::ZeroCreationTime => "zero_creation_time",
        }
    }
}

#[cfg(windows)]
const SYSTEM_PROCESS_ID: u32 = 4;

#[cfg(not(windows))]
pub fn read_kernel_session_identity() -> SessionIdentity {
    SessionIdentity::Unverified(UnverifiedReason::UnsupportedPlatform)
}

#[cfg(windows)]
pub fn read_kernel_session_identity() -> SessionIdentity {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ACCESS_DENIED, FILETIME};
    use windows_sys::Win32::System::Threading::{
        GetProcessId, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    // SAFETY: OpenProcess takes no pointers; a null return is a failure with a thread error code.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, SYSTEM_PROCESS_ID) };
    if handle.is_null() {
        // SAFETY: reads this thread's last-error value, set by the failed OpenProcess above.
        let reason = if unsafe { GetLastError() } == ERROR_ACCESS_DENIED {
            UnverifiedReason::AccessDenied
        } else {
            UnverifiedReason::OpenFailed
        };
        return SessionIdentity::Unverified(reason);
    }
    let identity = (|| {
        // SAFETY: `handle` is a live process handle owned by this function until CloseHandle below.
        if unsafe { GetProcessId(handle) } != SYSTEM_PROCESS_ID {
            return SessionIdentity::Unverified(UnverifiedReason::ProcessIdMismatch);
        }
        let zero = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
        // SAFETY: the four out-pointers name distinct, writable, properly aligned FILETIME locals.
        let read = unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) };
        if read == 0 {
            return SessionIdentity::Unverified(UnverifiedReason::TimesUnreadable);
        }
        let value = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
        if value == 0 {
            return SessionIdentity::Unverified(UnverifiedReason::ZeroCreationTime);
        }
        SessionIdentity::Verified(value)
    })();
    // SAFETY: `handle` came from OpenProcess above and is closed exactly once.
    unsafe { CloseHandle(handle) };
    identity
}

#[cfg(test)]
mod tests {
    use super::{SessionIdentity, UnverifiedReason};

    // Design clause (iv): `unverified` equals nothing, another `unverified` included.
    #[test]
    fn only_two_equal_verified_identities_are_the_same_session() {
        let s1 = SessionIdentity::Verified(134_000_000_000_000_000);
        let s2 = SessionIdentity::Verified(134_000_000_000_000_001);
        let denied = SessionIdentity::Unverified(UnverifiedReason::AccessDenied);
        assert!(s1.same_session(s1));
        assert!(!s1.same_session(s2));
        assert!(!s1.same_session(denied));
        assert!(!denied.same_session(s1));
        assert!(!denied.same_session(denied));
    }
}
