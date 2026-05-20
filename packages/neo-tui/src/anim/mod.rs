//! Animation primitives: spinner, scanner, pulse, shimmer.
//!
//! All animations are time-driven (millisecond `now`), stateless from
//! the caller's perspective beyond construction. Frames are pure
//! functions of `now`.

const BRAILLE_FRAMES: &[char] = &[
    '\u{2802}', '\u{2804}', '\u{2806}', '\u{2826}', '\u{2827}', '\u{2837}', '\u{283F}', '\u{281F}',
];
const TICK_INTERVAL_MS: u64 = 80;

#[derive(Clone, Copy, Debug)]
pub struct Spinner {
    frames: &'static [char],
    interval_ms: u64,
}

impl Spinner {
    pub const fn braille() -> Self {
        Self {
            frames: BRAILLE_FRAMES,
            interval_ms: TICK_INTERVAL_MS,
        }
    }
    pub const fn custom(frames: &'static [char], interval_ms: u64) -> Self {
        Self { frames, interval_ms }
    }
    // CLIPPY-ALLOW: `now_ms / interval_ms` is a small tick counter; truncation on 32-bit targets is harmless.
    #[allow(clippy::cast_possible_truncation)]
    pub fn next_frame(self, now_ms: u64) -> char {
        if self.frames.is_empty() {
            return ' ';
        }
        let idx = ((now_ms / self.interval_ms) as usize) % self.frames.len();
        self.frames[idx]
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Scanner {
    width: usize,
    interval_ms: u64,
}

impl Scanner {
    pub const fn new(width: usize) -> Self {
        Self {
            width,
            interval_ms: 60,
        }
    }
    // CLIPPY-ALLOW: `now_ms / interval_ms` is a small tick counter; truncation on 32-bit targets is harmless.
    #[allow(clippy::cast_possible_truncation)]
    pub const fn current_position(self, now_ms: u64) -> usize {
        if self.width == 0 {
            return 0;
        }
        let period = self.width * 2 - 2; // bounce: 0..width-1..0
        if period == 0 {
            return 0;
        }
        let t = ((now_ms / self.interval_ms) as usize) % period;
        if t < self.width { t } else { period - t }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Pulse {
    period_ms: u64,
}

impl Pulse {
    pub const fn new(period_ms: u64) -> Self {
        Self {
            period_ms: if period_ms == 0 { 1000 } else { period_ms },
        }
    }
    // CLIPPY-ALLOW: `now_ms % period_ms` is bounded by `period_ms` (typically <= 1000),
    // well within f32's 24-bit mantissa. No real precision loss.
    #[allow(clippy::cast_precision_loss)]
    pub fn intensity(self, now_ms: u64) -> f32 {
        let phase = (now_ms % self.period_ms) as f32 / self.period_ms as f32;
        // Smooth sine-based 0..1..0 cycle
        (phase * std::f32::consts::TAU).sin().mul_add(0.5, 0.5)
    }
}

pub mod shimmer;
