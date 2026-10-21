//! Read-only working-set accounting for this app and its daemon-owned PTYs.
use crate::daemon::agent_recognition::executable_stem;
use crate::daemon::{client::DaemonBridge, protocol::SessionMeta};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

#[derive(Clone, Debug)]
struct ProcessSample {
    pid: u32,
    parent: Option<u32>,
    started_at: u64,
    name: String,
    command: Vec<String>,
    memory: u64,
    app_webview: bool,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameworkMemory {
    app_bytes: u64,
    webview_bytes: u64,
    daemon_bytes: u64,
    helper_bytes: u64,
    total_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMemory {
    pid: u32,
    name: String,
    memory_bytes: u64,
    process_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalMemory {
    session_id: String,
    root_pid: Option<u32>,
    total_bytes: Option<u64>,
    shell_bytes: u64,
    other_bytes: u64,
    local_only: bool,
    agents: Vec<AgentMemory>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalMemorySnapshot {
    sampled_at: u64,
    daemon_available: bool,
    framework: FrameworkMemory,
    terminals: Vec<TerminalMemory>,
    unassigned_bytes: u64,
    total_bytes: u64,
}

fn belongs_to(pid: u32, root: u32, processes: &HashMap<u32, &ProcessSample>) -> bool {
    let mut current = pid;
    let mut visited = HashSet::new();
    while visited.insert(current) {
        if current == root {
            return true;
        }
        let Some(parent) = processes.get(&current).and_then(|process| process.parent) else {
            break;
        };
        current = parent;
    }
    false
}

fn identify_agent(process: &ProcessSample) -> Option<&'static str> {
    crate::daemon::agent_recognition::identify_agent(&process.name, &process.command)
}

fn nearest_terminal(
    pid: u32,
    roots: &HashMap<u32, usize>,
    processes: &HashMap<u32, &ProcessSample>,
) -> Option<usize> {
    let mut current = pid;
    let mut visited = HashSet::new();
    while visited.insert(current) {
        if let Some(index) = roots.get(&current) {
            return Some(*index);
        }
        current = processes.get(&current)?.parent?;
    }
    None
}

fn agent_owner(
    pid: u32,
    terminal_root: u32,
    processes: &HashMap<u32, &ProcessSample>,
) -> Option<(u32, &'static str)> {
    let mut current = pid;
    let mut owner = None;
    let mut visited = HashSet::new();
    while visited.insert(current) {
        let process = processes.get(&current)?;
        if let Some(label) = identify_agent(process) {
            match owner {
                None => owner = Some((current, label)),
                Some((_, previous)) if previous == label => owner = Some((current, label)),
                Some(_) => break,
            }
        }
        if current == terminal_root {
            break;
        }
        let Some(parent) = process.parent else { break };
        current = parent;
    }
    owner
}

fn aggregate(
    process_list: &[ProcessSample],
    app_pid: u32,
    daemon_pid: Option<u32>,
    sessions: &[SessionMeta],
    daemon_available: bool,
) -> TerminalMemorySnapshot {
    let processes: HashMap<_, _> = process_list
        .iter()
        .map(|process| (process.pid, process))
        .collect();
    let daemon_roots: Vec<_> = process_list
        .iter()
        .filter(|process| {
            daemon_pid == Some(process.pid)
                || (executable_stem(&process.name) == "cli-manager-daemon"
                    && belongs_to(process.pid, app_pid, &processes))
        })
        .map(|process| process.pid)
        .collect();
    let mut roots = HashMap::new();
    let mut duplicate_roots = HashSet::new();
    for (index, session) in sessions.iter().enumerate() {
        if !session.alive {
            continue;
        }
        let Some(pid) = session.root_pid else {
            continue;
        };
        let Some(process) = processes.get(&pid) else {
            continue;
        };
        if session
            .root_started_at
            .is_some_and(|start| start != process.started_at)
            || !daemon_pid.is_some_and(|daemon| belongs_to(pid, daemon, &processes))
        {
            continue;
        }
        if roots.insert(pid, index).is_some() {
            duplicate_roots.insert(pid);
        }
    }
    for pid in duplicate_roots {
        roots.remove(&pid);
    }
    let mut terminals: Vec<_> = sessions
        .iter()
        .enumerate()
        .map(|(index, session)| TerminalMemory {
            session_id: session.session_id.clone(),
            root_pid: session.root_pid,
            total_bytes: (!session.alive
                || session
                    .root_pid
                    .is_some_and(|pid| roots.get(&pid) == Some(&index)))
            .then_some(0),
            shell_bytes: 0,
            other_bytes: 0,
            local_only: session.environment_type.as_deref() == Some("ssh")
                || session
                    .shell
                    .as_deref()
                    .is_some_and(|shell| shell.to_ascii_lowercase().contains("wsl")),
            agents: Vec::new(),
        })
        .collect();
    let mut agents = BTreeMap::<(usize, u32), AgentMemory>::new();
    let mut snapshot = TerminalMemorySnapshot {
        sampled_at: chrono::Utc::now().timestamp_millis().max(0) as u64,
        daemon_available,
        framework: FrameworkMemory::default(),
        terminals: Vec::new(),
        unassigned_bytes: 0,
        total_bytes: 0,
    };
    for process in process_list {
        if let Some(index) = nearest_terminal(process.pid, &roots, &processes) {
            let terminal = &mut terminals[index];
            *terminal.total_bytes.as_mut().unwrap() += process.memory;
            if let Some((pid, name)) =
                agent_owner(process.pid, terminal.root_pid.unwrap(), &processes)
            {
                let agent = agents.entry((index, pid)).or_insert_with(|| AgentMemory {
                    pid,
                    name: name.to_string(),
                    memory_bytes: 0,
                    process_count: 0,
                });
                agent.memory_bytes += process.memory;
                agent.process_count += 1;
            } else if terminal.root_pid == Some(process.pid) {
                terminal.shell_bytes += process.memory;
            } else {
                terminal.other_bytes += process.memory;
            }
        } else if daemon_roots
            .iter()
            .any(|pid| belongs_to(process.pid, *pid, &processes))
        {
            if daemon_pid == Some(process.pid) {
                snapshot.framework.daemon_bytes += process.memory;
            } else {
                snapshot.unassigned_bytes += process.memory;
            }
        } else if process.app_webview || belongs_to(process.pid, app_pid, &processes) {
            if process.pid == app_pid {
                snapshot.framework.app_bytes += process.memory;
            } else if crate::process_attribution::is_webview(&process.name)
            {
                snapshot.framework.webview_bytes += process.memory;
            } else {
                snapshot.framework.helper_bytes += process.memory;
            }
        } else {
            continue;
        }
        snapshot.total_bytes += process.memory;
    }
    for ((index, _), agent) in agents {
        terminals[index].agents.push(agent);
    }
    snapshot.framework.total_bytes = snapshot.framework.app_bytes
        + snapshot.framework.webview_bytes
        + snapshot.framework.daemon_bytes
        + snapshot.framework.helper_bytes;
    snapshot.terminals = terminals;
    snapshot
}

fn sample(
    system: &mut System,
    app_pid: u32,
    daemon_pid: Option<u32>,
    sessions: &[SessionMeta],
    daemon_available: bool,
) -> TerminalMemorySnapshot {
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().without_tasks(),
    );
    let identities: Vec<_> = system
        .processes()
        .iter()
        .map(|(pid, process)| ProcessSample {
            pid: pid.as_u32(),
            parent: process.parent().map(|pid| pid.as_u32()),
            started_at: process.start_time(),
            name: process.name().to_string_lossy().into_owned(),
            command: Vec::new(),
            memory: 0,
            app_webview: crate::process_attribution::is_app_webkit(
                pid.as_u32(), &process.name().to_string_lossy(), app_pid,
            ),
        })
        .collect();
    let parents: HashMap<_, _> = identities
        .iter()
        .map(|process| (process.pid, process))
        .collect();
    let managed: Vec<_> = identities
        .iter()
        .filter(|process| {
            process.app_webview || belongs_to(process.pid, app_pid, &parents)
                || daemon_pid.is_some_and(|pid| belongs_to(process.pid, pid, &parents))
        })
        .map(|process| Pid::from_u32(process.pid))
        .collect();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&managed),
        true,
        ProcessRefreshKind::nothing()
            .with_memory()
            .with_cmd(UpdateKind::Always)
            .with_exe(UpdateKind::Always)
            .without_tasks(),
    );
    let processes: Vec<_> = identities
        .into_iter()
        .map(|mut process| {
            if let Some(current) = system.process(Pid::from_u32(process.pid)) {
                if current.start_time() == process.started_at {
                    process.name = current
                        .exe()
                        .map(|path| path.as_os_str())
                        .unwrap_or(current.name())
                        .to_string_lossy()
                        .into_owned();
                    process.memory = current.memory();
                    process.command = current
                        .cmd()
                        .iter()
                        .map(|arg| arg.to_string_lossy().into_owned())
                        .collect();
                }
            }
            process
        })
        .collect();
    aggregate(&processes, app_pid, daemon_pid, sessions, daemon_available)
}

#[tauri::command]
pub async fn terminal_memory_get_snapshot(
    daemon_bridge: tauri::State<'_, DaemonBridge>,
) -> Result<TerminalMemorySnapshot, String> {
    let client = daemon_bridge.get();
    tauri::async_runtime::spawn_blocking(move || {
        let daemon_pid = client.as_ref().map(|client| client.info().pid);
        let sessions = client.as_ref().map(|client| client.list()).transpose();
        let daemon_available = client.is_some() && sessions.is_ok();
        let sessions = sessions.ok().flatten().unwrap_or_default();
        static SYSTEM: OnceLock<Mutex<System>> = OnceLock::new();
        let mut system = SYSTEM
            .get_or_init(|| Mutex::new(System::new()))
            .lock()
            .map_err(|_| "memory_collector_unavailable".to_string())?;
        Ok(sample(
            &mut system,
            std::process::id(),
            daemon_pid,
            &sessions,
            daemon_available,
        ))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn process(pid: u32, parent: u32, name: &str, memory: u64) -> ProcessSample {
        ProcessSample {
            pid,
            parent: Some(parent),
            name: name.to_string(),
            memory,
            started_at: 100,
            command: Vec::new(),
            app_webview: false,
        }
    }

    fn session(id: &str, root: Option<u32>) -> SessionMeta {
        serde_json::from_value(serde_json::json!({
            "sessionId": id, "rootPid": root, "rootStartedAt": 100,
            "alive": true, "createdAtMs": 100000,
        }))
        .unwrap()
    }

    #[test]
    fn partitions_framework_terminal_agents_and_unassigned_without_double_counting() {
        let mut wrapper = process(21, 20, "node.exe", 20);
        wrapper.command = vec![
            "node.exe".into(),
            "C:/npm/node_modules/@openai/codex/bin/codex.js".into(),
        ];
        let list = vec![
            process(1, 0, "cli-manager.exe", 100),
            process(2, 1, "msedgewebview2.exe", 200),
            process(3, 1, "git.exe", 5),
            process(10, 1, "cli-manager-daemon.exe", 50),
            process(20, 10, "powershell.exe", 10),
            wrapper,
            process(22, 21, "codex.exe", 30),
            process(23, 22, "rg.exe", 40),
            process(24, 22, "claude.exe", 50),
            process(25, 24, "node.exe", 60),
            process(26, 20, "python.exe", 7),
            process(30, 10, "ssh.exe", 8),
            process(99, 98, "codex.exe", 999),
        ];
        let snapshot = aggregate(&list, 1, Some(10), &[session("one", Some(20))], true);
        assert_eq!(snapshot.framework.total_bytes, 355);
        assert_eq!(snapshot.terminals[0].total_bytes, Some(217));
        assert_eq!(snapshot.terminals[0].shell_bytes, 10);
        assert_eq!(snapshot.terminals[0].other_bytes, 7);
        assert_eq!(snapshot.terminals[0].agents.len(), 2);
        assert_eq!(snapshot.terminals[0].agents[0].memory_bytes, 90);
        assert_eq!(snapshot.terminals[0].agents[0].process_count, 3);
        assert_eq!(snapshot.terminals[0].agents[1].memory_bytes, 110);
        assert_eq!(snapshot.unassigned_bytes, 8);
        assert_eq!(snapshot.total_bytes, 580);
    }

    #[test]
    fn separates_multiple_terminal_trees() {
        let list = vec![
            process(1, 0, "app", 1),
            process(10, 1, "cli-manager-daemon", 2),
            process(20, 10, "pwsh", 3),
            process(21, 20, "codex", 4),
            process(30, 10, "pwsh", 5),
            process(31, 30, "claude", 6),
        ];
        let snapshot = aggregate(
            &list,
            1,
            Some(10),
            &[session("one", Some(20)), session("two", Some(30))],
            true,
        );
        assert_eq!(snapshot.terminals[0].total_bytes, Some(7));
        assert_eq!(snapshot.terminals[1].total_bytes, Some(11));
        assert_eq!(snapshot.terminals[1].agents[0].name, "Claude");
        assert_eq!(snapshot.total_bytes, 21);
    }

    #[test]
    fn pi_packages_own_their_tool_children_without_crossing_terminal_roots() {
        let mut current = process(21, 20, "node.exe", 40);
        current.command = vec!["node.exe".into(),
            r"E:\dev-cache\npm-global\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js".into()];
        let mut legacy = process(31, 30, "node", 60);
        legacy.command = vec!["node".into(),
            "/npm/@mariozechner/pi-coding-agent/dist/cli.js".into()];
        let snapshot = aggregate(&[
            process(1, 0, "cli-manager.exe", 1),
            process(10, 1, "cli-manager.exe", 2),
            process(20, 10, "pwsh.exe", 3), current,
            process(22, 21, "pi.exe", 10),
            process(23, 22, "rg.exe", 5),
            process(30, 10, "pwsh.exe", 4), legacy,
            process(32, 31, "node.exe", 7),
        ], 1, Some(10), &[session("current", Some(20)), session("legacy", Some(30))], true);
        for (index, pid, bytes, count) in [(0, 21, 55, 3), (1, 31, 67, 2)] {
            let terminal = &snapshot.terminals[index];
            assert_eq!(terminal.agents.len(), 1);
            assert_eq!(terminal.agents[0].name, "Pi");
            assert_eq!(terminal.agents[0].pid, pid);
            assert_eq!(terminal.agents[0].memory_bytes, bytes);
            assert_eq!(terminal.agents[0].process_count, count);
            assert_eq!(terminal.other_bytes, 0);
        }
        assert_eq!(snapshot.total_bytes, 132);
    }

    #[test]
    fn counts_owned_launchd_webkit_services_without_claiming_other_apps() {
        let mut content = process(100, 1, "com.apple.WebKit.WebContent", 200);
        content.app_webview = true;
        let mut gpu = process(101, 1, "com.apple.WebKit.GPU", 30);
        gpu.app_webview = true;
        let snapshot = aggregate(&[
            process(20, 1, "cli-manager", 50), content, gpu,
            process(102, 1, "com.apple.WebKit.WebContent", 900),
        ], 20, None, &[], false);
        assert_eq!(snapshot.framework.webview_bytes, 230);
        assert_eq!(snapshot.framework.app_bytes, 50);
        assert_eq!(snapshot.total_bytes, 280);
    }

    #[test]
    fn rejects_reused_pids_and_roots_outside_the_daemon() {
        let list = vec![
            process(1, 0, "app", 1),
            process(10, 1, "cli-manager-daemon", 2),
            process(20, 10, "pwsh", 3),
            process(30, 0, "pwsh", 4),
        ];
        let mut reused = session("reused", Some(20));
        reused.root_started_at = Some(99);
        let snapshot = aggregate(
            &list,
            1,
            Some(10),
            &[reused, session("unrelated", Some(30))],
            true,
        );
        assert_eq!(snapshot.terminals[0].total_bytes, None);
        assert_eq!(snapshot.terminals[1].total_bytes, None);
        assert_eq!(snapshot.unassigned_bytes, 3);
        assert_eq!(snapshot.framework.total_bytes, 3);
    }

    #[test]
    fn duplicate_roots_are_unavailable_instead_of_double_counted() {
        let list = vec![
            process(10, 1, "cli-manager-daemon", 2),
            process(20, 10, "pwsh", 3),
        ];
        let snapshot = aggregate(
            &list,
            1,
            Some(10),
            &[session("one", Some(20)), session("two", Some(20))],
            true,
        );
        assert!(snapshot
            .terminals
            .iter()
            .all(|terminal| terminal.total_bytes.is_none()));
        assert_eq!(snapshot.total_bytes, 5);
        assert_eq!(snapshot.unassigned_bytes, 3);
    }

    #[test]
    fn legacy_daemon_and_exited_sessions_do_not_invent_zero_measurements() {
        let legacy: SessionMeta = serde_json::from_value(
            serde_json::json!({"sessionId":"old","alive":true,"createdAtMs":1}),
        )
        .unwrap();
        assert_eq!(legacy.root_pid, None);
        let mut exited = session("exited", Some(20));
        exited.alive = false;
        let snapshot = aggregate(&[], 1, Some(10), &[legacy, exited], true);
        assert_eq!(snapshot.terminals[0].total_bytes, None);
        assert_eq!(snapshot.terminals[1].total_bytes, Some(0));
    }

    #[test]
    fn shell_text_and_project_names_are_not_agent_identities() {
        let mut shell = process(20, 10, "powershell.exe", 3);
        shell.command = vec!["powershell.exe".into(), "-Command".into(), "claude".into()];
        assert_eq!(identify_agent(&shell), None);
        shell.name = "node.exe".into();
        shell.command = vec!["node.exe".into(), "C:/projects/claude/server.js".into()];
        assert_eq!(identify_agent(&shell), None);
        shell.command = vec![
            "node.exe".into(),
            "C:/npm/node_modules/@anthropic-ai/claude-code/cli.js".into(),
        ];
        assert_eq!(identify_agent(&shell), Some("Claude"));
    }

    #[test]
    fn remote_and_wsl_sessions_only_claim_local_process_memory() {
        let mut ssh = session("ssh", Some(20));
        ssh.environment_type = Some("ssh".into());
        let mut wsl = session("wsl", Some(30));
        wsl.shell = Some("wsl".into());
        let list = vec![
            process(10, 1, "cli-manager-daemon", 2),
            process(20, 10, "ssh.exe", 3),
            process(30, 10, "wsl.exe", 4),
        ];
        let snapshot = aggregate(&list, 1, Some(10), &[ssh, wsl], true);
        assert!(snapshot
            .terminals
            .iter()
            .all(|terminal| terminal.local_only && terminal.agents.is_empty()));
    }

    #[test]
    fn parent_cycles_terminate() {
        let list = vec![process(20, 21, "pwsh", 3), process(21, 20, "codex", 4)];
        assert_eq!(aggregate(&list, 1, None, &[], false).total_bytes, 0);
    }

    #[test]
    fn reads_real_current_process_memory() {
        let snapshot = sample(&mut System::new(), std::process::id(), None, &[], false);
        assert!(snapshot.framework.app_bytes > 0);
        assert!(snapshot.total_bytes >= snapshot.framework.app_bytes);
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "manual smoke check requires a running same-user WebKit application"]
    fn reads_real_launchd_webkit_memory() {
        let mut system = System::new();
        system.refresh_processes_specifics(ProcessesToUpdate::All, true,
            ProcessRefreshKind::nothing().without_tasks());
        let renderer = system.processes().iter().find(|(_, process)|
            process.name().to_string_lossy().contains("WebKit.WebContent"))
            .expect("run a WebKit application before this manual smoke check");
        let owner = system.processes().keys().find(|pid|
            crate::process_attribution::is_app_webkit(renderer.0.as_u32(),
                &renderer.1.name().to_string_lossy(), pid.as_u32()))
            .expect("WebKit must have an identifiable responsible application").as_u32();
        assert_ne!(renderer.1.parent().map(|pid| pid.as_u32()), Some(owner));
        let snapshot = sample(&mut system, owner, None, &[], false);
        assert!(snapshot.framework.webview_bytes > 0);
        assert!(snapshot.framework.app_bytes > 0);
        assert!(snapshot.total_bytes >= snapshot.framework.webview_bytes + snapshot.framework.app_bytes);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn reads_real_conpty_shell_with_recorded_process_identity() {
        use std::sync::Arc;
        struct Sink;
        impl crate::pty::manager::PtyEventSink for Sink {
            fn on_output(&self, _: &str, _: &[u8]) {}
            fn on_status(&self, _: &str, _: crate::pty::manager::PtyProcessStatus) {}
        }
        let manager = crate::pty::manager::PtyManager::new();
        let identity = manager
            .create("memory-test", None, None, Some("cmd"), Arc::new(Sink))
            .unwrap();
        let mut metadata = session("memory-test", Some(identity.root_pid));
        metadata.root_started_at = identity.root_started_at;
        let pid = std::process::id();
        let snapshot = sample(&mut System::new(), pid, Some(pid), &[metadata], true);
        manager.close("memory-test").unwrap();
        assert!(identity.root_started_at.is_some());
        assert!(snapshot.terminals[0].total_bytes.unwrap_or(0) > 0);
        assert!(snapshot.terminals[0].shell_bytes > 0);
        assert!(snapshot.terminals[0].agents.is_empty());
    }
}
