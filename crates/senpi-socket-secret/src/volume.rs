//! Reads the Windows volume facts the locality rule needs, all from ONE opened handle. The handle
//! follows reparse points (no `FILE_FLAG_OPEN_REPARSE_POINT`, design Revision 8.1 note 2): a junction
//! on NTFS that leads to a user-mode volume must be classified by the volume behind it.

use crate::classify::VolumeFacts;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProbeError {
    UnsupportedPlatform,
    OpenFailed(u32),
}

#[cfg(not(windows))]
pub fn probe_volume(_path: &str) -> Result<VolumeFacts, ProbeError> {
    Err(ProbeError::UnsupportedPlatform)
}

#[cfg(windows)]
pub fn probe_volume(path: &str) -> Result<VolumeFacts, ProbeError> {
    windows_probe::probe(path)
}

#[cfg(windows)]
mod windows_probe {
    use super::ProbeError;
    use crate::answers::{driver_path_from_query, remote_protocol_from_query, ProbeCodes};
    use crate::classify::{DriverPath, RemoteDevice, RemoteProtocol, VolumeFacts, NTFS_DRIVER, REFS_DRIVER};
    use windows_sys::Wdk::Storage::FileSystem::{
        FileFsDeviceInformation, FileFsDriverPathInformation, NtQueryVolumeInformationFile,
    };
    use windows_sys::Wdk::System::SystemServices::{FILE_FS_DEVICE_INFORMATION, FILE_REMOTE_DEVICE};
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FileRemoteProtocolInfo, GetFileInformationByHandleEx, GetVolumeInformationByHandleW,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES, FILE_REMOTE_PROTOCOL_INFO, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;

    struct OwnedHandle(HANDLE);

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            // SAFETY: the handle came from a successful CreateFileW and is closed exactly once here.
            unsafe { CloseHandle(self.0) };
        }
    }

    pub fn probe(path: &str) -> Result<VolumeFacts, ProbeError> {
        let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        // SAFETY: `wide` is NUL-terminated and outlives the call; the other pointers are null as allowed.
        let raw = unsafe {
            CreateFileW(
                wide.as_ptr(),
                FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS,
                std::ptr::null_mut(),
            )
        };
        if raw == INVALID_HANDLE_VALUE {
            // SAFETY: reads this thread's last-error value, set by the failed CreateFileW above.
            return Err(ProbeError::OpenFailed(unsafe { GetLastError() }));
        }
        let handle = OwnedHandle(raw);
        let (ntfs_driver, ntfs_status) = driver_in_path(handle.0, NTFS_DRIVER);
        let (refs_driver, refs_status) = driver_in_path(handle.0, REFS_DRIVER);
        let (remote_device, device_status) = remote_device(handle.0);
        let (remote_protocol, remote_protocol_error) = remote_protocol(handle.0);
        Ok(VolumeFacts {
            reported_file_system: reported_file_system(handle.0),
            ntfs_driver,
            refs_driver,
            remote_device,
            remote_protocol,
            codes: ProbeCodes {
                ntfs_status,
                refs_status,
                device_status,
                remote_protocol_error,
            },
        })
    }

    fn reported_file_system(handle: HANDLE) -> Option<String> {
        let mut name = [0u16; 261];
        // SAFETY: `name` is writable for its full length, which is passed as the buffer size.
        let ok = unsafe {
            GetVolumeInformationByHandleW(
                handle,
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                name.as_mut_ptr(),
                name.len() as u32,
            )
        };
        if ok == 0 {
            return None;
        }
        let end = name.iter().position(|&unit| unit == 0).unwrap_or(name.len());
        String::from_utf16(&name[..end]).ok()
    }

    fn remote_device(handle: HANDLE) -> (RemoteDevice, i32) {
        let mut info = FILE_FS_DEVICE_INFORMATION::default();
        let mut status_block = IO_STATUS_BLOCK::default();
        // SAFETY: `info` is a writable FILE_FS_DEVICE_INFORMATION and its exact size is passed.
        let status = unsafe {
            NtQueryVolumeInformationFile(
                handle,
                &mut status_block,
                (&mut info as *mut FILE_FS_DEVICE_INFORMATION).cast(),
                std::mem::size_of::<FILE_FS_DEVICE_INFORMATION>() as u32,
                FileFsDeviceInformation,
            )
        };
        let answer = if status < 0 {
            RemoteDevice::QueryFailed
        } else if info.Characteristics & FILE_REMOTE_DEVICE != 0 {
            RemoteDevice::Set
        } else {
            RemoteDevice::Clear
        };
        (answer, status)
    }

    fn remote_protocol(handle: HANDLE) -> (RemoteProtocol, u32) {
        // SAFETY: an all-zero FILE_REMOTE_PROTOCOL_INFO is a valid value of this plain-data struct.
        let mut info: FILE_REMOTE_PROTOCOL_INFO = unsafe { std::mem::zeroed() };
        // SAFETY: `info` is writable and its exact size is passed.
        let ok = unsafe {
            GetFileInformationByHandleEx(
                handle,
                FileRemoteProtocolInfo,
                (&mut info as *mut FILE_REMOTE_PROTOCOL_INFO).cast(),
                std::mem::size_of::<FILE_REMOTE_PROTOCOL_INFO>() as u32,
            )
        };
        let answered = ok != 0;
        // SAFETY: reads this thread's last-error value, set by the failed call above; unused on success.
        let error = if answered { 0 } else { unsafe { GetLastError() } };
        (remote_protocol_from_query(answered, error), error)
    }

    /// `FILE_FS_DRIVER_PATH_INFORMATION`: `BOOLEAN DriverInPath` at 0, `ULONG DriverNameLength` (bytes)
    /// at 4, `WCHAR DriverName[]` at 8. The caller writes the name first; the buffer is 8-byte aligned.
    fn driver_in_path(handle: HANDLE, driver: &str) -> (DriverPath, i32) {
        let name: Vec<u16> = driver.encode_utf16().collect();
        let name_bytes = name.len() * 2;
        let mut buffer = vec![0u64; (8 + name_bytes).div_ceil(8)];
        let bytes = buffer.as_mut_ptr().cast::<u8>();
        // SAFETY: `buffer` spans 8 + name_bytes bytes, is 8-byte aligned, and every write stays inside it.
        unsafe {
            bytes.add(4).cast::<u32>().write(name_bytes as u32);
            std::ptr::copy_nonoverlapping(name.as_ptr(), bytes.add(8).cast::<u16>(), name.len());
        }
        let mut status_block = IO_STATUS_BLOCK::default();
        // SAFETY: the buffer pointer and its byte length describe the allocation above.
        let status = unsafe {
            NtQueryVolumeInformationFile(
                handle,
                &mut status_block,
                bytes.cast(),
                (buffer.len() * 8) as u32,
                FileFsDriverPathInformation,
            )
        };
        // SAFETY: byte 0 is inside the buffer; the call wrote the BOOLEAN there on success and it is
        // still the zero it was allocated with otherwise.
        let in_path = unsafe { bytes.read() } != 0;
        (driver_path_from_query(status, status >= 0 && in_path), status)
    }
}
