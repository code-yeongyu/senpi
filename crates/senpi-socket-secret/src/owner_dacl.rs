//! The Windows meaning of "0600" in the #4199 design (4.5): a protected DACL granting full access to
//! the current user, SYSTEM and Administrators only, with no inherited ACEs. It is applied when the
//! staging file is created, before any byte is written.

#[cfg(windows)]
pub use windows_dacl::OwnerOnlyDescriptor;

#[cfg(windows)]
mod windows_dacl {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, LocalFree, HANDLE};
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    pub struct OwnerOnlyDescriptor(PSECURITY_DESCRIPTOR);

    impl OwnerOnlyDescriptor {
        /// `D:P` marks the DACL protected, so no ACE is inherited from the parent directory.
        pub fn for_current_user() -> Result<Self, u32> {
            let user = current_user_sid_string()?;
            let sddl: Vec<u16> = format!("D:P(A;;FA;;;{user})(A;;FA;;;SY)(A;;FA;;;BA)")
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();
            let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
            // SAFETY: `sddl` is NUL-terminated; `descriptor` receives a LocalAlloc'd pointer freed in Drop.
            let ok = unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl.as_ptr(),
                    SDDL_REVISION_1,
                    &mut descriptor,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 {
                // SAFETY: reads this thread's last-error value, set by the failed conversion above.
                return Err(unsafe { GetLastError() });
            }
            Ok(Self(descriptor))
        }

        pub const fn as_ptr(&self) -> PSECURITY_DESCRIPTOR {
            self.0
        }
    }

    impl Drop for OwnerOnlyDescriptor {
        fn drop(&mut self) {
            // SAFETY: the pointer came from ConvertStringSecurityDescriptorToSecurityDescriptorW.
            unsafe { LocalFree(self.0.cast()) };
        }
    }

    struct TokenHandle(HANDLE);

    impl Drop for TokenHandle {
        fn drop(&mut self) {
            // SAFETY: the handle came from a successful OpenProcessToken and is closed exactly once.
            unsafe { CloseHandle(self.0) };
        }
    }

    /// The process token's user SID in `S-1-...` form.
    fn current_user_sid_string() -> Result<String, u32> {
        let mut raw: HANDLE = std::ptr::null_mut();
        // SAFETY: GetCurrentProcess returns a pseudo-handle; `raw` is a writable HANDLE slot.
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) } == 0 {
            // SAFETY: reads this thread's last-error value.
            return Err(unsafe { GetLastError() });
        }
        let token = TokenHandle(raw);
        let mut buffer = vec![0u64; 32];
        let mut needed = 0u32;
        // SAFETY: `buffer` is 8-byte aligned and writable for the byte length passed.
        let ok = unsafe {
            GetTokenInformation(
                token.0,
                TokenUser,
                buffer.as_mut_ptr().cast(),
                (buffer.len() * 8) as u32,
                &mut needed,
            )
        };
        if ok == 0 {
            // SAFETY: reads this thread's last-error value.
            return Err(unsafe { GetLastError() });
        }
        // SAFETY: on success the buffer starts with a TOKEN_USER whose SID points into the same buffer.
        let sid = unsafe { (*buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid };
        let mut text: *mut u16 = std::ptr::null_mut();
        // SAFETY: `sid` is valid while `buffer` lives; `text` receives a LocalAlloc'd string freed below.
        if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
            // SAFETY: reads this thread's last-error value.
            return Err(unsafe { GetLastError() });
        }
        // SAFETY: `text` is a NUL-terminated wide string from ConvertSidToStringSidW.
        let length = (0..)
            .take_while(|&index| unsafe { *text.add(index) } != 0)
            .count();
        // SAFETY: `length` units were just read from the same allocation.
        let result =
            String::from_utf16(unsafe { std::slice::from_raw_parts(text, length) }).map_err(|_| 0u32);
        // SAFETY: `text` came from ConvertSidToStringSidW and is freed exactly once.
        unsafe { LocalFree(text.cast()) };
        result
    }
}
