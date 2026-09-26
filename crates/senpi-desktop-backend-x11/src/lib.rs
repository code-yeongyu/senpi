#![cfg(target_os = "linux")]

//! X11 desktop backend over pure-Rust x11rb (never links libX11/libxcb):
//! RandR display enumeration, EWMH window enumeration, and root-window
//! `GetImage` capture.

mod backend;
mod capture;

pub use backend::X11Backend;
pub use capture::{X11Capture, X11Connection};

pub const BACKEND_NAME: &str = env!("CARGO_PKG_NAME");
