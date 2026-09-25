//! Which backend the session drives: this OS's platform backend, or the
//! scripted fake selected by `SENPI_DESKTOP_BACKEND=fake:<scenario-path>`.

use std::path::PathBuf;

use senpi_desktop_backend_fake::{FakeBackend, FakeScenario};
use senpi_desktop_core::backend::Backend;
use senpi_desktop_core::error::{CoreResult, DesktopError};
use senpi_desktop_core::types::DisplaySelector;

/// Builds the backend on the session thread: once at start (the capabilities
/// probe) and again at every `session.open` with its display selector.
pub trait BackendFactory: Send + 'static {
    /// # Errors
    /// The reason no backend exists on this host; the session then reports
    /// `DesktopCapabilities::unavailable()` and fails every backend request
    /// with this error.
    fn create(&self, selector: DisplaySelector) -> CoreResult<Box<dyn Backend>>;
}

#[derive(Debug, Clone, PartialEq)]
pub enum BackendSelection {
    /// The backend crate for the compile target.
    Platform,
    /// The fake backend serving the scenario file at this path.
    FakeFile(PathBuf),
    /// The fake backend serving an in-memory scenario (`--selftest`).
    FakeScenario(Box<FakeScenario>),
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SelectionError {
    #[error("SENPI_DESKTOP_BACKEND=fake: needs a scenario path (fake:<scenario-path>)")]
    MissingScenarioPath,
    #[error("unknown SENPI_DESKTOP_BACKEND value '{0}'; expected fake:<scenario-path> or unset")]
    Unknown(String),
}

impl BackendSelection {
    pub const ENV: &'static str = "SENPI_DESKTOP_BACKEND";

    /// Parses the `SENPI_DESKTOP_BACKEND` value; unset or empty selects the
    /// platform backend.
    ///
    /// # Errors
    /// Any value other than `fake:<scenario-path>`.
    pub fn parse(value: Option<&str>) -> Result<Self, SelectionError> {
        let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
            return Ok(Self::Platform);
        };
        match value.strip_prefix("fake:") {
            Some("") => Err(SelectionError::MissingScenarioPath),
            Some(path) => Ok(Self::FakeFile(PathBuf::from(path))),
            None => Err(SelectionError::Unknown(value.to_owned())),
        }
    }
}

impl BackendFactory for BackendSelection {
    fn create(&self, selector: DisplaySelector) -> CoreResult<Box<dyn Backend>> {
        match self {
            Self::Platform => platform_backend(selector),
            Self::FakeFile(path) => FakeScenario::load(path)
                .map(fake_backend)
                .map_err(|error| DesktopError::capture_failed(error.to_string())),
            Self::FakeScenario(scenario) => Ok(fake_backend((**scenario).clone())),
        }
    }
}

fn fake_backend(scenario: FakeScenario) -> Box<dyn Backend> {
    Box::new(FakeBackend::new(scenario))
}

/// The backend crate for the compile target. X11 (todo 27), Windows (todo
/// 30) and Wayland (todo 33) add their `cfg(target_os)` arms here.
#[cfg(target_os = "macos")]
fn platform_backend(selector: DisplaySelector) -> CoreResult<Box<dyn Backend>> {
    let backend = senpi_desktop_backend_macos::MacosBackend::new(selector)?;
    Ok(Box::new(backend))
}

#[cfg(not(target_os = "macos"))]
fn platform_backend(_selector: DisplaySelector) -> CoreResult<Box<dyn Backend>> {
    Err(DesktopError::capture_failed(format!(
        "{} desktop backend not yet ported",
        std::env::consts::OS
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unset_or_blank_selects_the_platform_backend() {
        assert_eq!(BackendSelection::parse(None), Ok(BackendSelection::Platform));
        assert_eq!(
            BackendSelection::parse(Some("  ")),
            Ok(BackendSelection::Platform)
        );
    }

    #[test]
    fn fake_prefix_selects_the_scenario_file() {
        assert_eq!(
            BackendSelection::parse(Some("fake:fixtures/a.json")),
            Ok(BackendSelection::FakeFile(PathBuf::from("fixtures/a.json")))
        );
    }

    #[test]
    fn fake_without_path_and_unknown_values_are_rejected() {
        assert_eq!(
            BackendSelection::parse(Some("fake:")),
            Err(SelectionError::MissingScenarioPath)
        );
        assert_eq!(
            BackendSelection::parse(Some("quartz")),
            Err(SelectionError::Unknown("quartz".to_owned()))
        );
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn platform_backend_is_not_yet_ported() {
        let error = BackendSelection::Platform
            .create(DisplaySelector::All)
            .err()
            .map(|error| error.code);
        assert_eq!(error, Some(senpi_desktop_core::error::ErrorCode::CaptureFailed));
    }
}
