//! Presence cleanup of the #4199 design (4.2a Revision 7 "Presence cleanup", Windows row): the only way a presence
//! object is ever deleted. A deleter first takes an EXCLUSIVE hold on the object, a dedicated non-inheritable handle with
//! `DELETE` access and share mode 0. Presence guards and probes never grant `FILE_SHARE_DELETE`, so that open fails with
//! `ERROR_SHARING_VIOLATION` while any other handle on the object exists: a live lock, a prober's handle or another
//! hold. The hold reports the object's physical identity and its whole content, so the caller can revalidate the row
//! and the recorded identity while it holds the object; it then releases the hold with or without deletion. Deletion is
//! `FileDispositionInfo` delete-on-close set through the held handle, never a delete by path. The hold handle is opened
//! with `FILE_FLAG_OPEN_REPARSE_POINT` and refuses a reparse point: nothing here follows a link to delete its target.
//! Listing a root is `std::fs::read_dir` of the recorded root path, filtered to `*.presence`.
//!
//! Off Windows every call answers typed `unavailable`; the POSIX unlink-while-holding variant is the design's
//! conditional contract.

use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

/// The names a presence root holds, as `presenceRootList` reports them.
#[napi(object)]
#[derive(Debug, Default)]
pub struct PresenceRootListing {
    /// `listed`, `failed` or `unavailable`.
    pub status: String,
    /// The `*.presence` entries, in name order.
    pub names: Option<Vec<String>>,
    pub reason: Option<String>,
    pub step: Option<String>,
    pub code: Option<u32>,
}

#[napi(object)]
pub struct PresenceHoldRequest {
    /// The caller's key for this hold; one hold per key at a time.
    pub hold_id: String,
    /// The object's recorded path.
    pub path: String,
}

/// The outcome of `presenceObjectHold`.
#[napi(object)]
#[derive(Default)]
pub struct PresenceHold {
    /// `held`, `busy` (a sharing violation: another handle is open), `missing`, `failed` or `unavailable`.
    pub status: String,
    /// The held object's physical identity, decimal strings.
    pub volume_serial: Option<String>,
    pub file_id: Option<String>,
    /// The held object's whole content, bounded by `HEADER_LIMIT`.
    pub header: Option<Buffer>,
    pub reason: Option<String>,
    pub step: Option<String>,
    pub code: Option<u32>,
}

/// The outcome of `presenceObjectRelease`.
#[napi(object)]
#[derive(Debug, Default)]
pub struct PresenceHoldRelease {
    /// `deleted`, `closed`, `failed` or `unavailable`.
    pub status: String,
    pub reason: Option<String>,
    pub step: Option<String>,
    pub code: Option<u32>,
}

/// A presence object's content is an immutable header of a few hundred bytes; anything longer is not one.
pub const HEADER_LIMIT: usize = 4096;

/// The `*.presence` entries of a directory listing, in name order; non-UTF-8 names cannot be presence objects.
pub fn presence_names<I: IntoIterator<Item = String>>(entries: I) -> Vec<String> {
    let mut names: Vec<String> = entries
        .into_iter()
        .filter(|name| name.ends_with(".presence"))
        .collect();
    names.sort();
    names
}

#[cfg(windows)]
fn listing_failed(step: &str, code: u32) -> PresenceRootListing {
    PresenceRootListing {
        status: "failed".into(),
        step: Some(step.into()),
        code: Some(code),
        ..PresenceRootListing::default()
    }
}

/// Lists the `*.presence` entries of the presence root at `path`.
#[napi(js_name = "presenceRootList")]
pub fn presence_root_list(path: String) -> PresenceRootListing {
    #[cfg(windows)]
    {
        let entries = match std::fs::read_dir(&path) {
            Ok(entries) => entries,
            Err(error) => return listing_failed("read_dir", error.raw_os_error().unwrap_or(0) as u32),
        };
        let mut names = Vec::new();
        for entry in entries {
            match entry {
                Ok(entry) => {
                    if let Ok(name) = entry.file_name().into_string() {
                        names.push(name);
                    }
                }
                Err(error) => return listing_failed("read_entry", error.raw_os_error().unwrap_or(0) as u32),
            }
        }
        PresenceRootListing {
            status: "listed".into(),
            names: Some(presence_names(names)),
            ..PresenceRootListing::default()
        }
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        PresenceRootListing {
            status: "unavailable".into(),
            reason: Some("unsupported_platform".into()),
            ..PresenceRootListing::default()
        }
    }
}

/// Takes an exclusive hold (share mode 0, `DELETE` access) on the EXISTING object at `path` and reports its identity
/// and content. `busy` is a sharing violation; `missing` is not-found; every other failure is `failed`. The hold stays
/// open until `presenceObjectRelease` names its `holdId`.
#[napi(js_name = "presenceObjectHold")]
pub fn presence_object_hold(request: PresenceHoldRequest) -> PresenceHold {
    #[cfg(windows)]
    {
        windows_cleanup::hold(&request)
    }
    #[cfg(not(windows))]
    {
        let _ = request;
        PresenceHold {
            status: "unavailable".into(),
            reason: Some("unsupported_platform".into()),
            ..PresenceHold::default()
        }
    }
}

/// Releases the hold `holdId`: with `deleteObject` the object is marked delete-on-close through the held handle first,
/// so it disappears when the handle closes; otherwise it is left as it was.
#[napi(js_name = "presenceObjectRelease")]
pub fn presence_object_release(hold_id: String, delete_object: bool) -> PresenceHoldRelease {
    #[cfg(windows)]
    {
        windows_cleanup::release(&hold_id, delete_object)
    }
    #[cfg(not(windows))]
    {
        let _ = (hold_id, delete_object);
        PresenceHoldRelease {
            status: "unavailable".into(),
            reason: Some("unsupported_platform".into()),
            ..PresenceHoldRelease::default()
        }
    }
}

#[cfg(windows)]
mod windows_cleanup {
    use super::{PresenceHold, PresenceHoldRelease, PresenceHoldRequest, HEADER_LIMIT};
    use crate::presence_windows::identity;
    use std::collections::BTreeMap;
    use std::io::Read;
    use std::sync::{Mutex, OnceLock};
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SHARING_VIOLATION,
        GENERIC_READ, HANDLE, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FileBasicInfo, FileDispositionInfo, GetFileInformationByHandleEx,
        SetFileInformationByHandle, DELETE, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_BASIC_INFO, FILE_DISPOSITION_INFO, FILE_FLAG_OPEN_REPARSE_POINT, OPEN_EXISTING,
    };

    /// A held handle: exclusively owned, non-inheritable, reached only under the holds mutex.
    struct HeldHandle(HANDLE);

    // SAFETY: the handle is owned by exactly one `HeldHandle`, which lives in the mutex-guarded holds map; Windows
    // permits handles to move between threads.
    unsafe impl Send for HeldHandle {}

    impl Drop for HeldHandle {
        fn drop(&mut self) {
            // SAFETY: the handle came from a successful CreateFileW and is closed exactly once here.
            unsafe { CloseHandle(self.0) };
        }
    }

    fn holds() -> &'static Mutex<BTreeMap<String, HeldHandle>> {
        static HOLDS: OnceLock<Mutex<BTreeMap<String, HeldHandle>>> = OnceLock::new();
        HOLDS.get_or_init(Mutex::default)
    }

    fn last_error() -> u32 {
        // SAFETY: reads this thread's last-error value, set by the failed call just before.
        unsafe { GetLastError() }
    }

    fn hold_failed(step: &str, code: u32) -> PresenceHold {
        PresenceHold {
            status: "failed".into(),
            step: Some(step.into()),
            code: Some(code),
            ..PresenceHold::default()
        }
    }

    fn hold_status(status: &str) -> PresenceHold {
        PresenceHold {
            status: status.into(),
            ..PresenceHold::default()
        }
    }

    fn release_failed(step: &str, code: u32) -> PresenceHoldRelease {
        PresenceHoldRelease {
            status: "failed".into(),
            step: Some(step.into()),
            code: Some(code),
            ..PresenceHoldRelease::default()
        }
    }

    /// The exclusive open: `DELETE | GENERIC_READ`, share mode 0, the existing entry itself (no reparse following).
    fn open_exclusive(path: &str) -> Result<HeldHandle, u32> {
        let path: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        // SAFETY: `path` is NUL-terminated and outlives the call; a null SECURITY_ATTRIBUTES makes the handle
        // non-inheritable.
        let raw = unsafe {
            CreateFileW(
                path.as_ptr(),
                DELETE | GENERIC_READ,
                0,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
                std::ptr::null_mut(),
            )
        };
        if raw == INVALID_HANDLE_VALUE {
            Err(last_error())
        } else {
            Ok(HeldHandle(raw))
        }
    }

    fn is_reparse_point(handle: HANDLE) -> Result<bool, u32> {
        // SAFETY: FILE_BASIC_INFO is plain data; zero is a valid bit pattern.
        let mut info: FILE_BASIC_INFO = unsafe { std::mem::zeroed() };
        // SAFETY: `info` is writable and its exact size is passed.
        let ok = unsafe {
            GetFileInformationByHandleEx(
                handle,
                FileBasicInfo,
                (&mut info as *mut FILE_BASIC_INFO).cast(),
                std::mem::size_of::<FILE_BASIC_INFO>() as u32,
            )
        };
        if ok == 0 {
            return Err(last_error());
        }
        Ok(info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0)
    }

    fn read_header(handle: HANDLE) -> std::io::Result<Vec<u8>> {
        use std::os::windows::io::FromRawHandle;
        // SAFETY: a borrowed view of the live held handle; ManuallyDrop keeps File from closing it.
        let file = std::mem::ManuallyDrop::new(unsafe { std::fs::File::from_raw_handle(handle) });
        let mut header = Vec::new();
        (&*file).take(HEADER_LIMIT as u64 + 1).read_to_end(&mut header)?;
        Ok(header)
    }

    pub(super) fn hold(request: &PresenceHoldRequest) -> PresenceHold {
        let mut holds = holds().lock().unwrap();
        if holds.contains_key(&request.hold_id) {
            return hold_failed("hold_id", 0);
        }
        let handle = match open_exclusive(&request.path) {
            Ok(handle) => handle,
            Err(ERROR_SHARING_VIOLATION) => return hold_status("busy"),
            Err(ERROR_FILE_NOT_FOUND) | Err(ERROR_PATH_NOT_FOUND) => return hold_status("missing"),
            Err(code) => return hold_failed("open", code),
        };
        match is_reparse_point(handle.0) {
            Ok(false) => {}
            Ok(true) => return hold_failed("reparse_point", 0),
            Err(code) => return hold_failed("attributes", code),
        }
        let identity = match identity(handle.0) {
            Ok(identity) => identity,
            Err(code) => return hold_failed("identity", code),
        };
        let header = match read_header(handle.0) {
            Ok(header) if header.len() <= HEADER_LIMIT => header,
            Ok(_) => return hold_failed("header_limit", 0),
            Err(error) => return hold_failed("read", error.raw_os_error().unwrap_or(0) as u32),
        };
        holds.insert(request.hold_id.clone(), handle);
        PresenceHold {
            status: "held".into(),
            volume_serial: Some(identity.volume_serial.to_string()),
            file_id: Some(identity.file_id.to_string()),
            header: Some(header.into()),
            ..PresenceHold::default()
        }
    }

    pub(super) fn release(hold_id: &str, delete_object: bool) -> PresenceHoldRelease {
        let handle = match holds().lock().unwrap().remove(hold_id) {
            Some(handle) => handle,
            None => return release_failed("hold_id", 0),
        };
        if !delete_object {
            drop(handle);
            return PresenceHoldRelease {
                status: "closed".into(),
                ..PresenceHoldRelease::default()
            };
        }
        let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
        // SAFETY: the handle is live and was opened with DELETE access; `disposition` is a plain struct of the size
        // passed.
        let ok = unsafe {
            SetFileInformationByHandle(
                handle.0,
                FileDispositionInfo,
                (&disposition as *const FILE_DISPOSITION_INFO).cast(),
                std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
            )
        };
        let result = if ok == 0 {
            release_failed("disposition", last_error())
        } else {
            PresenceHoldRelease {
                status: "deleted".into(),
                ..PresenceHoldRelease::default()
            }
        };
        // The close carries the deletion out; a failed disposition closes the untouched object.
        drop(handle);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::presence_names;

    #[test]
    fn a_listing_keeps_only_presence_entries_in_name_order() {
        let names = presence_names(
            [
                "b.presence",
                "a.presence",
                "notes.txt",
                "c.presence.tmp",
                ".presence",
            ]
            .map(str::to_string),
        );
        assert_eq!(names, [".presence", "a.presence", "b.presence"]);
    }
}
