//! Pure layout computation for the senpi-neo TUI.
//!
//! The layout is a pure function of the terminal area + a small set of
//! state flags. Both `App::draw` and the snapshot tests call `compute`.

use ratatui::layout::{Constraint, Direction, Layout, Rect};

/// All rectangles needed to render a single frame.
#[derive(Clone, Copy, Debug, Default)]
pub struct ComputedLayout {
    pub header: Rect,
    pub chat: Rect,
    pub sidebar: Option<Rect>,
    pub working_indicator: Option<Rect>,
    pub input: Rect,
    pub footer: Rect,
}

/// Inputs to [`compute`]. Held by `App` and refreshed each frame.
#[derive(Clone, Copy, Debug)]
pub struct LayoutState {
    /// Number of lines currently visible in the input box (clamped 1..=7).
    pub input_lines: u16,
    /// `true` when the sidebar should be shown (auto-shown when width >= 120).
    pub sidebar_visible: bool,
    /// `true` when the one-row working indicator should be shown above input.
    pub show_working_indicator: bool,
}

impl Default for LayoutState {
    fn default() -> Self {
        Self {
            input_lines: 1,
            sidebar_visible: false,
            show_working_indicator: false,
        }
    }
}

const HEADER_HEIGHT: u16 = 3;
const FOOTER_HEIGHT: u16 = 1;
const WORKING_INDICATOR_HEIGHT: u16 = 1;
const SIDEBAR_WIDTH: u16 = 42;
/// Minimum terminal width at which the sidebar surfaces. Exposed so the
/// app loop can flip `LayoutState::sidebar_visible` in step with the
/// layout module's own clamp.
pub const SIDEBAR_MIN_TERMINAL_WIDTH: u16 = 120;
const INPUT_FRAME_OVERHEAD: u16 = 2; // 1 top border + 1 status row
const MIN_INPUT_HEIGHT: u16 = 1 + INPUT_FRAME_OVERHEAD;
const MAX_INPUT_HEIGHT: u16 = 7 + INPUT_FRAME_OVERHEAD;

/// Compute the frame layout.
#[must_use]
pub fn compute(area: Rect, state: LayoutState) -> ComputedLayout {
    if area.width < 10 || area.height < 6 {
        return ComputedLayout {
            header: area,
            ..ComputedLayout::default()
        };
    }

    let body_height = area.height.saturating_sub(HEADER_HEIGHT + FOOTER_HEIGHT);
    let working_indicator_height = if state.show_working_indicator {
        WORKING_INDICATOR_HEIGHT
    } else {
        0
    };
    let input_height = (state.input_lines.clamp(1, 7) + INPUT_FRAME_OVERHEAD)
        .clamp(MIN_INPUT_HEIGHT, MAX_INPUT_HEIGHT)
        .min(body_height.saturating_sub(3 + working_indicator_height));

    let constraints = if state.show_working_indicator {
        vec![
            Constraint::Length(HEADER_HEIGHT),
            Constraint::Min(3),
            Constraint::Length(WORKING_INDICATOR_HEIGHT),
            Constraint::Length(input_height),
            Constraint::Length(FOOTER_HEIGHT),
        ]
    } else {
        vec![
            Constraint::Length(HEADER_HEIGHT),
            Constraint::Min(3),
            Constraint::Length(input_height),
            Constraint::Length(FOOTER_HEIGHT),
        ]
    };

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints(constraints)
        .split(area);

    let header = chunks[0];
    let body = chunks[1];
    let working_indicator = state.show_working_indicator.then_some(chunks[2]);
    let input_index = if state.show_working_indicator { 3 } else { 2 };
    let input = chunks[input_index];
    let footer = chunks[input_index + 1];

    let show_sidebar = state.sidebar_visible && area.width >= SIDEBAR_MIN_TERMINAL_WIDTH;
    let (chat, sidebar) = if show_sidebar {
        let split = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Min(40), Constraint::Length(SIDEBAR_WIDTH)])
            .split(body);
        (split[0], Some(split[1]))
    } else {
        (body, None)
    };

    ComputedLayout {
        header,
        chat,
        sidebar,
        working_indicator,
        input,
        footer,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compute_at_120_40_shows_sidebar() {
        let layout = compute(
            Rect {
                x: 0,
                y: 0,
                width: 120,
                height: 40,
            },
            LayoutState {
                input_lines: 1,
                sidebar_visible: true,
                show_working_indicator: false,
            },
        );
        assert!(layout.sidebar.is_some(), "sidebar should appear at >=120 wide");
        assert_eq!(layout.header.height, 3);
        assert_eq!(layout.footer.height, 1);
    }

    #[test]
    fn compute_at_80_24_no_sidebar() {
        let layout = compute(
            Rect {
                x: 0,
                y: 0,
                width: 80,
                height: 24,
            },
            LayoutState {
                input_lines: 1,
                sidebar_visible: true,
                show_working_indicator: false,
            },
        );
        assert!(layout.sidebar.is_none(), "sidebar must hide at <120 wide");
        assert_eq!(layout.chat.x, 0);
        assert_eq!(layout.chat.width, 80);
    }

    #[test]
    fn compute_clamps_input_lines() {
        let l1 = compute(
            Rect {
                x: 0,
                y: 0,
                width: 100,
                height: 30,
            },
            LayoutState {
                input_lines: 1,
                sidebar_visible: false,
                show_working_indicator: false,
            },
        );
        let l9 = compute(
            Rect {
                x: 0,
                y: 0,
                width: 100,
                height: 30,
            },
            LayoutState {
                input_lines: 9,
                sidebar_visible: false,
                show_working_indicator: false,
            },
        );
        assert!(l9.input.height > l1.input.height);
        assert!(l9.input.height <= MAX_INPUT_HEIGHT);
    }

    #[test]
    fn working_indicator_allocates_row_when_busy() {
        let state = LayoutState {
            input_lines: 1,
            sidebar_visible: false,
            show_working_indicator: true,
        };
        let computed = compute(Rect::new(0, 0, 80, 24), state);
        let wi = computed.working_indicator.expect("indicator should allocate");
        assert_eq!(wi.height, 1);
        assert_eq!(wi.y, computed.chat.bottom());
        assert_eq!(computed.input.y, wi.bottom());
    }

    #[test]
    fn working_indicator_absent_when_idle() {
        let state = LayoutState {
            input_lines: 1,
            sidebar_visible: false,
            show_working_indicator: false,
        };
        let computed = compute(Rect::new(0, 0, 80, 24), state);
        assert!(computed.working_indicator.is_none());
    }

    #[test]
    fn compute_handles_tiny_terminal() {
        let layout = compute(
            Rect {
                x: 0,
                y: 0,
                width: 5,
                height: 3,
            },
            LayoutState::default(),
        );
        assert_eq!(layout.header.width, 5);
    }
}
