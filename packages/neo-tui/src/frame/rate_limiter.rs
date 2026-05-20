//! Limits how frequently frame draw notifications may be emitted.
//!
//! Widgets sometimes request a redraw more frequently than a user can
//! perceive. This limiter clamps draw notifications to a maximum of
//! 120 FPS to avoid wasted work.
//!
//! Kept as a small, pure helper so it can be unit-tested in isolation and
//! consumed by the async frame scheduler without adding complexity to the
//! app or event loop.

#![allow(
    dead_code,
    reason = "consumed by senpi-neo-tui app integration in a follow-up change"
)]
#![allow(
    clippy::redundant_pub_crate,
    reason = "frame is pub(crate) in lib.rs; pub(crate) items here mirror the crate-wide exposure intended for app integration"
)]

use std::time::{Duration, Instant};

/// A 120 FPS minimum frame interval (~8.33 ms).
pub(crate) const MIN_FRAME_INTERVAL: Duration = Duration::from_nanos(8_333_334);

/// Remembers the most recent emitted draw, allowing deadlines to be clamped forward.
#[derive(Debug, Default)]
pub(crate) struct FrameRateLimiter {
    last_emitted_at: Option<Instant>,
}

impl FrameRateLimiter {
    /// Returns `requested`, clamped forward if it would exceed the maximum frame rate.
    pub(crate) fn clamp_deadline(&self, requested: Instant) -> Instant {
        self.last_emitted_at.map_or(requested, |last| {
            let earliest = last.checked_add(MIN_FRAME_INTERVAL).unwrap_or(last);
            requested.max(earliest)
        })
    }

    /// Records that a draw notification was emitted at `emitted_at`.
    pub(crate) const fn mark_emitted(&mut self, emitted_at: Instant) {
        self.last_emitted_at = Some(emitted_at);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_does_not_clamp() {
        let t0 = Instant::now();
        let limiter = FrameRateLimiter::default();
        assert_eq!(limiter.clamp_deadline(t0), t0);
    }

    #[test]
    fn clamps_to_min_interval_since_last_emit() {
        let t0 = Instant::now();
        let mut limiter = FrameRateLimiter::default();
        limiter.mark_emitted(t0);
        let too_soon = t0 + Duration::from_millis(1);
        assert_eq!(limiter.clamp_deadline(too_soon), t0 + MIN_FRAME_INTERVAL);
    }

    #[test]
    fn does_not_clamp_far_future_deadline() {
        let t0 = Instant::now();
        let mut limiter = FrameRateLimiter::default();
        limiter.mark_emitted(t0);
        let far_future = t0 + Duration::from_millis(100);
        assert_eq!(limiter.clamp_deadline(far_future), far_future);
    }
}
