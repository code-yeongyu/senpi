#![cfg(target_os = "macos")]

//! macOS desktop backend: Quartz capture, display/window enumeration, and
//! capabilities. Input, focus guard, and AX land in later todos.

mod backend;
mod capture;

pub use backend::MacosBackend;

pub const BACKEND_NAME: &str = env!("CARGO_PKG_NAME");
