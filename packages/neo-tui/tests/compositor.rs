use std::sync::{Arc, Mutex};

use crossterm::event::{
    Event as CrosstermEvent, KeyCode, KeyEvent, KeyEventKind, KeyEventState, KeyModifiers,
};
use ratatui::{
    Frame, Terminal,
    backend::TestBackend,
    layout::{Position, Rect},
};
use senpi_neo_tui::{
    compositor::{Component, Compositor, EventResult, RenderContext},
    load_bundled_dark_theme,
};

struct MockComponent {
    name: &'static str,
    consume: bool,
    cursor: Option<Position>,
    focusable: bool,
    render_log: Arc<Mutex<Vec<&'static str>>>,
    dispatch_log: Arc<Mutex<Vec<&'static str>>>,
}

impl Component for MockComponent {
    fn name(&self) -> &'static str {
        self.name
    }

    fn render(&mut self, _frame: &mut Frame<'_>, _area: Rect, _ctx: &RenderContext<'_>) {
        self.render_log.lock().unwrap().push(self.name);
    }

    fn handle_event(&mut self, _event: &CrosstermEvent) -> EventResult {
        self.dispatch_log.lock().unwrap().push(self.name);
        if self.consume {
            EventResult::Consumed
        } else {
            EventResult::Ignored
        }
    }

    fn cursor(&self, _area: Rect) -> Option<Position> {
        self.cursor
    }

    fn focusable(&self) -> bool {
        self.focusable
    }
}

fn mock_component(
    name: &'static str,
    render_log: Arc<Mutex<Vec<&'static str>>>,
    dispatch_log: Arc<Mutex<Vec<&'static str>>>,
) -> MockComponent {
    MockComponent {
        name,
        consume: false,
        cursor: None,
        focusable: false,
        render_log,
        dispatch_log,
    }
}

fn key_event() -> CrosstermEvent {
    CrosstermEvent::Key(KeyEvent {
        code: KeyCode::Char('x'),
        modifiers: KeyModifiers::NONE,
        kind: KeyEventKind::Press,
        state: KeyEventState::NONE,
    })
}

#[test]
fn compositor_render_bottom_up_order() {
    let render_log = Arc::new(Mutex::new(Vec::new()));
    let dispatch_log = Arc::new(Mutex::new(Vec::new()));
    let mut compositor = Compositor::new();
    compositor.push(Box::new(mock_component(
        "bottom",
        Arc::clone(&render_log),
        Arc::clone(&dispatch_log),
    )));
    compositor.push(Box::new(mock_component(
        "top",
        Arc::clone(&render_log),
        Arc::clone(&dispatch_log),
    )));

    let backend = TestBackend::new(20, 10);
    let mut terminal = Terminal::new(backend).unwrap();
    let theme = load_bundled_dark_theme().unwrap();
    let ctx = RenderContext {
        theme: &theme,
        frame_index: 0,
        now_ms: 0,
    };
    terminal
        .draw(|frame| compositor.render(frame, Rect::new(0, 0, 20, 10), &ctx))
        .unwrap();

    assert_eq!(*render_log.lock().unwrap(), vec!["bottom", "top"]);
}

#[test]
fn compositor_event_dispatch_top_down() {
    let render_log = Arc::new(Mutex::new(Vec::new()));
    let dispatch_log = Arc::new(Mutex::new(Vec::new()));
    let mut compositor = Compositor::new();
    compositor.push(Box::new(mock_component(
        "bottom",
        Arc::clone(&render_log),
        Arc::clone(&dispatch_log),
    )));
    compositor.push(Box::new(mock_component(
        "top",
        Arc::clone(&render_log),
        Arc::clone(&dispatch_log),
    )));

    compositor.handle_event(&key_event());

    assert_eq!(*dispatch_log.lock().unwrap(), vec!["top", "bottom"]);
}

#[test]
fn compositor_event_consumed_stops_propagation() {
    let render_log = Arc::new(Mutex::new(Vec::new()));
    let dispatch_log = Arc::new(Mutex::new(Vec::new()));
    let mut top = mock_component("top", Arc::clone(&render_log), Arc::clone(&dispatch_log));
    top.consume = true;
    let mut compositor = Compositor::new();
    compositor.push(Box::new(mock_component(
        "bottom",
        Arc::clone(&render_log),
        Arc::clone(&dispatch_log),
    )));
    compositor.push(Box::new(top));

    let result = compositor.handle_event(&key_event());

    assert_eq!(result, EventResult::Consumed);
    assert_eq!(*dispatch_log.lock().unwrap(), vec!["top"]);
}

#[test]
fn compositor_cursor_from_top_focusable() {
    let render_log = Arc::new(Mutex::new(Vec::new()));
    let dispatch_log = Arc::new(Mutex::new(Vec::new()));
    let mut top = mock_component("top", Arc::clone(&render_log), Arc::clone(&dispatch_log));
    top.focusable = true;
    top.cursor = Some(Position::new(5, 3));
    let mut compositor = Compositor::new();
    compositor.push(Box::new(mock_component(
        "bottom",
        Arc::clone(&render_log),
        Arc::clone(&dispatch_log),
    )));
    compositor.push(Box::new(top));

    assert_eq!(
        compositor.cursor(Rect::new(0, 0, 20, 10)),
        Some(Position::new(5, 3)),
    );
}

#[test]
fn compositor_cursor_falls_through_when_top_returns_none() {
    let render_log = Arc::new(Mutex::new(Vec::new()));
    let dispatch_log = Arc::new(Mutex::new(Vec::new()));
    let mut bottom = mock_component("bottom", Arc::clone(&render_log), Arc::clone(&dispatch_log));
    bottom.focusable = true;
    bottom.cursor = Some(Position::new(1, 1));
    let mut top = mock_component("top", Arc::clone(&render_log), Arc::clone(&dispatch_log));
    top.focusable = true;
    let mut compositor = Compositor::new();
    compositor.push(Box::new(bottom));
    compositor.push(Box::new(top));

    assert_eq!(
        compositor.cursor(Rect::new(0, 0, 20, 10)),
        Some(Position::new(1, 1)),
    );
}

#[test]
fn compositor_push_pop() {
    let render_log = Arc::new(Mutex::new(Vec::new()));
    let dispatch_log = Arc::new(Mutex::new(Vec::new()));
    let mut compositor = Compositor::new();
    compositor.push(Box::new(mock_component(
        "bottom",
        Arc::clone(&render_log),
        Arc::clone(&dispatch_log),
    )));
    compositor.push(Box::new(mock_component(
        "top",
        Arc::clone(&render_log),
        Arc::clone(&dispatch_log),
    )));
    assert_eq!(compositor.len(), 2);

    let popped = compositor.pop();

    assert!(popped.is_some());
    assert_eq!(compositor.len(), 1);

    let backend = TestBackend::new(20, 10);
    let mut terminal = Terminal::new(backend).unwrap();
    let theme = load_bundled_dark_theme().unwrap();
    let ctx = RenderContext {
        theme: &theme,
        frame_index: 0,
        now_ms: 0,
    };
    terminal
        .draw(|frame| compositor.render(frame, Rect::new(0, 0, 20, 10), &ctx))
        .unwrap();
    assert_eq!(*render_log.lock().unwrap(), vec!["bottom"]);
}

#[test]
fn compositor_replace_top() {
    let render_log = Arc::new(Mutex::new(Vec::new()));
    let dispatch_log = Arc::new(Mutex::new(Vec::new()));
    let mut compositor = Compositor::new();
    compositor.push(Box::new(mock_component(
        "bottom",
        Arc::clone(&render_log),
        Arc::clone(&dispatch_log),
    )));
    compositor.push(Box::new(mock_component(
        "top",
        Arc::clone(&render_log),
        Arc::clone(&dispatch_log),
    )));
    compositor.replace_top(Box::new(mock_component(
        "new",
        Arc::clone(&render_log),
        Arc::clone(&dispatch_log),
    )));

    assert_eq!(compositor.len(), 2);
    let backend = TestBackend::new(20, 10);
    let mut terminal = Terminal::new(backend).unwrap();
    let theme = load_bundled_dark_theme().unwrap();
    let ctx = RenderContext {
        theme: &theme,
        frame_index: 0,
        now_ms: 0,
    };
    terminal
        .draw(|frame| compositor.render(frame, Rect::new(0, 0, 20, 10), &ctx))
        .unwrap();
    assert_eq!(*render_log.lock().unwrap(), vec!["bottom", "new"]);
}

#[test]
fn compositor_focus_set_and_get() {
    let render_log = Arc::new(Mutex::new(Vec::new()));
    let dispatch_log = Arc::new(Mutex::new(Vec::new()));
    let mut compositor = Compositor::new();
    compositor.push(Box::new(mock_component(
        "bottom",
        Arc::clone(&render_log),
        Arc::clone(&dispatch_log),
    )));
    compositor.push(Box::new(mock_component(
        "top",
        Arc::clone(&render_log),
        Arc::clone(&dispatch_log),
    )));

    compositor.set_focus(0);
    compositor.handle_event(&key_event());

    assert_eq!(compositor.focused_index(), Some(0));
    assert_eq!(*dispatch_log.lock().unwrap(), vec!["bottom", "top"]);
}
