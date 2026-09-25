//! Focus-guard primitives: the AX-truthful front window, its restore, and the
//! symmetric key-focus hand-back after background keyboard delivery.

use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication, NSWorkspace};
use senpi_desktop_core::error::{CoreResult, DesktopError};
use senpi_desktop_core::types::{DesktopWindow, FrontWindow};

use crate::ax;
use crate::input::MacInput;
use crate::skylight;

/// The frontmost application and its AX focused window. xcap's `focused` flag
/// marks every window of the active app, so the AX attribute is the truth.
pub(crate) fn front_window() -> CoreResult<Option<FrontWindow>> {
    let Some(app) = NSWorkspace::sharedWorkspace().frontmostApplication() else {
        return Ok(None);
    };
    let pid = app.processIdentifier();
    let Ok(pid_u32) = u32::try_from(pid) else {
        return Ok(None);
    };
    let mut front = FrontWindow {
        pid: pid_u32,
        window_id: None,
        app: app
            .localizedName()
            .map_or_else(String::new, |name| name.to_string()),
        key_window_ax_title: None,
    };
    if let Ok(application) = ax::element::create_application(pid) {
        if let Some(window) = ax::element::copy_element(&application, "AXFocusedWindow") {
            front.key_window_ax_title = ax::element::copy_string(&window, "AXTitle");
            if let Some(id) = ax::element::window_id(&window) {
                front.window_id = Some(id.to_string());
            }
        }
    }
    Ok(Some(front))
}

/// Brings a previously captured front window back to the foreground through
/// the SkyLight set-front SPI, falling back to the public activation API.
pub(crate) fn restore_front_window(front: &FrontWindow) -> CoreResult<()> {
    let pid = front_pid(front)?;
    if let Some(psn) = skylight::psn_for_process(pid) {
        if skylight::set_front_process(&psn) {
            return Ok(());
        }
    }
    let app = NSRunningApplication::runningApplicationWithProcessIdentifier(pid).ok_or_else(|| {
        DesktopError::window_not_found(format!(
            "application process {pid} for the previous front window is no longer running"
        ))
    })?;
    #[expect(
        deprecated,
        reason = "restoring the prior frontmost app must override the current one"
    )]
    let options = NSApplicationActivationOptions::ActivateIgnoringOtherApps;
    if app.activateWithOptions(options) {
        Ok(())
    } else {
        Err(DesktopError::input_failed(format!(
            "restoring the previous front window of process {pid} was rejected"
        )))
    }
}

/// Hands key focus back to `front` after a background action that took it.
///
/// The previous design posted the symmetric SkyLight defocus/focus records;
/// on macOS 26 the defocus record posted to a background target is delivered
/// to that application as a destructive input event (observed live: the typed
/// document text was wiped), so the restore instead re-activates the previous
/// application - which is the frontmost one, so nothing raises or changes -
/// and then marks its window main/focused through AX as belt-and-braces.
pub(crate) fn restore_key_focus(input: &mut MacInput, front: &FrontWindow) -> CoreResult<()> {
    let Ok(prev_pid) = libc::pid_t::try_from(front.pid) else {
        return Ok(());
    };
    if input.take_last_activated().is_some() {
        reactivate(prev_pid);
    }
    mark_key_window(front)
}

/// The AX belt-and-braces half: mark `front`'s window main and focused.
pub(crate) fn mark_key_window(front: &FrontWindow) -> CoreResult<()> {
    let Some(id) = front.window_id.as_deref() else {
        return Ok(());
    };
    let window = DesktopWindow {
        id: id.to_string(),
        title: String::new(),
        app: front.app.clone(),
        pid: Some(front.pid),
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        focused: false,
        elevated: None,
    };
    let _ = ax::focus_key_window(&window);
    Ok(())
}

/// Re-activates the (already frontmost) previous application: the supported
/// way to hand the global key window back without raising anything new.
fn reactivate(pid: libc::pid_t) {
    if let Some(app) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid) {
        #[expect(
            deprecated,
            reason = "restoring key focus to the frontmost app must override the background target"
        )]
        let options = NSApplicationActivationOptions::ActivateIgnoringOtherApps;
        let _ = app.activateWithOptions(options);
    }
}

fn front_pid(front: &FrontWindow) -> CoreResult<libc::pid_t> {
    libc::pid_t::try_from(front.pid).map_err(|_| {
        DesktopError::input_failed(format!(
            "the previous front window has an invalid process id {}",
            front.pid
        ))
    })
}
