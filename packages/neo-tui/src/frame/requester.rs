//! Coalescing frame draw scheduler.
//!
//! [`FrameRequester`] is a cheap clonable handle that anything in the TUI can
//! use to ask for a redraw. Internally it talks to a [`FrameScheduler`] actor
//! that coalesces many requests into a single broadcast notification while
//! respecting the 120 FPS cap enforced by [`FrameRateLimiter`].

#![allow(
    clippy::redundant_pub_crate,
    reason = "frame items are pub(crate)-scoped; module itself is pub(crate) in lib.rs"
)]
#![allow(
    dead_code,
    reason = "consumed by senpi-neo-tui app integration in a follow-up change"
)]

use std::time::{Duration, Instant};

use tokio::sync::{broadcast, mpsc};
use tokio::time::sleep_until;

use super::rate_limiter::FrameRateLimiter;

const ONE_YEAR: Duration = Duration::from_secs(31_536_000);

#[derive(Clone, Debug)]
pub(crate) struct FrameRequester {
    frame_schedule_tx: mpsc::UnboundedSender<Instant>,
}

impl FrameRequester {
    pub(crate) fn new(draw_tx: broadcast::Sender<()>) -> Self {
        let (frame_schedule_tx, frame_schedule_rx) = mpsc::unbounded_channel();
        let scheduler = FrameScheduler::new(frame_schedule_rx, draw_tx);
        tokio::spawn(scheduler.run());
        Self { frame_schedule_tx }
    }

    pub(crate) fn schedule_frame(&self) {
        let _ = self.frame_schedule_tx.send(Instant::now());
    }

    pub(crate) fn schedule_frame_in(&self, delay: Duration) {
        let when = Instant::now().checked_add(delay).unwrap_or_else(Instant::now);
        let _ = self.frame_schedule_tx.send(when);
    }

    #[cfg(test)]
    pub(crate) fn test_dummy() -> Self {
        let (tx, _rx) = mpsc::unbounded_channel();
        Self {
            frame_schedule_tx: tx,
        }
    }
}

#[derive(Debug)]
struct FrameScheduler {
    receiver: mpsc::UnboundedReceiver<Instant>,
    draw_tx: broadcast::Sender<()>,
    rate_limiter: FrameRateLimiter,
}

impl FrameScheduler {
    fn new(receiver: mpsc::UnboundedReceiver<Instant>, draw_tx: broadcast::Sender<()>) -> Self {
        Self {
            receiver,
            draw_tx,
            rate_limiter: FrameRateLimiter::default(),
        }
    }

    async fn run(mut self) {
        let mut next_deadline: Option<Instant> = None;
        loop {
            let target = next_deadline
                .unwrap_or_else(|| Instant::now().checked_add(ONE_YEAR).unwrap_or_else(Instant::now));
            let sleep_fut = sleep_until(target.into());
            tokio::pin!(sleep_fut);

            tokio::select! {
                draw_at = self.receiver.recv() => {
                    match draw_at {
                        Some(when) => {
                            let clamped = self.rate_limiter.clamp_deadline(when);
                            next_deadline = Some(
                                next_deadline.map_or(clamped, |cur| cur.min(clamped)),
                            );
                        }
                        None => break,
                    }
                }
                () = &mut sleep_fut => {
                    if next_deadline.is_some() {
                        next_deadline = None;
                        self.rate_limiter.mark_emitted(target);
                        let _ = self.draw_tx.send(());
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::rate_limiter::MIN_FRAME_INTERVAL;
    use super::*;
    use tokio::time::{advance, timeout};

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn schedule_frame_immediate_triggers_once() {
        let (draw_tx, mut draw_rx) = broadcast::channel(16);
        let requester = FrameRequester::new(draw_tx);

        requester.schedule_frame();
        advance(Duration::from_millis(1)).await;

        let first = timeout(Duration::from_millis(50), draw_rx.recv())
            .await
            .expect("timed out waiting for first draw");
        assert!(first.is_ok(), "broadcast closed unexpectedly");

        let second = timeout(Duration::from_millis(20), draw_rx.recv()).await;
        assert!(second.is_err(), "unexpected extra draw received");
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn coalesces_multiple_requests_into_single_draw() {
        let (draw_tx, mut draw_rx) = broadcast::channel(16);
        let requester = FrameRequester::new(draw_tx);

        requester.schedule_frame();
        requester.schedule_frame();
        requester.schedule_frame();

        advance(Duration::from_millis(1)).await;

        let first = timeout(Duration::from_millis(50), draw_rx.recv())
            .await
            .expect("timed out waiting for coalesced draw");
        assert!(first.is_ok(), "broadcast closed unexpectedly");

        let second = timeout(Duration::from_millis(20), draw_rx.recv()).await;
        assert!(second.is_err(), "unexpected extra draw received");
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn rate_limits_to_120fps() {
        let (draw_tx, mut draw_rx) = broadcast::channel(16);
        let requester = FrameRequester::new(draw_tx);

        requester.schedule_frame();
        advance(Duration::from_millis(1)).await;
        let first = timeout(Duration::from_millis(50), draw_rx.recv())
            .await
            .expect("timed out waiting for first draw");
        assert!(first.is_ok(), "broadcast closed unexpectedly");

        requester.schedule_frame();
        advance(Duration::from_millis(1)).await;
        let early = timeout(Duration::from_millis(1), draw_rx.recv()).await;
        assert!(early.is_err(), "draw fired before rate-limit interval");

        advance(MIN_FRAME_INTERVAL).await;
        let second = timeout(Duration::from_millis(50), draw_rx.recv())
            .await
            .expect("timed out waiting for rate-limited draw");
        assert!(second.is_ok(), "broadcast closed unexpectedly");
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn schedule_frame_in_triggers_at_delay() {
        let (draw_tx, mut draw_rx) = broadcast::channel(16);
        let requester = FrameRequester::new(draw_tx);

        requester.schedule_frame_in(Duration::from_millis(50));

        advance(Duration::from_millis(30)).await;
        let early = timeout(Duration::from_millis(1), draw_rx.recv()).await;
        assert!(early.is_err(), "draw fired before delay elapsed");

        advance(Duration::from_millis(25)).await;
        let first = timeout(Duration::from_millis(50), draw_rx.recv())
            .await
            .expect("timed out waiting for delayed draw");
        assert!(first.is_ok(), "broadcast closed unexpectedly");

        let second = timeout(Duration::from_millis(20), draw_rx.recv()).await;
        assert!(second.is_err(), "unexpected extra draw received");
    }
}
