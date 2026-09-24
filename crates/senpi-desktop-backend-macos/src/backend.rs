//! `MacosBackend`: capture, enumeration, and runtime capabilities. Input, the
//! focus guard, and AX (and with them the `Backend` trait impl) land in todos
//! 15 and 16.

use image::RgbaImage;
use senpi_desktop_core::error::CoreResult;
use senpi_desktop_core::frame::FrameGeometry;
use senpi_desktop_core::types::{
    DesktopCapabilities, DesktopDisplay, DesktopWindow, DisplaySelector, Target,
};

use crate::capture::{MacCapture, Screencapture};

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    /// Non-prompting Accessibility trust check; takes no arguments.
    safe fn AXIsProcessTrusted() -> bool;
}

pub struct MacosBackend {
    capture: MacCapture,
}

impl MacosBackend {
    pub fn new(display: DisplaySelector) -> Self {
        Self {
            capture: MacCapture::new(display, Screencapture::system()),
        }
    }

    /// Runtime truth from the TCC preflights; never prompts.
    pub fn capabilities(&self) -> DesktopCapabilities {
        let capture_permission = self.capture.permission_granted();
        let trusted = AXIsProcessTrusted();
        let display_count = if capture_permission {
            self.capture
                .displays()
                .map_or(0, |displays| u32::try_from(displays.len()).unwrap_or(u32::MAX))
        } else {
            0
        };
        DesktopCapabilities {
            backend: "quartz".to_string(),
            display_server: Some("Quartz WindowServer".to_string()),
            capture: capture_permission && display_count > 0,
            input: trusted,
            ax: trusted,
            // `trusted && skylight::is_available()` once the SkyLight probe
            // lands (todo 15).
            background_window_input: false,
            delivery_modes: vec!["background".to_string(), "foreground".to_string()],
            capture_permission: permission_label(capture_permission),
            input_permission: permission_label(trusted),
            ax_permission: permission_label(trusted),
            display_count,
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

fn permission_label(granted: bool) -> String {
    if granted { "granted" } else { "denied" }.to_string()
}
