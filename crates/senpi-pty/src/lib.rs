mod session;
mod session_threads;
mod signals;

pub use session::{PtyError, PtyExit, PtyResult, PtySession, PtySessionOptions};

use napi::bindgen_prelude::{
    AsyncTask, Buffer, Either3, Env, Function, Result as NapiResult, Status, Task, Uint8Array,
};
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use napi::Error as NapiError;
use napi_derive::napi;
use std::collections::HashMap;
use std::path::PathBuf;
use std::thread::JoinHandle;
use std::time::Duration;

const PACKAGE_VERSION: &str = "2026.7.5-2";

#[napi(object)]
pub struct NativePtySessionOptions {
    pub command: String,
    pub args: Option<Vec<String>>,
    pub cwd: Option<String>,
    pub env: Option<HashMap<String, Option<String>>>,
    pub cols: u16,
    pub rows: u16,
    pub timeout_ms: Option<u32>,
}

#[napi(object)]
pub struct NativePtyExit {
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
    pub cancelled: bool,
    pub timed_out: bool,
}

#[napi(js_name = "PtySession")]
pub struct NativePtySession {
    session: Option<PtySession>,
}

#[napi]
impl NativePtySession {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self { session: None }
    }

    #[napi]
    pub fn write(&mut self, data: Either3<String, Buffer, Uint8Array>) -> NapiResult<()> {
        let bytes = match data {
            Either3::A(text) => text.into_bytes(),
            Either3::B(buffer) => buffer.to_vec(),
            Either3::C(array) => array.to_vec(),
        };
        self.open_session()?.write(&bytes).map_err(to_napi_error)
    }

    #[napi]
    pub fn resize(&mut self, cols: u16, rows: u16) -> NapiResult<()> {
        self.open_session()?.resize(cols, rows).map_err(to_napi_error)
    }

    #[napi]
    pub fn kill(&mut self, signal: Option<String>) -> NapiResult<()> {
        let session = self.open_session()?;
        if let Some(signal) = signal {
            session.signal(&signal).map_err(to_napi_error)
        } else {
            session.kill().map_err(to_napi_error)
        }
    }

    #[napi(js_name = "waitExit")]
    pub fn wait_exit(&mut self) -> NapiResult<AsyncTask<NativePtyWaitTask>> {
        let waiter = self.open_session()?.wait_in_background().map_err(to_napi_error)?;
        Ok(AsyncTask::new(NativePtyWaitTask { waiter: Some(waiter) }))
    }

    #[napi]
    pub fn wait(&mut self) -> NapiResult<AsyncTask<NativePtyWaitTask>> {
        self.wait_exit()
    }
}

impl NativePtySession {
    fn open_session(&mut self) -> NapiResult<&mut PtySession> {
        self.session
            .as_mut()
            .ok_or_else(|| NapiError::new(Status::GenericFailure, "pty session is closed"))
    }
}

impl Default for NativePtySession {
    fn default() -> Self {
        Self::new()
    }
}

#[napi(js_name = "startPtySession")]
pub fn start_pty_session(
    options: NativePtySessionOptions,
    on_data: Function<'_, Buffer, ()>,
) -> NapiResult<NativePtySession> {
    let on_data = on_data
        .build_threadsafe_function::<Vec<u8>>()
        .build_callback(|context| Ok(Buffer::from(context.value)))?;
    let session = PtySession::start(options.into_session_options(), move |chunk| {
        let _ = on_data.call(chunk.to_vec(), ThreadsafeFunctionCallMode::NonBlocking);
    })
    .map_err(to_napi_error)?;

    Ok(NativePtySession {
        session: Some(session),
    })
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

impl NativePtySessionOptions {
    fn into_session_options(self) -> PtySessionOptions {
        let mut options = PtySessionOptions::new(self.command).size(self.cols, self.rows);

        for arg in self.args.unwrap_or_default() {
            options = options.arg(arg);
        }
        if let Some(cwd) = self.cwd {
            options = options.cwd(PathBuf::from(cwd));
        }
        for (key, value) in self.env.unwrap_or_default() {
            if let Some(value) = value {
                options = options.env(key, value);
            }
        }
        if let Some(timeout_ms) = self.timeout_ms {
            options = options.timeout(Duration::from_millis(u64::from(timeout_ms)));
        }

        options
    }
}

impl From<PtyExit> for NativePtyExit {
    fn from(exit: PtyExit) -> Self {
        Self {
            exit_code: exit.exit_code,
            signal: None,
            cancelled: exit.cancelled,
            timed_out: exit.timed_out,
        }
    }
}

fn to_napi_error(error: PtyError) -> NapiError {
    NapiError::new(Status::GenericFailure, error.to_string())
}

pub struct NativePtyWaitTask {
    waiter: Option<JoinHandle<PtyResult<PtyExit>>>,
}

impl Task for NativePtyWaitTask {
    type Output = PtyExit;
    type JsValue = NativePtyExit;

    fn compute(&mut self) -> NapiResult<Self::Output> {
        let waiter = self
            .waiter
            .take()
            .ok_or_else(|| NapiError::new(Status::GenericFailure, "pty wait task already consumed"))?;
        waiter
            .join()
            .map_err(|_| NapiError::new(Status::GenericFailure, "pty wait thread panicked"))?
            .map_err(to_napi_error)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> NapiResult<Self::JsValue> {
        Ok(output.into())
    }
}
