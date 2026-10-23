//! PTY 守护进程（Issue #123 Phase 2）。
//!
//! 生命周期与手动验证见 `docs/pty-daemon-manual.md`：
//! - UI 进程是客户端，daemon 持有 PTY 会话与 scrollback，应用退出后任务续跑；
//! - 仅监听 127.0.0.1，首帧 token 鉴权，NDJSON 帧；
//! - 无会话且无客户端 10 分钟自灭，物理防孤儿（Job Object / 进程组）。

pub(crate) mod agent_recognition;
mod agent_tracker;
#[cfg(any(target_os = "windows", test))]
mod agent_refresh;
#[cfg(any(target_os = "windows", test))]
mod windows_process;
pub mod client;
pub mod discovery;
pub mod protocol;
pub mod server;
mod ssh_agent_bridge;

#[cfg(target_os = "windows")]
static GOVERNANCE_JOB: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

#[cfg(target_os = "windows")]
fn governed_process_ids() -> Option<Vec<sysinfo::Pid>> {
    use std::sync::atomic::Ordering;
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_MORE_DATA, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        JobObjectBasicProcessIdList, QueryInformationJobObject, JOBOBJECT_BASIC_PROCESS_ID_LIST,
    };
    let job = GOVERNANCE_JOB.load(Ordering::Acquire) as HANDLE;
    if job.is_null() {
        return None;
    }
    let mut capacity = 64;
    loop {
        // usize storage preserves the flexible structure's pointer alignment.
        let mut buffer = vec![0usize; capacity + 2];
        let bytes = u32::try_from(buffer.len() * std::mem::size_of::<usize>()).ok()?;
        let ok = unsafe {
            QueryInformationJobObject(
                job,
                JobObjectBasicProcessIdList,
                buffer.as_mut_ptr().cast(),
                bytes,
                std::ptr::null_mut(),
            )
        };
        if ok != 0 {
            let info = unsafe { &*buffer.as_ptr().cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>() };
            let count = info.NumberOfProcessIdsInList as usize;
            if count <= capacity && info.NumberOfAssignedProcesses == info.NumberOfProcessIdsInList
            {
                // The Win32 flexible array occupies the remaining aligned storage.
                let ids = unsafe { std::slice::from_raw_parts(info.ProcessIdList.as_ptr(), count) };
                return ids
                    .iter()
                    .map(|pid| u32::try_from(*pid).ok().map(sysinfo::Pid::from_u32))
                    .collect();
            }
        } else if unsafe { GetLastError() } != ERROR_MORE_DATA {
            return None;
        }
        capacity = capacity.checked_mul(2)?;
        if capacity > 65_536 {
            return None;
        }
    }
}

/// 进程治理兜底（契约★）：Windows 上把 daemon 自身挂进
/// `KILL_ON_JOB_CLOSE` 的 Job Object——之后 daemon 创建的全部 PTY 子进程
/// 自动进入同一 Job，daemon 无论正常退出还是被强杀，系统都会回收整棵
/// 子进程树，物理杜绝 PTY 孤儿。非 Windows 平台为 no-op（PTY 子进程随
/// 会话关闭由平台 PTY 控制器回收；daemon 自身 detach 由拉起方处理）。
pub fn setup_process_governance() {
    #[cfg(target_os = "windows")]
    unsafe {
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        use windows_sys::Win32::System::Threading::GetCurrentProcess;

        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            log::warn!("daemon job object create failed, orphan protection disabled");
            return;
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if ok == 0 {
            log::warn!("daemon job object configure failed, orphan protection disabled");
            return;
        }
        if AssignProcessToJobObject(job, GetCurrentProcess()) == 0 {
            log::warn!("daemon job object assign failed, orphan protection disabled");
            return;
        }
        GOVERNANCE_JOB.store(job as usize, std::sync::atomic::Ordering::Release);
        // 故意不 CloseHandle：Job 句柄与 daemon 进程同生共死，
        // 进程终止时句柄关闭触发 KILL_ON_JOB_CLOSE 清理全部子进程。
        log::debug!("daemon job object active (kill-on-close)");
    }
}
