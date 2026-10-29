//! Windows backend of the presence guards (design 4.2a lifetime table, Windows row): a dedicated
//! non-inheritable handle on an EXISTING presence object (never created here; a missing object is
//! `Unknown`), shared for read and write but never for delete, and an exclusive `LockFileEx` on byte
//! [0,1). The handle is opened overlapped so Repair's blocking wait can be cancelled with `CancelIoEx`.

use crate::presence::{CancelToken, FileIdentity, PresenceBackend, WaitOutcome};
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_IO_PENDING, ERROR_OPERATION_ABORTED, GENERIC_READ, GENERIC_WRITE,
    HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FileIdInfo, GetFileInformationByHandleEx, LockFileEx, FILE_ATTRIBUTE_NORMAL,
    FILE_FLAG_OVERLAPPED, FILE_ID_INFO, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
    FILE_SHARE_WRITE, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY, OPEN_EXISTING,
};
use windows_sys::Win32::System::Threading::{CreateEventW, WaitForSingleObject, INFINITE};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};

pub struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        // SAFETY: the handle came from a successful CreateFileW/CreateEventW and is closed exactly once here.
        unsafe { CloseHandle(self.0) };
    }
}

fn wide(path: &str) -> Vec<u16> {
    path.encode_utf16().chain(std::iter::once(0)).collect()
}

fn last_error() -> u32 {
    // SAFETY: reads this thread's last-error value, set by the failed call just before.
    unsafe { GetLastError() }
}

fn open(path: &str, access: u32, share: u32, flags: u32) -> Result<OwnedHandle, u32> {
    let path = wide(path);
    // SAFETY: `path` is NUL-terminated and outlives the call; a null SECURITY_ATTRIBUTES makes the handle
    // non-inheritable.
    let raw = unsafe {
        CreateFileW(
            path.as_ptr(),
            access,
            share,
            std::ptr::null(),
            OPEN_EXISTING,
            flags,
            std::ptr::null_mut(),
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        Err(last_error())
    } else {
        Ok(OwnedHandle(raw))
    }
}

fn identity(handle: HANDLE) -> Result<FileIdentity, u32> {
    // SAFETY: FILE_ID_INFO is plain data; zero is a valid bit pattern.
    let mut info: FILE_ID_INFO = unsafe { std::mem::zeroed() };
    // SAFETY: `info` is writable and its exact size is passed.
    let ok = unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileIdInfo,
            (&mut info as *mut FILE_ID_INFO).cast(),
            std::mem::size_of::<FILE_ID_INFO>() as u32,
        )
    };
    if ok == 0 {
        return Err(last_error());
    }
    Ok(FileIdentity {
        volume_serial: info.VolumeSerialNumber,
        file_id: u128::from_le_bytes(info.FileId.Identifier),
    })
}

/// `LockFileEx` on byte [0,1) with `overlapped`; the range and flags never vary.
fn lock(handle: HANDLE, flags: u32, overlapped: &mut OVERLAPPED) -> bool {
    // SAFETY: `handle` is a live handle and `overlapped` outlives the call (and any pending I/O).
    unsafe { LockFileEx(handle, flags, 0, 1, 0, overlapped) != 0 }
}

#[derive(Default)]
pub struct WindowsPresenceBackend;

impl PresenceBackend for WindowsPresenceBackend {
    type Handle = OwnedHandle;

    fn open(&mut self, path: &str) -> Result<OwnedHandle, u32> {
        open(
            path,
            GENERIC_READ | GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OVERLAPPED,
        )
    }

    fn try_lock(&mut self, handle: &OwnedHandle) -> Result<(), u32> {
        // SAFETY: OVERLAPPED is plain data; zero means offset 0 and no event.
        let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
        if lock(
            handle.0,
            LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
            &mut overlapped,
        ) {
            return Ok(());
        }
        match last_error() {
            // A fail-immediately lock on an overlapped handle may still report pending; wait for its answer.
            ERROR_IO_PENDING => overlapped_result(handle.0, &mut overlapped),
            code => Err(code),
        }
    }

    fn wait_lock(&mut self, handle: &OwnedHandle, cancel: &CancelToken) -> WaitOutcome {
        if cancel.is_cancelled() {
            return WaitOutcome::Cancelled;
        }
        // SAFETY: a manual-reset, initially unsignalled, unnamed event.
        let event = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
        if event.is_null() {
            return WaitOutcome::Unknown(last_error());
        }
        let event = OwnedHandle(event);
        // The OVERLAPPED must stay at one address until the I/O completes or is cancelled.
        // SAFETY: OVERLAPPED is plain data; the event is set below.
        let mut overlapped: Box<OVERLAPPED> = Box::new(unsafe { std::mem::zeroed() });
        overlapped.hEvent = event.0;
        let outcome = if lock(handle.0, LOCKFILE_EXCLUSIVE_LOCK, &mut overlapped) {
            WaitOutcome::Acquired
        } else {
            match last_error() {
                ERROR_IO_PENDING => {
                    // The I/O exists before its canceller does, so a cancel can never land in between and be lost.
                    let (raw_handle, raw_overlapped) =
                        (handle.0 as usize, &mut *overlapped as *mut OVERLAPPED as usize);
                    let registered = cancel.register(Box::new(move || {
                        // SAFETY: the token runs this under its lock, and `clear` below takes that lock before the
                        // handle and OVERLAPPED are dropped, so both are live whenever this runs.
                        unsafe { CancelIoEx(raw_handle as HANDLE, raw_overlapped as *const OVERLAPPED) };
                    }));
                    if !registered {
                        // SAFETY: the handle and OVERLAPPED of the pending lock are live here.
                        unsafe { CancelIoEx(handle.0, &*overlapped) };
                    }
                    // SAFETY: waits on the live event of the pending lock; no timeout by design.
                    unsafe { WaitForSingleObject(event.0, INFINITE) };
                    match overlapped_result(handle.0, &mut overlapped) {
                        Ok(()) => WaitOutcome::Acquired,
                        Err(ERROR_OPERATION_ABORTED) => WaitOutcome::Cancelled,
                        Err(code) => WaitOutcome::Unknown(code),
                    }
                }
                code => WaitOutcome::Unknown(code),
            }
        };
        cancel.clear();
        outcome
    }

    fn handle_identity(&mut self, handle: &OwnedHandle) -> Result<FileIdentity, u32> {
        identity(handle.0)
    }

    fn path_identity(&mut self, path: &str) -> Result<FileIdentity, u32> {
        let probe = open(
            path,
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            FILE_ATTRIBUTE_NORMAL,
        )?;
        identity(probe.0)
    }
}

fn overlapped_result(handle: HANDLE, overlapped: &mut OVERLAPPED) -> Result<(), u32> {
    let mut transferred = 0u32;
    // SAFETY: `overlapped` belongs to an I/O issued on `handle`; bWait = TRUE blocks until it completes.
    if unsafe { GetOverlappedResult(handle, overlapped, &mut transferred, 1) } != 0 {
        Ok(())
    } else {
        Err(last_error())
    }
}
