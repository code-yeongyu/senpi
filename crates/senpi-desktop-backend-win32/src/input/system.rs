//! `SendInput` primitives: synthesized events on the system input queue,
//! which reach whatever window has the foreground (keys) or lies under the
//! cursor (pointer). Absolute moves are normalized over the whole virtual
//! desktop, so every monitor is reachable.

use std::mem::size_of;

use senpi_desktop_core::backend::MouseButton;
use senpi_desktop_core::error::{CoreResult, DesktopError};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE,
    MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
    MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN,
    MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSEINPUT,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

use super::messages::absolute_coordinate;

fn send(event: &INPUT) -> CoreResult<()> {
    let size = i32::try_from(size_of::<INPUT>()).unwrap_or(i32::MAX);
    // SAFETY: [FFI] `event` is one fully initialized INPUT that Win32 copies
    // synchronously; `size` is its exact size.
    let sent = unsafe { SendInput(1, event, size) };
    if sent == 1 {
        Ok(())
    } else {
        Err(DesktopError::input_failed(format!(
            "Win32 SendInput failed: {}",
            std::io::Error::last_os_error()
        )))
    }
}

const fn mouse_event(flags: u32, data: i32, dx: i32, dy: i32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: u32::from_ne_bytes(data.to_ne_bytes()),
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

const fn key_event(vk: u16, scan: u16, flags: u32) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

/// Presses (`down`) or releases virtual key `vk`.
pub(super) fn key(vk: u16, down: bool) -> CoreResult<()> {
    send(&key_event(vk, 0, if down { 0 } else { KEYEVENTF_KEYUP }))
}

/// Types one UTF-16 unit layout-independently (`KEYEVENTF_UNICODE`).
pub(super) fn unicode_unit(unit: u16) -> CoreResult<()> {
    send(&key_event(0, unit, KEYEVENTF_UNICODE))?;
    send(&key_event(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP))
}

/// Makes this process the source of the last input event with a zero
/// relative mouse move (no motion, no button). `SetForegroundWindow` only
/// succeeds for the process that received the last input event, which an
/// engine driven over stdio never is on its own.
pub(super) fn claim_last_input() -> CoreResult<()> {
    send(&mouse_event(MOUSEEVENTF_MOVE, 0, 0, 0))
}

/// Moves the cursor to a physical virtual-desktop point.
pub(super) fn move_to((x, y): (i32, i32)) -> CoreResult<()> {
    // SAFETY: [FFI] `GetSystemMetrics` takes a scalar index and has no
    // preconditions.
    let (origin_x, origin_y, width, height) = unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    };
    let (Some(dx), Some(dy)) = (
        absolute_coordinate(x, origin_x, width),
        absolute_coordinate(y, origin_y, height),
    ) else {
        return Err(DesktopError::input_failed(
            "Win32 virtual desktop geometry is unavailable",
        ));
    };
    let flags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
    send(&mouse_event(flags, 0, dx, dy))
}

/// Presses (`down`) or releases `button` where the cursor is.
pub(super) fn button(button: MouseButton, down: bool) -> CoreResult<()> {
    let flags = match (button, down) {
        (MouseButton::Left, true) => MOUSEEVENTF_LEFTDOWN,
        (MouseButton::Left, false) => MOUSEEVENTF_LEFTUP,
        (MouseButton::Right, true) => MOUSEEVENTF_RIGHTDOWN,
        (MouseButton::Right, false) => MOUSEEVENTF_RIGHTUP,
        (MouseButton::Middle, true) => MOUSEEVENTF_MIDDLEDOWN,
        (MouseButton::Middle, false) => MOUSEEVENTF_MIDDLEUP,
    };
    send(&mouse_event(flags, 0, 0, 0))
}

/// One wheel event of `delta` (multiples of `WHEEL_DELTA`) on an axis.
pub(super) fn wheel(horizontal: bool, delta: i32) -> CoreResult<()> {
    let flags = if horizontal {
        MOUSEEVENTF_HWHEEL
    } else {
        MOUSEEVENTF_WHEEL
    };
    send(&mouse_event(flags, delta, 0, 0))
}
