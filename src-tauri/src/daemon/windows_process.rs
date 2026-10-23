//! Targeted Windows process observations. No Toolhelp/global PID enumeration and
//! no remote PEB pointer reads: the OS returns native-width query structures.

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ProcessIdentity {
    pub pid: u32,
    pub parent: Option<u32>,
    /// Full FILETIME precision is retained while validating ancestor relations.
    pub created_at: u64,
    pub started_at: u64,
    pub executable: String,
    pub command: Vec<String>,
    /// Parent/birth are known, but access to the executable/argv may be denied.
    pub command_available: bool,
}

const WINDOWS_EPOCH_TICKS: u64 = 116_444_736_000_000_000;
const MAX_QUERY_BYTES: usize = 128 * 1024;

fn unix_start_time(created_at: u64) -> Option<u64> {
    created_at
        .checked_sub(WINDOWS_EPOCH_TICKS)
        .map(|ticks| ticks / 10_000_000)
}

/// Validate the pointer as an offset into the returned local query buffer before
/// forming any slice. The kernel's UNICODE_STRING need not be NUL terminated.
fn command_range(
    base: usize,
    returned_bytes: usize,
    header_bytes: usize,
    pointer: usize,
    length: usize,
    maximum_length: usize,
) -> Option<std::ops::Range<usize>> {
    if returned_bytes < header_bytes
        || returned_bytes > MAX_QUERY_BYTES
        || length % 2 != 0
        || maximum_length % 2 != 0
        || length > maximum_length
        || pointer % 2 != 0
    {
        return None;
    }
    if length == 0 {
        return Some(header_bytes..header_bytes);
    }
    let start = pointer.checked_sub(base)?;
    let end = start.checked_add(length)?;
    let maximum_end = start.checked_add(maximum_length)?;
    (start >= header_bytes && end <= returned_bytes && maximum_end <= returned_bytes)
        .then_some(start..end)
}

#[cfg(target_os = "windows")]
mod native {
    use super::*;
    use std::ffi::c_void;
    use std::mem::{size_of, MaybeUninit};
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, LocalFree, ERROR_INVALID_PARAMETER, ERROR_NOT_FOUND, FILETIME,
        HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
    use windows_sys::Win32::System::Threading::{
        GetProcessId, GetProcessTimes, OpenProcess, QueryFullProcessImageNameW,
        WaitForSingleObject, PROCESS_QUERY_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SYNCHRONIZE,
    };
    use windows_sys::Win32::UI::Shell::CommandLineToArgvW;

    const PROCESS_BASIC_INFORMATION_CLASS: u32 = 0;
    // Windows WDK PROCESSINFOCLASS, also used by sysinfo's Windows reader.
    const PROCESS_COMMAND_LINE_INFORMATION_CLASS: u32 = 60;
    type NtQuery = unsafe extern "system" fn(HANDLE, u32, *mut c_void, u32, *mut u32) -> i32;

    #[repr(C)]
    struct BasicInformation {
        exit_status: i32,
        peb_address: *mut c_void,
        affinity: usize,
        base_priority: i32,
        pid: usize,
        parent: usize,
    }

    #[repr(C)]
    struct UnicodeString {
        length: u16,
        maximum_length: u16,
        buffer: *const u16,
    }

    // Both query classes describe the caller's native layout, including WOW64
    // targets; no target-width PEB/RTL_USER_PROCESS_PARAMETERS is dereferenced.
    const _: () = {
        assert!(size_of::<BasicInformation>() == 6 * size_of::<usize>());
        assert!(std::mem::offset_of!(BasicInformation, parent) == 5 * size_of::<usize>());
        assert!(size_of::<UnicodeString>() == 2 * size_of::<usize>());
        assert!(std::mem::offset_of!(UnicodeString, buffer) == size_of::<usize>());
    };

    struct ProcessHandle(HANDLE);
    impl Drop for ProcessHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    fn query_function() -> Option<NtQuery> {
        static QUERY: OnceLock<Option<NtQuery>> = OnceLock::new();
        *QUERY.get_or_init(|| unsafe {
            // ntdll is already loaded. This borrowed module handle is not freed.
            let module = GetModuleHandleW(windows_sys::core::w!("ntdll.dll"));
            if module.is_null() {
                return None;
            }
            let symbol =
                GetProcAddress(module, windows_sys::core::s!("NtQueryInformationProcess"))?;
            Some(std::mem::transmute::<
                unsafe extern "system" fn() -> isize,
                NtQuery,
            >(symbol))
        })
    }

    fn running(handle: HANDLE) -> Result<bool, ()> {
        match unsafe { WaitForSingleObject(handle, 0) } {
            WAIT_TIMEOUT => Ok(true),
            WAIT_OBJECT_0 => Ok(false),
            _ => Err(()),
        }
    }

    fn created_at(handle: HANDLE) -> Result<u64, ()> {
        let mut creation = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        if unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) } == 0
        {
            return Err(());
        }
        Ok((u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime))
    }

    fn basic(query: NtQuery, handle: HANDLE, pid: u32) -> Result<BasicInformation, ()> {
        let mut info = MaybeUninit::<BasicInformation>::uninit();
        let mut returned = 0;
        let status = unsafe {
            query(
                handle,
                PROCESS_BASIC_INFORMATION_CLASS,
                info.as_mut_ptr().cast(),
                size_of::<BasicInformation>() as u32,
                &mut returned,
            )
        };
        if status < 0 || returned as usize != size_of::<BasicInformation>() {
            return Err(());
        }
        let info = unsafe { info.assume_init() };
        if info.pid != pid as usize || unsafe { GetProcessId(handle) } != pid {
            return Err(());
        }
        Ok(info)
    }

    fn executable(handle: HANDLE) -> Result<String, ()> {
        // Win32's maximum extended path is 32767 UTF-16 units plus a terminator.
        let mut buffer = vec![0u16; 32768];
        let mut length = buffer.len() as u32;
        if unsafe { QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut length) } == 0
            || length == 0
            || length as usize >= buffer.len()
        {
            return Err(());
        }
        Ok(String::from_utf16_lossy(&buffer[..length as usize]))
    }

    fn command_line(query: NtQuery, handle: HANDLE) -> Result<Vec<u16>, ()> {
        let mut required = 0u32;
        unsafe {
            query(
                handle,
                PROCESS_COMMAND_LINE_INFORMATION_CLASS,
                std::ptr::null_mut(),
                0,
                &mut required,
            );
        }
        for _ in 0..3 {
            let length = required as usize;
            if !(size_of::<UnicodeString>()..=MAX_QUERY_BYTES).contains(&length) {
                return Err(());
            }
            // usize allocation guarantees alignment for the native-width header.
            let mut words = vec![0usize; length.div_ceil(size_of::<usize>())];
            let capacity = words.len() * size_of::<usize>();
            let mut returned = 0u32;
            let status = unsafe {
                query(
                    handle,
                    PROCESS_COMMAND_LINE_INFORMATION_CLASS,
                    words.as_mut_ptr().cast(),
                    capacity as u32,
                    &mut returned,
                )
            };
            if status < 0 {
                if returned as usize > capacity && returned as usize <= MAX_QUERY_BYTES {
                    required = returned;
                    continue;
                }
                return Err(());
            }
            if returned as usize > capacity || (returned as usize) < size_of::<UnicodeString>() {
                return Err(());
            }
            let header = unsafe { &*words.as_ptr().cast::<UnicodeString>() };
            let range = command_range(
                words.as_ptr() as usize,
                returned as usize,
                size_of::<UnicodeString>(),
                header.buffer as usize,
                header.length as usize,
                header.maximum_length as usize,
            )
            .ok_or(())?;
            let bytes = unsafe {
                std::slice::from_raw_parts(words.as_ptr().cast::<u8>(), returned as usize)
            };
            let line: Vec<u16> = bytes[range]
                .chunks_exact(2)
                .map(|pair| u16::from_ne_bytes([pair[0], pair[1]]))
                .collect();
            // An embedded NUL would make CommandLineToArgvW silently ignore a tail.
            if line.contains(&0) {
                return Err(());
            }
            return Ok(line);
        }
        Err(())
    }

    fn argv(mut line: Vec<u16>) -> Result<Vec<String>, ()> {
        if line.is_empty() {
            return Ok(Vec::new());
        }
        let max_chars = line.len();
        line.push(0);
        let mut count = 0i32;
        let pointers = unsafe { CommandLineToArgvW(line.as_ptr(), &mut count) };
        if pointers.is_null() {
            return Err(());
        }
        struct Arguments(*mut *mut u16);
        impl Drop for Arguments {
            fn drop(&mut self) {
                unsafe {
                    LocalFree(self.0.cast());
                }
            }
        }
        let _allocation = Arguments(pointers);
        if count < 0 || count as usize > max_chars + 1 {
            return Err(());
        }
        let mut result = Vec::with_capacity(count as usize);
        for pointer in unsafe { std::slice::from_raw_parts(pointers, count as usize) } {
            if pointer.is_null() {
                return Err(());
            }
            // The OS parser owns valid NUL-terminated strings in this allocation;
            // each argument can be no longer than the source command line.
            let mut length = 0;
            while length <= max_chars && unsafe { *pointer.add(length) } != 0 {
                length += 1;
            }
            if length > max_chars {
                return Err(());
            }
            result.push(String::from_utf16_lossy(unsafe {
                std::slice::from_raw_parts(*pointer, length)
            }));
        }
        Ok(result)
    }

    pub(crate) struct Observation {
        handle: ProcessHandle,
        pub identity: ProcessIdentity,
    }

    impl Observation {
        pub fn still_current(&self) -> Result<bool, ()> {
            Ok(running(self.handle.0)?
                && created_at(self.handle.0)? == self.identity.created_at
                && unsafe { GetProcessId(self.handle.0) } == self.identity.pid)
        }
    }

    pub(crate) fn observe(pid: u32) -> Result<Option<Observation>, ()> {
        if pid == 0 {
            return Ok(None);
        }
        let mut handle =
            unsafe { OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_SYNCHRONIZE, 0, pid) };
        if handle.is_null() {
            handle = unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                    0,
                    pid,
                )
            };
        }
        if handle.is_null() {
            return match unsafe { GetLastError() } {
                ERROR_INVALID_PARAMETER | ERROR_NOT_FOUND => Ok(None),
                _ => Err(()),
            };
        }
        let handle = ProcessHandle(handle);
        if !running(handle.0)? {
            return Ok(None);
        }
        let query = query_function().ok_or(())?;
        let before = created_at(handle.0)?;
        let info = basic(query, handle.0, pid)?;
        let executable = executable(handle.0);
        let command = command_line(query, handle.0).and_then(argv);
        if !running(handle.0)? {
            return Ok(None);
        }
        let command_available = executable.is_ok() && command.is_ok();
        let after = basic(query, handle.0, pid)?;
        if before != created_at(handle.0)? || info.parent != after.parent {
            return Err(());
        }
        let parent = u32::try_from(after.parent).map_err(|_| ())?;
        Ok(Some(Observation {
            handle,
            identity: ProcessIdentity {
                pid,
                parent: (parent > 0 && parent != pid).then_some(parent),
                created_at: before,
                started_at: unix_start_time(before).ok_or(())?,
                executable: executable.unwrap_or_default(),
                command: command.unwrap_or_default(),
                command_available,
            },
        }))
    }
}

#[cfg(target_os = "windows")]
pub(super) use native::observe;

/// Keep every handle open until the whole batch is checked. A PID cannot be
/// recycled underneath an ancestor while another process is being queried.
#[cfg(target_os = "windows")]
pub(super) fn observe_all(pids: &[u32]) -> Result<Vec<ProcessIdentity>, ()> {
    let observations: Vec<_> = pids
        .iter()
        .map(|&pid| observe(pid))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .flatten()
        .collect();
    let current = observations
        .iter()
        .map(|observation| observation.still_current())
        .collect::<Result<Vec<_>, _>>()?;
    // Only move command/executable buffers after every handle was rechecked.
    Ok(observations
        .into_iter()
        .zip(current)
        .filter_map(|(observation, current)| current.then_some(observation.identity))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filetime_preserves_unix_epoch_and_rejects_invalid_births() {
        assert_eq!(unix_start_time(WINDOWS_EPOCH_TICKS - 1), None);
        assert_eq!(unix_start_time(WINDOWS_EPOCH_TICKS + 12_345_678), Some(1));
    }

    #[test]
    fn native_string_offsets_reject_truncation_alignment_and_foreign_pointers() {
        assert_eq!(command_range(0x1000, 64, 16, 0x1010, 12, 14), Some(16..28));
        for (returned, pointer, length, maximum) in [
            (15, 0x1010, 12, 14),
            (64, 0x1008, 12, 14),
            (64, 0x2000, 12, 14),
            (64, 0x1011, 12, 14),
            (64, 0x1010, 13, 14),
            (64, 0x1010, 12, 10),
            (64, 0x1030, 12, 18),
        ] {
            assert!(command_range(0x1000, returned, 16, pointer, length, maximum).is_none());
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn native_reader_inspects_current_process_without_enumeration() {
        let observation = observe(std::process::id()).unwrap().unwrap();
        assert_eq!(observation.identity.pid, std::process::id());
        assert!(observation.identity.started_at > 0);
        assert!(!observation.identity.executable.is_empty());
        assert!(!observation.identity.command.is_empty());
        assert!(observation.still_current().unwrap());
    }
}
