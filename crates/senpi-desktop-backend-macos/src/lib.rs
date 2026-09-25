#![cfg(target_os = "macos")]

//! macOS desktop backend: Quartz capture, CGEvent input with SkyLight
//! background delivery and the focus guard, and the AXUIElement accessibility
//! backend.

mod ax;
mod backend;
mod capture;
mod cursor;
mod focus;
mod input;
mod skylight;

pub use ax::{is_trusted, MacAx};
pub use backend::MacosBackend;
pub use input::{CanaryMode, CanaryResult};

pub const BACKEND_NAME: &str = env!("CARGO_PKG_NAME");
