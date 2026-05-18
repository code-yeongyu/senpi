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
}

impl Default for LayoutState {
    fn default() -> Self {
        Self {
            input_lines: 1,
            sidebar_visible: false,
        }
    }
}

const HEADER_HEIGHT: u16 = 3;
const FOOTER_HEIGHT: u16 = 1;
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
    let input_height = (state.input_lines.clamp(1, 7) + INPUT_FRAME_OVERHEAD)
        .clamp(MIN_INPUT_HEIGHT, MAX_INPUT_HEIGHT)
        .min(body_height.saturating_sub(3));

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(HEADER_HEIGHT),
            Constraint::Min(3),
            Constraint::Length(input_height),
            Constraint::Length(FOOTER_HEIGHT),
        ])
        .split(area);

    let header = chunks[0];
    let body = chunks[1];
    let input = chunks[2];
    let footer = chunks[3];

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
            },
        );
        assert!(l9.input.height > l1.input.height);
        assert!(l9.input.height <= MAX_INPUT_HEIGHT);
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
