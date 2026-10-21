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
    foreground: bool,
}

#[derive(Default)]
pub(super) struct AgentTracker {
    system: System,
    processes: HashMap<u32, Process>,
}

impl AgentTracker {
    /// Failure is not evidence that an Agent exited. Keep the last observation.
    pub fn refresh(&mut self) -> bool {
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().without_tasks(),
        );
        // Only read command lines/executables for this daemon's descendants.
        let parents: HashMap<u32, Option<u32>> = self
            .system
            .processes()
            .iter()
            .map(|(pid, p)| (pid.as_u32(), p.parent().map(|pid| pid.as_u32())))
            .collect();
        let daemon_pid = std::process::id();
        let managed: Vec<Pid> = parents
            .keys()
            .filter(|pid| {
                let mut current = **pid;
                let mut visited = HashSet::new();
                while visited.insert(current) {
                    if current == daemon_pid {
                        return true;
                    }
                    let Some(parent) = parents.get(&current).copied().flatten() else {
                        break;
                    };
                    current = parent;
                }
                false
            })
            .map(|pid| Pid::from_u32(*pid))
            .collect();
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&managed),
            true,
            ProcessRefreshKind::nothing()
                .with_cmd(UpdateKind::Always)
                .with_exe(UpdateKind::Always)
                .without_tasks(),
        );
        #[cfg(unix)]
        let states = {
            let Ok(output) = std::process::Command::new("/bin/ps")
                .args(["-axo", "pid=,stat="])
                .output()
            else {
                return false;
            };
            if !output.status.success() {
                return false;
            }
            let states: HashMap<u32, String> = String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter_map(|line| {
                    let mut fields = line.split_whitespace();
                    Some((fields.next()?.parse().ok()?, fields.next()?.to_string()))
                })
                .collect();
            if states.is_empty() {
                return false;
            }
            states
        };
        self.processes = self
            .system
            .processes()
            .iter()
            .map(|(pid, process)| {
                let command = process
                    .cmd()
                    .iter()
                    .map(|s| s.to_string_lossy().into_owned())
                    .collect::<Vec<_>>();
                #[cfg(unix)]
                let foreground = states.get(&pid.as_u32()).is_some_and(|state| {
                    state.contains('+') && !state.contains('T') && !state.contains('Z')
                });
                // ConPTY has no POSIX foreground groups. Select an unambiguous outer Agent.
                #[cfg(not(unix))]
                let foreground = true;
                (
                    pid.as_u32(),
                    Process {
                        parent: process.parent().map(|pid| pid.as_u32()),
                        started_at: process.start_time(),
                        tool: identify_agent(
                            &process
                                .exe()
                                .map(|path| path.as_os_str())
                                .unwrap_or(process.name())
                                .to_string_lossy(),
                            &command,
                        )
                        .or_else(|| identify_agent(&process.name().to_string_lossy(), &command))
                        .map(str::to_ascii_lowercase),
                        foreground,
                    },
                )
            })
            .collect();
        true
    }

    pub fn belongs_to(&self, pid: u32, root: u32) -> bool {
        let mut current = pid;
        let mut visited = HashSet::new();
        while visited.insert(current) {
            if current == root {
                return true;
            }
            let Some(parent) = self.processes.get(&current).and_then(|p| p.parent) else {
                break;
            };
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
        if meta.environment_type.as_deref() == Some("ssh") {
            return None;
        }
        let root = meta.root_pid?;
        let process = self.processes.get(&root)?;
        if meta.root_started_at != Some(process.started_at) || !self.belongs_to(root, daemon_pid) {
            return None;
        }
        // A local WSL/SSH transport cannot describe the guest foreground process.
        if meta
            .shell
            .as_deref()
            .is_some_and(|s| s.to_ascii_lowercase().contains("wsl"))
        {
            return None;
        }
        let mut candidates = Vec::new();
        for (&pid, process) in &self.processes {
            if !process.foreground || process.tool.is_none() || !self.belongs_to(pid, root) {
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
                if ancestor.tool.is_some() && ancestor.foreground {
                    nested = true;
                    break;
                }
                if id == root {
                    break;
                }
                parent = ancestor.parent;
            }
            if !nested {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn process(parent: u32, tool: Option<&str>, foreground: bool) -> Process {
        Process {
            parent: Some(parent),
            started_at: 10,
            tool: tool.map(str::to_string),
            foreground,
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
        AgentTracker {
            processes: HashMap::from([
                (20, process(1, None, false)),
                (21, process(20, Some("codex"), true)),
                (22, process(21, Some("codex"), true)),
                (23, process(22, Some("claude"), true)),
                (30, process(1, None, false)),
                (31, process(30, Some("gemini"), true)),
            ]),
            ..Default::default()
        }
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
        assert_eq!(tracker.discover(&other_pane, 1, 100).unwrap().unwrap().tool, "gemini");
        tracker.processes.retain(|id, _| ![21, 22, 23].contains(id));
        assert_eq!(tracker.discover(&meta(), 1, 200), Some(None));
    }
    #[test]
    fn background_and_suspended_agents_do_not_bind() {
        let mut tracker = tracker();
        for id in [21, 22, 23] {
            tracker.processes.get_mut(&id).unwrap().foreground = false;
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
        assert_eq!(tracker.discover(&meta, 1, 100), None);
    }
}
