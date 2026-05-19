use crossterm::event::{
    Event as CrosstermEvent, KeyCode, KeyEvent, KeyEventKind, KeyEventState, KeyModifiers,
};
use senpi_neo_tui::overlay::{MODELS, ModelPickerOverlay, OverlayResult, ThemePickerOverlay};
use senpi_neo_tui::theme::registry::list_theme_ids;

const fn key_event(code: KeyCode) -> CrosstermEvent {
    CrosstermEvent::Key(KeyEvent {
        code,
        modifiers: KeyModifiers::NONE,
        kind: KeyEventKind::Press,
        state: KeyEventState::NONE,
    })
}

#[test]
fn model_picker_opens_with_all_models() {
    let overlay = ModelPickerOverlay::new();
    assert_eq!(overlay.visible_items(), MODELS);
}

#[test]
fn model_picker_filter_narrows() {
    let mut overlay = ModelPickerOverlay::new();
    overlay.set_filter("opus");
    assert_eq!(
        overlay.visible_items(),
        ["claude-opus-4-7", "claude-opus-4-6"],
    );
}

#[test]
fn model_picker_enter_returns_action_set_model() {
    let mut overlay = ModelPickerOverlay::new();
    assert_eq!(
        overlay.handle_event(&key_event(KeyCode::Enter)),
        OverlayResult::Selected("neo.model.set:claude-opus-4-7".to_string()),
    );
}

#[test]
fn model_picker_esc_returns_cancelled() {
    let mut overlay = ModelPickerOverlay::new();
    assert_eq!(
        overlay.handle_event(&key_event(KeyCode::Esc)),
        OverlayResult::Cancelled,
    );
}

#[test]
fn theme_picker_opens_with_all_themes() {
    let overlay = ThemePickerOverlay::new("senpi-neo-dark");
    assert_eq!(overlay.visible_items(), list_theme_ids());
}

#[test]
fn theme_picker_filter_narrows() {
    let mut overlay = ThemePickerOverlay::new("senpi-neo-dark");
    overlay.set_filter("dracula");
    assert_eq!(overlay.visible_items(), ["dracula"]);
}

#[test]
fn theme_picker_enter_returns_action_set_theme() {
    let mut overlay = ThemePickerOverlay::new("senpi-neo-dark");
    overlay.set_filter("dracula");
    assert_eq!(
        overlay.handle_event(&key_event(KeyCode::Enter)),
        OverlayResult::Selected("neo.theme.set:dracula".to_string()),
    );
}

#[test]
fn theme_picker_default_selection_marks_current() {
    let overlay = ThemePickerOverlay::new("tokyonight");
    assert_eq!(overlay.selected_item(), Some("tokyonight"));
}
