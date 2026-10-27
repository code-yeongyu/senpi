//! Presence placement of the #4199 design (4.2a "Placement." and "Lifetime object and binding"): the private presence
//! root a reserving owner resolves once, and the presence object an offer predeclares in it before any spawn.
//!
//! The root is opened following reparse points, and its canonical path, physical identity (volume serial plus file ID)
//! and locality all come from that one handle (Revision 8.1 note 2). An object is created NEW, relative to a root handle
//! whose identity matches the recorded one and which classifies `local`, with the owner-only DACL and without delete
//! sharing; its immutable header is written and flushed, then the directory is flushed. Nothing here renames, truncates,
//! replaces or deletes a presence object: a name collision is `exists`, never an overwrite. Choosing the root (beside a
//! local store, else under FOLDERID_LocalAppData) and recording it is the caller's job. Off Windows every call answers
//! typed `unavailable`; the POSIX placement is the design's conditional contract.

use crate::presence::FileIdentity;
use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

/// The presence root as one opened handle describes it.
#[napi(object)]
#[derive(Debug, Default)]
pub struct PresenceRoot {
    /// `opened`, `insecure` (not a directory, or an untrusted owner), `failed` or `unavailable`.
    pub status: String,
    /// The canonical path of the opened directory (`GetFinalPathNameByHandleW`).
    pub path: Option<String>,
    /// Decimal strings keep the full native identity.
    pub volume_serial: Option<String>,
    pub file_id: Option<String>,
    /// `local` or `not_local`, classified on the opened directory handle.
    pub locality: Option<String>,
    /// The `not_local` reason, the `insecure` reason, or `unsupported_platform`.
    pub reason: Option<String>,
    pub reported_file_system: Option<String>,
    /// The failed step and its Win32 error, for `failed`.
    pub step: Option<String>,
    pub code: Option<u32>,
}

#[napi(object)]
pub struct PresenceObjectRequest {
    /// The recorded canonical root path and its recorded physical identity.
    pub root_path: String,
    pub root_volume_serial: String,
    pub root_file_id: String,
    /// One path component, created inside the root.
    pub name: String,
    /// The immutable header: the whole content of the object.
    pub header: Buffer,
}

#[napi(object)]
#[derive(Debug, Default)]
pub struct PresenceObject {
    /// `created`, `exists`, `root_mismatch`, `root_not_local`, `insecure`, `failed` or `unavailable`.
    pub status: String,
    pub volume_serial: Option<String>,
    pub file_id: Option<String>,
    /// The object's own handle, classified after creation.
    pub locality: Option<String>,
    pub reason: Option<String>,
    pub reported_file_system: Option<String>,
    pub step: Option<String>,
    pub code: Option<u32>,
}

/// FOLDERID_LocalAppData, the per-user root that roaming profiles do not copy.
#[napi(object)]
#[derive(Debug, Default)]
pub struct KnownFolder {
    /// `found`, `failed` or `unavailable`.
    pub status: String,
    pub path: Option<String>,
    /// The failing HRESULT, for `failed`.
    pub code: Option<u32>,
    pub reason: Option<String>,
}

/// A presence object's name is exactly one path component: never empty, `.`, `..`, or anything with a separator,
/// a drive or stream colon, or a NUL.
pub fn valid_object_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['\\', '/', ':', '\0'])
}

/// The recorded identity, parsed losslessly from its decimal strings.
pub fn parse_identity(volume_serial: &str, file_id: &str) -> Option<FileIdentity> {
    Some(FileIdentity {
        volume_serial: volume_serial.parse().ok()?,
        file_id: file_id.parse().ok()?,
    })
}

/// Opens the presence root at `path`, creating it first (owner-only protected DACL, missing ancestors as ordinary
/// directories) when `create` is set and it does not exist. An existing root is opened as it is, never replaced.
#[napi(js_name = "presenceRootOpen")]
pub fn presence_root_open(path: String, create: bool) -> PresenceRoot {
    #[cfg(windows)]
    {
        windows_placement::root_open(&path, create)
    }
    #[cfg(not(windows))]
    {
        let _ = (path, create);
        PresenceRoot {
            status: "unavailable".into(),
            reason: Some("unsupported_platform".into()),
            ..PresenceRoot::default()
        }
    }
}

/// Creates the presence object `name` inside the recorded root, only when the root opened at the recorded path still
/// has the recorded physical identity and classifies `local`.
#[napi(js_name = "presenceObjectCreate")]
pub fn presence_object_create(request: PresenceObjectRequest) -> PresenceObject {
    if !valid_object_name(&request.name) {
        return PresenceObject {
            status: "failed".into(),
            step: Some("name".into()),
            code: Some(0),
            ..PresenceObject::default()
        };
    }
    #[cfg(windows)]
    {
        windows_placement::object_create(&request)
    }
    #[cfg(not(windows))]
    {
        let _ = request;
        PresenceObject {
            status: "unavailable".into(),
            reason: Some("unsupported_platform".into()),
            ..PresenceObject::default()
        }
    }
}

#[napi(js_name = "localAppDataPath")]
pub fn local_app_data_path() -> KnownFolder {
    #[cfg(windows)]
    {
        windows_placement::local_app_data()
    }
    #[cfg(not(windows))]
    {
        KnownFolder {
            status: "unavailable".into(),
            reason: Some("unsupported_platform".into()),
            ..KnownFolder::default()
        }
    }
}

#[cfg(windows)]
mod windows_placement {
    use super::{parse_identity, KnownFolder, PresenceObject, PresenceObjectRequest, PresenceRoot};
    use crate::owner_dacl::{current_user_sid_string, sid_string, OwnerOnlyDescriptor};
    use crate::presence_windows::identity;
    use crate::{classify, reason_code, volume::probe_handle, Locality};
    use windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES;
    use windows_sys::Wdk::Storage::FileSystem::{
        NtCreateFile, FILE_CREATE, FILE_NON_DIRECTORY_FILE, FILE_SYNCHRONOUS_IO_NONALERT,
    };
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, LocalFree, RtlNtStatusToDosError, ERROR_ALREADY_EXISTS, GENERIC_READ,
        GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE, OBJ_CASE_INSENSITIVE, STATUS_OBJECT_NAME_COLLISION,
        UNICODE_STRING,
    };
    use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT};
    use windows_sys::Win32::Security::{
        OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateDirectoryW, CreateFileW, FileBasicInfo, FlushFileBuffers, GetFileInformationByHandleEx,
        GetFinalPathNameByHandleW, WriteFile, FILE_ADD_FILE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL,
        FILE_BASIC_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_LIST_DIRECTORY, FILE_NAME_NORMALIZED,
        FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TRAVERSE,
        OPEN_EXISTING, READ_CONTROL, SYNCHRONIZE, VOLUME_NAME_DOS,
    };
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;
    use windows_sys::Win32::UI::Shell::{FOLDERID_LocalAppData, SHGetKnownFolderPath};

    /// The owners a private root may have: this user, SYSTEM, or Administrators (an elevated token's default owner).
    const SYSTEM_SID: &str = "S-1-5-18";
    const ADMINISTRATORS_SID: &str = "S-1-5-32-544";

    struct OwnedHandle(HANDLE);

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            // SAFETY: the handle came from a successful CreateFileW/NtCreateFile and is closed exactly once here.
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

    fn root_failed(step: &str, code: u32) -> PresenceRoot {
        PresenceRoot {
            status: "failed".into(),
            step: Some(step.into()),
            code: Some(code),
            ..PresenceRoot::default()
        }
    }

    fn object_failed(step: &str, code: u32) -> PresenceObject {
        PresenceObject {
            status: "failed".into(),
            step: Some(step.into()),
            code: Some(code),
            ..PresenceObject::default()
        }
    }

    fn object_status(status: &str, reason: Option<&str>) -> PresenceObject {
        PresenceObject {
            status: status.into(),
            reason: reason.map(str::to_string),
            ..PresenceObject::default()
        }
    }

    /// Opens a directory following reparse points (never `FILE_FLAG_OPEN_REPARSE_POINT`): the handle that classifies.
    /// `add_file` also grants FILE_ADD_FILE (FILE_WRITE_DATA), which flushing the directory needs.
    fn open_directory(path: &str, add_file: bool) -> Result<OwnedHandle, u32> {
        let path = wide(path);
        let access = FILE_LIST_DIRECTORY
            | FILE_TRAVERSE
            | FILE_READ_ATTRIBUTES
            | READ_CONTROL
            | SYNCHRONIZE
            | if add_file { FILE_ADD_FILE } else { 0 };
        // SAFETY: `path` is NUL-terminated and outlives the call; a null SECURITY_ATTRIBUTES makes the handle
        // non-inheritable.
        let raw = unsafe {
            CreateFileW(
                path.as_ptr(),
                access,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS,
                std::ptr::null_mut(),
            )
        };
        if raw == INVALID_HANDLE_VALUE {
            Err(last_error())
        } else {
            Ok(OwnedHandle(raw))
        }
    }

    fn is_directory(handle: HANDLE) -> Result<bool, u32> {
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
        Ok(info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0)
    }

    fn owner_is_trusted(handle: HANDLE) -> Result<bool, u32> {
        let mut owner: PSID = std::ptr::null_mut();
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        // SAFETY: `handle` is live and was opened with READ_CONTROL; the out-pointers are writable, and the owner SID
        // points into `descriptor`, which is freed below after its last use.
        let error = unsafe {
            GetSecurityInfo(
                handle,
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION,
                &mut owner,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut descriptor,
            )
        };
        if error != 0 {
            return Err(error);
        }
        let text = sid_string(owner);
        // SAFETY: `descriptor` came from GetSecurityInfo and is freed exactly once, after the owner SID was read.
        unsafe { LocalFree(descriptor.cast()) };
        let text = text?;
        Ok(text == current_user_sid_string()? || text == SYSTEM_SID || text == ADMINISTRATORS_SID)
    }

    fn final_path(handle: HANDLE) -> Result<String, u32> {
        let mut buffer = vec![0u16; 512];
        loop {
            // SAFETY: `buffer` is writable for the length passed.
            let length = unsafe {
                GetFinalPathNameByHandleW(
                    handle,
                    buffer.as_mut_ptr(),
                    buffer.len() as u32,
                    FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
                )
            } as usize;
            if length == 0 {
                return Err(last_error());
            }
            if length < buffer.len() {
                return String::from_utf16(&buffer[..length]).map_err(|_| 0);
            }
            buffer.resize(length + 1, 0);
        }
    }

    /// Validates the directory behind `handle` and describes it: type, owner, identity, canonical path, locality.
    fn describe(handle: &OwnedHandle) -> PresenceRoot {
        match is_directory(handle.0) {
            Ok(true) => {}
            Ok(false) => {
                return PresenceRoot {
                    status: "insecure".into(),
                    reason: Some("not_directory".into()),
                    ..PresenceRoot::default()
                }
            }
            Err(code) => return root_failed("attributes", code),
        }
        match owner_is_trusted(handle.0) {
            Ok(true) => {}
            Ok(false) => {
                return PresenceRoot {
                    status: "insecure".into(),
                    reason: Some("owner".into()),
                    ..PresenceRoot::default()
                }
            }
            Err(code) => return root_failed("owner", code),
        }
        let identity = match identity(handle.0) {
            Ok(identity) => identity,
            Err(code) => return root_failed("identity", code),
        };
        let path = match final_path(handle.0) {
            Ok(path) => path,
            Err(code) => return root_failed("final_path", code),
        };
        let facts = probe_handle(handle.0);
        let (locality, reason) = match classify(&facts) {
            Locality::Local => ("local", None),
            Locality::NotLocal(reason) => ("not_local", Some(reason_code(reason).to_string())),
        };
        PresenceRoot {
            status: "opened".into(),
            path: Some(path),
            volume_serial: Some(identity.volume_serial.to_string()),
            file_id: Some(identity.file_id.to_string()),
            locality: Some(locality.into()),
            reason,
            reported_file_system: facts.reported_file_system,
            ..PresenceRoot::default()
        }
    }

    pub(super) fn root_open(path: &str, create: bool) -> PresenceRoot {
        if create {
            if let Some(parent) = std::path::Path::new(path).parent() {
                if let Err(error) = std::fs::create_dir_all(parent) {
                    return root_failed("create_parent", error.raw_os_error().unwrap_or(0) as u32);
                }
            }
            let descriptor = match OwnerOnlyDescriptor::for_current_user() {
                Ok(descriptor) => descriptor,
                Err(code) => return root_failed("dacl", code),
            };
            let attributes = SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: descriptor.as_ptr(),
                bInheritHandle: 0,
            };
            // SAFETY: the path is NUL-terminated and `attributes` points at a live protected descriptor.
            if unsafe { CreateDirectoryW(wide(path).as_ptr(), &attributes) } == 0 {
                let code = last_error();
                if code != ERROR_ALREADY_EXISTS {
                    return root_failed("create_directory", code);
                }
            }
        }
        match open_directory(path, false) {
            Ok(handle) => describe(&handle),
            Err(code) => root_failed("open", code),
        }
    }

    fn write_all(handle: HANDLE, bytes: &[u8]) -> Result<(), u32> {
        let mut offset = 0;
        while offset < bytes.len() {
            let remaining = &bytes[offset..];
            let mut written = 0u32;
            // SAFETY: the buffer pointer and length describe `remaining`; `written` is a writable u32.
            let ok = unsafe {
                WriteFile(
                    handle,
                    remaining.as_ptr(),
                    u32::try_from(remaining.len()).unwrap_or(u32::MAX),
                    &mut written,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 {
                return Err(last_error());
            }
            if written == 0 {
                return Err(0);
            }
            offset += written as usize;
        }
        Ok(())
    }

    fn flush(handle: HANDLE) -> Result<(), u32> {
        // SAFETY: `handle` is live and grants FILE_WRITE_DATA (a file opened for writing, or a directory opened with
        // FILE_ADD_FILE).
        (unsafe { FlushFileBuffers(handle) } != 0)
            .then_some(())
            .ok_or_else(last_error)
    }

    /// `FILE_CREATE` relative to the verified root handle: the object can only be created inside that very directory,
    /// and an existing name fails instead of being opened, truncated or replaced.
    fn create_relative(
        root: &OwnedHandle,
        name: &str,
        descriptor: &OwnerOnlyDescriptor,
    ) -> Result<OwnedHandle, i32> {
        let mut name: Vec<u16> = name.encode_utf16().collect();
        let bytes = (name.len() * 2) as u16;
        let object_name = UNICODE_STRING {
            Length: bytes,
            MaximumLength: bytes,
            Buffer: name.as_mut_ptr(),
        };
        let attributes = OBJECT_ATTRIBUTES {
            Length: std::mem::size_of::<OBJECT_ATTRIBUTES>() as u32,
            RootDirectory: root.0,
            ObjectName: &object_name,
            Attributes: OBJ_CASE_INSENSITIVE,
            SecurityDescriptor: descriptor.as_ptr().cast(),
            SecurityQualityOfService: std::ptr::null(),
        };
        let mut raw: HANDLE = std::ptr::null_mut();
        let mut status_block = IO_STATUS_BLOCK::default();
        // SAFETY: every pointer names a live local; `name` and `descriptor` outlive the call. Sharing omits
        // FILE_SHARE_DELETE, like every presence handle.
        let status = unsafe {
            NtCreateFile(
                &mut raw,
                GENERIC_READ | GENERIC_WRITE | SYNCHRONIZE,
                &attributes,
                &mut status_block,
                std::ptr::null(),
                FILE_ATTRIBUTE_NORMAL,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                FILE_CREATE,
                FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT,
                std::ptr::null(),
                0,
            )
        };
        if status < 0 {
            Err(status)
        } else {
            Ok(OwnedHandle(raw))
        }
    }

    pub(super) fn object_create(request: &PresenceObjectRequest) -> PresenceObject {
        let Some(recorded) = parse_identity(&request.root_volume_serial, &request.root_file_id) else {
            return object_failed("recorded_identity", 0);
        };
        let root = match open_directory(&request.root_path, true) {
            Ok(root) => root,
            Err(code) => return object_failed("open_root", code),
        };
        match identity(root.0) {
            Ok(actual) if actual == recorded => {}
            Ok(_) => return object_status("root_mismatch", None),
            Err(code) => return object_failed("root_identity", code),
        }
        let trusted = is_directory(root.0).and_then(|directory| {
            if directory {
                owner_is_trusted(root.0)
            } else {
                Ok(false)
            }
        });
        match trusted {
            Ok(true) => {}
            Ok(false) => return object_status("insecure", Some("root")),
            Err(code) => return object_failed("root_security", code),
        }
        if let Locality::NotLocal(reason) = classify(&probe_handle(root.0)) {
            return object_status("root_not_local", Some(reason_code(reason)));
        }
        let descriptor = match OwnerOnlyDescriptor::for_current_user() {
            Ok(descriptor) => descriptor,
            Err(code) => return object_failed("dacl", code),
        };
        let object = match create_relative(&root, &request.name, &descriptor) {
            Ok(object) => object,
            Err(STATUS_OBJECT_NAME_COLLISION) => return object_status("exists", None),
            // SAFETY: a pure status-to-error mapping.
            Err(status) => return object_failed("create", unsafe { RtlNtStatusToDosError(status) }),
        };
        if let Err(code) = write_all(object.0, &request.header) {
            return object_failed("write", code);
        }
        if let Err(code) = flush(object.0) {
            return object_failed("flush", code);
        }
        let created = match identity(object.0) {
            Ok(created) => created,
            Err(code) => return object_failed("object_identity", code),
        };
        let facts = probe_handle(object.0);
        let (locality, reason) = match classify(&facts) {
            Locality::Local => ("local", None),
            Locality::NotLocal(reason) => ("not_local", Some(reason_code(reason).to_string())),
        };
        drop(object);
        // The namespace entry is part of what the offer will name: flush the directory before reporting success.
        if let Err(code) = flush(root.0) {
            return object_failed("flush_directory", code);
        }
        PresenceObject {
            status: "created".into(),
            volume_serial: Some(created.volume_serial.to_string()),
            file_id: Some(created.file_id.to_string()),
            locality: Some(locality.into()),
            reason,
            reported_file_system: facts.reported_file_system,
            ..PresenceObject::default()
        }
    }

    pub(super) fn local_app_data() -> KnownFolder {
        let mut raw: *mut u16 = std::ptr::null_mut();
        // SAFETY: the GUID is a static; `raw` receives a CoTaskMemAlloc'd string freed below on every path.
        let result =
            unsafe { SHGetKnownFolderPath(&FOLDERID_LocalAppData, 0, std::ptr::null_mut(), &mut raw) };
        let folder = if result < 0 || raw.is_null() {
            KnownFolder {
                status: "failed".into(),
                code: Some(result as u32),
                ..KnownFolder::default()
            }
        } else {
            // SAFETY: on success `raw` is a NUL-terminated wide string.
            let length = (0..).take_while(|&index| unsafe { *raw.add(index) } != 0).count();
            // SAFETY: `length` units were just read from the same allocation.
            match String::from_utf16(unsafe { std::slice::from_raw_parts(raw, length) }) {
                Ok(path) => KnownFolder {
                    status: "found".into(),
                    path: Some(path),
                    ..KnownFolder::default()
                },
                Err(_) => KnownFolder {
                    status: "failed".into(),
                    code: Some(0),
                    reason: Some("not_utf16".into()),
                    ..KnownFolder::default()
                },
            }
        };
        // SAFETY: SHGetKnownFolderPath requires the caller to free the buffer even on failure; null is allowed.
        unsafe { CoTaskMemFree(raw.cast()) };
        folder
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_identity, valid_object_name};

    #[test]
    fn an_object_name_is_exactly_one_path_component() {
        assert!(valid_object_name("0123abcd.presence"));
        for name in ["", ".", "..", r"..\x", "a/b", r"a\b", "C:x", "a:stream", "a\0b"] {
            assert!(!valid_object_name(name), "{name:?}");
        }
    }

    #[test]
    fn a_recorded_identity_parses_losslessly_or_not_at_all() {
        let identity =
            parse_identity("18446744073709551615", "340282366920938463463374607431768211455").unwrap();
        assert_eq!(identity.volume_serial, u64::MAX);
        assert_eq!(identity.file_id, u128::MAX);
        assert!(parse_identity("", "1").is_none());
        assert!(parse_identity("1", "-1").is_none());
        assert!(parse_identity("18446744073709551616", "1").is_none());
    }
}
