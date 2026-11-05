//! Presence guards of the #4199 design (4.2a "Namespace-independent lifetime proof", Revision 7 pre-action
//! check): one exclusive byte-range lock per presence ID, held by the registry for as long as the actor's
//! authority lasts. A successful acquisition is the only release proof; contention is `Occupied`, and every
//! other failure is `Unknown`, never a release. The registry has no unlock while authority is active: a
//! guard leaves it only with a quiescence receipt, whose reason is the holder's `released` commit or one
//! of the recovery order's release points (`ReleaseReason`), except that the handle a blocking wait
//! retained (`wait_and_acquire`) leaves without one when `probe_retained` finds it inadmissible or
//! without an identity, because that handle was never evidence. Any descriptor loss, identity change or
//! locality flip found by the pre-action check fences the registry for good; it never re-acquires and
//! continues. The Windows backend (`LockFileEx` on byte [0,1)) lives in `presence_windows.rs`; tests drive a
//! fake backend whose process-death and kernel-release events are separate.

use std::collections::BTreeMap;

/// `ERROR_LOCK_VIOLATION`: another handle holds the range. The only "occupied" answer.
pub const ERROR_LOCK_VIOLATION: u32 = 33;

/// The physical identity of an opened file: volume serial plus 128-bit file ID.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileIdentity {
    pub volume_serial: u64,
    pub file_id: u128,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LockAttempt {
    Acquired,
    Occupied,
    /// A successful acquisition that failed the Revision 7 admissibility rule (design 4.2a rules 1-3),
    /// or one made under a presence ID this registry already holds. The handle was released at once;
    /// the object counts as unknown. Distinct from any OS error code.
    Inadmissible,
    /// Nothing is retained under that presence ID for that path (`probe_retained`).
    NotHeld,
    /// The Win32 error of an open, identity or lock failure. Never a release proof.
    Unknown(u32),
    /// The registry is fenced; nothing is attempted.
    Fenced,
}

/// Maps one nonblocking lock call to its meaning: only `ERROR_LOCK_VIOLATION` is contention.
pub fn classify_lock_result(result: Result<(), u32>) -> LockAttempt {
    match result {
        Ok(()) => LockAttempt::Acquired,
        Err(ERROR_LOCK_VIOLATION) => LockAttempt::Occupied,
        Err(code) => LockAttempt::Unknown(code),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FenceReason {
    /// The presence ID has no guard in this registry.
    NotHeld,
    /// The guard's handle no longer answers an identity query.
    HandleLost(u32),
    /// The handle, the recorded identity and the path no longer name one object.
    IdentityChanged,
    /// The path could not be resolved to an identity.
    PathUnreadable(u32),
    /// The store no longer classifies `local`.
    NotLocal,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WaitOutcome {
    Acquired,
    Cancelled,
    /// The wait acquired, but the registry already holds that presence ID (for another object) or the
    /// completed wait carries no guard for it: the waited handle is dropped and is never evidence.
    Inadmissible,
    Unknown(u32),
    /// The registry is fenced; nothing is attempted.
    Fenced,
}

/// The OS calls a presence guard needs. `Handle` is owned by the registry and never exposed.
pub trait PresenceBackend {
    type Handle;
    /// Opens the presence object non-inheritably, without delete sharing.
    fn open(&mut self, path: &str) -> Result<Self::Handle, u32>;
    /// One nonblocking exclusive lock attempt on byte [0,1).
    fn try_lock(&mut self, handle: &Self::Handle) -> Result<(), u32>;
    /// Blocks until the lock is acquired or `cancel` fires (Repair's blocking wait); never times out.
    fn wait_lock(&mut self, handle: &Self::Handle, cancel: &CancelToken) -> WaitOutcome;
    fn handle_identity(&mut self, handle: &Self::Handle) -> Result<FileIdentity, u32>;
    fn path_identity(&mut self, path: &str) -> Result<FileIdentity, u32>;
}

type Canceller = Box<dyn FnOnce() + Send>;

#[derive(Default)]
struct CancelState {
    cancelled: bool,
    canceller: Option<Canceller>,
}

/// Cancels a blocking wait. Cloning shares the state. A backend registers a canceller for the wait in
/// progress (on Windows, `CancelIoEx` on that exact I/O), so cancelling needs no polling.
#[derive(Clone, Default)]
pub struct CancelToken(std::sync::Arc<std::sync::Mutex<CancelState>>);

impl CancelToken {
    /// Runs the registered canceller while holding the state lock, so once `clear` returns no canceller can
    /// still be running against an I/O that has ended.
    pub fn cancel(&self) {
        let mut state = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        state.cancelled = true;
        if let Some(canceller) = state.canceller.take() {
            canceller();
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .cancelled
    }

    /// Registers the canceller of a wait whose I/O is already issued. Returns `false`, without registering,
    /// when the token was already cancelled; the caller must then cancel that I/O itself.
    pub fn register(&self, canceller: Canceller) -> bool {
        let mut state = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.cancelled {
            return false;
        }
        state.canceller = Some(canceller);
        true
    }

    /// Whether a wait's I/O is pending with its canceller registered: the moment a cancel takes the
    /// pending-I/O path rather than the pre-cancel check.
    pub fn has_pending_wait(&self) -> bool {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .canceller
            .is_some()
    }

    /// Drops the canceller once the wait has ended, so a later `cancel` cannot touch a finished I/O.
    pub fn clear(&self) {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .canceller = None;
    }
}

/// Proof, committed by the caller before release, that this actor's authority ended (`released`), or
/// the point of the recovery transaction order (design 4.2a, step 3-5) at which a recovered guard is
/// released.
#[derive(Debug)]
pub struct QuiescenceReceipt {
    pub presence_id: String,
}

/// Why a guard leaves the registry: the holder's own `released` commit, or one of the three points of
/// the recovery transaction order (design 4.2a) that release recovered guards. Nothing else does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReleaseReason {
    /// The holder committed `released`: the Revision 7 quiescence receipt for its own authority.
    Released,
    /// Step 3 met contention or an error, so the attempt cannot retire: its acquired guards are
    /// released at once and the attempt reports occupied/unknown.
    RecoveryAbandoned,
    /// Step 4 recomputed the probe set: the role committed `released` in the meantime and that
    /// commit discharges it, so the guard acquired for it is released.
    Discharged,
    /// Step 5 committed retirement and deleted the retired generation's objects; the recovered
    /// guards are released last, keeping tombstones.
    Retired,
}

impl ReleaseReason {
    /// The receipt states a caller may supply; any other string releases nothing.
    pub fn parse(state: &str) -> Option<Self> {
        match state {
            "released" => Some(Self::Released),
            "recovery_abandoned" => Some(Self::RecoveryAbandoned),
            "discharged" => Some(Self::Discharged),
            "retired" => Some(Self::Retired),
            _ => None,
        }
    }
}

struct Guard<H> {
    path: String,
    identity: FileIdentity,
    handle: H,
    /// Retained by a blocking wait (Repair's busy-owner wait), not by `acquire`: only such a guard
    /// may be probed in place and released without a receipt (`probe_retained`).
    wait_retained: bool,
}

pub struct PresenceRegistry<B: PresenceBackend> {
    backend: B,
    guards: BTreeMap<String, Guard<B::Handle>>,
    fenced: Option<FenceReason>,
}

impl<B: PresenceBackend> PresenceRegistry<B> {
    pub fn new(backend: B) -> Self {
        Self {
            backend,
            guards: BTreeMap::new(),
            fenced: None,
        }
    }

    pub fn fenced(&self) -> Option<FenceReason> {
        self.fenced
    }

    pub fn holds(&self, presence_id: &str) -> bool {
        self.guards.contains_key(presence_id)
    }

    /// A probe first attempts a fresh exclusive acquisition. Contention is occupied regardless of
    /// admissibility. An inadmissible success is dropped; an admissible success remains in the registry.
    pub fn probe(
        &mut self,
        presence_id: &str,
        path: &str,
        admissible: impl FnOnce(&mut B, &B::Handle, FileIdentity) -> bool,
    ) -> LockAttempt {
        if self.fenced.is_some() {
            return LockAttempt::Fenced;
        }
        let handle = match self.backend.open(path) {
            Ok(handle) => handle,
            Err(code) => return LockAttempt::Unknown(code),
        };
        let attempt = classify_lock_result(self.backend.try_lock(&handle));
        if attempt != LockAttempt::Acquired {
            return attempt;
        }
        let identity = match self.backend.handle_identity(&handle) {
            Ok(identity) => identity,
            Err(code) => return LockAttempt::Unknown(code),
        };
        if self.holds(presence_id) || !admissible(&mut self.backend, &handle, identity) {
            return LockAttempt::Inadmissible; // `handle` drops here: released at once.
        }
        self.guards.insert(
            presence_id.to_string(),
            Guard {
                path: path.to_string(),
                identity,
                handle,
                wait_retained: false,
            },
        );
        LockAttempt::Acquired
    }

    /// Repair's retained wait handle as step 3's acquisition of its object (design Revision 8, r7
    /// note 4): the probe's admissibility rule applied to a guard this registry already holds, through
    /// that handle, which is never closed and reacquired. An inadmissible handle is released at once;
    /// a handle that no longer answers an identity query is released as `Unknown`; a guard not held,
    /// held for another path, or held by `acquire` (the holder's own authority guard, which leaves
    /// only with a receipt) is `NotHeld` and nothing changes.
    pub fn probe_retained(
        &mut self,
        presence_id: &str,
        path: &str,
        admissible: impl FnOnce(&mut B, &B::Handle, FileIdentity) -> bool,
    ) -> LockAttempt {
        if self.fenced.is_some() {
            return LockAttempt::Fenced;
        }
        let Some(guard) = self.guards.get(presence_id) else {
            return LockAttempt::NotHeld;
        };
        if guard.path != path || !guard.wait_retained {
            return LockAttempt::NotHeld;
        }
        let identity = match self.backend.handle_identity(&guard.handle) {
            Ok(identity) => identity,
            Err(code) => {
                self.guards.remove(presence_id);
                return LockAttempt::Unknown(code);
            }
        };
        if !admissible(&mut self.backend, &guard.handle, identity) {
            self.guards.remove(presence_id);
            return LockAttempt::Inadmissible;
        }
        LockAttempt::Acquired
    }

    /// Transfer a completed blocking acquisition into the process-rooted registry. The wait runs
    /// outside its mutex so unrelated releases and pre-action checks cannot deadlock behind it.
    pub fn retain_wait(&mut self, mut completed: Self, presence_id: &str) -> WaitOutcome {
        if self.fenced.is_some() {
            return WaitOutcome::Fenced;
        }
        if self.holds(presence_id) {
            return WaitOutcome::Inadmissible;
        }
        match completed.guards.remove(presence_id) {
            Some(guard) => {
                self.guards.insert(presence_id.to_string(), guard);
                WaitOutcome::Acquired
            }
            None => WaitOutcome::Inadmissible,
        }
    }

    /// Opens and attempts the lock once. On `Acquired` the guard is retained; on anything else the
    /// handle is closed again and nothing is retained.
    pub fn acquire(&mut self, presence_id: &str, path: &str) -> LockAttempt {
        if self.fenced.is_some() {
            return LockAttempt::Fenced;
        }
        if let Some(guard) = self.guards.get(presence_id) {
            // A second object under a held ID is never opened, let alone counted as evidence.
            return if guard.path == path {
                LockAttempt::Acquired
            } else {
                LockAttempt::Inadmissible
            };
        }
        let handle = match self.backend.open(path) {
            Ok(handle) => handle,
            Err(code) => return LockAttempt::Unknown(code),
        };
        let attempt = classify_lock_result(self.backend.try_lock(&handle));
        if attempt != LockAttempt::Acquired {
            return attempt;
        }
        match self.backend.handle_identity(&handle) {
            Ok(identity) => {
                self.guards.insert(
                    presence_id.to_string(),
                    Guard {
                        path: path.to_string(),
                        identity,
                        handle,
                        wait_retained: false,
                    },
                );
                LockAttempt::Acquired
            }
            Err(code) => LockAttempt::Unknown(code),
        }
    }

    /// Repair's cancellable blocking wait (test 26): retains the guard only if the wait acquired it.
    pub fn wait_and_acquire(&mut self, presence_id: &str, path: &str, cancel: &CancelToken) -> WaitOutcome {
        if self.fenced.is_some() {
            return WaitOutcome::Fenced;
        }
        if self.guards.contains_key(presence_id) {
            return WaitOutcome::Acquired;
        }
        let handle = match self.backend.open(path) {
            Ok(handle) => handle,
            Err(code) => return WaitOutcome::Unknown(code),
        };
        match self.backend.wait_lock(&handle, cancel) {
            WaitOutcome::Acquired => match self.backend.handle_identity(&handle) {
                Ok(identity) => {
                    self.guards.insert(
                        presence_id.to_string(),
                        Guard {
                            path: path.to_string(),
                            identity,
                            handle,
                            wait_retained: true,
                        },
                    );
                    WaitOutcome::Acquired
                }
                Err(code) => WaitOutcome::Unknown(code),
            },
            other => other,
        }
    }

    /// The Revision 7 pre-action check, run before every authorized bind, spawn or credential mutation.
    /// `store_is_local` is the current locality classification of the guard's store. A failure fences
    /// the registry permanently: every later check and acquisition fails.
    pub fn pre_action_check(&mut self, presence_id: &str, store_is_local: bool) -> Result<(), FenceReason> {
        if let Some(reason) = self.fenced {
            return Err(reason);
        }
        let verdict = self.check(presence_id, store_is_local);
        if let Err(reason) = verdict {
            self.fenced = Some(reason);
        }
        verdict
    }

    /// Reclassify the retained handle, rather than trusting locality supplied by JavaScript.
    pub fn pre_action_check_with(
        &mut self,
        presence_id: &str,
        is_local: impl FnOnce(&mut B, &B::Handle) -> bool,
    ) -> Result<(), FenceReason> {
        if let Some(reason) = self.fenced {
            return Err(reason);
        }
        let local = self
            .guards
            .get(presence_id)
            .is_some_and(|guard| is_local(&mut self.backend, &guard.handle));
        self.pre_action_check(presence_id, local)
    }

    fn check(&mut self, presence_id: &str, store_is_local: bool) -> Result<(), FenceReason> {
        let guard = self.guards.get(presence_id).ok_or(FenceReason::NotHeld)?;
        if !store_is_local {
            return Err(FenceReason::NotLocal);
        }
        let held = self
            .backend
            .handle_identity(&guard.handle)
            .map_err(FenceReason::HandleLost)?;
        let named = self
            .backend
            .path_identity(&guard.path)
            .map_err(FenceReason::PathUnreadable)?;
        if held != guard.identity || named != guard.identity {
            return Err(FenceReason::IdentityChanged);
        }
        Ok(())
    }

    /// Closes a guard after its `released` commit, or at one of the recovery order's release points
    /// (`ReleaseReason`). The only other way a guard leaves the registry is `probe_retained` finding a
    /// wait-retained handle inadmissible or without an identity; an `acquire`d guard leaves only here.
    pub fn release_after_quiescence(&mut self, receipt: QuiescenceReceipt) -> bool {
        self.guards.remove(&receipt.presence_id).is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    /// A fake kernel: files with identities, handles, the process that owns each handle, and the lock
    /// holder of each file. Process death and kernel release are separate events (design test 18).
    #[derive(Default)]
    struct FakeKernel {
        files: BTreeMap<String, FileIdentity>,
        next_handle: u32,
        handles: BTreeMap<u32, (String, FileIdentity, &'static str)>,
        holders: BTreeMap<String, u32>,
        dead: Vec<&'static str>,
        lost_handles: Vec<u32>,
        released_on_wait: bool,
        /// A Win32 error every open fails with, standing in for a real kernel answer.
        open_error: Option<u32>,
        process: &'static str,
    }

    impl FakeKernel {
        fn with_file(path: &str, file_id: u128) -> Self {
            let mut kernel = Self {
                process: "recovery",
                ..Self::default()
            };
            kernel.files.insert(
                path.to_string(),
                FileIdentity {
                    volume_serial: 7,
                    file_id,
                },
            );
            kernel
        }

        /// Another process holding the lock on `path` through its own handle.
        fn held_by(mut self, path: &str, process: &'static str) -> Self {
            let handle = self.next_handle + 1000;
            self.next_handle += 1;
            self.handles
                .insert(handle, (path.to_string(), self.files[path], process));
            self.holders.insert(path.to_string(), handle);
            self
        }

        fn process_dies(&mut self, process: &'static str) {
            self.dead.push(process);
        }

        /// The kernel finally releases the dead process's locks.
        fn kernel_releases(&mut self) {
            let dead = self.dead.clone();
            self.holders
                .retain(|_, handle| !dead.contains(&self.handles[handle].2));
        }
    }

    impl PresenceBackend for &mut FakeKernel {
        type Handle = u32;

        fn open(&mut self, path: &str) -> Result<u32, u32> {
            if let Some(code) = self.open_error {
                return Err(code);
            }
            let identity = *self.files.get(path).ok_or(2u32)?;
            self.next_handle += 1;
            self.handles
                .insert(self.next_handle, (path.to_string(), identity, self.process));
            Ok(self.next_handle)
        }

        fn try_lock(&mut self, handle: &u32) -> Result<(), u32> {
            let (path, _, _) = self.handles[handle].clone();
            match self.holders.get(&path) {
                Some(holder) if holder != handle => Err(ERROR_LOCK_VIOLATION),
                _ => {
                    self.holders.insert(path, *handle);
                    Ok(())
                }
            }
        }

        fn wait_lock(&mut self, handle: &u32, cancel: &CancelToken) -> WaitOutcome {
            if cancel.is_cancelled() {
                return WaitOutcome::Cancelled;
            }
            if self.released_on_wait {
                self.kernel_releases();
            }
            match self.try_lock(handle) {
                Ok(()) => WaitOutcome::Acquired,
                Err(_) => WaitOutcome::Cancelled,
            }
        }

        fn handle_identity(&mut self, handle: &u32) -> Result<FileIdentity, u32> {
            if self.lost_handles.contains(handle) {
                return Err(6);
            }
            self.handles.get(handle).map(|entry| entry.1).ok_or(6)
        }

        fn path_identity(&mut self, path: &str) -> Result<FileIdentity, u32> {
            self.files.get(path).copied().ok_or(2)
        }
    }

    const PATH: &str = r"C:\Users\u\AppData\Local\senpi\presence\p-1.lock";

    #[test]
    fn probe_attempts_the_lock_before_interpreting_admissibility() {
        let mut kernel = FakeKernel::with_file(PATH, 1).held_by(PATH, "host");
        let mut registry = PresenceRegistry::new(&mut kernel);
        assert_eq!(
            registry.probe("p-1", PATH, |_, _, _| panic!("busy must not be reclassified")),
            LockAttempt::Occupied
        );
        assert!(!registry.holds("p-1"));
    }

    #[test]
    fn probe_retains_only_admissible_successes() {
        for admissible in [false, true] {
            let mut kernel = FakeKernel::with_file(PATH, 1);
            let mut registry = PresenceRegistry::new(&mut kernel);
            let attempt = registry.probe("p-1", PATH, |_, _, _| admissible);
            assert_eq!(
                attempt,
                if admissible {
                    LockAttempt::Acquired
                } else {
                    LockAttempt::Inadmissible
                }
            );
            assert_eq!(registry.holds("p-1"), admissible);
        }
    }

    #[test]
    fn a_real_error_invalid_data_stays_an_os_error_and_is_not_inadmissibility() {
        let mut kernel = FakeKernel::with_file(PATH, 1);
        kernel.open_error = Some(13);
        let mut registry = PresenceRegistry::new(&mut kernel);
        assert_eq!(
            registry.probe("p-1", PATH, |_, _, _| panic!("a failed open reaches no rule")),
            LockAttempt::Unknown(13)
        );
        assert_ne!(LockAttempt::Unknown(13), LockAttempt::Inadmissible);
        assert!(!registry.holds("p-1"));
    }

    #[test]
    fn a_retained_wait_handle_is_probed_in_place_and_released_at_once_when_inadmissible() {
        for admissible in [true, false] {
            let mut kernel = FakeKernel::with_file(PATH, 1).held_by(PATH, "host");
            kernel.process_dies("host");
            kernel.released_on_wait = true;
            let mut registry = PresenceRegistry::new(&mut kernel);
            assert_eq!(
                registry.wait_and_acquire("p-1", PATH, &CancelToken::default()),
                WaitOutcome::Acquired
            );
            let handles_before = registry.backend.next_handle;
            let attempt = registry.probe_retained("p-1", PATH, |_, _, identity| {
                assert_eq!(identity.file_id, 1);
                admissible
            });
            assert_eq!(
                registry.backend.next_handle, handles_before,
                "the rule is applied to the wait's handle; nothing is reopened"
            );
            assert_eq!(
                attempt,
                if admissible {
                    LockAttempt::Acquired
                } else {
                    LockAttempt::Inadmissible
                }
            );
            assert_eq!(registry.holds("p-1"), admissible);
        }
    }

    #[test]
    fn probe_retained_without_a_retained_guard_is_not_held_and_retains_nothing() {
        let mut kernel = FakeKernel::with_file(PATH, 1);
        let mut registry = PresenceRegistry::new(&mut kernel);
        assert_eq!(
            registry.probe_retained("p-1", PATH, |_, _, _| panic!("nothing to apply the rule to")),
            LockAttempt::NotHeld
        );
        assert!(!registry.holds("p-1"));
        assert_eq!(registry.acquire("p-1", PATH), LockAttempt::Acquired);
        assert_eq!(
            registry.probe_retained("p-1", r"C:\other.lock", |_, _, _| true),
            LockAttempt::NotHeld
        );
        assert!(registry.holds("p-1"), "a guard under another path is left alone");
    }

    /// senpi#4470 review LOW: `probe_retained` acts only on a guard a blocking wait retained. The
    /// holder's own `acquire`d authority guard never leaves the registry without a receipt, whatever
    /// header or rule a misdirected call brings.
    #[test]
    fn probe_retained_never_drops_an_acquired_authority_guard() {
        let mut kernel = FakeKernel::with_file(PATH, 1);
        let mut registry = PresenceRegistry::new(&mut kernel);
        assert_eq!(registry.acquire("p-1", PATH), LockAttempt::Acquired);
        assert_eq!(
            registry.probe_retained("p-1", PATH, |_, _, _| false),
            LockAttempt::NotHeld,
            "an authority guard is not a wait's retained handle"
        );
        assert!(registry.holds("p-1"), "the authority guard stays registered");
        assert_eq!(registry.pre_action_check("p-1", true), Ok(()));
    }

    #[test]
    fn a_retained_handle_that_lost_its_identity_is_unknown_and_released() {
        let mut kernel = FakeKernel::with_file(PATH, 1).held_by(PATH, "host");
        kernel.process_dies("host");
        kernel.released_on_wait = true;
        let mut registry = PresenceRegistry::new(&mut kernel);
        assert_eq!(
            registry.wait_and_acquire("p-1", PATH, &CancelToken::default()),
            WaitOutcome::Acquired
        );
        let retained = registry.backend.next_handle;
        registry.backend.lost_handles.push(retained);
        assert_eq!(
            registry.probe_retained("p-1", PATH, |_, _, _| panic!("no identity, no rule")),
            LockAttempt::Unknown(6)
        );
        assert!(!registry.holds("p-1"));
    }

    #[test]
    fn every_release_point_of_the_recovery_order_has_a_reason_and_nothing_else_does() {
        assert_eq!(ReleaseReason::parse("released"), Some(ReleaseReason::Released));
        assert_eq!(
            ReleaseReason::parse("recovery_abandoned"),
            Some(ReleaseReason::RecoveryAbandoned)
        );
        assert_eq!(
            ReleaseReason::parse("discharged"),
            Some(ReleaseReason::Discharged)
        );
        assert_eq!(ReleaseReason::parse("retired"), Some(ReleaseReason::Retired));
        for state in ["", "active", "Released", "cancelled", "quiescent", "occupied"] {
            assert_eq!(ReleaseReason::parse(state), None, "{state:?} releases nothing");
        }
    }

    #[test]
    fn only_a_lock_violation_is_occupied_and_every_other_error_is_unknown() {
        assert_eq!(classify_lock_result(Ok(())), LockAttempt::Acquired);
        assert_eq!(classify_lock_result(Err(33)), LockAttempt::Occupied);
        for code in [5, 6, 32, 158, 1167] {
            assert_eq!(classify_lock_result(Err(code)), LockAttempt::Unknown(code));
        }
    }

    #[test]
    fn a_dead_holder_stays_occupied_until_the_kernel_releases_its_lock() {
        let mut kernel = FakeKernel::with_file(PATH, 1).held_by(PATH, "host");
        kernel.process_dies("host");
        {
            let mut registry = PresenceRegistry::new(&mut kernel);
            assert_eq!(registry.acquire("p-1", PATH), LockAttempt::Occupied);
            assert!(!registry.holds("p-1"));
        }
        kernel.kernel_releases();
        let mut registry = PresenceRegistry::new(&mut kernel);
        assert_eq!(registry.acquire("p-1", PATH), LockAttempt::Acquired);
        assert!(registry.holds("p-1"));
    }

    #[test]
    fn a_missing_presence_object_is_unknown_and_never_recreated() {
        let mut kernel = FakeKernel::with_file(PATH, 1);
        kernel.files.clear();
        let mut registry = PresenceRegistry::new(&mut kernel);
        assert_eq!(registry.acquire("p-1", PATH), LockAttempt::Unknown(2));
        assert!(!registry.holds("p-1"));
    }

    #[test]
    fn a_held_guard_passes_the_pre_action_check() {
        let mut kernel = FakeKernel::with_file(PATH, 1);
        let mut registry = PresenceRegistry::new(&mut kernel);
        assert_eq!(registry.acquire("p-1", PATH), LockAttempt::Acquired);
        assert_eq!(registry.pre_action_check("p-1", true), Ok(()));
    }

    fn fenced_by(
        change: impl FnOnce(&mut FakeKernel, u32),
        store_is_local: bool,
    ) -> (FenceReason, LockAttempt) {
        let mut kernel = FakeKernel::with_file(PATH, 1);
        kernel.files.insert(
            r"C:\other.lock".to_string(),
            FileIdentity {
                volume_serial: 7,
                file_id: 9,
            },
        );
        let handle = {
            let mut registry = PresenceRegistry::new(&mut kernel);
            assert_eq!(registry.acquire("p-1", PATH), LockAttempt::Acquired);
            drop(registry);
            1
        };
        change(&mut kernel, handle);
        let held_guard = PresenceRegistry {
            backend: &mut kernel,
            guards: BTreeMap::from([(
                "p-1".to_string(),
                Guard {
                    path: PATH.to_string(),
                    identity: FileIdentity {
                        volume_serial: 7,
                        file_id: 1,
                    },
                    handle,
                    wait_retained: false,
                },
            )]),
            fenced: None,
        };
        let mut registry = held_guard;
        let reason = registry
            .pre_action_check("p-1", store_is_local)
            .expect_err("the change must fence");
        assert_eq!(
            registry.pre_action_check("p-1", true),
            Err(reason),
            "a fence is permanent"
        );
        (reason, registry.acquire("p-2", r"C:\other.lock"))
    }

    #[test]
    fn descriptor_loss_fences_and_nothing_is_reacquired() {
        let (reason, later) = fenced_by(|kernel, handle| kernel.lost_handles.push(handle), true);
        assert_eq!(reason, FenceReason::HandleLost(6));
        assert_eq!(later, LockAttempt::Fenced);
    }

    #[test]
    fn a_replaced_presence_file_fences() {
        let (reason, _) = fenced_by(
            |kernel, _| {
                kernel.files.insert(
                    PATH.to_string(),
                    FileIdentity {
                        volume_serial: 7,
                        file_id: 2,
                    },
                );
            },
            true,
        );
        assert_eq!(reason, FenceReason::IdentityChanged);
    }

    #[test]
    fn a_handle_remapped_to_another_file_fences() {
        let (reason, _) = fenced_by(
            |kernel, handle| {
                let other = kernel.files[r"C:\other.lock"];
                kernel.handles.get_mut(&handle).expect("handle").1 = other;
            },
            true,
        );
        assert_eq!(reason, FenceReason::IdentityChanged);
    }

    #[test]
    fn a_store_that_flips_to_not_local_fences() {
        let (reason, _) = fenced_by(|_, _| {}, false);
        assert_eq!(reason, FenceReason::NotLocal);
    }

    #[test]
    fn a_presence_id_without_a_guard_fails_the_check() {
        let mut kernel = FakeKernel::with_file(PATH, 1);
        let mut registry = PresenceRegistry::new(&mut kernel);
        assert_eq!(registry.pre_action_check("p-9", true), Err(FenceReason::NotHeld));
    }

    #[test]
    fn a_guard_leaves_only_with_a_quiescence_receipt() {
        let mut kernel = FakeKernel::with_file(PATH, 1);
        let mut registry = PresenceRegistry::new(&mut kernel);
        assert_eq!(registry.acquire("p-1", PATH), LockAttempt::Acquired);
        assert!(registry.release_after_quiescence(QuiescenceReceipt {
            presence_id: "p-1".to_string()
        }));
        assert!(!registry.holds("p-1"));
    }

    #[test]
    fn the_blocking_wait_acquires_on_the_release_event_and_retains_the_guard() {
        let mut kernel = FakeKernel::with_file(PATH, 1).held_by(PATH, "host");
        kernel.process_dies("host");
        kernel.released_on_wait = true;
        let mut registry = PresenceRegistry::new(&mut kernel);
        assert_eq!(
            registry.wait_and_acquire("p-1", PATH, &CancelToken::default()),
            WaitOutcome::Acquired
        );
        assert!(registry.holds("p-1"));
    }

    #[test]
    fn a_cancelled_wait_retains_nothing() {
        let mut kernel = FakeKernel::with_file(PATH, 1).held_by(PATH, "host");
        let cancel = CancelToken::default();
        cancel.cancel();
        let mut registry = PresenceRegistry::new(&mut kernel);
        assert_eq!(
            registry.wait_and_acquire("p-1", PATH, &cancel),
            WaitOutcome::Cancelled
        );
        assert!(!registry.holds("p-1"));
    }

    #[test]
    fn a_wait_on_a_presence_id_already_held_opens_no_second_handle() {
        let mut kernel = FakeKernel::with_file(PATH, 1);
        let mut registry = PresenceRegistry::new(&mut kernel);
        assert_eq!(registry.acquire("p-1", PATH), LockAttempt::Acquired);
        assert_eq!(
            registry.wait_and_acquire("p-1", PATH, &CancelToken::default()),
            WaitOutcome::Acquired
        );
        drop(registry);
        assert_eq!(
            kernel.next_handle, 1,
            "only the first acquisition opened a handle"
        );
    }

    #[test]
    fn a_completed_wait_for_an_id_already_held_is_inadmissible_and_its_handle_dropped() {
        const OTHER: &str = r"C:\other.lock";
        let mut kernel = FakeKernel::with_file(PATH, 1);
        kernel.files.insert(
            OTHER.to_string(),
            FileIdentity {
                volume_serial: 7,
                file_id: 9,
            },
        );
        let mut completed = PresenceRegistry::new(&mut kernel);
        assert_eq!(
            completed.wait_and_acquire("p-1", OTHER, &CancelToken::default()),
            WaitOutcome::Acquired
        );
        let mut other = FakeKernel::with_file(PATH, 1);
        let mut registry = PresenceRegistry::new(&mut other);
        assert_eq!(registry.acquire("p-1", PATH), LockAttempt::Acquired);
        assert_eq!(registry.retain_wait(completed, "p-1"), WaitOutcome::Inadmissible);
        assert_ne!(WaitOutcome::Inadmissible, WaitOutcome::Unknown(13));
        assert_eq!(registry.acquire("p-1", OTHER), LockAttempt::Inadmissible);
        assert!(registry.holds("p-1"), "the guard held first is untouched");
    }

    #[test]
    fn a_fenced_registry_answers_a_wait_with_fenced_not_an_os_error() {
        let mut kernel = FakeKernel::with_file(PATH, 1);
        let mut registry = PresenceRegistry::new(&mut kernel);
        assert_eq!(registry.pre_action_check("p-9", true), Err(FenceReason::NotHeld));
        assert_eq!(
            registry.wait_and_acquire("p-1", PATH, &CancelToken::default()),
            WaitOutcome::Fenced
        );
    }

    #[test]
    fn a_cleared_canceller_never_runs_and_registering_after_cancel_is_refused() {
        let ran = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let token = CancelToken::default();
        let counter = std::sync::Arc::clone(&ran);
        assert!(token.register(Box::new(move || {
            counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        })));
        token.clear();
        token.cancel();
        assert_eq!(ran.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert!(!token.register(Box::new(|| {})));
    }

    #[test]
    fn a_pending_wait_is_visible_only_while_its_canceller_is_registered() {
        let token = CancelToken::default();
        assert!(!token.has_pending_wait());
        assert!(token.register(Box::new(|| {})));
        assert!(token.has_pending_wait());
        token.clear();
        assert!(!token.has_pending_wait());
    }
}
