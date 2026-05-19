//! Behavioral tests for the native input editor state.

use senpi_neo_tui::components::input::InputState;
use senpi_neo_tui::text::visible_width;

#[test]
fn editor_word_wrap_korean_at_right_edge() {
    let mut input = InputState::default();
    let text = "가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허고노";

    input.insert_str(text);

    let lines = input.display_lines(60);
    assert!(lines.len() >= 2, "expected wrap, got {lines:?}");
    assert_eq!(lines.concat(), text);
    for line in lines {
        assert!(
            visible_width(&line) <= 60,
            "line exceeds wrap width: {line:?} width={}",
            visible_width(&line),
        );
    }
}

#[test]
fn editor_word_wrap_mixed_korean_latin_word_boundary() {
    let mut input = InputState::default();
    let text = "hello 한국어 world testing";

    input.insert_str(text);

    let lines = input.display_lines(20);
    assert_eq!(lines, vec!["hello 한국어 world".to_string(), "testing".to_string()]);
    assert_eq!(lines.join(" "), text);
    assert!(lines.iter().any(|line| line.contains("한국어")));
    for line in lines {
        assert!(visible_width(&line) <= 20, "line exceeds wrap width: {line:?}");
    }
}

#[test]
fn editor_paste_marker_collapses_large_pastes() {
    let mut input = InputState::default();
    let pasted = (1..=15)
        .map(|line| format!("line {line}"))
        .collect::<Vec<_>>()
        .join("\n");

    input.handle_paste(&pasted);

    let displayed = input.display_lines(80).join("\n");
    assert!(
        displayed.contains("[paste #1 +15 lines]"),
        "missing paste marker in {displayed:?}",
    );
    assert!(!displayed.contains("line 1"), "large paste content leaked into display");
    assert_eq!(input.take_buffer(), pasted);
}

#[test]
fn editor_paste_under_10_lines_inlined() {
    let mut input = InputState::default();
    let pasted = (1..=9)
        .map(|line| format!("line {line}"))
        .collect::<Vec<_>>()
        .join("\n");

    input.handle_paste(&pasted);

    assert_eq!(input.buffer, pasted);
    let displayed = input.display_lines(80).join("\n");
    assert_eq!(displayed, pasted);
    assert!(!displayed.contains("[paste #"));
}

#[test]
fn editor_cursor_position_after_wrap() {
    let mut input = InputState::default();
    let text = format!("{}b", "a".repeat(80));

    input.insert_str(&text);

    assert_eq!(input.cursor_visual_position(10), (8, 1));
}

#[test]
fn editor_history_navigation() {
    let mut input = InputState::default();

    input.push_history("first");
    input.push_history("second");

    assert_eq!(input.recall_prev_history().as_deref(), Some("second"));
    assert_eq!(input.recall_prev_history().as_deref(), Some("first"));
    assert_eq!(input.recall_prev_history(), None);
    assert_eq!(input.buffer, "first");
}

#[test]
fn editor_korean_visible_truncation_repro() {
    let mut input = InputState::default();
    let text = "한".repeat(30);

    input.insert_str(&text);

    let lines = input.display_lines(55);
    assert!(lines.len() >= 2, "expected wrap, got {lines:?}");
    assert_eq!(lines.concat(), text);
    for line in lines {
        assert!(visible_width(&line) <= 55, "line exceeds wrap width: {line:?}");
    }
}
