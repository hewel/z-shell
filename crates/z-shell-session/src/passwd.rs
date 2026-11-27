//! Thread-safe effective-UID and NSS `getpwuid_r` account resolution.

/// Returns the effective Unix user ID of the current process on Linux.
#[must_use]
pub(crate) fn effective_uid() -> Option<u32> {
    #[cfg(target_os = "linux")]
    {
        Some(linux::effective_uid())
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

/// Resolves the canonical login username owning the current process's effective UID.
pub(crate) fn resolve_effective_username() -> Result<String, String> {
    #[cfg(target_os = "linux")]
    {
        linux::resolve_username_by_uid(linux::effective_uid())
    }
    #[cfg(not(target_os = "linux"))]
    {
        Err("effective-UID account lookup is only supported on Linux".to_owned())
    }
}

/// Resolves a numeric UID to its login username via thread-safe `getpwuid_r`.
pub(crate) fn resolve_username_by_uid(uid: u32) -> Result<String, String> {
    #[cfg(target_os = "linux")]
    {
        linux::resolve_username_by_uid(uid)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = uid;
        Err("UID account lookup via getpwuid_r is only supported on Linux".to_owned())
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use std::ffi::{CStr, c_char, c_int};
    use std::io;
    use std::ptr;
    use zeroize::Zeroizing;

    const ERANGE: c_int = 34;
    const INITIAL_PWBUF_LEN: usize = 4096;
    const MAX_PWBUF_LEN: usize = 1024 * 1024;

    #[repr(C)]
    struct Passwd {
        pw_name: *mut c_char,
        pw_passwd: *mut c_char,
        pw_uid: u32,
        pw_gid: u32,
        pw_gecos: *mut c_char,
        pw_dir: *mut c_char,
        pw_shell: *mut c_char,
    }

    unsafe extern "C" {
        fn geteuid() -> u32;
        fn getpwuid_r(
            uid: u32,
            pwd: *mut Passwd,
            buf: *mut c_char,
            buflen: usize,
            result: *mut *mut Passwd,
        ) -> c_int;
    }

    pub(super) fn effective_uid() -> u32 {
        // SAFETY: `geteuid` has no preconditions and is thread-safe on Linux.
        unsafe { geteuid() }
    }

    pub(super) fn resolve_username_by_uid(uid: u32) -> Result<String, String> {
        let mut buf_len = INITIAL_PWBUF_LEN;
        loop {
            let mut buffer = Zeroizing::new(vec![0_u8; buf_len]);
            let mut pwd = Passwd {
                pw_name: ptr::null_mut(),
                pw_passwd: ptr::null_mut(),
                pw_uid: 0,
                pw_gid: 0,
                pw_gecos: ptr::null_mut(),
                pw_dir: ptr::null_mut(),
                pw_shell: ptr::null_mut(),
            };
            let mut result: *mut Passwd = ptr::null_mut();
            // SAFETY: `pwd`, `buffer`, and `result` are uniquely owned valid storage outliving the
            // reentrant `getpwuid_r` call and the `CStr` read below.
            let status = unsafe {
                getpwuid_r(
                    uid,
                    &raw mut pwd,
                    buffer.as_mut_ptr().cast::<c_char>(),
                    buffer.len(),
                    &raw mut result,
                )
            };
            if status == 0 {
                if result.is_null() {
                    return Err(format!("no account entry found for uid {uid}"));
                }
                // SAFETY: When `getpwuid_r` returns 0 with non-null `result`, `(*result).pw_name`
                // points to a NUL-terminated string stored inside `buffer`.
                let name_ptr = unsafe { (*result).pw_name };
                if name_ptr.is_null() {
                    return Err(format!("passwd entry for uid {uid} has a null username"));
                }
                // SAFETY: `name_ptr` is NUL-terminated and backed by `buffer` for this scope.
                let raw_name = unsafe { CStr::from_ptr(name_ptr) };
                let username = raw_name
                    .to_str()
                    .map_err(|_| format!("passwd username for uid {uid} is not valid UTF-8"))?;
                if username.is_empty() {
                    return Err(format!("passwd username for uid {uid} is empty"));
                }
                return Ok(username.to_owned());
            }
            if status == ERANGE && buf_len < MAX_PWBUF_LEN {
                buf_len = (buf_len * 2).min(MAX_PWBUF_LEN);
                continue;
            }
            return Err(format!(
                "getpwuid_r({uid}) failed: {}",
                io::Error::from_raw_os_error(status)
            ));
        }
    }
}
