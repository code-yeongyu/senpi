use napi::bindgen_prelude::{AsyncTask, JsObjectValue, JsValue};
use napi::{Env, Error, Status, Task};
use napi_derive::napi;

mod abort_signal;
mod cancel;
mod matcher;
mod options;
mod search;
mod walk;

pub use abort_signal::AbortSignal;
pub use cancel::CancelToken;
pub use options::{
    GrepCounts, GrepError, GrepFileCount, GrepMatch, GrepMode, GrepOptions, GrepResult, GrepWarning,
};
pub use search::search;

/// Native ABI version. This is INTENTIONALLY decoupled from the package/CalVer
/// version: it identifies the shape of the native surface (exports + signatures)
/// that the TypeScript loader requires. Bump it ONLY on a backward-incompatible
/// change to that surface, and update `NATIVE_GREP_ABI_VERSION` in the loader +
/// the `__senpiGrepAbi<N>` sentinel export together. A CalVer release must NOT
/// change it — otherwise every release invalidates the prebuilt binaries.
pub const NATIVE_GREP_ABI_VERSION: &str = "1";

// Stable ABI sentinel. The `js_name` MUST be a string literal (napi requirement),
// so it is spelled `__senpiGrepAbi<N>` where N == NATIVE_GREP_ABI_VERSION. The
// loader derives the same name from its own ABI constant and also checks the
// return value, rejecting any prebuilt binary compiled against a different ABI.
#[napi(js_name = "__senpiGrepAbi1")]
pub fn senpi_grep_abi_sentinel() -> String {
    NATIVE_GREP_ABI_VERSION.to_string()
}

pub struct GrepTask {
    options: GrepOptions,
    cancel: CancelToken,
    signal: Option<AbortSignal>,
}

#[napi]
impl Task for GrepTask {
    // Keep domain errors as data until the JS thread can create an Error with
    // the contract code; Task's own error type only admits napi::Status.
    type Output = Result<GrepResult, GrepError>;
    type JsValue = GrepResult;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        Ok(search(&self.options, &self.cancel))
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        // Abort can arrive after compute finishes but before JS settlement.
        let output = if self.cancel.is_aborted() {
            Err(GrepError::Aborted)
        } else {
            output
        };
        match output {
            Ok(result) => Ok(result),
            Err(error) => {
                let message = error.to_string();
                let mut object = env.create_error(Error::new(Status::GenericFailure, message.clone()))?;
                object.set_named_property("code", error.code())?;
                let mut mapped = Error::from(object.to_unknown());
                mapped.reason = message;
                Err(mapped)
            }
        }
    }

    fn finally(self, env: Env) -> napi::Result<()> {
        if let Some(signal) = self.signal {
            signal.detach(&env)?;
        }
        Ok(())
    }
}

#[napi]
pub fn grep(options: GrepOptions, signal: Option<AbortSignal>) -> AsyncTask<GrepTask> {
    let mut cancel = CancelToken::new(options.timeout_ms);
    if let Some(signal) = &signal {
        cancel.aborted = signal.aborted.clone();
    }
    AsyncTask::new(GrepTask {
        options,
        cancel,
        signal,
    })
}

#[cfg(test)]
mod tests;
