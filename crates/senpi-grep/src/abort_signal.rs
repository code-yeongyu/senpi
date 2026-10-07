use napi::bindgen_prelude::{
    FnArgs, FromNapiValue, Function, FunctionRef, JsObjectValue, Object, ObjectRef, TypeName,
    ValidateNapiValue,
};
use napi::{sys, Env, Result, ValueType};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

type AddListenerArgs<'env> = FnArgs<(String, Function<'env, (), ()>, Object<'env>)>;
type RemoveListenerArgs<'env> = FnArgs<(String, Function<'env, (), ()>)>;

/// Cooperative adapter for a JS AbortSignal. napi-rs 3.12.1's built-in adapter
/// ignores pre-aborted signals and cancels queued libuv work with `Cancelled`,
/// bypassing Task::reject. Keeping the work queued lets GrepTask settle every
/// explicit abort as `ABORTED`, without replacing the caller's onabort handler.
pub struct AbortSignal {
    pub(crate) aborted: Arc<AtomicBool>,
    subscription: Option<(ObjectRef, FunctionRef<(), ()>)>,
}

impl TypeName for AbortSignal {
    fn type_name() -> &'static str {
        "AbortSignal"
    }

    fn value_type() -> ValueType {
        ValueType::Object
    }
}

impl ValidateNapiValue for AbortSignal {}

impl FromNapiValue for AbortSignal {
    unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> Result<Self> {
        // SAFETY: napi-rs supplies the live argument and its owning JS env.
        let signal = unsafe { Object::from_napi_value(env, value)? };
        let env = Env::from_raw(env);
        let aborted = Arc::new(AtomicBool::new(signal.get_named_property::<bool>("aborted")?));
        if aborted.load(Ordering::Acquire) {
            return Ok(Self {
                aborted,
                subscription: None,
            });
        }
        let flag = aborted.clone();
        let listener = env.create_function_from_closure::<(), (), _>("grepAbort", move |_| {
            flag.store(true, Ordering::Release);
            Ok(())
        })?;
        let listener_ref = listener.create_ref()?;
        let add: Function<AddListenerArgs, ()> = signal.get_named_property("addEventListener")?;
        let mut once = Object::new(&env)?;
        once.set_named_property("once", true)?;
        let signal_ref = signal.create_ref()?;
        if let Err(error) = add.apply(signal, ("abort".into(), listener, once).into()) {
            signal_ref.unref(&env)?;
            return Err(error);
        }
        Ok(Self {
            aborted,
            subscription: Some((signal_ref, listener_ref)),
        })
    }
}

impl AbortSignal {
    pub(crate) fn detach(self, env: &Env) -> Result<()> {
        if let Some((signal_ref, listener_ref)) = self.subscription {
            let removed = (|| {
                let signal = signal_ref.get_value(env)?;
                let remove: Function<RemoveListenerArgs, ()> =
                    signal.get_named_property("removeEventListener")?;
                remove.apply(signal, ("abort".into(), listener_ref.borrow_back(env)?).into())
            })();
            // Always release the retained signal, including on a JS exception.
            let released = signal_ref.unref(env);
            removed?;
            released?;
        }
        Ok(())
    }
}
