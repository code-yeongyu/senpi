use std::f32::consts::PI;

use ratatui::style::{Color, Modifier, Style};
use ratatui::text::Span;

const fn extract_rgb(color: Color) -> Option<(u8, u8, u8)> {
    match color {
        Color::Rgb(r, g, b) => Some((r, g, b)),
        _ => None,
    }
}

#[must_use]
#[allow(clippy::cast_precision_loss)]
pub fn shimmer_spans(text: &str, fg: Color, highlight: Color, now_ms: u64) -> Vec<Span<'static>> {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return Vec::new();
    }

    let padding = 10usize;
    let sweep_seconds = 2.0f32;
    let band_half_width = 5.0f32;
    let period = chars.len() + padding * 2;

    let secs = (now_ms as f32 / 1000.0) % sweep_seconds;
    let pos = (secs / sweep_seconds) * period as f32;

    let rgb_pair = extract_rgb(fg).zip(extract_rgb(highlight));

    let mut spans: Vec<Span<'static>> = Vec::with_capacity(chars.len());
    for (i, ch) in chars.iter().enumerate() {
        let char_pos = (i + padding) as f32;
        let dist = (char_pos - pos).abs();

        let style = match rgb_pair {
            Some((fg_rgb, hi_rgb)) => rgb_style(dist, band_half_width, fg_rgb, hi_rgb),
            None => ansi_style(dist, band_half_width, fg, highlight),
        };
        spans.push(Span::styled(ch.to_string(), style));
    }
    spans
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn rgb_style(dist: f32, band_half_width: f32, fg_rgb: (u8, u8, u8), hi_rgb: (u8, u8, u8)) -> Style {
    let t = if dist <= band_half_width {
        0.5 * (1.0 + (PI * dist / band_half_width).cos())
    } else {
        0.0
    };
    let mix = t * 0.9;
    let blend = |fg_ch: u8, hi_ch: u8| -> u8 {
        let out = (1.0 - mix).mul_add(f32::from(fg_ch), mix * f32::from(hi_ch));
        out.clamp(0.0, 255.0) as u8
    };
    let r = blend(fg_rgb.0, hi_rgb.0);
    let g = blend(fg_rgb.1, hi_rgb.1);
    let b = blend(fg_rgb.2, hi_rgb.2);
    Style::default()
        .fg(Color::Rgb(r, g, b))
        .add_modifier(Modifier::BOLD)
}

fn ansi_style(dist: f32, band_half_width: f32, fg: Color, highlight: Color) -> Style {
    if dist <= band_half_width / 3.0 {
        Style::default().fg(highlight).add_modifier(Modifier::BOLD)
    } else if dist <= band_half_width {
        Style::default().fg(highlight)
    } else {
        Style::default().fg(fg).add_modifier(Modifier::DIM)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_text_returns_empty_spans() {
        assert!(shimmer_spans("", Color::White, Color::Black, 0).is_empty());
    }

    #[test]
    fn span_count_matches_char_count() {
        assert_eq!(shimmer_spans("Hello", Color::White, Color::Black, 0).len(), 5);
    }

    #[test]
    fn all_spans_have_bold_modifier() {
        let spans = shimmer_spans("Working", Color::Rgb(255, 255, 255), Color::Rgb(0, 255, 0), 0);
        assert!(!spans.is_empty());
        for span in &spans {
            assert!(
                span.style.add_modifier.contains(Modifier::BOLD),
                "span {span:?} missing BOLD modifier"
            );
        }
    }

    #[test]
    fn sweep_position_changes_with_time() {
        let fg = Color::Rgb(200, 200, 200);
        let hi = Color::Rgb(0, 255, 255);
        let a = shimmer_spans("Loading session", fg, hi, 0);
        let b = shimmer_spans("Loading session", fg, hi, 500);
        assert_eq!(a.len(), b.len());
        assert!(
            a.iter().zip(b.iter()).any(|(sa, sb)| sa.style.fg != sb.style.fg),
            "expected at least one character to differ in fg between t=0 and t=500ms"
        );
    }
}
