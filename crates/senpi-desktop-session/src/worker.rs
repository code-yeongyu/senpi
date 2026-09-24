//! The session thread's state and request dispatch.

use std::sync::Arc;

use parking_lot::Mutex;
use senpi_desktop_core::ax::{AxBackend, AxRegistry};
use senpi_desktop_core::backend::Backend;
use senpi_desktop_core::error::{CoreResult, DesktopError, ErrorCode};
use senpi_desktop_core::protocol_results::AuditEvent;
use senpi_desktop_core::types::{
    DesktopCapabilities, DesktopSessionOptions, DesktopWindow, DisplaySelector, Target,
};

use crate::mutate::SessionSafety;
use crate::pointer::FrameCache;
use crate::request::{Op, Response};
use crate::selection::BackendFactory;

/// Owned by the session thread: AX handles are `Rc`, so it never leaves it.
pub(crate) struct Worker {
    factory: Box<dyn BackendFactory>,
    pub(crate) backend: CoreResult<Box<dyn Backend>>,
    /// `Some` once `session.open` ran; backend requests need it.
    pub(crate) options: Option<DesktopSessionOptions>,
    pub(crate) registry: AxRegistry,
    pub(crate) frames: FrameCache,
    capabilities: Arc<Mutex<DesktopCapabilities>>,
    pub(crate) safety: SessionSafety,
}

/// A mutating request's reply and the audit event it emitted.
pub(crate) type Audited = (Response, AuditEvent);

impl Worker {
    /// Builds the probe backend that answers `capabilities` before
    /// `session.open`.
    pub(crate) fn new(
        factory: Box<dyn BackendFactory>,
        capabilities: Arc<Mutex<DesktopCapabilities>>,
        safety: SessionSafety,
    ) -> Self {
        let backend = factory.create(DisplaySelector::All);
        let mut worker = Self {
            factory,
            backend,
            options: None,
            registry: AxRegistry::default(),
            frames: FrameCache::default(),
            capabilities,
            safety,
        };
        worker.refresh_capabilities();
        worker
    }

    /// Re-creates the backend for the requested display; every earlier ref
    /// and frame belongs to the previous backend and is dropped.
    pub(crate) fn open(&mut self, options: DesktopSessionOptions) -> DesktopCapabilities {
        self.backend = self
            .factory
            .create(DisplaySelector::parse(options.display.clone()));
        self.registry = AxRegistry::default();
        self.frames = FrameCache::default();
        self.options = Some(options);
        self.refresh_capabilities()
    }

    pub(crate) fn refresh_capabilities(&mut self) -> DesktopCapabilities {
        let capabilities = match self.backend.as_mut() {
            Ok(backend) => backend.capabilities(),
            Err(_) => DesktopCapabilities::unavailable(),
        };
        self.capabilities.lock().clone_from(&capabilities);
        capabilities
    }

    pub(crate) fn process(&mut self, op: Op) -> CoreResult<Response> {
        if self.options.is_none() {
            return Err(DesktopError::new(
                ErrorCode::Closed,
                "desktop session is not open; call session.open first",
            ));
        }
        let served = |audited: CoreResult<Audited>| audited.map(|(response, _audit)| response);
        // Every mutating request goes through `mutate`; reads bypass it.
        match op {
            Op::Displays => Ok(Response::Displays(self.backend()?.displays()?)),
            Op::Windows => Ok(Response::Windows(self.backend()?.windows()?)),
            Op::Capture(params) => self.capture(&params),
            Op::Click(params) => served(self.click(&params)),
            Op::MoveMouse(params) => served(self.move_mouse(&params)),
            Op::Drag(params) => served(self.drag(&params)),
            Op::Scroll(params) => served(self.scroll(&params)),
            Op::TypeText(params) => served(self.type_text(&params)),
            Op::KeyChord(params) => served(self.key_chord(&params)),
            Op::RaiseWindow(params) => served(self.raise_window(&params.window_id)),
            Op::AxSnapshot(params) => self.ax_snapshot(&params),
            Op::AxQuery(params) => self.ax_query(&params),
            Op::AxElementAt(params) => self.ax_element_at(&params),
            Op::AxFocused => self.ax_focused(),
            Op::AxNode(params) => self.ax_node(&params.ref_),
            Op::AxAttributes(params) => self.ax_attributes(&params.ref_),
            Op::AxChildren(params) => self.ax_children(&params.ref_),
            Op::AxParent(params) => self.ax_parent(&params.ref_),
            Op::AxPerform(params) => served(self.ax_perform(&params.ref_, &params.action)),
            Op::AxSetValue(params) => served(self.ax_set_value(&params.ref_, &params.value)),
            Op::AxFocus(params) => served(self.ax_focus(&params.ref_)),
            Op::AxClick(params) => served(self.ax_click(&params)),
        }
    }

    pub(crate) fn backend(&mut self) -> CoreResult<&mut dyn Backend> {
        match self.backend.as_mut() {
            Ok(backend) => Ok(backend.as_mut()),
            Err(error) => Err(error.clone()),
        }
    }

    /// The accessibility backend and the ref registry, borrowed together.
    pub(crate) fn ax_parts(&mut self) -> CoreResult<(&mut dyn AxBackend, &mut AxRegistry)> {
        let backend = match self.backend.as_mut() {
            Ok(backend) => backend,
            Err(error) => return Err(error.clone()),
        };
        let ax = backend.ax().ok_or_else(DesktopError::ax_unsupported)?;
        Ok((ax, &mut self.registry))
    }

    /// The window `target` names; `desktop` means the focused window.
    pub(crate) fn window(&mut self, target: &Target) -> CoreResult<DesktopWindow> {
        let windows = self.backend()?.windows()?;
        match target {
            Target::Window(id) => windows
                .into_iter()
                .find(|window| window.id == *id)
                .ok_or_else(|| DesktopError::window_not_found(format!("window '{id}' was not found"))),
            Target::Desktop => windows
                .into_iter()
                .find(|window| window.focused)
                .ok_or_else(|| DesktopError::window_not_found("no focused window was found")),
        }
    }
}
