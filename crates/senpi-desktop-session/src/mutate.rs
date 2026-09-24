//! The single choke point of every mutating request: the fail-closed
//! [`gate`], then one input transaction (focus/cursor capture, the action
//! under `catch_unwind`, `release_all` on failure or suspension, the
//! focus/cursor restore), then exactly one [`AuditEvent`]. Read-only
//! requests never pass here.

use std::sync::Arc;
use std::time::Instant;

use parking_lot::Mutex;
use senpi_desktop_core::backend::DeliveryMode;
use senpi_desktop_core::error::{CoreResult, DesktopError, ErrorCode};
use senpi_desktop_core::protocol_results::AuditEvent;
use senpi_desktop_safety::{
    gate, FrameContext, FrameId, GateError, LockState, MonotonicClock, MutatingAction, PermissionGate,
    StopPolicy, Supervisor,
};

use crate::audit::audit_event;
use crate::restore::{Guard, TransactionError};
use crate::session::guarded;
use crate::worker::Worker;

/// Serializes input transactions across every session of the process
/// (gajae `INPUT_TRANSACTION`): capture through restore is never interleaved.
static INPUT_TRANSACTION: Mutex<()> = parking_lot::const_mutex(());

/// What the session thread needs to gate input and report it.
pub struct SessionSafety {
    /// The engine's kill switch; every mutating request is gated on it.
    pub supervisor: Arc<Supervisor>,
    /// Receives one [`AuditEvent`] per mutating request, success or failure;
    /// the engine forwards it as the `audit` notification.
    pub audit: Box<dyn Fn(&AuditEvent) + Send>,
}

impl SessionSafety {
    /// A private supervisor no stop path can reach: every mutating request is
    /// refused `StopPathUnavailable`, and no one consumes its audit events.
    #[must_use]
    pub fn fail_closed() -> Self {
        Self {
            supervisor: Arc::new(Supervisor::new(Arc::new(MonotonicClock::new()))),
            audit: Box::new(|_| {}),
        }
    }
}

/// One mutating request as the gate, the transaction, and the audit see it.
pub(crate) struct Mutation<'a> {
    pub(crate) action: MutatingAction,
    /// `desktop`, a window id, or (AX requests) the window key of the ref.
    pub(crate) target: String,
    pub(crate) delivery: DeliveryMode,
    /// The capture the request's coordinates are pixels of.
    pub(crate) frame_id: Option<&'a str>,
    /// Typed text or an AX value: audited by length and hash only.
    pub(crate) text: Option<&'a str>,
    pub(crate) keys: Option<&'a [String]>,
}

impl Mutation<'_> {
    pub(crate) const fn new(action: MutatingAction, target: String, delivery: DeliveryMode) -> Self {
        Self {
            action,
            target,
            delivery,
            frame_id: None,
            text: None,
            keys: None,
        }
    }
}

/// The gate's view of the session, probed once per request.
struct GateView {
    lock: LockState,
    input_granted: bool,
    latest_frame: Option<String>,
}

impl PermissionGate for GateView {
    fn input_granted(&self) -> bool {
        self.input_granted
    }
}

impl FrameContext for GateView {
    fn screen_locked(&self) -> LockState {
        self.lock
    }

    fn is_latest(&self, frame: &FrameId) -> bool {
        self.latest_frame.as_deref() == Some(frame.as_str())
    }
}

impl Worker {
    /// Runs `act` as one gated, audited input transaction. The host performs
    /// no cleanup: release and restore all happen here.
    ///
    /// # Errors
    /// The gate's refusal, the action's error, `Suspended` when a stop landed
    /// while it ran, or `FocusRestoreFailed` / `CursorRestoreFailed` naming
    /// the error they followed.
    pub(crate) fn mutate<T>(
        &mut self,
        mutation: &Mutation<'_>,
        act: impl FnOnce(&mut Self) -> CoreResult<T>,
    ) -> CoreResult<(T, AuditEvent)> {
        let started = Instant::now();
        let (result, focus_restored) = {
            let _transaction = INPUT_TRANSACTION.lock();
            self.transaction(mutation, act)
        };
        let result = result.map_err(DesktopError::from);
        let code = result.as_ref().err().map(|error| error.code);
        let event = audit_event(mutation, code, focus_restored, started.elapsed());
        (self.safety.audit)(&event);
        result.map(|value| (value, event))
    }

    /// The gate and the transaction proper; `focus_restored` is `None` when
    /// nothing was captured to restore.
    pub(crate) fn transaction<T>(
        &mut self,
        mutation: &Mutation<'_>,
        act: impl FnOnce(&mut Self) -> CoreResult<T>,
    ) -> (Result<T, TransactionError>, Option<bool>) {
        if let Err(refused) = self.gate(mutation) {
            return (Err(TransactionError::Primary(refused.into())), None);
        }
        let guard = match Guard::begin(self, mutation.action, mutation.delivery) {
            Ok(guard) => guard,
            Err(error) => return (Err(TransactionError::Primary(error)), None),
        };
        let mut result = guarded(|| act(self));
        if result.is_ok() && self.safety.supervisor.is_suspended() {
            result = Err(DesktopError::new(
                ErrorCode::Suspended,
                "input was suspended while the action ran; held input was released",
            ));
        }
        if let Err(primary) = &mut result {
            // Recorded on the primary error, never in place of it.
            if let Err(release) = guarded(|| self.backend()?.release_all()) {
                primary.message = format!("{}; releasing held input also failed: {release}", primary.message);
            }
        }
        guard.restore(self, result)
    }

    fn gate(&mut self, mutation: &Mutation<'_>) -> Result<(), GateError> {
        let policy = StopPolicy {
            allow_host_relay_only: self
                .options
                .as_ref()
                .is_some_and(|options| options.allow_host_relay_only_stop),
        };
        let input_granted = self.refresh_capabilities().input_permission == "granted";
        let lock = match self.backend().and_then(|backend| backend.screen_locked()) {
            Ok(true) => LockState::Locked,
            Ok(false) => LockState::Unlocked,
            Err(_) => LockState::Unknown,
        };
        let view = GateView {
            lock,
            input_granted,
            latest_frame: self.frames.latest_id(&mutation.target).map(str::to_owned),
        };
        gate(
            &mutation.action,
            &self.safety.supervisor,
            &policy,
            &view,
            &view,
            mutation.frame_id.map(FrameId::new),
        )
    }
}

#[cfg(test)]
mod tests;
