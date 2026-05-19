//! Helix-style component stack. Renders bottom-up, dispatches top-down.
//! Tracks focus + cursor for IME positioning.

use crossterm::event::Event as CrosstermEvent;
use ratatui::{
    Frame,
    layout::{Position, Rect},
};

use crate::theme::ResolvedTheme;

/// Bubble-or-consume signal returned by [`Component::handle_event`].
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EventResult {
    Consumed,
    Ignored,
}

/// Shared render metadata supplied by the app render loop.
#[derive(Debug)]
pub struct RenderContext<'a> {
    pub theme: &'a ResolvedTheme,
    pub frame_index: u64,
    pub now_ms: u64,
}

/// Trait every composited UI element implements.
pub trait Component {
    fn name(&self) -> &'static str;

    fn render(&mut self, frame: &mut Frame<'_>, area: Rect, ctx: &RenderContext<'_>);

    fn handle_event(&mut self, event: &CrosstermEvent) -> EventResult {
        let _ = event;
        EventResult::Ignored
    }

    fn cursor(&self, area: Rect) -> Option<Position> {
        let _ = area;
        None
    }

    fn focusable(&self) -> bool {
        false
    }
}

/// Stack-of-layers compositor.
pub struct Compositor {
    stack: Vec<Box<dyn Component>>,
    focus_idx: Option<usize>,
}

impl Compositor {
    #[must_use]
    pub const fn new() -> Self {
        Self {
            stack: Vec::new(),
            focus_idx: None,
        }
    }

    pub fn push(&mut self, component: Box<dyn Component>) {
        self.stack.push(component);
    }

    pub fn pop(&mut self) -> Option<Box<dyn Component>> {
        let component = self.stack.pop();
        if self.focus_idx.is_some_and(|idx| idx >= self.stack.len()) {
            self.focus_idx = None;
        }
        component
    }

    pub fn replace_top(&mut self, component: Box<dyn Component>) {
        let _ = self.pop();
        self.push(component);
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.stack.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.stack.is_empty()
    }

    #[must_use]
    pub const fn focused_index(&self) -> Option<usize> {
        self.focus_idx
    }

    pub fn set_focus(&mut self, idx: usize) {
        if idx < self.stack.len() {
            self.focus_idx = Some(idx);
        }
    }

    pub const fn clear_focus(&mut self) {
        self.focus_idx = None;
    }

    pub fn render(&mut self, frame: &mut Frame<'_>, area: Rect, ctx: &RenderContext<'_>) {
        for component in &mut self.stack {
            component.render(frame, area, ctx);
        }
    }

    pub fn handle_event(&mut self, event: &CrosstermEvent) -> EventResult {
        let focused_idx = self.focus_idx.filter(|&idx| idx < self.stack.len());
        if let Some(idx) = focused_idx {
            let result = self.stack[idx].handle_event(event);
            if result == EventResult::Consumed {
                return EventResult::Consumed;
            }
        }

        for (idx, component) in self.stack.iter_mut().enumerate().rev() {
            if Some(idx) == focused_idx {
                continue;
            }
            let result = component.handle_event(event);
            if result == EventResult::Consumed {
                return EventResult::Consumed;
            }
        }

        EventResult::Ignored
    }

    #[must_use]
    pub fn cursor(&self, area: Rect) -> Option<Position> {
        for component in self.stack.iter().rev() {
            if component.focusable() {
                if let Some(position) = component.cursor(area) {
                    return Some(position);
                }
            }
        }
        None
    }
}

impl Default for Compositor {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Debug for Compositor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Compositor")
            .field("layer_count", &self.stack.len())
            .field("focus_idx", &self.focus_idx)
            .finish()
    }
}
