//! `Win32Backend`: DPI awareness at construction, capture and enumeration,
//! and the capabilities that report the engine's integrity level. Window and
//! desktop input land in todo 31 and UI Automation in todo 32; until then the
//! capabilities report input and AX unavailable, so the session gate refuses
//! input before any input method below is reached.

use image::RgbaImage;
use senpi_desktop_core::backend::{AxBackend, Backend, DeliveryMode, PointerEvent};
use senpi_desktop_core::error::{CoreResult, DesktopError};
use senpi_desktop_core::frame::FrameGeometry;
use senpi_desktop_core::keys::KeyName;
use senpi_desktop_core::types::{
    CaptureCaps, DesktopCapabilities, DesktopDisplay, DesktopWindow, DisplaySelector, Target,
};

use crate::capture::{enable_per_monitor_awareness, Win32Capture};
use crate::integrity::{self, IntegrityRid};

pub struct Win32Backend {
    capture: Win32Capture,
    integrity: IntegrityRid,
}

impl Win32Backend {
    /// Enables per-monitor-v2 DPI awareness before any xcap or geometry call,
    /// reads the process integrity label, and validates the display selector.
    ///
    /// # Errors
    /// `CaptureFailed` when DPI awareness or the integrity label is
    /// unavailable or no display is active; `InvalidTarget` when the selected
    /// display id is not active.
    pub fn new(display: DisplaySelector) -> CoreResult<Self> {
        enable_per_monitor_awareness()?;
        let integrity = integrity::current_process().map_err(|error| {
            DesktopError::capture_failed(format!("Win32 process integrity level query failed: {error}"))
        })?;
        let capture = Win32Capture::new(display, integrity);
        capture.displays()?;
        Ok(Self { capture, integrity })
    }

    pub fn capabilities(&self) -> DesktopCapabilities {
        let display_count = self
            .capture
            .displays()
            .map_or(0, |displays| u32::try_from(displays.len()).unwrap_or(u32::MAX));
        DesktopCapabilities {
            backend: "win32".to_string(),
            display_server: Some("win32".to_string()),
            capture: display_count > 0,
            capture_permission: if display_count > 0 { "granted" } else { "unknown" }.to_string(),
            display_count,
            integrity_level: Some(self.integrity.level().label().to_string()),
            ..DesktopCapabilities::unavailable()
        }
    }

    pub fn displays(&self) -> CoreResult<Vec<DesktopDisplay>> {
        self.capture.displays()
    }

    pub fn windows(&self) -> CoreResult<Vec<DesktopWindow>> {
        self.capture.windows()
    }

    pub fn capture(&self, target: &Target) -> CoreResult<(RgbaImage, FrameGeometry)> {
        self.capture.capture(target)
    }
}

fn input_unavailable() -> DesktopError {
    DesktopError::input_failed("Win32 native input is not available in this engine build")
}

impl Backend for Win32Backend {
    fn capabilities(&mut self) -> DesktopCapabilities {
        Win32Backend::capabilities(self)
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
