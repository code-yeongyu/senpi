mod session;
mod signals;

pub use session::{PtyError, PtyExit, PtyResult, PtySession, PtySessionOptions};

use napi_derive::napi;

const PACKAGE_VERSION: &str = "2026.7.5-2";

#[napi(js_name = "PtySession")]
pub struct NativePtySession {}

#[napi]
impl NativePtySession {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {}
    }
}

#[napi]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[napi(js_name = "__senpiPtyV2026_7_5")]
pub fn senpi_pty_version_sentinel() -> String {
    PACKAGE_VERSION.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_matches_crate_version() {
        assert_eq!(version(), env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn version_sentinel_matches_package_version() {
        assert_eq!(senpi_pty_version_sentinel(), PACKAGE_VERSION);
    }

    #[test]
    fn package_version_constant_matches_package_json() {
        let package_json = include_str!("../../../packages/pty/package.json");
        assert!(
            package_json.contains("\"version\": \"2026.7.5-2\""),
            "PACKAGE_VERSION and sentinel export must be updated with packages/pty/package.json"
        );
    }

    #[test]
    fn portable_pty_backend_is_linked() {
        let _pty_system = portable_pty::native_pty_system();
    }
}

#[cfg(test)]
mod session_tests;
