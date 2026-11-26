//! Input delivery for a PTY session.
//!
//! A write to the PTY master blocks while the slave's input queue is full, which is exactly the
//! state of a child that produces output but is not reading its input. Writing on the caller's
//! thread therefore froze the JavaScript host: the reader thread waits for JavaScript to take each
//! output chunk, JavaScript waits for the write, and the child waits for its output to drain
//! (senpi#3857). Input is instead handed to a per-session writer thread, so a full input queue only
//! stalls that thread while output keeps flowing.

use crate::session::{PtyError, PtyResult};
use std::io::Write;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, PoisonError};

/// Input accepted but not yet taken by the child, beyond which a further write is refused.
/// A single write into an empty backlog is always accepted, whatever its size.
pub(crate) const MAX_PENDING_INPUT_BYTES: usize = 16 * 1024 * 1024;

type BoxedWriter = Box<dyn Write + Send>;
type SharedFailure = Arc<Mutex<Option<String>>>;

enum InputState {
    Idle(BoxedWriter),
    Running(InputQueue),
    Closed,
}

struct InputQueue {
    sender: Sender<Vec<u8>>,
    pending: Arc<AtomicUsize>,
    failure: SharedFailure,
}

pub(crate) struct PtyInput {
    state: Mutex<InputState>,
}

impl PtyInput {
    pub(crate) fn new(writer: BoxedWriter) -> Self {
        Self {
            state: Mutex::new(InputState::Idle(writer)),
        }
    }

    pub(crate) fn send(&self, bytes: &[u8]) -> PtyResult<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| PtyError::new("pty writer lock poisoned"))?;
        if matches!(*state, InputState::Idle(_)) {
            if let InputState::Idle(writer) = std::mem::replace(&mut *state, InputState::Closed) {
                *state = InputState::Running(InputQueue::spawn(writer)?);
            }
        }
        match &*state {
            InputState::Running(queue) => queue.send(bytes),
            InputState::Idle(_) | InputState::Closed => Err(closed()),
        }
    }

    pub(crate) fn close(&self) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        *state = InputState::Closed;
    }
}

impl InputQueue {
    fn spawn(writer: BoxedWriter) -> PtyResult<Self> {
        let (sender, receiver) = mpsc::channel();
        let pending = Arc::new(AtomicUsize::new(0));
        let failure: SharedFailure = Arc::new(Mutex::new(None));
        let thread_pending = Arc::clone(&pending);
        let thread_failure = Arc::clone(&failure);
        std::thread::Builder::new()
            .name("senpi-pty-writer".to_string())
            .spawn(move || deliver(writer, &receiver, &thread_pending, &thread_failure))?;
        Ok(Self {
            sender,
            pending,
            failure,
        })
    }

    fn send(&self, bytes: &[u8]) -> PtyResult<()> {
        if let Some(message) = self
            .failure
            .lock()
            .map_err(|_| PtyError::new("pty writer lock poisoned"))?
            .as_ref()
        {
            return Err(PtyError::new(message.clone()));
        }
        let length = bytes.len();
        let backlog = self.pending.fetch_add(length, Ordering::SeqCst);
        if backlog > 0 && backlog.saturating_add(length) > MAX_PENDING_INPUT_BYTES {
            self.pending.fetch_sub(length, Ordering::SeqCst);
            return Err(PtyError::new(format!(
                "pty input backlog is full: the program has not read {backlog} bytes of earlier input"
            )));
        }
        self.sender.send(bytes.to_vec()).map_err(|_| {
            self.pending.fetch_sub(length, Ordering::SeqCst);
            closed()
        })
    }
}

/// Writer-thread body. The writer is kept until every sender is gone, even after a failed write:
/// dropping portable-pty's Unix writer injects `\n` + VEOF, which must never reach a live child
/// before the session has disabled it.
fn deliver(
    mut writer: BoxedWriter,
    receiver: &Receiver<Vec<u8>>,
    pending: &AtomicUsize,
    failure: &Mutex<Option<String>>,
) {
    for chunk in receiver {
        let failed = failure.lock().unwrap_or_else(PoisonError::into_inner).is_some();
        if !failed {
            if let Err(error) = writer.write_all(&chunk).and_then(|()| writer.flush()) {
                *failure.lock().unwrap_or_else(PoisonError::into_inner) = Some(error.to_string());
            }
        }
        pending.fetch_sub(chunk.len(), Ordering::SeqCst);
    }
}

fn closed() -> PtyError {
    PtyError::new("pty session is closed")
}
