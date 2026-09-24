#![cfg(target_os = "macos")]

//! macOS desktop backend: Quartz capture, display/window enumeration,
//! capabilities, and the AXUIElement accessibility backend. Input and the
//! focus guard land in later todos.

mod ax;
mod backend;
mod capture;

pub use ax::{is_trusted, MacAx};
pub use backend::MacosBackend;

pub const BACKEND_NAME: &str = env!("CARGO_PKG_NAME");
