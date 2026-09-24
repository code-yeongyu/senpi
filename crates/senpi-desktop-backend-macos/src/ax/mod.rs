//! AXUIElement accessibility backend. Handles wrap `CFRetained<AXUIElement>`
//! in core's session-thread `AxHandle::Native`; refs and generations stay in
//! core's `AxRegistry`.

mod actions;
mod element;
mod props;
mod tree;

use senpi_desktop_core::ax::{AxBackend, AxHandle, AxProps};
use senpi_desktop_core::error::CoreResult;
use senpi_desktop_core::types::DesktopWindow;

pub use self::element::is_trusted;
use self::element::{element, handle};

#[derive(Debug, Default)]
pub struct MacAx;

impl MacAx {
    pub const fn new() -> Self {
        Self
    }

    /// `AXRaise` on the window's AX root; the `raise_window` primitive.
    pub fn raise(&mut self, window: &DesktopWindow) -> CoreResult<()> {
        actions::perform(&*tree::window_root(window)?, "AXRaise")
    }
}

impl AxBackend for MacAx {
    fn window_root(&mut self, win: &DesktopWindow) -> CoreResult<AxHandle> {
        tree::window_root(win).map(handle)
    }

    fn props(&mut self, h: &AxHandle) -> CoreResult<AxProps> {
        props::read_props(element(h)?)
    }

    fn children(&mut self, h: &AxHandle) -> CoreResult<Vec<AxHandle>> {
        Ok(tree::children(element(h)?).into_iter().map(handle).collect())
    }

    fn parent(&mut self, h: &AxHandle) -> CoreResult<Option<AxHandle>> {
        Ok(tree::parent(element(h)?).map(handle))
    }

    fn perform(&mut self, h: &AxHandle, action: &str) -> CoreResult<()> {
        actions::perform(element(h)?, action)
    }

    fn set_value(&mut self, h: &AxHandle, value: &str) -> CoreResult<()> {
        actions::set_value(element(h)?, value)
    }

    fn focus(&mut self, h: &AxHandle) -> CoreResult<()> {
        actions::focus(element(h)?)
    }

    fn element_at(&mut self, x: f64, y: f64) -> CoreResult<Option<AxHandle>> {
        tree::element_at(x, y).map(|found| found.map(handle))
    }

    fn focused_element(&mut self) -> CoreResult<Option<AxHandle>> {
        tree::focused_element().map(|found| found.map(handle))
    }

    fn attributes(&mut self, h: &AxHandle) -> CoreResult<Vec<(String, String)>> {
        tree::attributes(element(h)?)
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod live_tests;
