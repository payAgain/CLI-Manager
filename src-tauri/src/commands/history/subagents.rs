use super::*;
use cli_manager_history_core::subagent::{codex_subagent_metadata, SubagentMetadata};
use std::io::Read;

type HeaderCache = HashMap<String, (SessionFileFingerprint, Option<SubagentMetadata>)>;
static HEADERS: OnceLock<Mutex<HeaderCache>> = OnceLock::new();

pub(super) fn metadata(source: &str, path: &Path) -> Option<SubagentMetadata> {
    if source == "claude" {
        let normalized = path.to_string_lossy().replace('\\', "/");
        let index = normalized.to_lowercase().rfind("/subagents/")?;
        let parent = &normalized[..index];
        let filename = normalized[index + "/subagents/".len()..].to_lowercase();
        if !filename.starts_with("agent-")
            || !filename.ends_with(".jsonl")
            || filename.contains('/')
        {
            return None;
        }
        return Some(SubagentMetadata {
            parent_session_id: parent.rsplit('/').next()?.to_string(),
            nickname: None,
        });
    }
    if source != "codex" {
        return None;
    }
    let key = path_to_key(path);
    let fingerprint = session_file_fingerprint(path);
    let cache = HEADERS.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(entries) = cache.lock() {
        if let Some((previous, value)) = entries.get(&key) {
            if can_reuse_session_scan(*previous, fingerprint) {
                return value.clone();
            }
        }
    }
    // The first metadata belongs to this file. Forks may embed parent metadata later.
    let value = File::open(path).ok().and_then(|file| {
        BufReader::new(file.take(1024 * 1024))
            .lines()
            .map_while(Result::ok)
            .take(64)
            .filter_map(|line| serde_json::from_str::<Value>(&line).ok())
            .find(|record| record.get("type").and_then(Value::as_str) == Some("session_meta"))
            .and_then(|record| codex_subagent_metadata(&record))
    });
    if let Ok(mut entries) = cache.lock() {
        if entries.len() >= 2048 {
            entries.clear();
        }
        entries.insert(key, (fingerprint, value.clone()));
    }
    value
}

/// Relationships stay inside a CLI installation; cwd/project may change in a child Worktree.
pub(super) fn scope(source: &str, path: &str) -> String {
    let mut normalized = path.replace('\\', "/");
    if normalized.to_lowercase().starts_with("//?/unc/") {
        normalized = format!("//{}", &normalized[8..]);
    } else if normalized.starts_with("//?/") {
        normalized = normalized[4..].to_string();
    }
    if normalized.to_lowercase().starts_with("//wsl$/") {
        normalized = format!("//wsl.localhost/{}", &normalized[7..]);
    }
    let lower = normalized.to_lowercase();
    let marker = if source == "codex" {
        "/sessions/"
    } else {
        "/subagents/"
    };
    let root = if let Some(index) = lower.rfind(marker) {
        if source == "codex" {
            &normalized[..index]
        } else {
            normalized[..index]
                .rsplit_once('/')
                .map_or("", |(root, _)| root)
        }
    } else {
        normalized.rsplit_once('/').map_or("", |(root, _)| root)
    };
    if normalized.starts_with("//") || normalized.as_bytes().get(1) == Some(&b':') {
        root.to_lowercase()
    } else {
        root.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_metadata_uses_the_file_header_not_inherited_parent_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout-child.jsonl");
        let child = json!({"type":"session_meta","payload":{
            "id":"child", "parent_thread_id":"main", "agent_nickname":"Feynman",
            "source":{"subagent":{"thread_spawn":{"parent_thread_id":"main","depth":1}}}
        }});
        let parent = json!({"type":"session_meta","payload":{"id":"main","source":"vscode"}});
        fs::write(&path, format!("{child}\n{parent}\n")).unwrap();
        let relation = metadata("codex", &path).unwrap();
        assert_eq!(relation.parent_session_id, "main");
        assert_eq!(relation.nickname.as_deref(), Some("Feynman"));
        fs::write(&path, format!("{parent}\n{child}\n{{}}\n")).unwrap();
        assert!(metadata("codex", &path).is_none());
        assert!(metadata("claude", &path).is_none());
    }

    #[test]
    fn relationship_scope_is_independent_of_project_and_preserves_environment_boundaries() {
        assert_eq!(
            scope("codex", "/config/a/sessions/2026/01/rollout-a.jsonl"),
            scope("codex", "/config/a/sessions/2026/02/rollout-b.jsonl")
        );
        assert_ne!(
            scope("codex", "/config/a/sessions/rollout.jsonl"),
            scope("codex", "/config/b/sessions/rollout.jsonl")
        );
        assert_eq!(
            scope(
                "claude",
                r"C:\Users\dev\projects\p\main\subagents\agent-child.jsonl"
            ),
            scope("claude", "c:/Users/dev/projects/p/main.jsonl")
        );
        assert_ne!(
            scope(
                "codex",
                r"\\wsl.localhost\Ubuntu\home\dev\.codex\sessions\rollout.jsonl"
            ),
            scope(
                "codex",
                r"\\wsl.localhost\Debian\home\dev\.codex\sessions\rollout.jsonl"
            )
        );
        assert_eq!(
            scope(
                "codex",
                r"\\?\UNC\wsl$\Ubuntu\home\dev\.codex\sessions\rollout.jsonl"
            ),
            scope(
                "codex",
                r"\\wsl.localhost\Ubuntu\home\dev\.codex\sessions\rollout.jsonl"
            )
        );
    }
}
