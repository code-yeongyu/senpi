//! The Windows process-identity adapter of the #4199 design (4.2a "OS identity"): one retained,
//! non-inheritable handle from `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE)`, and
//! `GetProcessId`, the creation FILETIME, the `TokenUser` SID and the exit state all read on that same
//! handle. Exit is observed by waiting on the process object, never by a wrapper's exit.

use crate::process_identity::{Observation, ProcessFacts};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenError {
    UnsupportedPlatform,
    /// `ERROR_INVALID_PARAMETER`: no process has this PID.
    NoSuchProcess,
    AccessDenied,
    Other(u32),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExitWait {
    Exited,
    TimedOut,
    Failed(u32),
}

/// Reopens `pid` once and reports what it observed; the handle is closed before returning.
pub fn observe_pid(pid: u32) -> Observation {
    match RetainedProcess::open(pid) {
        Ok(process) => Observation::Opened(process.facts()),
        Err(OpenError::NoSuchProcess) => Observation::NoSuchProcess,
        Err(OpenError::AccessDenied) => Observation::AccessDenied,
        Err(OpenError::UnsupportedPlatform) => Observation::OpenFailed(0),
        Err(OpenError::Other(code)) => Observation::OpenFailed(code),
    }
}

pub use imp::RetainedProcess;

#[cfg(not(windows))]
mod imp {
    use super::{ExitWait, OpenError, ProcessFacts};

    /// Uninhabited off Windows: `open` always fails, so no value exists.
    #[derive(Debug)]
    pub enum RetainedProcess {}

    impl RetainedProcess {
        pub const fn open(_pid: u32) -> Result<Self, OpenError> {
            Err(OpenError::UnsupportedPlatform)
        }

        pub const fn facts(&self) -> ProcessFacts {
            match *self {}
        }

        pub const fn wait_for_exit(&self, _timeout_ms: u32) -> ExitWait {
            match *self {}
        }
    }
}

#[cfg(windows)]
mod imp {
    use super::{ExitWait, OpenError, ProcessFacts};
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, LocalFree, ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER, FILETIME, HANDLE,
        WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows_sys::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
    use windows_sys::Win32::System::Threading::{
        GetProcessId, GetProcessTimes, OpenProcess, OpenProcessToken, WaitForSingleObject,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    };

    struct OwnedHandle(HANDLE);

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            // SAFETY: the handle came from a successful open call and is closed exactly once here.
            unsafe { CloseHandle(self.0) };
        }
    }

    /// A process handle this process holds while it grants or observes that participant.
    pub struct RetainedProcess {
        handle: OwnedHandle,
    }

    impl std::fmt::Debug for RetainedProcess {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("RetainedProcess")
        }
    }

    impl RetainedProcess {
        pub fn open(pid: u32) -> Result<Self, OpenError> {
            let access = PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE;
            // SAFETY: OpenProcess takes no pointers; `0` asks for a non-inheritable handle.
            let raw = unsafe { OpenProcess(access, 0, pid) };
            if raw.is_null() {
                // SAFETY: reads this thread's last-error value, set by the failed OpenProcess above.
                return Err(match unsafe { GetLastError() } {
                    ERROR_INVALID_PARAMETER => OpenError::NoSuchProcess,
                    ERROR_ACCESS_DENIED => OpenError::AccessDenied,
                    code => OpenError::Other(code),
                });
            }
            Ok(Self {
                handle: OwnedHandle(raw),
            })
        }

        pub fn facts(&self) -> ProcessFacts {
            let handle = self.handle.0;
            // SAFETY: `handle` is a live process handle owned by `self`.
            let pid = unsafe { GetProcessId(handle) };
            ProcessFacts {
                handle_pid: (pid != 0).then_some(pid),
                creation_time: creation_time(handle),
                user_sid: user_sid(handle),
                exited: match self.wait_for_exit(0) {
                    ExitWait::Exited => Some(true),
                    ExitWait::TimedOut => Some(false),
                    ExitWait::Failed(_) => None,
                },
            }
        }

        /// Waits up to `timeout_ms` for the process object to be signalled (`u32::MAX` is infinite).
        pub fn wait_for_exit(&self, timeout_ms: u32) -> ExitWait {
            // SAFETY: `handle` is a live process handle opened with SYNCHRONIZE access.
            match unsafe { WaitForSingleObject(self.handle.0, timeout_ms) } {
                WAIT_OBJECT_0 => ExitWait::Exited,
                WAIT_TIMEOUT => ExitWait::TimedOut,
                // SAFETY: reads this thread's last-error value after a failed wait.
                _ => ExitWait::Failed(unsafe { GetLastError() }),
            }
        }
    }

    fn creation_time(handle: HANDLE) -> Option<u64> {
        let zero = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
        // SAFETY: the four out-pointers name distinct, writable, properly aligned FILETIME locals.
        let read = unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) };
        let value = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
        (read != 0 && value != 0).then_some(value)
    }

    fn user_sid(process: HANDLE) -> Option<String> {
        let mut raw_token: HANDLE = std::ptr::null_mut();
        // SAFETY: `process` is live; the out-pointer names a writable HANDLE local.
        if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut raw_token) } == 0 {
            return None;
        }
        let token = OwnedHandle(raw_token);
        let mut needed = 0u32;
        // SAFETY: a null buffer of length 0 asks only for the required size, written to `needed`.
        unsafe { GetTokenInformation(token.0, TokenUser, std::ptr::null_mut(), 0, &mut needed) };
        if needed == 0 {
            return None;
        }
        let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
        // SAFETY: `buffer` is 8-byte aligned and spans at least `needed` bytes.
        let ok = unsafe {
            GetTokenInformation(
                token.0,
                TokenUser,
                buffer.as_mut_ptr().cast(),
                needed,
                &mut needed,
            )
        };
        if ok == 0 {
            return None;
        }
        // SAFETY: on success the buffer starts with a TOKEN_USER whose SID points inside the buffer.
        let sid = unsafe { (*buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid };
        let mut text: *mut u16 = std::ptr::null_mut();
        // SAFETY: `sid` is a valid SID for the life of `buffer`; `text` receives a LocalAlloc string.
        if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 || text.is_null() {
            return None;
        }
        // SAFETY: `text` is a NUL-terminated UTF-16 string from ConvertSidToStringSidW.
        let length = (0..)
            .take_while(|&index| unsafe { *text.add(index) } != 0)
            .count();
        // SAFETY: `text` holds `length` readable UTF-16 units before its terminator.
        let value = String::from_utf16(unsafe { std::slice::from_raw_parts(text, length) }).ok();
        // SAFETY: `text` was allocated by ConvertSidToStringSidW and is freed exactly once.
        unsafe { LocalFree(text.cast()) };
        value
    }
}
