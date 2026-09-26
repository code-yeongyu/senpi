#![cfg(target_os = "windows")]

//! Windows desktop backend: xcap (GDI) capture and display/window
//! enumeration in the per-monitor-v2 DPI regime, UI Automation
//! accessibility, and the mandatory integrity label of the engine and of each
//! window's process. `SendInput`/`PostMessageW` input lands in todo 31.

mod ax;
mod backend;
mod capture;
mod integrity;

pub use backend::Win32Backend;

pub const BACKEND_NAME: &str = env!("CARGO_PKG_NAME");
