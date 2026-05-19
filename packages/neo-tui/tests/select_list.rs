use crossterm::event::{
    Event as CrosstermEvent, KeyCode, KeyEvent, KeyEventKind, KeyEventState, KeyModifiers,
};
use ratatui::{Terminal, backend::TestBackend, layout::Rect};
use senpi_neo_tui::{
    components::select_list::SelectList,
    compositor::{Component, EventResult, RenderContext},
    load_bundled_dark_theme,
};

const fn key_event(code: KeyCode) -> CrosstermEvent {
    CrosstermEvent::Key(KeyEvent {
        code,
        modifiers: KeyModifiers::NONE,
        kind: KeyEventKind::Press,
        state: KeyEventState::NONE,
    })
}

#[test]
fn select_list_initial_selection_zero() {
    let list = SelectList::new(vec!["a", "b", "c"]);
    assert_eq!(list.selected_index(), Some(0));
}

#[test]
fn select_list_empty_no_selection() {
    let list = SelectList::new(Vec::<String>::new());
    assert_eq!(list.selected_index(), None);
}

#[test]
fn select_list_arrow_down_advances() {
    let mut list = SelectList::new(vec!["a", "b", "c"]);
    let result = list.handle_event(&key_event(KeyCode::Down));
    assert_eq!(result, EventResult::Consumed);
    assert_eq!(list.selected_index(), Some(1));
}

#[test]
fn select_list_arrow_up_at_top_stays() {
    let mut list = SelectList::new(vec!["a", "b", "c"]);
    let result = list.handle_event(&key_event(KeyCode::Up));
    assert_eq!(result, EventResult::Consumed);
    assert_eq!(list.selected_index(), Some(0));
}

#[test]
fn select_list_arrow_down_at_bottom_stays() {
    let mut list = SelectList::new(vec!["a", "b", "c"]);
    list.handle_event(&key_event(KeyCode::Down));
    list.handle_event(&key_event(KeyCode::Down));
    assert_eq!(list.selected_index(), Some(2));
    let result = list.handle_event(&key_event(KeyCode::Down));
    assert_eq!(result, EventResult::Consumed);
    assert_eq!(list.selected_index(), Some(2));
}

#[test]
fn select_list_page_down_jumps_visible_height() {
    let mut list = SelectList::new(vec!["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"]);
    list.set_visible_height(3);
    let result = list.handle_event(&key_event(KeyCode::PageDown));
    assert_eq!(result, EventResult::Consumed);
    assert_eq!(list.selected_index(), Some(3));
}

#[test]
fn select_list_enter_returns_consumed_with_selection() {
    let mut list = SelectList::new(vec!["a", "b", "c"]);
    list.handle_event(&key_event(KeyCode::Down));
    let result = list.handle_event(&key_event(KeyCode::Enter));
    assert_eq!(result, EventResult::Consumed);
    assert_eq!(list.take_selection(), Some(("b".to_string(), 1)));
}

#[test]
fn select_list_escape_returns_consumed_and_marks_cancelled() {
    let mut list = SelectList::new(vec!["a", "b", "c"]);
    let result = list.handle_event(&key_event(KeyCode::Esc));
    assert_eq!(result, EventResult::Consumed);
    assert!(list.was_cancelled());
}

#[test]
fn select_list_filter_narrows_options() {
    let mut list = SelectList::new(vec!["apple", "banana", "apricot"]);
    list.set_filter("ap");
    assert_eq!(list.visible_indices().len(), 2);
    assert_eq!(list.selected_index(), Some(0));
}

#[test]
fn select_list_filter_empty_string_shows_all() {
    let mut list = SelectList::new(vec!["apple", "banana", "apricot"]);
    list.set_filter("ap");
    assert_eq!(list.visible_indices().len(), 2);
    list.set_filter("");
    assert_eq!(list.visible_indices().len(), 3);
}

#[test]
fn select_list_scroll_indicator_when_overflow() {
    let items: Vec<String> = (0..100).map(|i| format!("item-{i}")).collect();
    let mut list = SelectList::new(items);
    list.set_visible_height(10);
    // Move selection to index 50
    for _ in 0..50 {
        list.handle_event(&key_event(KeyCode::Down));
    }
    assert_eq!(list.selected_index(), Some(50));

    // Render to exercise the path; the real assertion is on scroll offset.
    let backend = TestBackend::new(20, 15);
    let mut terminal = Terminal::new(backend).unwrap();
    let theme = load_bundled_dark_theme().unwrap();
    let ctx = RenderContext {
        theme: &theme,
        frame_index: 0,
        now_ms: 0,
    };
    terminal
        .draw(|frame| list.render(frame, Rect::new(0, 0, 20, 15), &ctx))
        .unwrap();

    // Selection at 50 with visible_height 10 should have scrolled down.
    assert_ne!(list.scroll_top_offset(), 0);
}
