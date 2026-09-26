//! `SENPI_DESKTOP_FAKE_STOP_PATH=live`: a Global stop listener for the fake
//! backend that is live once started and never fires, so a fake `--serve`
//! daemon has the global stop path a real OS listener would give it.

use std::sync::Arc;

use senpi_desktop_safety::{Chord, StopPathError, StopPathId, StopPathListener, Supervisor};

pub const FAKE_STOP_PATH_ENV: &str = "SENPI_DESKTOP_FAKE_STOP_PATH";

#[derive(Default)]
pub struct FakeGlobalListener {
    live: bool,
}

impl FakeGlobalListener {
    pub fn from_env() -> Option<Self> {
        (std::env::var(FAKE_STOP_PATH_ENV).as_deref() == Ok("live")).then(Self::default)
    }
}

impl StopPathListener for FakeGlobalListener {
    fn start(&mut self, _chord: &Chord, sup: Arc<Supervisor>) -> Result<(), StopPathError> {
        sup.set_live(StopPathId::Global, true);
        self.live = true;
        Ok(())
    }

    fn is_live(&self) -> bool {
        self.live
    }

    fn restart(&mut self) {}
}
