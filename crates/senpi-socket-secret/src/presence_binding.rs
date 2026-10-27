//! Process-rooted presence guards. JS owns no descriptor and GC cannot release authority.
//! Callers supply paths and persisted bindings; placement and reservation transactions live above
//! this bridge. Only a committed `released` receipt closes a retained guard.
use crate::presence::CancelToken;
use napi::bindgen_prelude::{AsyncTask, Buffer};
use napi_derive::napi;
use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};

#[napi(object)]
#[derive(Debug)]
pub struct PresenceResult {
    pub status: String,
    pub reason: Option<String>,
    pub code: Option<u32>,
}

fn result(status: &str, reason: Option<&str>, code: Option<u32>) -> PresenceResult {
    PresenceResult {
        status: status.into(),
        reason: reason.map(str::to_string),
        code,
    }
}

#[napi(object)]
pub struct PresenceProbe {
    pub presence_id: String,
    pub path: String,
    pub tag: Buffer,
    /// Decimal strings preserve the full native file identity.
    pub volume_serial: String,
    pub file_id: String,
    pub created_local: bool,
    pub relocated: bool,
    pub kernel_session: Option<String>,
}

#[napi(object)]
pub struct ReleasedReceipt {
    pub presence_id: String,
    pub state: String,
}

#[cfg(not(windows))]
fn unavailable() -> PresenceResult {
    result("unavailable", Some("unsupported_platform"), None)
}

struct PendingWait {
    #[cfg(windows)]
    presence_id: String,
    cancel: CancelToken,
}

fn waits() -> &'static Mutex<BTreeMap<String, PendingWait>> {
    static WAITS: OnceLock<Mutex<BTreeMap<String, PendingWait>>> = OnceLock::new();
    WAITS.get_or_init(Mutex::default)
}

#[cfg(windows)]
mod windows {
    use super::*;
    use crate::presence::{
        FenceReason, LockAttempt, PresenceBackend, PresenceRegistry, QuiescenceReceipt, WaitOutcome,
    };
    use crate::presence_windows::WindowsPresenceBackend;

    pub(super) type Registry = PresenceRegistry<WindowsPresenceBackend>;

    pub(super) fn registry() -> &'static Mutex<Registry> {
        static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
        REGISTRY.get_or_init(|| Mutex::new(Registry::new(WindowsPresenceBackend)))
    }

    pub(super) fn attempt(attempt: LockAttempt) -> PresenceResult {
        match attempt {
            LockAttempt::Acquired => result("acquired", None, None),
            LockAttempt::Occupied => result("occupied", None, None),
            LockAttempt::Unknown(code) => result("unknown", Some("os_error"), Some(code)),
            LockAttempt::Fenced => result("fenced", Some("registry_fenced"), None),
        }
    }

    pub(super) fn waited(outcome: WaitOutcome) -> PresenceResult {
        match outcome {
            WaitOutcome::Acquired => result("acquired", None, None),
            WaitOutcome::Cancelled => result("cancelled", None, None),
            WaitOutcome::Unknown(code) => result("unknown", Some("os_error"), Some(code)),
            WaitOutcome::Fenced => result("fenced", Some("registry_fenced"), None),
        }
    }

    pub(super) fn checked(check: Result<(), FenceReason>) -> PresenceResult {
        match check {
            Ok(()) => result("valid", None, None),
            Err(reason) => {
                let (reason, code) = match reason {
                    FenceReason::NotHeld => ("not_held", None),
                    FenceReason::HandleLost(code) => ("handle_lost", Some(code)),
                    FenceReason::IdentityChanged => ("identity_changed", None),
                    FenceReason::PathUnreadable(code) => ("path_unreadable", Some(code)),
                    FenceReason::NotLocal => ("not_local", None),
                };
                result("fenced", Some(reason), code)
            }
        }
    }

    /// Admissibility rules 1-3 (design 4.2a Revision 7) against an opened handle of the object.
    fn admissible(
        request: &PresenceProbe,
    ) -> impl FnOnce(
        &mut WindowsPresenceBackend,
        &<WindowsPresenceBackend as PresenceBackend>::Handle,
        crate::presence::FileIdentity,
    ) -> bool
           + '_ {
        |backend, handle, identity| {
            let identity_matches = request.volume_serial.parse::<u64>().ok() == Some(identity.volume_serial)
                && request.file_id.parse::<u128>().ok() == Some(identity.file_id)
                && backend.path_identity(&request.path).ok() == Some(identity);
            let session_matches = !request.relocated
                || request
                    .kernel_session
                    .as_deref()
                    .and_then(|s| s.parse::<u64>().ok())
                    .is_some_and(|recorded| {
                        crate::read_kernel_session_identity()
                            .same_session(crate::SessionIdentity::Verified(recorded))
                    });
            identity_matches
                && handle.tag_matches(&request.tag)
                && request.created_local
                && handle.is_local()
                && session_matches
        }
    }

    pub(super) fn probe(request: PresenceProbe) -> PresenceResult {
        let mut registry = registry().lock().unwrap();
        let attempt = registry.probe(&request.presence_id, &request.path, admissible(&request));
        match attempt {
            LockAttempt::Unknown(13) => result("unknown", Some("inadmissible"), None),
            other => self::attempt(other),
        }
    }

    /// The same rules applied to the guard a blocking wait retained, through that handle.
    pub(super) fn probe_retained(request: PresenceProbe) -> PresenceResult {
        let mut registry = registry().lock().unwrap();
        let attempt = registry.probe_retained(&request.presence_id, &request.path, admissible(&request));
        match attempt {
            LockAttempt::Unknown(13) => result("unknown", Some("inadmissible"), None),
            LockAttempt::Unknown(2) => result("unknown", Some("not_held"), None),
            other => self::attempt(other),
        }
    }

    pub(super) fn release(receipt: ReleasedReceipt) -> PresenceResult {
        if receipt.state != "released" {
            return result("unknown", Some("quiescence_required"), None);
        }
        if registry()
            .lock()
            .unwrap()
            .release_after_quiescence(QuiescenceReceipt {
                presence_id: receipt.presence_id,
            })
        {
            result("released", None, None)
        } else {
            result("unknown", Some("not_held"), None)
        }
    }
}

#[napi(js_name = "presenceAcquire")]
pub fn presence_acquire(presence_id: String, path: String) -> PresenceResult {
    #[cfg(windows)]
    {
        let pending = waits().lock().unwrap();
        if pending.values().any(|wait| wait.presence_id == presence_id) {
            return result("unknown", Some("wait_pending"), None);
        }
        windows::attempt(windows::registry().lock().unwrap().acquire(&presence_id, &path))
    }
    #[cfg(not(windows))]
    {
        let _ = (presence_id, path);
        unavailable()
    }
}

#[napi(js_name = "presenceProbe")]
pub fn presence_probe(request: PresenceProbe) -> PresenceResult {
    #[cfg(windows)]
    {
        windows::probe(request)
    }
    #[cfg(not(windows))]
    {
        let _ = request;
        unavailable()
    }
}

#[napi(js_name = "presenceProbeRetained")]
pub fn presence_probe_retained(request: PresenceProbe) -> PresenceResult {
    #[cfg(windows)]
    {
        windows::probe_retained(request)
    }
    #[cfg(not(windows))]
    {
        let _ = request;
        unavailable()
    }
}

#[napi(js_name = "presencePreActionCheck")]
pub fn presence_pre_action_check(presence_id: String) -> PresenceResult {
    #[cfg(windows)]
    {
        windows::checked(
            windows::registry()
                .lock()
                .unwrap()
                .pre_action_check_with(&presence_id, |_, handle| handle.is_local()),
        )
    }
    #[cfg(not(windows))]
    {
        let _ = presence_id;
        unavailable()
    }
}

#[napi(js_name = "presenceReleaseAfterQuiescence")]
pub fn presence_release_after_quiescence(receipt: ReleasedReceipt) -> PresenceResult {
    #[cfg(windows)]
    {
        windows::release(receipt)
    }
    #[cfg(not(windows))]
    {
        let _ = receipt;
        unavailable()
    }
}

pub struct PresenceWait {
    wait_id: String,
    presence_id: String,
    path: String,
    cancel: CancelToken,
    registered: bool,
}

impl napi::Task for PresenceWait {
    type Output = PresenceResult;
    type JsValue = PresenceResult;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        #[cfg(windows)]
        {
            use crate::presence::{PresenceRegistry, WaitOutcome};
            use crate::presence_windows::WindowsPresenceBackend;
            if !self.registered {
                return Ok(result("unknown", Some("wait_pending"), None));
            }
            {
                let mut registry = windows::registry().lock().unwrap();
                if registry.fenced().is_some() || registry.holds(&self.presence_id) {
                    let result = if registry.fenced().is_some() {
                        result("fenced", Some("registry_fenced"), None)
                    } else {
                        windows::attempt(registry.acquire(&self.presence_id, &self.path))
                    };
                    drop(registry);
                    waits().lock().unwrap().remove(&self.wait_id);
                    return Ok(result);
                }
            }
            let mut completed = PresenceRegistry::new(WindowsPresenceBackend);
            let outcome = completed.wait_and_acquire(&self.presence_id, &self.path, &self.cancel);
            let outcome = if outcome == WaitOutcome::Acquired {
                windows::registry()
                    .lock()
                    .unwrap()
                    .retain_wait(completed, &self.presence_id)
            } else {
                outcome
            };
            waits().lock().unwrap().remove(&self.wait_id);
            Ok(windows::waited(outcome))
        }
        #[cfg(not(windows))]
        {
            let _ = (
                &self.wait_id,
                &self.presence_id,
                &self.path,
                &self.cancel,
                self.registered,
            );
            Ok(unavailable())
        }
    }

    fn resolve(&mut self, _env: napi::Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(js_name = "presenceWaitAndAcquire")]
pub fn presence_wait_and_acquire(
    presence_id: String,
    path: String,
    wait_id: String,
) -> AsyncTask<PresenceWait> {
    let cancel = CancelToken::default();
    #[cfg(windows)]
    let registered = {
        let mut waits = waits().lock().unwrap();
        if waits.contains_key(&wait_id) || waits.values().any(|wait| wait.presence_id == presence_id) {
            false
        } else {
            waits.insert(
                wait_id.clone(),
                PendingWait {
                    presence_id: presence_id.clone(),
                    cancel: cancel.clone(),
                },
            );
            true
        }
    };
    #[cfg(not(windows))]
    let registered = false;
    AsyncTask::new(PresenceWait {
        wait_id,
        presence_id,
        path,
        cancel,
        registered,
    })
}

#[napi(js_name = "presenceCancelWait")]
pub fn presence_cancel_wait(wait_id: String) {
    if let Some(wait) = waits().lock().unwrap().get(&wait_id) {
        wait.cancel.cancel();
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use crate::presence::{LockAttempt, PresenceRegistry, QuiescenceReceipt};
    use crate::presence_windows::WindowsPresenceBackend;
    use napi::Task;

    #[test]
    fn native_cancel_reaches_a_registered_wait_before_the_worker_starts() {
        let id = "binding-cancel-before-worker".to_string();
        let cancel = CancelToken::default();
        waits().lock().unwrap().insert(
            id.clone(),
            PendingWait {
                presence_id: id.clone(),
                cancel: cancel.clone(),
            },
        );
        presence_cancel_wait(id.clone());
        let path = std::env::temp_dir().join(format!("binding-cancel-{}.lock", std::process::id()));
        std::fs::write(&path, b"tag").unwrap();
        let mut task = PresenceWait {
            wait_id: id.clone(),
            presence_id: id.clone(),
            path: path.to_str().unwrap().into(),
            cancel,
            registered: true,
        };
        assert_eq!(task.compute().unwrap().status, "cancelled");
        assert!(!windows::registry().lock().unwrap().holds(&id));
        assert!(!waits().lock().unwrap().contains_key(&id));
    }

    #[test]
    fn completed_worker_retains_the_guard_outside_the_task_lifetime() {
        let id = "binding-worker-retention".to_string();
        let cancel = CancelToken::default();
        waits().lock().unwrap().insert(
            id.clone(),
            PendingWait {
                presence_id: id.clone(),
                cancel: cancel.clone(),
            },
        );
        let path = std::env::temp_dir().join(format!("binding-wait-{}.lock", std::process::id()));
        std::fs::write(&path, b"tag").unwrap();
        let path = path.to_str().unwrap().to_string();
        let mut holder = PresenceRegistry::new(WindowsPresenceBackend);
        assert_eq!(holder.acquire("holder", &path), LockAttempt::Acquired);
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let waiter = {
            let (id, path) = (id.clone(), path.clone());
            std::thread::spawn(move || {
                let mut task = PresenceWait {
                    wait_id: id.clone(),
                    presence_id: id,
                    path,
                    cancel,
                    registered: true,
                };
                started_tx.send(()).unwrap();
                task.compute().unwrap()
            })
        };
        started_rx
            .recv_timeout(std::time::Duration::from_secs(30))
            .unwrap();
        holder.release_after_quiescence(QuiescenceReceipt {
            presence_id: "holder".into(),
        });
        assert_eq!(waiter.join().unwrap().status, "acquired");
        assert!(windows::registry().lock().unwrap().holds(&id));
        assert_eq!(holder.acquire("holder", &path), LockAttempt::Occupied);
        assert_eq!(
            presence_release_after_quiescence(ReleasedReceipt {
                presence_id: id,
                state: "released".into(),
            })
            .status,
            "released"
        );
        assert_eq!(holder.acquire("holder", &path), LockAttempt::Acquired);
    }
}
