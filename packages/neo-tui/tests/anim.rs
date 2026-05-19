//! Animation primitive contract tests.
//!
//! T4A locks spinner, scanner, and pulse behaviour.  All tests are
//! pure functions of `now_ms` — no UI integration here.

use senpi_neo_tui::anim::{Pulse, Scanner, Spinner};

// ------------------------------------------------------------------
// Spinner
// ------------------------------------------------------------------

#[test]
fn spinner_braille_cycles_through_8_frames() {
    let spinner = Spinner::braille();
    let mut chars = Vec::new();
    for i in 0..8 {
        let t = i * 80;
        chars.push(spinner.next_frame(t));
    }
    // All 8 frames must be distinct.
    let unique: std::collections::HashSet<_> = chars.iter().copied().collect();
    assert_eq!(
        unique.len(),
        8,
        "expected 8 distinct braille frames, got {chars:?}"
    );
    // Each char must be a valid braille pattern.
    let expected = [
        '\u{2802}', '\u{2804}', '\u{2806}', '\u{2826}', '\u{2827}', '\u{2837}', '\u{283F}', '\u{281F}',
    ];
    for (i, &ch) in chars.iter().enumerate() {
        assert_eq!(ch, expected[i], "frame {i} mismatch");
    }
}

#[test]
fn spinner_respects_tick_interval() {
    let spinner = Spinner::braille();
    let a = spinner.next_frame(0);
    let b = spinner.next_frame(40);
    let c = spinner.next_frame(80);
    assert_eq!(a, b, "same frame within one interval");
    assert_ne!(a, c, "advanced to next frame at boundary");
}

#[test]
fn spinner_wraps_around() {
    let spinner = Spinner::braille();
    for i in 0..100 {
        let t = i * 80;
        let _ch = spinner.next_frame(t);
        // Must not panic; index always within bounds.
    }
}

// ------------------------------------------------------------------
// Scanner (knight-rider bounce)
// ------------------------------------------------------------------

#[test]
fn scanner_advances_left_to_right() {
    let scanner = Scanner::new(10);
    let positions: Vec<usize> = (0..20).map(|i| scanner.current_position(i * 60)).collect();
    // First pass: 0,1,2,...,9
    for (i, &pos) in positions.iter().enumerate().take(10) {
        assert_eq!(pos, i, "forward sweep at step {i}");
    }
    // Bounce back: 8,7,...,1,0
    for (i, &pos) in positions.iter().enumerate().skip(10).take(9) {
        assert_eq!(pos, 19 - i - 1, "backward sweep at step {i}");
    }
    // Then repeats 0,1,2,...
    assert_eq!(positions[18], 0);
    assert_eq!(positions[19], 1);
}

#[test]
fn scanner_pause_holds_position() {
    let scanner = Scanner::new(10);
    let p1 = scanner.current_position(0);
    let p2 = scanner.current_position(0);
    assert_eq!(p1, p2, "same timestamp must yield same position");
}

// ------------------------------------------------------------------
// Pulse (breathing)
// ------------------------------------------------------------------

#[test]
fn pulse_intensity_in_unit_range() {
    let pulse = Pulse::new(1000);
    for t in [0, 250, 500, 750, 999, 1000, 2000] {
        let v = pulse.intensity(t);
        assert!((0.0..=1.0).contains(&v), "intensity({t}) = {v} out of [0,1]");
    }
}

#[test]
fn pulse_at_zero_is_zero_or_min() {
    let pulse = Pulse::new(1000);
    let v = pulse.intensity(0);
    assert!(
        v.abs() < 1e-3 || (v - 0.5).abs() < 1e-3,
        "intensity(0) should be near 0 or 0.5, got {v}"
    );
}

#[test]
fn pulse_periodic() {
    let pulse = Pulse::new(1000);
    let a = pulse.intensity(0);
    let b = pulse.intensity(1000);
    assert!(
        (a - b).abs() < 1e-4,
        "intensity(0)={a} should equal intensity(1000)={b}"
    );
}
