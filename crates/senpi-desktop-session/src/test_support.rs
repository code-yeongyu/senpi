//! A worker over the fake backend with a live stop path, its op log, its
//! failure queues, and every audit event it emitted.

use std::sync::Arc;

use parking_lot::Mutex;
use senpi_desktop_backend_fake::{FakeBackend, FakeScenario, Faults, RecordingSink};
use senpi_desktop_core::backend::Backend;
use senpi_desktop_core::error::CoreResult;
use senpi_desktop_core::protocol_params::{CaptureParams, PointParams};
use senpi_desktop_core::protocol_results::AuditEvent;
use senpi_desktop_core::types::{
    DesktopCapabilities, DesktopSessionOptions, DisplaySelector, PointerOptions,
};
use senpi_desktop_safety::{FakeClock, StopPathId, Supervisor};
use serde_json::Value;

use crate::mutate::SessionSafety;
use crate::request::{Op, Response};
use crate::selection::BackendFactory;
use crate::worker::Worker;

const FIXTURE: &str = include_str!("../../senpi-desktop-backend-fake/fixtures/two-displays-one-window.json");

pub(crate) struct Harness {
    pub(crate) worker: Worker,
    pub(crate) sink: RecordingSink,
    pub(crate) faults: Faults,
    pub(crate) supervisor: Arc<Supervisor>,
    pub(crate) audits: Arc<Mutex<Vec<AuditEvent>>>,
}

type Built = Arc<Mutex<Option<(RecordingSink, Faults)>>>;

struct Factory {
    scenario: FakeScenario,
    built: Built,
}

impl BackendFactory for Factory {
    fn create(&self, _selector: DisplaySelector) -> CoreResult<Box<dyn Backend>> {
        let backend = FakeBackend::new(self.scenario.clone());
        *self.built.lock() = Some((backend.sink(), backend.faults()));
        Ok(Box::new(backend))
    }
}

/// An open session over the fixture with `overlay`'s top-level keys
/// replaced, and a live, fresh global stop path.
pub(crate) fn harness(overlay: &Value) -> Harness {
    let mut json: Value = serde_json::from_str(FIXTURE).expect("fixture is JSON");
    for (key, value) in overlay.as_object().expect("overlay is an object") {
        json[key] = value.clone();
    }
    let scenario = FakeScenario::from_json(&json.to_string()).expect("scenario parses");
    let built = Built::default();
    let supervisor = Arc::new(Supervisor::new(Arc::new(FakeClock::new(0))));
    supervisor.set_live(StopPathId::Global, true);
    let audits = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&audits);
    let safety = SessionSafety {
        supervisor: Arc::clone(&supervisor),
        audit: Box::new(move |event| recorded.lock().push(event.clone())),
    };
    let factory = Factory {
        scenario,
        built: Arc::clone(&built),
    };
    let capabilities = Arc::new(Mutex::new(DesktopCapabilities::unavailable()));
    let mut worker = Worker::new(Box::new(factory), capabilities, safety);
    worker.open(DesktopSessionOptions::default());
    let (sink, faults) = built.lock().clone().expect("open built a backend");
    Harness {
        worker,
        sink,
        faults,
        supervisor,
        audits,
    }
}

impl Harness {
    /// Captures `target` and returns the frame id.
    pub(crate) fn capture(&mut self, target: &str) -> String {
        let params = CaptureParams {
            target: target.to_owned(),
            caps: None,
        };
        match self.worker.process(Op::Capture(params)) {
            Ok(Response::Capture(capture)) => capture.frame_id,
            other => panic!("capture of {target} failed: {other:?}"),
        }
    }

    /// The ref of the fixture's focused text area.
    pub(crate) fn focused_ref(&mut self) -> String {
        match self.worker.process(Op::AxFocused) {
            Ok(Response::MaybeNode(Some(node))) => node.ref_,
            other => panic!("no focused element: {other:?}"),
        }
    }

    pub(crate) fn audits(&self) -> Vec<AuditEvent> {
        self.audits.lock().clone()
    }
}

pub(crate) fn delivery(mode: &str) -> Option<PointerOptions> {
    Some(PointerOptions {
        delivery_mode: Some(mode.to_owned()),
        ..PointerOptions::default()
    })
}

/// A click at pixel (10, 10) of `frame_id`, a capture of window `101`.
pub(crate) fn click_window(frame_id: &str, opts: Option<PointerOptions>) -> Op {
    Op::Click(PointParams {
        target: "101".to_owned(),
        x: 10.0,
        y: 10.0,
        frame_id: Some(frame_id.to_owned()),
        opts,
    })
}
