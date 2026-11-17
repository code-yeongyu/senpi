//! Process-rooted presence guards. JS owns no descriptor and GC cannot release authority.
//! Callers supply paths and persisted bindings; placement and reservation transactions live above
//! this bridge. Only a committed receipt closes a retained guard: the holder's `released`, or one of
//! the recovery order's release points (`ReleaseReason`).
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
    /// The object's whole immutable header as recorded in the row (design 4.2a: a random tag, the
    /// schema and a creation timestamp); the opened object must equal it byte for byte.
    pub header: Buffer,
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
    /// One of `ReleaseReason`'s states: `released`, `recovery_abandoned`, `discharged`, `retired`.
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
        FenceReason, FileIdentity, LockAttempt, PresenceBackend, PresenceRegistry, QuiescenceReceipt,
        ReleaseReason, WaitOutcome,
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
            LockAttempt::Inadmissible => result("unknown", Some("inadmissible"), None),
            LockAttempt::NotHeld => result("unknown", Some("not_held"), None),
            LockAttempt::Unknown(code) => result("unknown", Some("os_error"), Some(code)),
            LockAttempt::Fenced => result("fenced", Some("registry_fenced"), None),
        }
    }

    pub(super) fn waited(outcome: WaitOutcome) -> PresenceResult {
        match outcome {
            WaitOutcome::Acquired => result("acquired", None, None),
            WaitOutcome::Cancelled => result("cancelled", None, None),
            WaitOutcome::Inadmissible => result("unknown", Some("inadmissible"), None),
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

    /// Admissibility rules 1-3 (design 4.2a Revision 7) against an opened handle of the object: the
    /// recorded identity and header (1), created local and local now through this handle (2), and for
    /// a relocated object the recorded kernel session verified and equal to the current one (3).
    fn admissible(
        request: &PresenceProbe,
    ) -> impl FnOnce(
        &mut WindowsPresenceBackend,
        &<WindowsPresenceBackend as PresenceBackend>::Handle,
        FileIdentity,
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
                && handle.header_matches(&request.header)
                && request.created_local
                && handle.is_local()
                && session_matches
        }
    }

    pub(super) fn probe(request: PresenceProbe) -> PresenceResult {
        let mut registry = registry().lock().unwrap();
        attempt(registry.probe(&request.presence_id, &request.path, admissible(&request)))
    }

    /// The same rules applied to the guard a blocking wait retained, through that handle.
    pub(super) fn probe_retained(request: PresenceProbe) -> PresenceResult {
        let mut registry = registry().lock().unwrap();
        attempt(registry.probe_retained(&request.presence_id, &request.path, admissible(&request)))
    }

    pub(super) fn release(receipt: ReleasedReceipt) -> PresenceResult {
        if ReleaseReason::parse(&receipt.state).is_none() {
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

/// Applies the admissibility rules to a guard this process already retains, the one a blocking wait
/// acquired (design Revision 8, r7 note 4), through that handle: `acquired` keeps it as the recovery
/// guard, an inadmissible handle is released at once (`unknown`, `inadmissible`), and a guard not
/// held under that ID and path is `unknown`, `not_held`. The handle is never closed and reacquired.
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
    use crate::presence::{LockAttempt, PresenceBackend, PresenceRegistry, QuiescenceReceipt};
    use crate::presence_windows::WindowsPresenceBackend;
    use napi::Task;

    const HEADER: &[u8] = b"{\"tag\":\"c0ffee\",\"schema\":1,\"createdAt\":\"2026-10-27T00:00:00.000Z\"}\n";

    /// Removes the test's lock file once every handle on it is closed (a file still held stays until
    /// the process exits; the next run's name differs by pid).
    struct TempObject(String);

    impl Drop for TempObject {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    /// A presence object in the temp directory holding the design's immutable header, and the
    /// admissibility binding that names it: its header, its identity, created local and not relocated.
    /// The returned guard removes the file when the test ends.
    fn presence_object(label: &str) -> (String, impl Fn(&str, &[u8]) -> PresenceProbe, TempObject) {
        let path = std::env::temp_dir().join(format!("binding-{label}-{}.lock", std::process::id()));
        std::fs::write(&path, HEADER).unwrap();
        let path = path.to_str().unwrap().to_string();
        let cleanup = TempObject(path.clone());
        let mut backend = WindowsPresenceBackend;
        let handle = backend.open(&path).unwrap();
        let identity = backend.handle_identity(&handle).unwrap();
        drop(handle);
        let probe_path = path.clone();
        let probe = move |presence_id: &str, header: &[u8]| PresenceProbe {
            presence_id: presence_id.into(),
            path: probe_path.clone(),
            header: header.to_vec().into(),
            volume_serial: identity.volume_serial.to_string(),
            file_id: identity.file_id.to_string(),
            created_local: true,
            relocated: false,
            kernel_session: None,
        };
        (path, probe, cleanup)
    }

    /// Runs the wait worker for `id` on `path` while `holder` holds the lock, releases the holder once
    /// the worker has started, and returns the worker's result.
    fn wait_through_worker(
        id: &str,
        path: &str,
        holder: &mut PresenceRegistry<WindowsPresenceBackend>,
    ) -> PresenceResult {
        let cancel = CancelToken::default();
        waits().lock().unwrap().insert(
            id.to_string(),
            PendingWait {
                presence_id: id.to_string(),
                cancel: cancel.clone(),
            },
        );
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let waiter = {
            let (id, path) = (id.to_string(), path.to_string());
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
        waiter.join().unwrap()
    }

    #[test]
    fn the_wait_handle_is_probed_in_place_and_an_inadmissible_one_is_released_at_once() {
        let id = "binding-wait-inadmissible";
        let (path, probe, _cleanup) = presence_object(id);
        let mut holder = PresenceRegistry::new(WindowsPresenceBackend);
        assert_eq!(holder.acquire("holder", &path), LockAttempt::Acquired);
        assert_eq!(wait_through_worker(id, &path, &mut holder).status, "acquired");
        assert!(windows::registry().lock().unwrap().holds(id));
        let verdict = presence_probe_retained(probe(id, b"{\"tag\":\"c0ffee\""));
        assert_eq!(verdict.status, "unknown");
        assert_eq!(verdict.reason.as_deref(), Some("inadmissible"));
        assert_eq!(verdict.code, None);
        assert!(!windows::registry().lock().unwrap().holds(id));
        // Released at once: a fresh acquisition succeeds without any quiescence receipt for `id`.
        assert_eq!(holder.acquire("holder", &path), LockAttempt::Acquired);
        holder.release_after_quiescence(QuiescenceReceipt {
            presence_id: "holder".into(),
        });
    }

    #[test]
    fn the_wait_handle_that_passes_the_rules_stays_the_retained_recovery_guard() {
        let id = "binding-wait-admissible";
        let (path, probe, _cleanup) = presence_object(id);
        let mut holder = PresenceRegistry::new(WindowsPresenceBackend);
        assert_eq!(holder.acquire("holder", &path), LockAttempt::Acquired);
        assert_eq!(wait_through_worker(id, &path, &mut holder).status, "acquired");
        assert_eq!(presence_probe_retained(probe(id, HEADER)).status, "acquired");
        assert!(windows::registry().lock().unwrap().holds(id));
        assert_eq!(holder.acquire("holder", &path), LockAttempt::Occupied);
        // Step 5 of the recovery order releases the recovered guard after the retirement commit.
        assert_eq!(
            presence_release_after_quiescence(ReleasedReceipt {
                presence_id: id.into(),
                state: "retired".into(),
            })
            .status,
            "released"
        );
        assert_eq!(holder.acquire("holder", &path), LockAttempt::Acquired);
        holder.release_after_quiescence(QuiescenceReceipt {
            presence_id: "holder".into(),
        });
    }

    #[test]
    fn probe_retained_without_a_retained_guard_is_not_held() {
        let id = "binding-retained-not-held";
        let (_, probe, _cleanup) = presence_object(id);
        let verdict = presence_probe_retained(probe(id, HEADER));
        assert_eq!(verdict.status, "unknown");
        assert_eq!(verdict.reason.as_deref(), Some("not_held"));
        assert!(!windows::registry().lock().unwrap().holds(id));
    }

    #[test]
    fn every_release_point_of_the_recovery_order_releases_and_anything_else_is_refused() {
        let id = "binding-release-reasons";
        let (path, _, _cleanup) = presence_object(id);
        for state in ["released", "recovery_abandoned", "discharged", "retired"] {
            assert_eq!(presence_acquire(id.into(), path.clone()).status, "acquired");
            for refused in ["active", "quiescent", ""] {
                let verdict = presence_release_after_quiescence(ReleasedReceipt {
                    presence_id: id.into(),
                    state: refused.into(),
                });
                assert_eq!(
                    verdict.reason.as_deref(),
                    Some("quiescence_required"),
                    "{refused:?}"
                );
                assert!(windows::registry().lock().unwrap().holds(id));
            }
            assert_eq!(
                presence_release_after_quiescence(ReleasedReceipt {
                    presence_id: id.into(),
                    state: state.into(),
                })
                .status,
                "released",
                "{state:?}"
            );
            assert!(!windows::registry().lock().unwrap().holds(id));
        }
    }

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
