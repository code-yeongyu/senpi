//! `X11Backend`: capture and display/window enumeration with honest
//! capabilities. Input delivery (XTEST/XSendEvent), the focus guard, the XI2
//! stop path and AT-SPI accessibility are not wired yet, so capabilities
//! report them unavailable and the session gate refuses input before any
//! input method below is reached.

use image::RgbaImage;
use senpi_desktop_core::ax::AxBackend;
use senpi_desktop_core::backend::{Backend, DeliveryMode, PointerEvent};
use senpi_desktop_core::error::{CoreResult, DesktopError};
use senpi_desktop_core::frame::FrameGeometry;
use senpi_desktop_core::keys::KeyName;
use senpi_desktop_core::types::{
    CaptureCaps, DesktopCapabilities, DesktopDisplay, DesktopWindow, DisplaySelector, Target,
};

use crate::capture::{X11Capture, X11Connection, XServer};

pub struct X11Backend<S = X11Connection> {
    capture: X11Capture<S>,
    display_server: Option<String>,
}

impl X11Backend<X11Connection> {
    /// Connects to the X server named by `DISPLAY`.
    ///
    /// # Errors
    /// `CaptureFailed` when the server is unreachable or its root unreadable.
    pub fn new(selector: DisplaySelector) -> CoreResult<Self> {
        Ok(Self {
            capture: X11Capture::new(selector)?,
            display_server: std::env::var("DISPLAY").ok(),
        })
    }
}

impl<S: XServer> X11Backend<S> {
    #[cfg(test)]
    pub(crate) fn with_capture(capture: X11Capture<S>, display_server: Option<String>) -> Self {
        Self {
            capture,
            display_server,
        }
    }

    /// Capture truth from a live RandR query; input and AX stay unavailable
    /// until their delivery paths exist.
    pub fn capabilities(&self) -> DesktopCapabilities {
        let displays = self.capture.displays();
        let capture = displays.is_ok();
        DesktopCapabilities {
            backend: "x11".to_string(),
            display_server: self.display_server.clone(),
            capture,
            capture_permission: if capture { "granted" } else { "unavailable" }.to_string(),
            display_count: displays.map_or(0, |items| u32::try_from(items.len()).unwrap_or(u32::MAX)),
            ..DesktopCapabilities::unavailable()
        }
    }
}

fn input_unavailable() -> DesktopError {
    DesktopError::input_failed("X11 input delivery is not available in this engine build")
}

impl<S: XServer + Send> Backend for X11Backend<S> {
    fn capabilities(&mut self) -> DesktopCapabilities {
        X11Backend::capabilities(self)
    }

    fn displays(&mut self) -> CoreResult<Vec<DesktopDisplay>> {
        self.capture.displays()
    }

    fn windows(&mut self) -> CoreResult<Vec<DesktopWindow>> {
        self.capture.windows()
    }

    fn capture(&mut self, target: &Target, _caps: &CaptureCaps) -> CoreResult<(RgbaImage, FrameGeometry)> {
        self.capture.capture(target)
    }

    fn pointer(
        &mut self,
        _target: &Target,
        _event: PointerEvent,
        _frame: &FrameGeometry,
        _mode: DeliveryMode,
    ) -> CoreResult<()> {
        Err(input_unavailable())
    }

    fn type_text(&mut self, _target: &Target, _text: &str, _mode: DeliveryMode) -> CoreResult<()> {
        Err(input_unavailable())
    }

    fn key_chord(&mut self, _target: &Target, _keys: &[KeyName], _mode: DeliveryMode) -> CoreResult<()> {
        Err(input_unavailable())
    }

    fn raise_window(&mut self, _id: &str) -> CoreResult<()> {
        Err(input_unavailable())
    }

    fn ax(&mut self) -> Option<&mut dyn AxBackend> {
        None
    }
}
