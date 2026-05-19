//! Contract tests for ANSI-aware text utilities.

use senpi_neo_tui::text::{slice_by_column, truncate_to_width, visible_width, wrap_text_with_ansi};

#[test]
fn visible_width_plain_ascii() {
    assert_eq!(visible_width("hello"), 5);
}

#[test]
fn visible_width_strips_csi_escape() {
    assert_eq!(visible_width("\x1b[31mred\x1b[0m"), 3);
}

#[test]
fn visible_width_cjk_double() {
    assert_eq!(visible_width("한국어"), 6);
}

#[test]
fn visible_width_emoji_zwj_one_grapheme() {
    assert_eq!(visible_width("👨‍👩‍👧"), 2);
}

#[test]
fn visible_width_combining_marks_zero() {
    assert_eq!(visible_width("é"), 1);
}

#[test]
fn visible_width_mixed_ansi_cjk() {
    assert_eq!(visible_width("\x1b[33m한\x1b[0m한"), 4);
}

#[test]
fn truncate_to_width_no_truncation_needed() {
    assert_eq!(truncate_to_width("hello", 8, "…"), "hello");
}

#[test]
fn truncate_to_width_basic() {
    assert_eq!(truncate_to_width("hello world", 8, "…"), "hello w…");
}

#[test]
fn truncate_to_width_preserves_ansi_after_cut() {
    let truncated = truncate_to_width("\x1b[31mhello world\x1b[0m", 8, "…");

    assert!(
        truncated.ends_with("\x1b[0m"),
        "truncated styled text must close ANSI style: {truncated:?}",
    );
}

#[test]
fn truncate_to_width_cjk_boundary() {
    assert_eq!(truncate_to_width("한국어", 4, "…"), "한…");
}

#[test]
fn wrap_text_with_ansi_basic() {
    assert_eq!(
        wrap_text_with_ansi("the quick brown fox", 10),
        vec!["the quick".to_string(), "brown fox".to_string()],
    );
}

#[test]
fn wrap_text_with_ansi_preserves_color_across_wrap() {
    assert_eq!(
        wrap_text_with_ansi("\x1b[33mthe quick brown fox\x1b[0m", 10),
        vec![
            "\x1b[33mthe quick\x1b[0m".to_string(),
            "\x1b[33mbrown fox\x1b[0m".to_string(),
        ],
    );
}

#[test]
fn wrap_text_with_ansi_cjk() {
    assert_eq!(
        wrap_text_with_ansi("한국어 만세 만세", 8),
        vec!["한국어".to_string(), "만세".to_string(), "만세".to_string()],
    );
}

#[test]
fn wrap_text_with_ansi_long_word_hard_break() {
    assert_eq!(
        wrap_text_with_ansi("abcdefghijklmnop", 5),
        vec![
            "abcde".to_string(),
            "fghij".to_string(),
            "klmno".to_string(),
            "p".to_string(),
        ],
    );
}

#[test]
fn wrap_text_with_ansi_empty_input_returns_empty() {
    assert_eq!(wrap_text_with_ansi("", 10), Vec::<String>::new());
}

#[test]
fn slice_by_column_plain() {
    assert_eq!(slice_by_column("hello world", 6, 11), "world");
}

#[test]
fn slice_by_column_with_ansi() {
    assert_eq!(slice_by_column("\x1b[31mhello\x1b[0m world", 6, 11), " worl");
}

#[test]
fn slice_by_column_cjk() {
    assert_eq!(slice_by_column("한국어", 2, 4), "국");
}
