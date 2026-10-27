//! N-API surface of the Windows process-identity adapter (`process_handle.rs`), for the #4199 design's
//! grant-time and recovery-time process evidence (4.2a "OS identity"; "Process evidence and the
//! kernel-session gate (Revision 8)", clause (ii)). `processOpen` opens a PID once, reads `GetProcessId`,
//! the creation FILETIME, the `TokenUser` SID and the exit state on that ONE handle, and RETAINS the handle
//! in a process-rooted registry under the caller's handle ID, so an issuer keeps the handle it verified on
//! while it grants and observes that participant; `processObserve` rereads the same handle;
//! `processClose` is the only release. JS owns no HANDLE and GC never closes one. The facts are raw: the
//! live / gone / unknown rule over them is the caller's (`process_identity.rs` in Rust, the TypeScript
//! classifier in `process-evidence.ts`).
use napi_derive::napi;

#[napi(object)]
#[derive(Debug)]
pub struct ProcessObservationResult {
    /// `opened` (the facts below), `no_such_process`, `access_denied`, `failed` (`code`), `held` (the
    /// handle ID is in use), `not_held`, `closed`, or `unavailable` (`reason` `unsupported_platform`).
    pub status: String,
    pub reason: Option<String>,
    pub code: Option<u32>,
    /// `GetProcessId` on the opened handle; `None` when that query failed.
    pub handle_pid: Option<u32>,
    /// The complete 64-bit creation FILETIME as a decimal string, never rounded.
    pub creation_time: Option<String>,
    pub user_sid: Option<String>,
    /// Whether the process object is signalled; `None` when the wait failed.
    pub exited: Option<bool>,
}

fn plain(status: &str, reason: Option<&str>, code: Option<u32>) -> ProcessObservationResult {
    ProcessObservationResult {
        status: status.into(),
        reason: reason.map(str::to_string),
        code,
        handle_pid: None,
        creation_time: None,
        user_sid: None,
        exited: None,
    }
}

#[cfg(not(windows))]
fn unavailable() -> ProcessObservationResult {
    plain("unavailable", Some("unsupported_platform"), None)
}

#[cfg(windows)]
mod windows {
    use super::{plain, ProcessObservationResult};
    use crate::process_handle::{OpenError, RetainedProcess};
    use crate::process_identity::ProcessFacts;
    use std::collections::BTreeMap;
    use std::sync::{Mutex, OnceLock};

    fn registry() -> &'static Mutex<BTreeMap<String, RetainedProcess>> {
        static REGISTRY: OnceLock<Mutex<BTreeMap<String, RetainedProcess>>> = OnceLock::new();
        REGISTRY.get_or_init(Mutex::default)
    }

    fn opened(facts: ProcessFacts) -> ProcessObservationResult {
        ProcessObservationResult {
            status: "opened".into(),
            reason: None,
            code: None,
            handle_pid: facts.handle_pid,
            creation_time: facts.creation_time.map(|value| value.to_string()),
            user_sid: facts.user_sid,
            exited: facts.exited,
        }
    }

    pub fn open(handle_id: String, pid: u32) -> ProcessObservationResult {
        let mut retained = registry().lock().unwrap();
        if retained.contains_key(&handle_id) {
            return plain("held", Some("handle_in_use"), None);
        }
        match RetainedProcess::open(pid) {
            Ok(process) => {
                let result = opened(process.facts());
                retained.insert(handle_id, process);
                result
            }
            Err(OpenError::NoSuchProcess) => plain("no_such_process", None, None),
            Err(OpenError::AccessDenied) => plain("access_denied", None, None),
            Err(OpenError::UnsupportedPlatform) => plain("unavailable", Some("unsupported_platform"), None),
            Err(OpenError::Other(code)) => plain("failed", Some("open_process"), Some(code)),
        }
    }

    pub fn observe(handle_id: &str) -> ProcessObservationResult {
        match registry().lock().unwrap().get(handle_id) {
            Some(process) => opened(process.facts()),
            None => plain("not_held", None, None),
        }
    }

    pub fn close(handle_id: &str) -> ProcessObservationResult {
        match registry().lock().unwrap().remove(handle_id) {
            Some(_process) => plain("closed", None, None),
            None => plain("not_held", None, None),
        }
    }
}

/// Opens `pid` on this kernel, reads its facts on that handle and retains the handle under `handle_id`.
#[napi(js_name = "processOpen")]
pub fn process_open(handle_id: String, pid: u32) -> ProcessObservationResult {
    #[cfg(windows)]
    {
        windows::open(handle_id, pid)
    }
    #[cfg(not(windows))]
    {
        let _ = (handle_id, pid);
        unavailable()
    }
}

/// Rereads the facts on the handle retained under `handle_id`: a fresh observation of that exact instance.
#[napi(js_name = "processObserve")]
pub fn process_observe(handle_id: String) -> ProcessObservationResult {
    #[cfg(windows)]
    {
        windows::observe(&handle_id)
    }
    #[cfg(not(windows))]
    {
        let _ = handle_id;
        unavailable()
    }
}

/// Closes the handle retained under `handle_id`; the only way a retained handle is released.
#[napi(js_name = "processClose")]
pub fn process_close(handle_id: String) -> ProcessObservationResult {
    #[cfg(windows)]
    {
        windows::close(&handle_id)
    }
    #[cfg(not(windows))]
    {
        let _ = handle_id;
        unavailable()
    }
}
