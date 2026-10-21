//! WebKit XPC services on macOS are parented by launchd, not the app.
//! Only claim a WebKit service when the OS identifies this app as responsible.
/// A recorded parent PID may now belong to a different process on Windows.
/// Equal timestamps are valid because sysinfo exposes whole seconds.
pub fn parent_precedes_child(child_started_at: u64, parent_started_at: u64) -> bool {
    parent_started_at > 0 && child_started_at >= parent_started_at
}

pub fn parent_pid(system: &sysinfo::System, pid: sysinfo::Pid) -> Option<u32> {
    let child = system.process(pid)?;
    let parent = child.parent()?;
    let parent_process = system.process(parent)?;
    (parent != pid && parent_precedes_child(child.start_time(), parent_process.start_time()))
        .then_some(parent.as_u32())
}

pub fn is_webview(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.contains("webview") || name.contains("webkit")
}

pub fn is_app_webkit(pid: u32, name: &str, app_pid: u32) -> bool {
    is_webview(name) && responsible_pid(pid) == Some(app_pid)
}

#[cfg(target_os = "macos")]
fn responsible_pid(pid: u32) -> Option<u32> {
    use std::sync::OnceLock;
    type Query = unsafe extern "C" fn(i32) -> i32;
    static QUERY: OnceLock<Option<Query>> = OnceLock::new();
    let query = QUERY.get_or_init(|| unsafe {
        // Not present in every system SDK. Resolve at runtime and leave the
        // process unclaimed if the OS does not expose the query.
        let symbol = nix::libc::dlsym(
            nix::libc::RTLD_DEFAULT,
            b"responsibility_get_pid_responsible_for_pid\0"
                .as_ptr()
                .cast(),
        );
        (!symbol.is_null()).then(|| std::mem::transmute::<*mut nix::libc::c_void, Query>(symbol))
    });
    let pid = i32::try_from(pid).ok()?;
    let owner = unsafe { query.as_ref()?(pid) };
    (owner > 0).then_some(owner as u32)
}

#[cfg(not(target_os = "macos"))]
fn responsible_pid(_: u32) -> Option<u32> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parent_identity_rejects_pid_reuse_and_unknown_start_times() {
        assert!(parent_precedes_child(101, 100));
        assert!(parent_precedes_child(100, 100));
        assert!(!parent_precedes_child(100, 101));
        assert!(!parent_precedes_child(100, 0));
        assert!(!parent_precedes_child(0, 100));
    }
    #[test]
    fn recognizes_platform_renderer_names() {
        assert!(is_webview("com.apple.WebKit.WebContent"));
        assert!(is_webview("com.apple.WebKit.GPU"));
        assert!(is_webview("msedgewebview2.exe"));
        assert!(!is_webview("cli-manager"));
    }
    #[test]
    fn missing_process_is_not_claimed() {
        assert!(!is_app_webkit(
            u32::MAX,
            "com.apple.WebKit.WebContent",
            std::process::id()
        ));
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn reads_real_responsibility_without_privilege() {
        assert!(responsible_pid(std::process::id()).is_some());
    }
}
