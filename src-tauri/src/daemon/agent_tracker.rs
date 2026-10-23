//! Daemon-owned discovery, independent of visible panes and window focus.
use super::agent_recognition::identify_agent;
use super::protocol::{AgentIdentity, SessionMeta};
use std::collections::{HashMap, HashSet};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

#[derive(Clone)]
struct Process {
    parent: Option<u32>,
    started_at: u64,
    tool: Option<String>,
    foreground: Option<bool>,
    tool_unavailable: bool,
}

#[derive(Default)]
pub(super) struct AgentTracker {
    system: System,
    processes: HashMap<u32, Process>,
    candidates: HashSet<u32>,
    #[cfg(target_os = "windows")]
    managed_ids: Vec<u32>,
    #[cfg(test)]
    full_table_scans: usize,
    #[cfg(test)]
    hook_process_reads: usize,
}

impl AgentTracker {
    /// Failure is not evidence that an Agent exited. Keep the last observation.
    #[cfg(not(target_os = "windows"))]
    pub fn refresh(&mut self) -> bool {
        #[cfg(test)]
        self.record_scan(true, 0);
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().without_tasks(),
        );
        // Build the parent index once instead of walking every process's full
        // ancestry. Only daemon descendants need command/executable inspection.
        let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
        for &pid in self.system.processes().keys() {
            if let Some(parent) = crate::process_attribution::parent_pid(&self.system, pid) {
                children.entry(parent).or_default().push(pid.as_u32());
            }
        }
        let managed = descendants(&children, std::process::id());
        let managed_pids: Vec<_> = managed.iter().copied().map(Pid::from_u32).collect();
        #[cfg(test)]
        self.record_scan(false, 0);
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&managed_pids),
            true,
            command_refresh_kind(),
        );
        self.processes = observe_processes(&self.system, &managed);
        self.reindex_candidates();
        true
    }

    fn reindex_candidates(&mut self) {
        self.candidates = self
            .processes
            .iter()
            .filter_map(|(&pid, process)| {
                (process.tool.is_some() || process.tool_unavailable).then_some(pid)
            })
            .collect();
    }

    /// Normal Windows discovery only enumerates the daemon's Job. If Job
    /// governance is unavailable, the existing scheduled watchdog enumerates
    /// parent/PID metadata once; commands are still read by PID, never sysinfo.
    #[cfg(target_os = "windows")]
    pub fn refresh(&mut self) -> bool {
        let job_ids = super::governed_process_ids();
        let managed = if let Some(ids) = &job_ids {
            ids.iter().map(|pid| pid.as_u32()).collect::<Vec<_>>()
        } else {
            #[cfg(test)]
            self.record_scan(true, 0);
            self.system.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing().without_tasks(),
            );
            let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
            for &pid in self.system.processes().keys() {
                if let Some(parent) = crate::process_attribution::parent_pid(&self.system, pid) {
                    children.entry(parent).or_default().push(pid.as_u32());
                }
            }
            descendants(&children, std::process::id())
        };
        let Some((identities, managed)) = read_windows_scope(managed, job_ids.is_some(), |_| {})
        else {
            return false;
        };
        self.processes = windows_processes(&identities);
        self.managed_ids = managed;
        self.reindex_candidates();
        true
    }

    /// The caller supplies either a fresh Job list or a successful watchdog
    /// generation that started after this Hook arrived. Neither path enumerates
    /// the system process table on behalf of the Hook.
    #[cfg(target_os = "windows")]
    pub fn observe_windows_hook(
        &mut self,
        metas: &[SessionMeta],
        helper: Option<u32>,
        job_ids: Option<&[Pid]>,
    ) -> Option<Self> {
        let roots = metas.iter().filter(|meta| !is_remote(meta))
            .filter_map(|meta| meta.root_pid).collect::<Vec<_>>();
        let contains_origins = |scope: &[Pid]| roots.iter().any(|root| {
            hook_job_contains_origins(scope, *root, helper, std::process::id())
        });
        let ids = job_ids
            .map(|ids| ids.iter().map(|pid| pid.as_u32()).collect::<Vec<_>>())
            .unwrap_or_else(|| self.managed_ids.clone());
        let scope: Vec<_> = ids.iter().copied().map(Pid::from_u32).collect();
        if !contains_origins(&scope) {
            return None;
        }
        let (identities, sampled_ids) = read_windows_scope(ids, job_ids.is_some(), |count| {
            #[cfg(test)]
            {
                self.hook_process_reads += count;
            }
            #[cfg(not(test))]
            let _ = count;
        })?;
        let scope: Vec<_> = sampled_ids.iter().copied().map(Pid::from_u32).collect();
        if !contains_origins(&scope) {
            return None;
        }
        let mut observation = Self {
            processes: windows_processes(&identities),
            ..Self::default()
        };
        if let Some(helper) = helper {
            observation.processes.get(&helper)?;
        }
        observation.reindex_candidates();
        Some(observation)
    }

    /// macOS sysinfo also enumerates all PIDs for Some. Read each required
    /// process directly, including fresh argv/executable and foreground group.
    #[cfg(target_os = "macos")]
    pub fn observe_hook(&mut self, meta: &SessionMeta, helper: Option<u32>) -> Option<Self> {
        if is_remote(meta) {
            return None;
        }
        let root = meta.root_pid?;
        let mut processes = HashMap::new();
        let mut observed = HashSet::new();
        let mut pending = vec![root];
        pending.extend(helper);
        while let Some(pid) = pending.pop() {
            if pid == 0 || !observed.insert(pid) {
                continue;
            }
            #[cfg(test)]
            {
                self.hook_process_reads += 1;
            }
            let Some(process) = read_mac_process(pid).ok()? else {
                continue;
            };
            if pid != std::process::id() {
                pending.extend(process.parent);
            }
            processes.insert(pid, process);
        }
        // Enumerate siblings before accepting the helper branch. Once a live
        // outer Agent is found, its descendants cannot independently own a pane.
        pending.push(root);
        let mut visited = HashSet::new();
        while let Some(pid) = pending.pop() {
            if !visited.insert(pid) {
                continue;
            }
            if observed.insert(pid) {
                #[cfg(test)]
                {
                    self.hook_process_reads += 1;
                }
                if let Some(process) = read_mac_process(pid).ok()? {
                    processes.insert(pid, process);
                }
            }
            let Some(process) = processes.get(&pid) else {
                continue;
            };
            if process.tool.is_some() && process.foreground == Some(true) {
                continue;
            }
            pending.extend(child_pids(pid)?);
        }
        if let Some(pid) = helper {
            processes.get(&pid)?;
        }
        let mut observation = Self {
            processes,
            ..Self::default()
        };
        observation.reindex_candidates();
        Some(observation)
    }

    /// Each Hook gets fresh OS observations, never a TTL-based identity cache.
    /// The periodic index supplies candidate PIDs, not trusted identities. A new
    /// Agent's first Hook is discoverable through the waiting helper's ancestry.
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    pub fn observe_hook(&mut self, meta: &SessionMeta, helper: Option<u32>) -> Option<Self> {
        if is_remote(meta) {
            return None;
        }
        let root = meta.root_pid?;
        let mut pending: Vec<u32> = self
            .candidates
            .iter()
            .copied()
            .filter(|pid| self.belongs_to(*pid, root))
            .collect();
        pending.push(root);
        if let Some(agent) = meta.agent_detection.as_ref().and_then(|d| d.agent.as_ref()) {
            pending.push(agent.pid);
        }
        pending.extend(helper);
        let mut observed = HashSet::new();
        // A separate System cannot accidentally reuse an old parent's identity
        // when the helper or its ancestors exited since the background sample.
        let mut system = System::new();
        while !pending.is_empty() {
            pending.retain(|pid| *pid > 0 && observed.insert(*pid));
            if pending.is_empty() {
                break;
            }
            #[cfg(test)]
            self.record_scan(false, pending.len());
            let pids: Vec<_> = pending.iter().copied().map(Pid::from_u32).collect();
            system.refresh_processes_specifics(
                ProcessesToUpdate::Some(&pids),
                true,
                command_refresh_kind(),
            );
            pending = pids
                .iter()
                .filter_map(|pid| {
                    // Do not trust parent_pid until both ends have been refreshed.
                    let parent = system.process(*pid)?.parent()?.as_u32();
                    (*pid != Pid::from_u32(std::process::id())).then_some(parent)
                })
                .collect();
        }
        // Check the current pane's branches as well as the helper chain. A new
        // sibling Agent may not exist in the periodic candidate index yet.
        self.observe_pane_branches(root, &mut system, &mut observed)?;
        if let Some(pid) = helper {
            let process = system.process(Pid::from_u32(pid))?;
            if matches!(process.status(), sysinfo::ProcessStatus::Zombie) {
                return None;
            }
        }
        let mut observation = Self {
            processes: observe_processes(&system, &observed.into_iter().collect::<Vec<_>>()),
            ..Self::default()
        };
        observation.reindex_candidates();
        Some(observation)
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    fn observe_pane_branches(
        &mut self,
        root: u32,
        system: &mut System,
        observed: &mut HashSet<u32>,
    ) -> Option<()> {
        let mut pending = vec![root];
        let mut visited = HashSet::new();
        while let Some(pid) = pending.pop() {
            if !visited.insert(pid) {
                continue;
            }
            if observed.insert(pid) {
                #[cfg(test)]
                self.record_scan(false, 1);
                system.refresh_processes_specifics(
                    ProcessesToUpdate::Some(&[Pid::from_u32(pid)]),
                    true,
                    command_refresh_kind(),
                );
            }
            let Some(process) = system.process(Pid::from_u32(pid)) else {
                continue;
            };
            let command: Vec<_> = process
                .cmd()
                .iter()
                .map(|s| s.to_string_lossy().into_owned())
                .collect();
            let tool = identify_agent(
                &process
                    .exe()
                    .map(|p| p.as_os_str())
                    .unwrap_or(process.name())
                    .to_string_lossy(),
                &command,
            )
            .or_else(|| identify_agent(&process.name().to_string_lossy(), &command));
            if tool.is_some() && foreground(pid, process.start_time())? {
                // All descendants collapse into this outer foreground Agent;
                // the separately observed helper chain still verifies its origin.
                continue;
            }
            pending.extend(child_pids(pid)?);
        }
        Some(())
    }

    #[cfg(test)]
    fn record_scan(&mut self, all: bool, hook_process_reads: usize) {
        // Count sysinfo's hidden Windows/macOS full PID enumeration for Some too.
        self.full_table_scans += usize::from(refresh_enumerates_process_table(
            all,
            cfg!(any(target_os = "windows", target_os = "macos")),
        ));
        self.hook_process_reads += hook_process_reads;
    }

    #[cfg(test)]
    pub fn scan_counts(&self) -> (usize, usize) {
        (self.full_table_scans, self.hook_process_reads)
    }

    pub fn belongs_to(&self, pid: u32, root: u32) -> bool {
        let mut current = pid;
        let mut visited = HashSet::new();
        while visited.insert(current) {
            if current == root {
                return true;
            }
            let Some(child) = self.processes.get(&current) else {
                break;
            };
            let Some(parent) = child.parent else { break };
            let Some(parent_process) = self.processes.get(&parent) else {
                break;
            };
            if !crate::process_attribution::parent_precedes_child(
                child.started_at,
                parent_process.started_at,
            ) {
                break;
            }
            current = parent;
        }
        false
    }

    /// None = unavailable / remote; Some(None) = confirmed foreground shell/no Agent.
    pub fn discover(
        &self,
        meta: &SessionMeta,
        daemon_pid: u32,
        now: u64,
    ) -> Option<Option<AgentIdentity>> {
        if is_remote(meta) {
            return None;
        }
        let root = meta.root_pid?;
        let process = self.processes.get(&root)?;
        if meta.root_started_at != Some(process.started_at) || !self.belongs_to(root, daemon_pid) {
            return None;
        }
        let mut candidates = Vec::new();
        for &pid in &self.candidates {
            let Some(process) = self.processes.get(&pid) else {
                continue;
            };
            if !self.belongs_to(pid, root) {
                continue;
            }
            // Ignore nested agents and launcher/native-child duplicates: the outer Agent owns the pane.
            let mut parent = if pid == root { None } else { process.parent };
            let mut nested = false;
            let mut visited = HashSet::new();
            while let Some(id) = parent.filter(|id| visited.insert(*id)) {
                let Some(ancestor) = self.processes.get(&id) else {
                    break;
                };
                if ancestor.tool.is_some() && ancestor.foreground == Some(true) {
                    nested = true;
                    break;
                }
                if id == root {
                    break;
                }
                parent = ancestor.parent;
            }
            if nested {
                continue;
            }
            // Only an unowned branch in this pane can make its identity unknown.
            // An inaccessible helper below a confirmed outer Agent is not an
            // independent owner, nor is an inaccessible process in another pane.
            if process.tool_unavailable {
                return None;
            }
            if process.foreground? && process.tool.is_some() {
                candidates.push((pid, process));
            }
        }
        match candidates.as_slice() {
            [] => Some(None),
            [(pid, process)] => Some(Some(AgentIdentity {
                tool: process.tool.clone().unwrap(),
                pid: *pid,
                started_at: process.started_at,
                run_id: format!("{pid}:{}", process.started_at),
                detected_at_ms: now,
                cli_session_id: None,
            })),
            // Multiple independent Agents in one console are ambiguous.
            _ => None,
        }
    }
}

#[cfg(target_os = "windows")]
fn read_windows_scope(
    ids: Vec<u32>,
    require_job: bool,
    did_read: impl FnMut(usize),
) -> Option<(Vec<super::windows_process::ProcessIdentity>, Vec<u32>)> {
    read_windows_scope_with(
        ids,
        require_job,
        super::windows_process::observe_all,
        || {
            Some(
                super::governed_process_ids()?
                    .iter()
                    .map(|pid| pid.as_u32())
                    .collect(),
            )
        },
        did_read,
    )
}

#[cfg(any(test, target_os = "windows"))]
fn read_windows_scope_with(
    mut ids: Vec<u32>,
    require_job: bool,
    mut read: impl FnMut(&[u32]) -> Result<Vec<super::windows_process::ProcessIdentity>, ()>,
    mut members: impl FnMut() -> Option<Vec<u32>>,
    mut did_read: impl FnMut(usize),
) -> Option<(Vec<super::windows_process::ProcessIdentity>, Vec<u32>)> {
    for attempt in 0..2 {
        did_read(ids.len());
        let identities = read(&ids).ok()?;
        if require_job {
            let current = members()?;
            if ids.iter().copied().collect::<HashSet<_>>()
                != current.iter().copied().collect::<HashSet<_>>()
            {
                // One short-lived process in another pane should not discard a
                // valid Hook. Resample once, including all fresh sibling births.
                if attempt == 0 {
                    ids = current;
                    continue;
                }
                return None;
            }
        }
        return Some((identities, ids));
    }
    None
}

#[cfg(any(test, target_os = "windows"))]
fn windows_processes(
    identities: &[super::windows_process::ProcessIdentity],
) -> HashMap<u32, Process> {
    let births: HashMap<_, _> = identities.iter().map(|p| (p.pid, p.created_at)).collect();
    identities
        .iter()
        .map(|identity| {
            let parent = identity.parent.filter(|pid| {
                births
                    .get(pid)
                    .is_some_and(|birth| *birth <= identity.created_at)
            });
            let tool = identify_agent(&identity.executable, &identity.command)
                .map(str::to_ascii_lowercase);
            (
                identity.pid,
                Process {
                    parent,
                    started_at: identity.started_at,
                    tool_unavailable: !identity.command_available && tool.is_none(),
                    tool,
                    // ConPTY has no Unix foreground groups; independent Agents remain ambiguous.
                    foreground: Some(true),
                },
            )
        })
        .collect()
}

#[cfg(any(test, target_os = "windows"))]
fn hook_job_contains_origins(ids: &[Pid], root: u32, helper: Option<u32>, daemon: u32) -> bool {
    [Some(root), helper, Some(daemon)]
        .into_iter()
        .flatten()
        .all(|pid| ids.contains(&Pid::from_u32(pid)))
}

#[cfg(test)]
fn refresh_enumerates_process_table(all: bool, platform_enumerates_some: bool) -> bool {
    all || platform_enumerates_some
}

fn is_remote(meta: &SessionMeta) -> bool {
    matches!(meta.environment_type.as_deref(), Some("ssh" | "wsl"))
        || meta
            .shell
            .as_deref()
            .is_some_and(|s| s.to_ascii_lowercase().contains("wsl"))
}

fn command_refresh_kind() -> ProcessRefreshKind {
    ProcessRefreshKind::nothing()
        .with_cmd(UpdateKind::Always)
        .with_exe(UpdateKind::Always)
        .without_tasks()
}

fn descendants(children: &HashMap<u32, Vec<u32>>, root: u32) -> Vec<u32> {
    let mut pending = vec![root];
    let mut visited = HashSet::new();
    let mut result = Vec::new();
    while let Some(pid) = pending.pop() {
        if !visited.insert(pid) {
            continue;
        }
        result.push(pid);
        if let Some(children) = children.get(&pid) {
            pending.extend(children);
        }
    }
    result
}

fn observe_processes(system: &System, pids: &[u32]) -> HashMap<u32, Process> {
    let mut result = HashMap::new();
    for &pid in pids {
        let Some(process) = system.process(Pid::from_u32(pid)) else {
            continue;
        };
        let command: Vec<_> = process
            .cmd()
            .iter()
            .map(|s| s.to_string_lossy().into_owned())
            .collect();
        let tool = identify_agent(
            &process
                .exe()
                .map(|path| path.as_os_str())
                .unwrap_or(process.name())
                .to_string_lossy(),
            &command,
        )
        .or_else(|| identify_agent(&process.name().to_string_lossy(), &command))
        .map(str::to_ascii_lowercase);
        // Only Agent candidates need foreground-group checks. Shells and
        // helpers still participate in the start-time-validated ancestry chain.
        let foreground = if tool.is_some() {
            foreground(pid, process.start_time())
        } else {
            Some(false)
        };
        result.insert(
            pid,
            Process {
                parent: crate::process_attribution::parent_pid(system, Pid::from_u32(pid)),
                started_at: process.start_time(),
                tool,
                foreground,
                tool_unavailable: false,
            },
        );
    }
    result
}

#[cfg(target_os = "macos")]
fn child_pids(pid: u32) -> Option<Vec<u32>> {
    let pid = i32::try_from(pid).ok()?;
    let mut capacity = 32;
    loop {
        let mut children = vec![0i32; capacity];
        // proc_listchildpids returns a PID count, not the byte count used by
        // proc_listpids. Retry a full buffer so ambiguity cannot be truncated.
        let count = unsafe {
            nix::libc::proc_listchildpids(
                pid,
                children.as_mut_ptr().cast(),
                (children.len() * std::mem::size_of::<i32>()) as i32,
            )
        };
        if count < 0 {
            return None;
        }
        if (count as usize) < capacity {
            children.truncate(count as usize);
            return Some(
                children
                    .into_iter()
                    .filter(|pid| *pid > 0)
                    .map(|pid| pid as u32)
                    .collect(),
            );
        }
        capacity = capacity.checked_mul(2)?;
        if capacity > 65_536 {
            return None;
        }
    }
}

#[cfg(target_os = "linux")]
fn child_pids(pid: u32) -> Option<Vec<u32>> {
    let mut children = HashSet::new();
    // Children can be parented to any thread in a multithreaded launcher.
    for task in std::fs::read_dir(format!("/proc/{pid}/task")).ok()? {
        let task = task.ok()?;
        match std::fs::read_to_string(task.path().join("children")) {
            Ok(text) => {
                for child in text.split_whitespace() {
                    children.insert(child.parse().ok()?);
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return None,
        }
    }
    Some(children.into_iter().collect())
}

#[cfg(all(
    not(target_os = "windows"),
    not(any(target_os = "macos", target_os = "linux"))
))]
fn child_pids(_pid: u32) -> Option<Vec<u32>> {
    None
}

#[cfg(target_os = "macos")]
fn mac_bsd_info(pid: u32) -> Result<Option<nix::libc::proc_bsdinfo>, ()> {
    use nix::libc;
    let native_pid = i32::try_from(pid).map_err(|_| ())?;
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::uninit();
    let size = std::mem::size_of::<libc::proc_bsdinfo>();
    // SAFETY: only read the structure after the kernel filled its entire size.
    let read = unsafe {
        libc::proc_pidinfo(
            native_pid,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size as i32,
        )
    };
    if read != size as i32 {
        return match std::io::Error::last_os_error().raw_os_error() {
            Some(libc::ESRCH | libc::ENOENT) => Ok(None),
            _ => Err(()),
        };
    }
    let info = unsafe { info.assume_init() };
    if info.pbi_pid != pid {
        return Err(());
    }
    Ok((info.pbi_status != libc::SZOMB).then_some(info))
}

#[cfg(target_os = "macos")]
fn mac_command(pid: u32) -> Result<(String, Vec<String>), ()> {
    use nix::libc;
    let mut mib = [
        libc::CTL_KERN,
        libc::KERN_PROCARGS2,
        i32::try_from(pid).map_err(|_| ())?,
    ];
    let mut size = 0usize;
    // Query the bounded kernel buffer, then parse only argc arguments, never
    // environment strings. No process arguments are logged or persisted.
    if unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            std::ptr::null_mut(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    } != 0
        || !(4..=16 * 1024 * 1024).contains(&size)
    {
        return Err(());
    }
    let mut bytes = vec![0u8; size];
    if unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            bytes.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    } != 0
        || size > bytes.len()
    {
        return Err(());
    }
    bytes.truncate(size);
    parse_mac_command(&bytes).ok_or(())
}

#[cfg(any(test, target_os = "macos"))]
fn parse_mac_command(bytes: &[u8]) -> Option<(String, Vec<String>)> {
    let argc = i32::from_ne_bytes(bytes.get(..4)?.try_into().ok()?);
    if argc < 0 || argc as usize > bytes.len() {
        return None;
    }
    let remaining = bytes.get(4..)?;
    let executable_end = remaining.iter().position(|byte| *byte == 0)?;
    let executable = String::from_utf8_lossy(&remaining[..executable_end]).into_owned();
    let mut args = remaining.get(executable_end + 1..)?;
    while args.first() == Some(&0) {
        args = &args[1..];
    }
    let mut command = Vec::with_capacity(argc as usize);
    for _ in 0..argc {
        let end = args.iter().position(|byte| *byte == 0)?;
        command.push(String::from_utf8_lossy(&args[..end]).into_owned());
        args = &args[end + 1..];
    }
    Some((executable, command))
}

#[cfg(any(test, target_os = "macos"))]
fn identify_mac_agent(executable: &str, command: &(String, Vec<String>)) -> Option<String> {
    // sysinfo's macOS name comes from KERN_PROCARGS2 exec_path's basename
    // (or proc_pidpath as fallback), not the mutable BSD process title.
    identify_agent(executable, &command.1)
        .or_else(|| identify_agent(&command.0, &command.1))
        .map(str::to_ascii_lowercase)
}

#[cfg(target_os = "macos")]
fn read_mac_process(pid: u32) -> Result<Option<Process>, ()> {
    use nix::libc;
    let Some(before) = mac_bsd_info(pid)? else {
        return Ok(None);
    };
    let mut path = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let length =
        unsafe { libc::proc_pidpath(pid as i32, path.as_mut_ptr().cast(), path.len() as u32) };
    let command = mac_command(pid);
    // Reject reuse or reparenting during argv/executable inspection. A vanished
    // candidate can be ignored; an unreadable live candidate remains unknown.
    let Some(after) = mac_bsd_info(pid)? else {
        return Ok(None);
    };
    if (
        before.pbi_start_tvsec,
        before.pbi_start_tvusec,
        before.pbi_ppid,
    ) != (
        after.pbi_start_tvsec,
        after.pbi_start_tvusec,
        after.pbi_ppid,
    ) {
        return Err(());
    }
    if length <= 0 || length as usize > path.len() {
        return Err(());
    }
    path.truncate(length as usize);
    if let Some(end) = path.iter().position(|byte| *byte == 0) {
        path.truncate(end);
    }
    let command = command?;
    let executable = String::from_utf8_lossy(&path);
    let tool = identify_mac_agent(&executable, &command);
    Ok(Some(Process {
        parent: (after.pbi_ppid != pid && after.pbi_ppid > 0).then_some(after.pbi_ppid),
        started_at: after.pbi_start_tvsec,
        tool,
        tool_unavailable: false,
        foreground: Some(
            after.e_tpgid > 0 && after.e_tpgid == after.pbi_pgid && after.pbi_status != libc::SSTOP,
        ),
    }))
}

#[cfg(target_os = "macos")]
fn foreground(pid: u32, started_at: u64) -> Option<bool> {
    let info = mac_bsd_info(pid).ok()??;
    if info.pbi_start_tvsec != started_at {
        return None;
    }
    Some(info.e_tpgid > 0 && info.e_tpgid == info.pbi_pgid && info.pbi_status != nix::libc::SSTOP)
}

#[cfg(target_os = "linux")]
fn foreground(pid: u32, started_at: u64) -> Option<bool> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // comm can contain spaces and ')'; fields after its last ')' begin at state.
    let fields: Vec<_> = stat.rsplit_once(')')?.1.split_whitespace().collect();
    // Reject reuse between sysinfo's identity observation and this stat read.
    let ticks = fields.get(19)?.parse::<u64>().ok()?;
    let frequency = unsafe { nix::libc::sysconf(nix::libc::_SC_CLK_TCK) };
    if frequency <= 0 || System::boot_time().saturating_add(ticks / frequency as u64) != started_at
    {
        return None;
    }
    let group = fields.get(2)?.parse::<i64>().ok()?;
    let foreground_group = fields.get(5)?.parse::<i64>().ok()?;
    Some(
        group > 0
            && group == foreground_group
            && !matches!(*fields.first()?, "T" | "t" | "Z" | "X"),
    )
}

#[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
fn foreground(pid: u32, _started_at: u64) -> Option<bool> {
    let output = std::process::Command::new("/bin/ps")
        .args(["-p", &pid.to_string(), "-o", "stat="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let state = String::from_utf8_lossy(&output.stdout);
    Some(state.contains('+') && !state.contains('T') && !state.contains('Z'))
}

#[cfg(not(unix))]
fn foreground(_pid: u32, _started_at: u64) -> Option<bool> {
    // ConPTY has no POSIX foreground groups. Discovery rejects ambiguity.
    Some(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn process(parent: u32, tool: Option<&str>, foreground: bool) -> Process {
        Process {
            parent: Some(parent),
            started_at: 10,
            tool: tool.map(str::to_string),
            foreground: Some(foreground),
            tool_unavailable: false,
        }
    }
    fn meta() -> SessionMeta {
        serde_json::from_value(serde_json::json!({
            "sessionId":"one", "rootPid":20, "rootStartedAt":10,
            "alive":true, "createdAtMs":1
        }))
        .unwrap()
    }
    fn tracker() -> AgentTracker {
        let mut tracker = AgentTracker {
            processes: HashMap::from([
                (1, process(0, None, false)),
                (20, process(1, None, false)),
                (21, process(20, Some("codex"), true)),
                (22, process(21, Some("codex"), true)),
                (23, process(22, Some("claude"), true)),
                (30, process(1, None, false)),
                (31, process(30, Some("gemini"), true)),
            ]),
            ..Default::default()
        };
        tracker.reindex_candidates();
        tracker
    }
    #[test]
    fn mac_argv_parser_keeps_empty_arguments_and_excludes_environment() {
        let mut bytes = 3i32.to_ne_bytes().to_vec();
        bytes.extend_from_slice(b"/usr/bin/node\0\0node\0\0/project/main.js\0TOOL=codex\0");
        assert_eq!(
            parse_mac_command(&bytes),
            Some((
                "/usr/bin/node".into(),
                vec!["node".into(), "".into(), "/project/main.js".into()]
            ))
        );
        let named_launcher = ("/tmp/codex".to_string(), vec!["/tmp/codex".to_string()]);
        assert_eq!(
            identify_mac_agent("/usr/local/lib/launcher", &named_launcher),
            Some("codex".into())
        );
        let plain_shell = (
            "/bin/bash".to_string(),
            vec!["bash".into(), "-c".into(), "codex".into()],
        );
        assert_eq!(identify_mac_agent("/bin/bash", &plain_shell), None);
        let mut truncated = 2i32.to_ne_bytes().to_vec();
        truncated.extend_from_slice(b"/bin/bash\0bash\0unterminated");
        assert!(parse_mac_command(&truncated).is_none());
        assert!(parse_mac_command(&(-1i32).to_ne_bytes()).is_none());
    }

    fn windows_identity(
        pid: u32,
        parent: u32,
        birth: u64,
        exe: &str,
    ) -> super::super::windows_process::ProcessIdentity {
        super::super::windows_process::ProcessIdentity {
            pid,
            parent: (parent > 0).then_some(parent),
            created_at: birth,
            // Deliberately identical seconds: native parent validation must use
            // the full FILETIME, not this legacy wire-format timestamp.
            started_at: 10,
            executable: exe.into(),
            command: vec![exe.into()],
            command_available: true,
        }
    }

    fn windows_tracker(
        identities: &[super::super::windows_process::ProcessIdentity],
    ) -> AgentTracker {
        let mut tracker = AgentTracker {
            processes: windows_processes(identities),
            ..Default::default()
        };
        tracker.reindex_candidates();
        tracker
    }

    #[test]
    fn windows_first_hook_discovers_new_agent_and_preserves_nested_owner() {
        let observations = [
            windows_identity(1, 0, 100, "daemon.exe"),
            windows_identity(20, 1, 200, "powershell.exe"),
            windows_identity(21, 20, 300, "codex.exe"),
            windows_identity(22, 21, 400, "claude.exe"),
            windows_identity(23, 22, 500, "hook.exe"),
        ];
        // No watchdog candidate cache is involved in this fresh Job batch.
        let tracker = windows_tracker(&observations);
        let agent = tracker.discover(&meta(), 1, 1000).unwrap().unwrap();
        assert_eq!((agent.pid, agent.tool.as_str()), (21, "codex"));
        assert!(tracker.belongs_to(23, agent.pid));
    }

    #[test]
    fn windows_new_independent_sibling_is_ambiguous_on_its_first_hook() {
        let observations = [
            windows_identity(1, 0, 100, "daemon.exe"),
            windows_identity(20, 1, 200, "powershell.exe"),
            windows_identity(21, 20, 300, "codex.exe"),
            windows_identity(22, 21, 400, "hook.exe"),
            windows_identity(30, 20, 450, "gemini.exe"),
        ];
        let tracker = windows_tracker(&observations);
        assert_eq!(tracker.discover(&meta(), 1, 1000), None);
    }

    #[test]
    fn windows_same_second_reused_parent_cannot_own_an_older_helper() {
        let observations = [
            windows_identity(1, 0, 100, "daemon.exe"),
            windows_identity(20, 1, 200, "powershell.exe"),
            // This PID was recycled to another Agent after the helper's birth.
            windows_identity(21, 20, 500, "codex.exe"),
            windows_identity(22, 21, 400, "hook.exe"),
        ];
        let tracker = windows_tracker(&observations);
        let agent = tracker.discover(&meta(), 1, 1000).unwrap().unwrap();
        assert_eq!(agent.pid, 21);
        assert!(!tracker.belongs_to(22, agent.pid));
        let mut reused_root = observations.to_vec();
        reused_root[0].created_at = 600;
        assert_eq!(
            windows_tracker(&reused_root).discover(&meta(), 1, 1000),
            None
        );
    }

    #[test]
    fn windows_unreadable_commands_only_defer_their_own_unowned_branch() {
        let mut observations = vec![
            windows_identity(1, 0, 100, "daemon.exe"),
            windows_identity(20, 1, 200, "powershell.exe"),
            windows_identity(21, 20, 300, "codex.exe"),
            windows_identity(22, 21, 400, ""),
            windows_identity(30, 1, 250, "powershell.exe"),
            windows_identity(31, 30, 450, ""),
        ];
        observations[3].command_available = false;
        observations[5].command_available = false;
        let tracker = windows_tracker(&observations);
        assert_eq!(tracker.discover(&meta(), 1, 1000).unwrap().unwrap().pid, 21);
        let mut other_meta = meta();
        other_meta.root_pid = Some(30);
        assert_eq!(tracker.discover(&other_meta, 1, 1000), None);
        observations[5].parent = Some(20);
        assert_eq!(
            windows_tracker(&observations).discover(&meta(), 1, 1000),
            None
        );
    }

    #[test]
    fn windows_job_churn_retries_once_and_includes_new_independent_agent() {
        let observations = [
            windows_identity(1, 0, 100, "daemon.exe"),
            windows_identity(20, 1, 200, "powershell.exe"),
            windows_identity(21, 20, 300, "codex.exe"),
            windows_identity(22, 21, 400, "hook.exe"),
            windows_identity(30, 20, 450, "gemini.exe"),
        ];
        let mut batches = Vec::new();
        let (sampled, _) = read_windows_scope_with(
            vec![1, 20, 21, 22],
            true,
            |ids| {
                Ok(observations
                    .iter()
                    .filter(|p| ids.contains(&p.pid))
                    .cloned()
                    .collect())
            },
            || Some(vec![1, 20, 21, 22, 30]),
            |count| batches.push(count),
        )
        .unwrap();
        assert_eq!(batches, vec![4, 5]);
        assert_eq!(windows_tracker(&sampled).discover(&meta(), 1, 1000), None);
        // Continuous churn is unavailable, with a bounded two-read cost.
        let mut generation = 0;
        let mut batches = 0;
        assert!(read_windows_scope_with(
            vec![1],
            true,
            |_| Ok(vec![]),
            || {
                generation += 1;
                Some(vec![1, generation + 10])
            },
            |_| batches += 1,
        )
        .is_none());
        assert_eq!(batches, 2);
    }

    #[test]
    fn windows_sampling_counts_include_some_and_reject_outside_job_helpers() {
        assert!(
            refresh_enumerates_process_table(false, true),
            "Windows Some still enumerates Toolhelp"
        );
        assert!(refresh_enumerates_process_table(true, true));
        assert!(!refresh_enumerates_process_table(false, false));
        let ids = [1, 20, 21, 22, 30, 31].map(Pid::from_u32);
        assert!(hook_job_contains_origins(&ids, 20, Some(22), 1));
        assert!(!hook_job_contains_origins(&ids, 20, Some(99), 1));
        assert!(!hook_job_contains_origins(&ids, 99, Some(22), 1));
        assert!(!hook_job_contains_origins(&ids, 20, Some(22), 99));
        // Job membership is only an enumeration scope, never pane identity.
        let tracker = tracker();
        assert!(hook_job_contains_origins(&ids, 20, Some(31), 1));
        assert!(!tracker.belongs_to(31, 20));
    }

    #[test]
    fn descendant_index_ignores_unrelated_forest_and_terminates_cycles() {
        let mut children: HashMap<u32, Vec<u32>> =
            (100..10_000).map(|pid| (pid, vec![pid + 1])).collect();
        children.extend([
            (1, vec![20, 30]),
            (20, vec![21]),
            (21, vec![22]),
            (22, vec![20]),
        ]);
        let actual: HashSet<_> = descendants(&children, 1).into_iter().collect();
        assert_eq!(actual, HashSet::from([1, 20, 21, 22, 30]));
    }

    #[test]
    fn unavailable_foreground_candidate_only_defers_its_own_pane() {
        let mut tracker = tracker();
        tracker.processes.get_mut(&31).unwrap().foreground = None;
        assert_eq!(
            tracker.discover(&meta(), 1, 100).unwrap().unwrap().tool,
            "codex"
        );
        let mut other_pane = meta();
        other_pane.root_pid = Some(30);
        assert_eq!(tracker.discover(&other_pane, 1, 100), None);
    }

    #[test]
    fn owns_exact_pane_and_collapses_launchers_and_nested_agents() {
        let tracker = tracker();
        let agent = tracker.discover(&meta(), 1, 100).unwrap().unwrap();
        assert_eq!(agent.tool, "codex");
        assert_eq!(agent.pid, 21);
        assert!(!tracker.belongs_to(31, 20));
    }

    #[test]
    fn reused_parent_pid_does_not_bind_an_unrelated_agent() {
        let mut tracker = tracker();
        tracker.processes.get_mut(&21).unwrap().started_at = 9;
        assert!(!tracker.belongs_to(21, 20));
        assert_eq!(tracker.discover(&meta(), 1, 100), Some(None));
        tracker.processes.get_mut(&20).unwrap().started_at = 9;
        let mut metadata = meta();
        metadata.root_started_at = Some(9);
        assert_eq!(tracker.discover(&metadata, 1, 100), None);
    }
    #[test]
    fn pi_package_discovery_binds_only_its_own_pane_and_clears_on_exit() {
        let mut tracker = tracker();
        let tool = identify_agent("node.exe", &[
            "node.exe".into(),
            "E:/dev-cache/npm-global/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js".into(),
        ]).map(str::to_ascii_lowercase);
        tracker.processes.get_mut(&21).unwrap().tool = tool;
        let agent = tracker.discover(&meta(), 1, 100).unwrap().unwrap();
        assert_eq!(agent.tool, "pi");
        assert_eq!(agent.pid, 21);
        let mut other_pane = meta();
        other_pane.root_pid = Some(30);
        assert_eq!(
            tracker.discover(&other_pane, 1, 100).unwrap().unwrap().tool,
            "gemini"
        );
        tracker.processes.retain(|id, _| ![21, 22, 23].contains(id));
        assert_eq!(tracker.discover(&meta(), 1, 200), Some(None));
    }
    #[test]
    fn background_and_suspended_agents_do_not_bind() {
        let mut tracker = tracker();
        for id in [21, 22, 23] {
            tracker.processes.get_mut(&id).unwrap().foreground = Some(false);
        }
        assert_eq!(tracker.discover(&meta(), 1, 100), Some(None));
    }
    #[test]
    fn exits_switches_and_same_tool_restarts_have_distinct_identity() {
        let mut tracker = tracker();
        let first = tracker.discover(&meta(), 1, 100).unwrap().unwrap();
        tracker.processes.retain(|id, _| ![21, 22, 23].contains(id));
        assert_eq!(tracker.discover(&meta(), 1, 200), Some(None));
        tracker
            .processes
            .insert(21, process(20, Some("claude"), true));
        tracker.processes.get_mut(&21).unwrap().started_at = 11;
        tracker.reindex_candidates();
        let second = tracker.discover(&meta(), 1, 200).unwrap().unwrap();
        assert_ne!(first.run_id, second.run_id);
        assert_eq!(second.tool, "claude");
    }
    #[test]
    fn stale_root_remote_and_ambiguous_probes_are_unavailable() {
        let mut tracker = tracker();
        let mut meta = meta();
        meta.root_started_at = Some(9);
        assert_eq!(tracker.discover(&meta, 1, 100), None);
        meta.root_started_at = Some(10);
        meta.environment_type = Some("ssh".into());
        assert_eq!(tracker.discover(&meta, 1, 100), None);
        meta.environment_type = None;
        meta.shell = Some("wsl".into());
        assert_eq!(tracker.discover(&meta, 1, 100), None);
        meta.shell = None;
        tracker
            .processes
            .insert(25, process(20, Some("gemini"), true));
        tracker.reindex_candidates();
        assert_eq!(tracker.discover(&meta, 1, 100), None);
    }
}
