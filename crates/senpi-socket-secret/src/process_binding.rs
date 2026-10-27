//! N-API surface of the Windows process-identity adapter (`process_handle.rs`), for the #4199 design's
//! grant-time and recovery-time process evidence (4.2a "OS identity"; "Process evidence and the
//! kernel-session gate (Revision 8)", clause (ii)). `processOpen` opens a PID once, reads `GetProcessId`,
//! the creation FILETIME, the `TokenUser` SID and the exit state on that ONE handle, and RETAINS the handle
//! in a process-rooted registry under the caller's handle ID, so an issuer keeps the handle it verified on
//! while it grants and observes that participant; `processObserve` rereads the same handle;
//! `processClose` is the only release. JS owns no HANDLE and GC never closes one. The facts are raw: the
//! live / gone / unknown rule over them is the caller's (`process_identity.rs` in Rust, the TypeScript
//! classifier in `process-evidence.ts`).
//!
//! `processWaitExit` is the design's "process-object signalling for exit (`RegisterWaitForSingleObject` or
//! equivalent), not wrapper exit": a dedicated thread waits on a duplicate of the retained handle, so the
//! supervisor learns its host's death from the kernel object, never from a wrapper's exit event. The wait
//! ends with the object's signal (`exited`, with `GetExitCodeProcess`), `processCancelWaitExit` on its wait
//! ID (`cancelled`), or the close of the retained handle (`cancelled`). It never polls.
use napi::bindgen_prelude::{Env, JsValue, PromiseRaw};
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
    /// `GetExitCodeProcess` of a signalled object (`processWaitExit` `exited`); `None` when unreadable.
    pub exit_code: Option<u32>,
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
        exit_code: None,
    }
}

/// A blocking wait for the exit of a retained process, registered under its wait ID until it ends.
#[cfg(windows)]
pub use windows::ExitWaiter;

/// Uninhabited off Windows: `begin_exit_wait` always answers `unavailable`, so no value exists.
#[cfg(not(windows))]
#[derive(Debug)]
pub enum ExitWaiter {}

#[cfg(not(windows))]
impl ExitWaiter {
    pub fn wait(self) -> ProcessObservationResult {
        match self {}
    }
}

/// Registers an exit wait on the handle retained under `handle_id`: `held` (`wait_pending`) when the wait ID
/// is in use, `not_held` when no handle is, `failed` (`code`) when the wait handle or its cancel event could
/// not be created. The returned waiter blocks on `wait`; its end (or its drop) unregisters the wait ID.
pub fn begin_exit_wait(
    handle_id: String,
    wait_id: String,
) -> Result<ExitWaiter, Box<ProcessObservationResult>> {
    #[cfg(windows)]
    {
        windows::begin_exit_wait(handle_id, wait_id)
    }
    #[cfg(not(windows))]
    {
        let _ = (handle_id, wait_id);
        Err(Box::new(unavailable()))
    }
}

/// Cancels the exit wait registered under `wait_id`, if any: it answers `cancelled`.
#[napi(js_name = "processCancelWaitExit")]
pub fn process_cancel_wait_exit(wait_id: String) {
    #[cfg(windows)]
    {
        windows::cancel_exit_wait(&wait_id)
    }
    #[cfg(not(windows))]
    {
        let _ = wait_id;
    }
}

#[cfg(not(windows))]
fn unavailable() -> ProcessObservationResult {
    plain("unavailable", Some("unsupported_platform"), None)
}

#[cfg(windows)]
mod windows {
    use super::{plain, ProcessObservationResult};
    use crate::process_handle::{CancelEvent, ExitSignal, OpenError, ProcessWaitHandle, RetainedProcess};
    use crate::process_identity::ProcessFacts;
    use std::collections::BTreeMap;
    use std::sync::{Arc, Mutex, OnceLock};

    fn registry() -> &'static Mutex<BTreeMap<String, RetainedProcess>> {
        static REGISTRY: OnceLock<Mutex<BTreeMap<String, RetainedProcess>>> = OnceLock::new();
        REGISTRY.get_or_init(Mutex::default)
    }

    struct PendingExitWait {
        handle_id: String,
        cancel: Arc<CancelEvent>,
    }

    /// Wait ID -> the pending exit wait; a cancel or the close of its handle sets the event.
    fn exit_waits() -> &'static Mutex<BTreeMap<String, PendingExitWait>> {
        static WAITS: OnceLock<Mutex<BTreeMap<String, PendingExitWait>>> = OnceLock::new();
        WAITS.get_or_init(Mutex::default)
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
            exit_code: None,
        }
    }

    /// A registered exit wait: its own duplicate of the process handle and its cancel event.
    pub struct ExitWaiter {
        wait_id: String,
        process: ProcessWaitHandle,
        cancel: Arc<CancelEvent>,
    }

    impl std::fmt::Debug for ExitWaiter {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter
                .debug_struct("ExitWaiter")
                .field("wait_id", &self.wait_id)
                .finish()
        }
    }

    impl ExitWaiter {
        /// Blocks until the process object or the cancel event is signalled; the wait ID is free once it returns.
        pub fn wait(self) -> ProcessObservationResult {
            match self.process.wait_exit_or(&self.cancel) {
                ExitSignal::Exited { exit_code } => ProcessObservationResult {
                    exit_code,
                    ..plain("exited", None, None)
                },
                ExitSignal::Cancelled => plain("cancelled", None, None),
                ExitSignal::Failed(code) => plain("failed", Some("wait"), Some(code)),
            }
        }
    }

    impl Drop for ExitWaiter {
        fn drop(&mut self) {
            exit_waits().lock().unwrap().remove(&self.wait_id);
        }
    }

    pub fn begin_exit_wait(
        handle_id: String,
        wait_id: String,
    ) -> Result<ExitWaiter, Box<ProcessObservationResult>> {
        let mut waits = exit_waits().lock().unwrap();
        if waits.contains_key(&wait_id) {
            return Err(Box::new(plain("held", Some("wait_pending"), None)));
        }
        let process = {
            let retained = registry().lock().unwrap();
            let Some(process) = retained.get(&handle_id) else {
                return Err(Box::new(plain("not_held", None, None)));
            };
            process
                .duplicate_for_wait()
                .map_err(|code| Box::new(plain("failed", Some("duplicate_handle"), Some(code))))?
        };
        let cancel = Arc::new(
            CancelEvent::new().map_err(|code| Box::new(plain("failed", Some("create_event"), Some(code))))?,
        );
        waits.insert(
            wait_id.clone(),
            PendingExitWait {
                handle_id,
                cancel: Arc::clone(&cancel),
            },
        );
        Ok(ExitWaiter {
            wait_id,
            process,
            cancel,
        })
    }

    pub fn cancel_exit_wait(wait_id: &str) {
        if let Some(wait) = exit_waits().lock().unwrap().get(wait_id) {
            wait.cancel.set();
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
            Some(_process) => {
                // The closed handle's pending waits end as cancelled: their duplicates are released with them.
                for wait in exit_waits().lock().unwrap().values() {
                    if wait.handle_id == handle_id {
                        wait.cancel.set();
                    }
                }
                plain("closed", None, None)
            }
            None => plain("not_held", None, None),
        }
    }
}

/// Resolves once the process object retained under `handle_id` is signalled (`exited`, with its exit code),
/// the wait is cancelled through `wait_id` or the handle is closed (`cancelled`); `not_held`, `held`
/// (`wait_pending`), `failed` or `unavailable` at once.
#[napi(js_name = "processWaitExit")]
pub fn process_wait_exit<'env>(
    env: &'env Env,
    handle_id: String,
    wait_id: String,
) -> napi::Result<PromiseRaw<'env, ProcessObservationResult>> {
    let (deferred, promise) = env.create_deferred::<ProcessObservationResult, Settle>()?;
    match begin_exit_wait(handle_id, wait_id) {
        Err(result) => deferred.resolve(settle(*result)),
        Ok(waiter) => {
            std::thread::Builder::new()
                .name("senpi-socket-secret-exit-wait".to_string())
                .spawn(move || {
                    // The wait ID is free before the promise settles: a caller may register the next wait at once.
                    let result = waiter.wait();
                    deferred.resolve(settle(result));
                })
                .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        }
    }
    Ok(PromiseRaw::new(env.raw(), promise.raw()))
}

type Settle = Box<dyn FnOnce(Env) -> napi::Result<ProcessObservationResult> + Send>;

fn settle(result: ProcessObservationResult) -> Settle {
    Box::new(move |_env| Ok(result))
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
