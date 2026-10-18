use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Checkpoint {
    Walk,
    BeforeRead,
    Read,
    Scan,
    Sink,
    Finish,
}

/// Shared by the walker, rayon workers, and the N-API task's abort handler.
/// Timeouts are sticky; an explicit abort always takes precedence over timeout.
pub struct CancelToken {
    pub deadline: Instant,
    pub aborted: Arc<AtomicBool>,
    timed_out: AtomicBool,
    #[cfg(test)]
    clock: Option<Box<dyn Fn(Checkpoint) -> Instant + Send + Sync>>,
}

impl CancelToken {
    pub fn new(timeout_ms: Option<u32>) -> Self {
        Self {
            deadline: Instant::now() + Duration::from_millis(timeout_ms.unwrap_or(30_000).into()),
            aborted: Arc::new(AtomicBool::new(false)),
            timed_out: AtomicBool::new(false),
            #[cfg(test)]
            clock: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn with_clock(
        deadline: Instant,
        clock: impl Fn(Checkpoint) -> Instant + Send + Sync + 'static,
    ) -> Self {
        Self {
            deadline,
            clock: Some(Box::new(clock)),
            ..Self::new(None)
        }
    }

    pub fn is_aborted(&self) -> bool {
        self.aborted.load(Ordering::Acquire)
    }

    pub(crate) fn timed_out(&self) -> bool {
        self.timed_out.load(Ordering::Relaxed)
    }

    pub(crate) fn check(&self, _point: Checkpoint) -> io::Result<()> {
        #[cfg(test)]
        let now = self
            .clock
            .as_ref()
            .map_or_else(Instant::now, |clock| clock(_point));
        #[cfg(not(test))]
        let now = Instant::now();
        if self.is_aborted() {
            return Err(io::Error::new(io::ErrorKind::Interrupted, "Search aborted"));
        }
        if now >= self.deadline || self.timed_out() {
            self.timed_out.store(true, Ordering::Relaxed);
            return Err(io::Error::new(io::ErrorKind::TimedOut, "Search timed out"));
        }
        Ok(())
    }
}
