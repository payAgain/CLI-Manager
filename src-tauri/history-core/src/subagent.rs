use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubagentMetadata {
    pub parent_session_id: String,
    pub nickname: Option<String>,
}

/// Only spawned agent threads are children. A user's ordinary fork is a session.
pub fn codex_subagent_metadata(record: &Value) -> Option<SubagentMetadata> {
    if record.get("type")?.as_str()? != "session_meta" {
        return None;
    }
    let payload = record.get("payload")?;
    let spawn = payload.pointer("/source/subagent/thread_spawn")?;
    let parent = spawn
        .get("parent_thread_id")
        .or_else(|| payload.get("parent_thread_id"))
        .or_else(|| payload.get("forked_from_id"))?
        .as_str()?
        .trim();
    if parent.is_empty() || payload.get("id").and_then(Value::as_str) == Some(parent) {
        return None;
    }
    Some(SubagentMetadata {
        parent_session_id: parent.to_string(),
        nickname: payload
            .get("agent_nickname")
            .or_else(|| spawn.get("agent_nickname"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{apply_jsonl_line, build_summary, ParserState};
    use serde_json::json;

    #[test]
    fn spawned_threads_are_children_but_ordinary_forks_are_sessions() {
        let fork = json!({"type":"session_meta","payload":{"id":"fork","forked_from_id":"main","source":"cli"}});
        assert!(codex_subagent_metadata(&fork).is_none());
        let mut child = fork.clone();
        child["payload"]["source"] = json!({"subagent":{"thread_spawn":{"parent_thread_id":"main","agent_nickname":"Archimedes"}}});
        let metadata = codex_subagent_metadata(&child).unwrap();
        assert_eq!(metadata.parent_session_id, "main");
        assert_eq!(metadata.nickname.as_deref(), Some("Archimedes"));
        child["payload"]["source"]["subagent"]["thread_spawn"]["parent_thread_id"] = json!("fork");
        assert!(codex_subagent_metadata(&child).is_none());
    }

    #[test]
    fn remote_parser_preserves_child_identity_when_parent_context_is_embedded() {
        let mut state = ParserState::default();
        for (index, line) in [
            json!({"type":"session_meta","payload":{"id":"child","source":{"subagent":{"thread_spawn":{"parent_thread_id":"main"}}}}}),
            json!({"type":"session_meta","payload":{"id":"main","source":"vscode"}}),
        ].into_iter().enumerate() {
            apply_jsonl_line(&mut state, "codex", &line.to_string(), index);
        }
        let summary = build_summary(
            &state, "codex", "host-a", "artifact", "fallback", "app", 1, 2, 1,
        );
        assert_eq!(summary.session_ref.source_session_id, "child");
        assert_eq!(summary.subagent.unwrap().parent_session_id, "main");
    }
}
