//! Read-only, session-scoped task snapshots. Tool calls are proposals: only their
//! matching successful results change state. No directory-recency association.
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

const READ_BUDGET: u64 = 2 * 1024 * 1024;
const MAX_LINE: usize = 512 * 1024;
const MAX_ITEMS: usize = 128;
const TEXT_LIMIT: usize = 16 * 1024;
const MAX_DISCOVERY: usize = 20_000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Pending,
    Running,
    Done,
    Failed,
    Unknown,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTask {
    pub id: String,
    pub title: String,
    pub description: String,
    pub status: TaskStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPlan {
    pub id: String,
    pub title: String,
    pub content: String,
    pub status: TaskStatus,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBackgroundTask {
    pub id: String,
    pub title: String,
    pub description: String,
    pub status: TaskStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTasksSnapshot {
    pub tasks: Vec<AgentTask>,
    pub plans: Vec<AgentPlan>,
    pub background_tasks: Vec<AgentBackgroundTask>,
    pub warnings: Vec<String>,
    pub supported: bool,
}

fn text(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(Value::as_str)
        .map(bounded)
        .unwrap_or_default()
}
fn bounded(s: &str) -> String {
    s.chars().take(TEXT_LIMIT).collect()
}
fn safe_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 160
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}
fn status(s: &str) -> TaskStatus {
    match s {
        "pending" => TaskStatus::Pending,
        "in_progress" | "running" => TaskStatus::Running,
        "completed" | "done" => TaskStatus::Done,
        "failed" | "killed" => TaskStatus::Failed,
        _ => TaskStatus::Unknown,
    }
}
fn result_status(raw: &str, exit_code: Option<i64>) -> TaskStatus {
    match exit_code {
        Some(code) if code != 0 => TaskStatus::Failed,
        Some(0) if matches!(status(raw), TaskStatus::Done | TaskStatus::Unknown) => {
            TaskStatus::Done
        }
        _ => status(raw),
    }
}
fn result_text(v: &Value) -> String {
    if let Some(s) = v.as_str() {
        return bounded(s);
    }
    if let Some(a) = v.as_array() {
        return bounded(
            &a.iter()
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n"),
        );
    }
    String::new()
}
fn warning(warnings: &mut Vec<String>, code: &str) {
    if warnings.len() < 24 && !warnings.iter().any(|s| s == code) {
        warnings.push(code.to_string());
    }
}
fn regex_capture(pattern: &str, s: &str) -> Option<String> {
    // Patterns are constants, never supplied by the caller or transcript.
    regex::Regex::new(pattern)
        .ok()?
        .captures(s)?
        .get(1)
        .map(|m| m.as_str().to_string())
}

#[derive(Clone)]
struct Call {
    name: String,
    input: Value,
}
#[derive(Default)]
struct Parser {
    tasks: BTreeMap<String, AgentTask>,
    plans: BTreeMap<String, AgentPlan>,
    background: BTreeMap<String, AgentBackgroundTask>,
    background_calls: HashMap<String, String>,
    // Running evidence observed after initial replay, never a clock/PID guess.
    live_background: HashSet<String>,
    calls: HashMap<String, Call>,
    warnings: Vec<String>,
    uncertain: bool,
    codex_identity: bool,
    claude_identity: bool,
    plan_mode: bool,
}

impl Parser {
    fn warn(&mut self, code: &str) {
        warning(&mut self.warnings, code);
    }
    fn task(&mut self, task: AgentTask) {
        if self.tasks.contains_key(&task.id) || self.tasks.len() < MAX_ITEMS {
            self.tasks.insert(task.id.clone(), task);
        } else {
            self.uncertain = true;
            self.warn("task_limit_reached");
        }
    }
    fn plan(&mut self, plan: AgentPlan) {
        if self.plans.contains_key(&plan.id) || self.plans.len() < 16 {
            self.plans.insert(plan.id.clone(), plan);
        } else {
            self.warn("plan_limit_reached");
        }
    }
    fn line(&mut self, source: &str, session: &str, root: &Path, line: &[u8]) {
        let Ok(v) = serde_json::from_slice::<Value>(line) else {
            self.uncertain = true;
            self.warn("transcript_invalid_json");
            return;
        };
        if source == "codex" {
            self.codex_line(session, &v);
        } else {
            self.claude_line(session, root, &v);
        }
    }
    fn remember(&mut self, id: &str, name: &str, input: &Value) {
        if id.is_empty() {
            return;
        }
        if self.calls.len() >= 32 && !self.calls.contains_key(id) {
            self.uncertain = true;
            self.warn("pending_tool_limit_reached");
            return;
        }
        self.calls.insert(
            id.to_string(),
            Call {
                name: name.to_string(),
                input: input.clone(),
            },
        );
    }
    fn claude_line(&mut self, session: &str, root: &Path, v: &Value) {
        if v.get("sessionId").and_then(Value::as_str) != Some(session)
            || v.get("isSidechain").and_then(Value::as_bool) == Some(true)
            || v.get("agentId")
                .and_then(Value::as_str)
                .is_some_and(|s| !s.is_empty())
        {
            return;
        }
        self.claude_identity = true;
        let record_type = v.get("type").and_then(Value::as_str).unwrap_or("");
        // Completion events can be queued or rendered as system messages. They
        // retain the exact parent session checked above, even before delivery.
        if record_type == "queue-operation"
            && v.get("operation").and_then(Value::as_str) == Some("enqueue")
        {
            if let Some(content) = v.get("content").and_then(Value::as_str) {
                self.notification(content);
            }
        }
        if record_type == "attachment"
            && v.pointer("/attachment/type").and_then(Value::as_str) == Some("queued_command")
            && v.pointer("/attachment/commandMode").and_then(Value::as_str)
                == Some("task-notification")
        {
            if let Some(content) = v.pointer("/attachment/prompt").and_then(Value::as_str) {
                self.notification(content);
            }
        }
        let role = v
            .pointer("/message/role")
            .and_then(Value::as_str)
            .unwrap_or("");
        if matches!(role, "user" | "system") {
            if let Some(content) = v.pointer("/message/content").and_then(Value::as_str) {
                self.notification(content);
            }
        }
        let Some(blocks) = v.pointer("/message/content").and_then(Value::as_array) else {
            return;
        };
        for block in blocks {
            if matches!(role, "user" | "system")
                && block.get("type").and_then(Value::as_str) == Some("text")
            {
                if let Some(content) = block.get("text").and_then(Value::as_str) {
                    self.notification(content);
                }
            }
        }
        // Request blobs are snapshots of previously sent messages, not new
        // tool executions. Replaying one could resurrect a completed task.
        if record_type == "api-request-blob" {
            return;
        }
        for block in blocks {
            match (role, block.get("type").and_then(Value::as_str)) {
                ("assistant", Some("tool_use")) => {
                    let name = text(block, "name");
                    if matches!(
                        name.as_str(),
                        "TodoWrite"
                            | "TaskCreate"
                            | "TaskUpdate"
                            | "Bash"
                            | "TaskOutput"
                            | "TaskStop"
                            | "EnterPlanMode"
                            | "ExitPlanMode"
                            | "Write"
                            | "Read"
                    ) {
                        // Keep only fields used below; never retain an arbitrary tool payload.
                        let mut input = serde_json::Map::new();
                        if let Some(obj) = block.get("input").and_then(Value::as_object) {
                            for key in [
                                "todos",
                                "subject",
                                "description",
                                "activeForm",
                                "status",
                                "taskId",
                                "task_id",
                                "command",
                                "run_in_background",
                                "file_path",
                                "content",
                                "plan",
                            ] {
                                if let Some(value) = obj.get(key) {
                                    let value = if let Some(s) = value.as_str() {
                                        Value::String(bounded(s))
                                    } else {
                                        value.clone()
                                    };
                                    input.insert(key.to_string(), value);
                                }
                            }
                        }
                        // TodoWrite can be large; a pending invocation is bounded independently.
                        if Value::Object(input.clone()).to_string().len() <= 64 * 1024 {
                            self.remember(&text(block, "id"), &name, &Value::Object(input));
                        } else {
                            self.uncertain = true;
                            self.warn("tool_input_limit_reached");
                        }
                    }
                }
                ("user", Some("tool_result")) => {
                    let id = text(block, "tool_use_id");
                    if let Some(call) = self.calls.remove(&id) {
                        if block.get("is_error").and_then(Value::as_bool) != Some(true) {
                            self.claude_result(
                                root,
                                &id,
                                call,
                                block,
                                v.get("toolUseResult").unwrap_or(&Value::Null),
                            );
                        }
                    }
                }
                _ => {}
            }
        }
    }
    fn claude_result(
        &mut self,
        root: &Path,
        call_id: &str,
        call: Call,
        result: &Value,
        structured: &Value,
    ) {
        let input = &call.input;
        let output = result_text(&result["content"]);
        match call.name.as_str() {
            "TodoWrite" => {
                let Some(todos) = input.get("todos").and_then(Value::as_array) else {
                    return;
                };
                self.tasks.retain(|id, _| !id.starts_with("todo:"));
                for (index, todo) in todos.iter().take(MAX_ITEMS).enumerate() {
                    let content = text(todo, "content");
                    self.task(AgentTask {
                        id: format!("todo:{index}"),
                        title: content.clone(),
                        description: content,
                        status: status(&text(todo, "status")),
                        detail: nonempty(text(todo, "activeForm")),
                    });
                }
                if todos.len() > MAX_ITEMS {
                    self.uncertain = true;
                    self.warn("task_limit_reached");
                }
            }
            "TaskCreate" => {
                let id = structured
                    .pointer("/task/id")
                    .or_else(|| structured.get("taskId"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| {
                        regex_capture(
                            r"^Task #([A-Za-z0-9_-]+) created successfully",
                            output.trim(),
                        )
                    });
                if let Some(id) = id.filter(|s| safe_id(s)) {
                    self.task(AgentTask {
                        id,
                        title: text(input, "subject"),
                        description: text(input, "description"),
                        status: TaskStatus::Pending,
                        detail: nonempty(text(input, "activeForm")),
                    });
                } else {
                    self.warn("task_create_id_unconfirmed");
                }
            }
            "TaskUpdate" => {
                let id = text(input, "taskId");
                if !safe_id(&id) {
                    return;
                }
                if text(input, "status") == "deleted" {
                    self.tasks.remove(&id);
                    return;
                }
                let mut task = self.tasks.remove(&id).unwrap_or(AgentTask {
                    id: id.clone(),
                    title: format!("Task #{id}"),
                    description: String::new(),
                    status: TaskStatus::Unknown,
                    detail: None,
                });
                if input.get("status").is_some() {
                    task.status = status(&text(input, "status"));
                }
                if input.get("subject").is_some() {
                    task.title = text(input, "subject");
                }
                if input.get("description").is_some() {
                    task.description = text(input, "description");
                }
                if input.get("activeForm").is_some() {
                    task.detail = nonempty(text(input, "activeForm"));
                }
                self.task(task);
            }
            "Bash" => {
                let id = structured
                    .get("backgroundTaskId")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| {
                        regex_capture(
                            r"(?m)^Command running in background with ID: ([A-Za-z0-9_-]+)(?:\.|\s|$)",
                            &output,
                        )
                    });
                if let Some(id) = id.filter(|s| safe_id(s)) {
                    if self.background.len() >= MAX_ITEMS && !self.background.contains_key(&id) {
                        self.warn("background_limit_reached");
                        return;
                    }
                    // A repeated launch result cannot overwrite independent completion.
                    self.background
                        .entry(id.clone())
                        .or_insert_with(|| AgentBackgroundTask {
                            id: id.clone(),
                            title: text(input, "command"),
                            description: nonempty(text(input, "description"))
                                .unwrap_or_else(|| text(input, "command")),
                            status: TaskStatus::Running,
                            output: None,
                        });
                    self.background_calls
                        .entry(id.clone())
                        .or_insert_with(|| call_id.to_string());
                    self.live_background.insert(id);
                } else if input.get("run_in_background").and_then(Value::as_bool) == Some(true) {
                    self.warn("background_task_id_unconfirmed");
                }
            }
            "TaskOutput" => {
                let id = text(input, "task_id");
                let actual_id = structured
                    .pointer("/task/task_id")
                    .or_else(|| structured.pointer("/task/id"))
                    .and_then(Value::as_str);
                if actual_id == Some(id.as_str()) {
                    let task = &structured["task"];
                    let code = task
                        .get("exitCode")
                        .or_else(|| task.get("exit_code"))
                        .and_then(Value::as_i64);
                    self.background_state(
                        &id,
                        result_status(&text(task, "status"), code),
                        nonempty(text(task, "output")),
                    );
                } else if actual_id.is_none() {
                    // Only protocol headers can supply identity/status; command
                    // output itself can contain arbitrary XML-looking text.
                    let headers = output.split("<output>").next().unwrap_or("");
                    if xml_field(headers, "task_id").as_deref() == Some(id.as_str()) {
                        let code = xml_field(headers, "exit_code").and_then(|s| s.parse().ok());
                        self.background_state(
                            &id,
                            result_status(&xml_field(headers, "status").unwrap_or_default(), code),
                            xml_field(&output, "output").map(|s| bounded(&s)),
                        );
                    }
                }
            }
            "TaskStop" => {
                let id = text(input, "task_id");
                // The real local_bash result confirms termination, not success
                // of the command. Failed/ambiguous stop calls change nothing.
                if structured.get("task_id").and_then(Value::as_str) == Some(id.as_str())
                    && text(structured, "task_type") == "local_bash"
                    && text(structured, "message")
                        .to_ascii_lowercase()
                        .contains("successfully stopped")
                {
                    self.background_state(&id, TaskStatus::Failed, None);
                } else if structured.get("task_id").is_none()
                    && output.starts_with(&format!("Task {id} successfully stopped"))
                {
                    self.background_state(&id, TaskStatus::Failed, None);
                }
            }
            "EnterPlanMode" => {
                self.plan_mode = true;
                self.plan(AgentPlan {
                    id: "claude:plan".into(),
                    title: "Plan".into(),
                    content: String::new(),
                    status: TaskStatus::Running,
                });
            }
            "ExitPlanMode" => {
                self.plan_mode = false;
                let content =
                    nonempty(text(input, "plan")).or_else(|| nonempty(text(structured, "plan")));
                if let Some(content) = content {
                    let path = text(structured, "filePath");
                    let id = if plan_path(root, &path).is_some() {
                        path
                    } else {
                        "claude:plan".into()
                    };
                    self.plans.remove("claude:plan");
                    self.plan(AgentPlan {
                        id,
                        title: "Plan".into(),
                        content,
                        status: TaskStatus::Pending,
                    });
                }
                for plan in self.plans.values_mut() {
                    plan.status = TaskStatus::Pending;
                }
            }
            "Write" | "Read" => {
                let path = text(input, "file_path");
                if plan_path(root, &path).is_none() {
                    return;
                }
                let content = if call.name == "Write" {
                    text(input, "content")
                } else {
                    structured
                        .pointer("/file/content")
                        .and_then(Value::as_str)
                        .map(bounded)
                        .unwrap_or_default()
                };
                if content.is_empty() {
                    self.warn("plan_content_unavailable");
                    return;
                }
                self.plans.remove("claude:plan");
                self.plan(AgentPlan {
                    id: path.clone(),
                    title: Path::new(&path)
                        .file_name()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "Plan".into()),
                    content,
                    status: if self.plan_mode {
                        TaskStatus::Running
                    } else {
                        TaskStatus::Unknown
                    },
                });
            }
            _ => {}
        }
    }
    fn background_state(&mut self, id: &str, state: TaskStatus, output: Option<String>) {
        let Some(task) = self.background.get_mut(id) else {
            return;
        };
        // Terminal evidence wins over replayed launch/running observations and
        // duplicated notifications. A stop is never inferred from parent Stop.
        if matches!(task.status, TaskStatus::Done | TaskStatus::Failed)
            || matches!(state, TaskStatus::Unknown)
        {
            return;
        }
        if matches!(state, TaskStatus::Running) {
            self.live_background.insert(id.to_string());
        }
        task.status = state;
        if output.is_some() {
            task.output = output;
        }
    }
    fn notification(&mut self, content: &str) {
        // Multiple notifications may share a rendered message. The transcript
        // reader bounds each line; each extracted display value is bounded too.
        let mut rest = content;
        for _ in 0..MAX_ITEMS {
            let Some(start) = rest.find("<task-notification>") else {
                break;
            };
            rest = &rest[start + "<task-notification>".len()..];
            let Some(end) = rest.find("</task-notification>") else {
                break;
            };
            let body = &rest[..end];
            rest = &rest[end + "</task-notification>".len()..];
            let Some(id) = xml_field(body, "task-id").filter(|id| safe_id(id)) else {
                continue;
            };
            // Bind to the successful Bash tool, when the notification supplies
            // its tool-use ID. Agent/subagent events cannot create Bash rows.
            if let Some(call_id) = xml_field(body, "tool-use-id") {
                if self.background_calls.get(&id) != Some(&call_id) {
                    continue;
                }
            }
            let state = result_status(
                &xml_field(body, "status").unwrap_or_default(),
                xml_field(body, "exit-code")
                    .or_else(|| xml_field(body, "exit_code"))
                    .and_then(|s| s.parse().ok()),
            );
            self.background_state(
                &id,
                state,
                xml_field(body, "summary")
                    .or_else(|| xml_field(body, "result"))
                    .map(|s| bounded(&s)),
            );
        }
    }
    fn codex_line(&mut self, session: &str, v: &Value) {
        if v.get("type").and_then(Value::as_str) == Some("session_meta") {
            if v.pointer("/payload/id").and_then(Value::as_str) != Some(session)
                || cli_manager_history_core::subagent::codex_subagent_metadata(v).is_some()
            {
                self.codex_identity = false;
                self.uncertain = true;
                self.warn("transcript_session_mismatch");
            } else if !self.uncertain {
                self.codex_identity = true;
            }
            return;
        }
        if !self.codex_identity || v.get("type").and_then(Value::as_str) != Some("response_item") {
            return;
        }
        let p = &v["payload"];
        match p.get("type").and_then(Value::as_str) {
            Some("function_call") => {
                let name = text(p, "name");
                let name = name.strip_prefix("functions.").unwrap_or(&name);
                if !matches!(name, "update_plan" | "exec_command" | "write_stdin") {
                    return;
                }
                let args = text(p, "arguments");
                if let Ok(input) = serde_json::from_str::<Value>(&args) {
                    self.remember(&text(p, "call_id"), name, &input);
                } else {
                    self.uncertain = true;
                    self.warn("tool_arguments_invalid");
                }
            }
            Some("function_call_output") => {
                let Some(call) = self.calls.remove(&text(p, "call_id")) else {
                    return;
                };
                let output = result_text(&p["output"]);
                if call.name == "update_plan" {
                    if output.trim() != "Plan updated" {
                        self.warn("plan_update_unconfirmed");
                        return;
                    }
                    let Some(steps) = call.input.get("plan").and_then(Value::as_array) else {
                        return;
                    };
                    self.tasks.retain(|id, _| !id.starts_with("codex:step:"));
                    let mut content = text(&call.input, "explanation");
                    let mut all_done = !steps.is_empty();
                    let mut running = false;
                    for (index, step) in steps.iter().take(MAX_ITEMS).enumerate() {
                        let state = status(&text(step, "status"));
                        all_done &= matches!(state, TaskStatus::Done);
                        running |= matches!(state, TaskStatus::Running);
                        let title = text(step, "step");
                        content.push_str(&format!(
                            "\n- [{}] {}",
                            if matches!(state, TaskStatus::Done) {
                                "x"
                            } else {
                                " "
                            },
                            title
                        ));
                        self.task(AgentTask {
                            id: format!("codex:step:{index}"),
                            title: title.clone(),
                            description: title,
                            status: state,
                            detail: None,
                        });
                    }
                    if steps.len() > MAX_ITEMS {
                        self.uncertain = true;
                        self.warn("task_limit_reached");
                    }
                    self.plan(AgentPlan {
                        id: "codex:plan".into(),
                        title: "Plan".into(),
                        content: bounded(content.trim()),
                        status: if all_done {
                            TaskStatus::Done
                        } else if running {
                            TaskStatus::Running
                        } else {
                            TaskStatus::Pending
                        },
                    });
                } else if call.name == "exec_command" {
                    if let Some(id) = regex_capture(
                        r"(?m)^Process running with session ID ([0-9]+)\s*$",
                        output.split("Output:").next().unwrap_or(""),
                    ) {
                        if self.background.len() < MAX_ITEMS || self.background.contains_key(&id) {
                            self.background.entry(id.clone()).or_insert_with(|| {
                                AgentBackgroundTask {
                                    id: id.clone(),
                                    title: text(&call.input, "cmd"),
                                    description: nonempty(text(&call.input, "description"))
                                        .or_else(|| nonempty(text(&call.input, "justification")))
                                        .unwrap_or_else(|| text(&call.input, "cmd")),
                                    status: TaskStatus::Running,
                                    output: nonempty(output),
                                }
                            });
                            self.live_background.insert(id);
                        } else {
                            self.warn("background_limit_reached");
                        }
                    }
                } else if call.name == "write_stdin" {
                    let id = call
                        .input
                        .get("session_id")
                        .map(|s| {
                            s.as_str()
                                .map(str::to_string)
                                .unwrap_or_else(|| s.to_string())
                        })
                        .unwrap_or_default();
                    // Exec metadata precedes Output; never interpret text
                    // printed by the command as a process completion header.
                    let headers = output.split("Output:").next().unwrap_or("");
                    let state = if let Some(code) =
                        regex_capture(r"(?m)^Process exited with code (-?[0-9]+)\s*$", headers)
                    {
                        result_status("completed", code.parse().ok())
                    } else if regex_capture(
                        r"(?m)^Process running with session ID ([0-9]+)\s*$",
                        headers,
                    )
                    .as_deref()
                        == Some(id.as_str())
                    {
                        TaskStatus::Running
                    } else {
                        TaskStatus::Unknown
                    };
                    self.background_state(&id, state, nonempty(output));
                }
            }
            _ => {}
        }
    }
    fn snapshot(&self, complete: bool) -> AgentTasksSnapshot {
        let mut snapshot = AgentTasksSnapshot {
            tasks: self.tasks.values().cloned().collect(),
            plans: self.plans.values().cloned().collect(),
            background_tasks: self.background.values().cloned().collect(),
            warnings: self.warnings.clone(),
            supported: true,
        };
        if self.uncertain || !complete {
            for task in &mut snapshot.tasks {
                task.status = TaskStatus::Unknown;
            }
            for plan in &mut snapshot.plans {
                plan.status = TaskStatus::Unknown;
            }
            for task in &mut snapshot.background_tasks {
                task.status = TaskStatus::Unknown;
            }
        }
        if !complete {
            warning(&mut snapshot.warnings, "transcript_incomplete");
        }
        if !self.calls.is_empty() {
            warning(&mut snapshot.warnings, "tool_results_pending");
        }
        for task in &mut snapshot.background_tasks {
            if matches!(task.status, TaskStatus::Running)
                && !self.live_background.contains(&task.id)
            {
                task.status = TaskStatus::Unknown;
                warning(&mut snapshot.warnings, "background_status_unconfirmed");
            }
        }
        snapshot
    }
}
fn nonempty(s: String) -> Option<String> {
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}
fn xml_field(content: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = content.find(&open)? + open.len();
    Some(content[start..].split_once(&close)?.0.trim().to_string())
}

/// Only an exact path referenced by a successful parent tool is a plan. This
/// check is lexical too, so a currently missing plan file remains associable.
fn plan_path(root: &Path, raw: &str) -> Option<PathBuf> {
    let raw = if let Some((distro, _)) = crate::wsl::parse_wsl_unc_path(&root.to_string_lossy()) {
        if raw.starts_with('/') {
            crate::wsl::linux_to_unc_wsl_path(raw, &distro)
        } else {
            crate::wsl::normalize_wsl_unc_path(raw)
        }
    } else {
        raw.to_string()
    };
    let path = PathBuf::from(raw);
    let plans = root.join("plans");
    let relative = path.strip_prefix(&plans).ok()?;
    if relative.components().count() != 1
        || !path.extension().is_some_and(|s| s == "md")
        || !clean_path(&path)
    {
        return None;
    }
    if path.exists() && !contained(&path, root) {
        return None;
    }
    Some(path)
}
fn clean_path(path: &Path) -> bool {
    path.is_absolute()
        && !path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
}
fn contained(path: &Path, root: &Path) -> bool {
    match (path.canonicalize(), root.canonicalize()) {
        (Ok(p), Ok(r)) => p.starts_with(r),
        _ => false,
    }
}

struct Entry {
    path: PathBuf,
    offset: u64,
    last_len: u64,
    modified: Option<SystemTime>,
    created: Option<SystemTime>,
    anchor: Vec<u8>,
    parser: Parser,
    skipping_line: bool,
    replaying: bool,
    used: Instant,
}
impl Entry {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            offset: 0,
            last_len: 0,
            modified: None,
            created: None,
            anchor: Vec::new(),
            parser: Parser::default(),
            skipping_line: false,
            replaying: true,
            used: Instant::now(),
        }
    }
    fn refresh(&mut self, source: &str, session: &str, root: &Path) -> Result<bool, String> {
        let mut file = File::open(&self.path).map_err(|_| "transcript_unavailable".to_string())?;
        let meta = file
            .metadata()
            .map_err(|_| "transcript_metadata_unavailable".to_string())?;
        let len = meta.len();
        let modified = meta.modified().ok();
        let created = meta.created().ok();
        let mut reset = len < self.last_len
            || len < self.offset
            || created != self.created && self.offset > 0
            || len == self.last_len && modified != self.modified && self.offset > 0;
        if !reset && !self.anchor.is_empty() {
            file.seek(SeekFrom::Start(self.offset - self.anchor.len() as u64))
                .map_err(|_| "transcript_seek_failed")?;
            let mut anchor = vec![0; self.anchor.len()];
            reset = file.read_exact(&mut anchor).is_err() || anchor != self.anchor;
        }
        if reset {
            let path = self.path.clone();
            *self = Self::new(path);
        }
        file.seek(SeekFrom::Start(self.offset))
            .map_err(|_| "transcript_seek_failed")?;
        let mut bytes = Vec::new();
        (&mut file)
            .take(READ_BUDGET.min(len.saturating_sub(self.offset)))
            .read_to_end(&mut bytes)
            .map_err(|_| "transcript_read_failed")?;
        let mut consumed = 0;
        for (index, byte) in bytes.iter().enumerate() {
            if *byte != b'\n' {
                continue;
            }
            let line = &bytes[consumed..index];
            if self.skipping_line || line.len() > MAX_LINE {
                self.parser.uncertain = true;
                self.parser.warn("transcript_line_limit_reached");
            } else if !line.is_empty() {
                self.parser.line(source, session, root, line);
            }
            self.skipping_line = false;
            consumed = index + 1;
        }
        if bytes.len() - consumed > MAX_LINE {
            consumed = bytes.len();
            self.skipping_line = true;
            self.parser.uncertain = true;
            self.parser.warn("transcript_line_limit_reached");
        }
        self.offset += consumed as u64;
        self.anchor = vec![0; self.offset.min(256) as usize];
        file.seek(SeekFrom::Start(self.offset - self.anchor.len() as u64))
            .map_err(|_| "transcript_seek_failed")?;
        file.read_exact(&mut self.anchor)
            .map_err(|_| "transcript_read_failed")?;
        self.last_len = len;
        self.modified = modified;
        self.created = created;
        self.used = Instant::now();
        let stable = file
            .metadata()
            .is_ok_and(|current| current.len() == len && current.modified().ok() == modified);
        if !stable {
            self.parser.warn("transcript_changed_during_read");
        }
        let complete = self.offset == len && !self.skipping_line && stable;
        if self.replaying {
            self.parser.live_background.clear();
            if complete {
                self.replaying = false;
            }
        }
        Ok(complete)
    }
}
#[derive(Default)]
struct Cache {
    entries: HashMap<String, Entry>,
}
static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();

fn home_dir() -> Option<PathBuf> {
    if cfg!(windows) {
        std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))
    } else {
        std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))
    }
    .map(PathBuf::from)
}

// Only fixed scripts with positional arguments. All output and execution time
// are bounded, including WSL discovery (UNC directory enumeration is unreliable).
fn wsl_text(distro: &str, script: &str, args: &[&str]) -> Result<String, String> {
    use std::process::Stdio;
    let exe = crate::wsl::find_wsl_exe().unwrap_or_else(|| PathBuf::from("wsl.exe"));
    let mut child = crate::shell_resolver::silent_command(&exe.to_string_lossy())
        .args([
            "-d",
            distro,
            "--exec",
            "sh",
            "-c",
            script,
            "cli-manager-agent-tasks",
        ])
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "wsl_unavailable".to_string())?;
    let stdout = child.stdout.take().ok_or("wsl_stdout_unavailable")?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.take(65537).read_to_end(&mut bytes).map(|_| bytes)
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    let success = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("wsl_discovery_timeout".into());
            }
        }
    };
    let bytes = reader
        .join()
        .map_err(|_| "wsl_read_failed")?
        .map_err(|_| "wsl_read_failed")?;
    if !success {
        return Err("wsl_discovery_failed".into());
    }
    if bytes.len() > 65536 {
        return Err("discovery_limit_reached".into());
    }
    String::from_utf8(bytes).map_err(|_| "wsl_invalid_path_encoding".into())
}

fn resolve_root(
    source: &str,
    cwd: &str,
    config: Option<&str>,
    distro: Option<&str>,
) -> Result<PathBuf, String> {
    let cwd_wsl = crate::wsl::parse_wsl_unc_path(&crate::wsl::normalize_wsl_unc_path(cwd));
    let config_wsl =
        config.and_then(|p| crate::wsl::parse_wsl_unc_path(&crate::wsl::normalize_wsl_unc_path(p)));
    let distro = distro
        .or_else(|| cwd_wsl.as_ref().map(|(d, _)| d.as_str()))
        .or_else(|| config_wsl.as_ref().map(|(d, _)| d.as_str()));
    if let Some(distro) = distro {
        if distro.is_empty()
            || distro.starts_with('-')
            || distro
                .chars()
                .any(|c| matches!(c, '/' | '\\' | '\0' | '\n' | '\r'))
        {
            return Err("invalid_wsl_distro".into());
        }
        if cwd_wsl
            .as_ref()
            .is_some_and(|(d, _)| !d.eq_ignore_ascii_case(distro))
            || config_wsl
                .as_ref()
                .is_some_and(|(d, _)| !d.eq_ignore_ascii_case(distro))
        {
            return Err("history_wsl_distro_mismatch".into());
        }
        let linux = if let Some((_, p)) = config_wsl.as_ref() {
            p.clone()
        } else if let Some(config) = config {
            if config.starts_with('/') {
                config.to_string()
            } else {
                crate::wsl::windows_path_to_wsl(config).ok_or("invalid_config_dir")?
            }
        } else {
            let home = wsl_text(distro, "printf %s \"$HOME\"", &[])?;
            if !home.starts_with('/') {
                return Err("invalid_wsl_home".into());
            }
            format!("{}/.{source}", home.trim_end_matches('/'))
        };
        if linux.split('/').any(|s| s == "." || s == "..") {
            return Err("invalid_config_dir".into());
        }
        return Ok(PathBuf::from(crate::wsl::linux_to_unc_wsl_path(
            &linux, distro,
        )));
    }
    if cfg!(windows) && cwd.starts_with('/') {
        return Err("wsl_distro_required".into());
    }
    let root = config
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os(if source == "claude" {
                "CLAUDE_CONFIG_DIR"
            } else {
                "CODEX_HOME"
            })
            .map(PathBuf::from)
        })
        .or_else(|| home_dir().map(|p| p.join(format!(".{source}"))))
        .ok_or("home_unavailable")?;
    if !clean_path(&root) {
        return Err("invalid_config_dir".into());
    }
    // General UNC paths are not an SSH transport and cannot grant remote access.
    if root.to_string_lossy().starts_with("\\\\") {
        return Err("unsupported_remote_path".into());
    }
    Ok(root)
}
fn slug(cwd: &str) -> String {
    cwd.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect()
}
fn find_transcript(source: &str, session: &str, cwd: &str, root: &Path) -> Result<PathBuf, String> {
    let base = root.join(if source == "claude" {
        "projects"
    } else {
        "sessions"
    });
    let wsl = crate::wsl::parse_wsl_unc_path(&base.to_string_lossy());
    let actual_cwd = if wsl.is_some() {
        crate::wsl::parse_wsl_unc_path(&crate::wsl::normalize_wsl_unc_path(cwd))
            .map(|(_, p)| p)
            .or_else(|| crate::wsl::windows_path_to_wsl(cwd))
            .unwrap_or_else(|| cwd.to_string())
    } else {
        cwd.to_string()
    };
    if source == "claude" {
        let expected = base
            .join(slug(&actual_cwd))
            .join(format!("{session}.jsonl"));
        if expected.is_file() {
            if !contained(&expected, root) {
                return Err("transcript_path_outside_root".into());
            }
            return Ok(expected);
        }
    }
    let mut candidates = Vec::new();
    if let Some((distro, linux)) = wsl {
        let pattern = if source == "claude" {
            format!("{session}.jsonl")
        } else {
            format!("rollout-*-{session}.jsonl")
        };
        let depth = if source == "claude" { "2" } else { "4" };
        let output = wsl_text(
            &distro,
            "find \"$1\" -maxdepth \"$2\" -type f -name \"$3\" -print",
            &[&linux, depth, &pattern],
        )?;
        for line in output.lines() {
            let path = PathBuf::from(crate::wsl::linux_to_unc_wsl_path(line, &distro));
            if path.starts_with(&base) && contained(&path, root) {
                candidates.push(path);
            }
        }
    } else {
        let mut stack = vec![(base, 0)];
        let mut examined = 0;
        while let Some((dir, depth)) = stack.pop() {
            let entries = fs::read_dir(&dir).map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    "transcript_not_found"
                } else {
                    "transcript_discovery_failed"
                }
            })?;
            for entry in entries {
                examined += 1;
                if examined > MAX_DISCOVERY {
                    return Err("discovery_limit_reached".into());
                }
                let entry = entry.map_err(|_| "transcript_discovery_failed")?;
                let kind = entry
                    .file_type()
                    .map_err(|_| "transcript_discovery_failed")?;
                if kind.is_dir() && depth < if source == "claude" { 1 } else { 3 } {
                    stack.push((entry.path(), depth + 1));
                }
                if !kind.is_file() {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                let matches = if source == "claude" {
                    depth == 1 && name == format!("{session}.jsonl")
                } else {
                    name.starts_with("rollout-") && name.ends_with(&format!("-{session}.jsonl"))
                };
                if matches {
                    if !contained(&entry.path(), root) {
                        return Err("transcript_path_outside_root".into());
                    }
                    candidates.push(entry.path());
                }
            }
        }
    }
    if candidates.len() != 1 {
        return Err(if candidates.is_empty() {
            "transcript_not_found"
        } else {
            "transcript_ambiguous"
        }
        .into());
    }
    Ok(candidates.remove(0))
}

fn file_tasks(root: &Path, session: &str, snapshot: &mut AgentTasksSnapshot) {
    let dir = root.join("tasks").join(session);
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
        Err(_) => {
            warning(&mut snapshot.warnings, "task_files_unavailable");
            return;
        }
    };
    if !contained(&dir, root) {
        warning(&mut snapshot.warnings, "task_path_outside_root");
        return;
    }
    let mut total = 0u64;
    for (index, entry) in entries.enumerate() {
        if index >= MAX_ITEMS * 2 {
            warning(&mut snapshot.warnings, "task_file_limit_reached");
            break;
        }
        let Ok(entry) = entry else {
            warning(&mut snapshot.warnings, "task_file_unavailable");
            continue;
        };
        let path = entry.path();
        if path.extension().is_none_or(|s| s != "json") {
            continue;
        }
        if !contained(&path, &dir) {
            warning(&mut snapshot.warnings, "task_path_outside_root");
            continue;
        }
        let mut read = || -> Option<Value> {
            let file = File::open(&path).ok()?;
            let len = file.metadata().ok()?.len();
            total += len;
            if len > 64 * 1024 || total > READ_BUDGET {
                return None;
            }
            let mut bytes = Vec::new();
            file.take(64 * 1024 + 1).read_to_end(&mut bytes).ok()?;
            if bytes.len() > 64 * 1024 {
                return None;
            }
            serde_json::from_slice(&bytes).ok()
        };
        let Some(v) = read() else {
            warning(&mut snapshot.warnings, "task_file_invalid_or_limited");
            continue;
        };
        let id = text(&v, "id");
        if !safe_id(&id) || path.file_stem().and_then(|s| s.to_str()) != Some(id.as_str()) {
            warning(&mut snapshot.warnings, "task_file_identity_mismatch");
            continue;
        }
        let task = AgentTask {
            id: id.clone(),
            title: text(&v, "subject"),
            description: text(&v, "description"),
            status: status(&text(&v, "status")),
            detail: nonempty(text(&v, "activeForm")),
        };
        if let Some(existing) = snapshot.tasks.iter_mut().find(|t| t.id == id) {
            *existing = task;
        } else if snapshot.tasks.len() < MAX_ITEMS {
            snapshot.tasks.push(task);
        } else {
            warning(&mut snapshot.warnings, "task_limit_reached");
        }
    }
}

fn get_snapshot(
    source: &str,
    session: &str,
    cwd: &str,
    config: Option<&str>,
    distro: Option<&str>,
    transport: Option<&str>,
) -> Result<AgentTasksSnapshot, String> {
    if transport.is_some_and(|s| s != "local" && s != "ssh") {
        return Err("invalid_transport_kind".into());
    }
    if transport == Some("ssh") || !matches!(source, "claude" | "codex") {
        return Ok(AgentTasksSnapshot {
            warnings: vec![if transport == Some("ssh") {
                "ssh_agent_tasks_unsupported"
            } else {
                "agent_tasks_source_unsupported"
            }
            .into()],
            ..Default::default()
        });
    }
    if !safe_id(session) {
        return Err("invalid_parent_session_id".into());
    }
    if cwd.trim().is_empty() {
        return Err("cwd_required".into());
    }
    let root = resolve_root(
        source,
        cwd,
        config.filter(|s| !s.trim().is_empty()),
        distro.filter(|s| !s.trim().is_empty()),
    )?;
    let key = format!("{source}\0{session}\0{}\0{cwd}", root.display());
    let mut cache = CACHE
        .get_or_init(|| Mutex::new(Cache::default()))
        .lock()
        .map_err(|_| "agent_tasks_cache_unavailable")?;
    if !cache.entries.contains_key(&key) {
        let path = find_transcript(source, session, cwd, &root)?;
        if cache.entries.len() >= 8 {
            if let Some(oldest) = cache
                .entries
                .iter()
                .min_by_key(|(_, e)| e.used)
                .map(|(k, _)| k.clone())
            {
                cache.entries.remove(&oldest);
            }
        }
        cache.entries.insert(key.clone(), Entry::new(path));
    }
    let entry = cache
        .entries
        .get_mut(&key)
        .ok_or("agent_tasks_cache_unavailable")?;
    if !contained(&entry.path, &root) {
        cache.entries.remove(&key);
        return Err("transcript_path_outside_root".into());
    }
    let complete = entry.refresh(source, session, &root)?;
    if (source == "codex" && !entry.parser.codex_identity)
        || (source == "claude" && !entry.parser.claude_identity)
    {
        return Err("transcript_session_mismatch".into());
    }
    let mut snapshot = entry.parser.snapshot(complete);
    if source == "claude" {
        let warnings_before = snapshot.warnings.len();
        file_tasks(&root, session, &mut snapshot);
        if snapshot.warnings.len() > warnings_before {
            for task in &mut snapshot.tasks {
                task.status = TaskStatus::Unknown;
            }
        }
    }
    Ok(snapshot)
}

/// Invoke with camelCase arguments. SSH callers must pass transportKind: "ssh";
/// this local/WSL API deliberately never reads a local transcript for SSH.
#[tauri::command]
pub async fn agent_tasks_get_snapshot(
    source: String,
    parent_session_id: String,
    cwd: String,
    config_dir: Option<String>,
    wsl_distro_name: Option<String>,
    transport_kind: Option<String>,
) -> Result<AgentTasksSnapshot, String> {
    tokio::task::spawn_blocking(move || {
        get_snapshot(
            &source,
            &parent_session_id,
            &cwd,
            config_dir.as_deref(),
            wsl_distro_name.as_deref(),
            transport_kind.as_deref(),
        )
    })
    .await
    .map_err(|_| "agent_tasks_worker_failed".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn feed(parser: &mut Parser, source: &str, root: &Path, v: Value) {
        parser.line(source, "parent", root, v.to_string().as_bytes());
    }
    fn tool(parser: &mut Parser, root: &Path, id: &str, name: &str, input: Value) {
        feed(
            parser,
            "claude",
            root,
            json!({"sessionId":"parent","message":{"role":"assistant","content":[{"type":"tool_use","id":id,"name":name,"input":input}]}}),
        );
    }
    fn result(
        parser: &mut Parser,
        root: &Path,
        id: &str,
        content: &str,
        structured: Value,
        error: bool,
    ) {
        feed(
            parser,
            "claude",
            root,
            json!({"sessionId":"parent","toolUseResult":structured,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":id,"content":content,"is_error":error}]}}),
        );
    }
    fn codex_tool(
        parser: &mut Parser,
        root: &Path,
        id: &str,
        name: &str,
        args: Value,
        output: &str,
    ) {
        feed(
            parser,
            "codex",
            root,
            json!({"type":"response_item","payload":{"type":"function_call","call_id":id,"name":name,"arguments":args.to_string()}}),
        );
        feed(
            parser,
            "codex",
            root,
            json!({"type":"response_item","payload":{"type":"function_call_output","call_id":id,"output":output}}),
        );
    }
    #[test]
    fn claude_tasks_require_successful_result_and_exclude_other_sessions() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        let mut p = Parser::default();
        tool(
            &mut p,
            root,
            "create",
            "TaskCreate",
            json!({"subject":"Build","description":"details"}),
        );
        assert!(p.tasks.is_empty());
        result(
            &mut p,
            root,
            "create",
            "Task #7 created successfully: Build",
            Value::Null,
            false,
        );
        assert!(matches!(p.tasks["7"].status, TaskStatus::Pending));
        tool(
            &mut p,
            root,
            "update",
            "TaskUpdate",
            json!({"taskId":"7","status":"in_progress"}),
        );
        result(&mut p, root, "update", "failed", Value::Null, true);
        assert!(matches!(p.tasks["7"].status, TaskStatus::Pending));
        tool(
            &mut p,
            root,
            "update2",
            "TaskUpdate",
            json!({"taskId":"7","status":"completed"}),
        );
        feed(
            &mut p,
            "claude",
            root,
            json!({"sessionId":"other","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"update2","content":"ok"}]}}),
        );
        assert!(matches!(p.tasks["7"].status, TaskStatus::Pending));
        result(&mut p, root, "update2", "ok", Value::Null, false);
        assert!(matches!(p.tasks["7"].status, TaskStatus::Done));
        feed(
            &mut p,
            "claude",
            root,
            json!({"sessionId":"parent","isSidechain":true,"message":{"role":"assistant","content":[{"type":"tool_use","id":"child","name":"TodoWrite","input":{"todos":[{"content":"wrong","status":"completed"}]}}]}}),
        );
        result(&mut p, root, "child", "ok", Value::Null, false);
        assert_eq!(p.tasks.len(), 1);
    }
    #[test]
    fn todo_replacement_preserves_modern_tasks() {
        let root = tempfile::tempdir().unwrap();
        let mut p = Parser::default();
        tool(
            &mut p,
            root.path(),
            "create",
            "TaskCreate",
            json!({"subject":"Build"}),
        );
        result(
            &mut p,
            root.path(),
            "create",
            "",
            json!({"task":{"id":"1"}}),
            false,
        );
        for (id, todos) in [
            (
                "a",
                json!([{"content":"first","status":"in_progress"},{"content":"second","status":"pending"}]),
            ),
            ("b", json!([{"content":"first","status":"completed"}])),
        ] {
            tool(&mut p, root.path(), id, "TodoWrite", json!({"todos":todos}));
            result(&mut p, root.path(), id, "ok", Value::Null, false);
        }
        assert_eq!(p.tasks.len(), 2);
        assert!(matches!(p.tasks["todo:0"].status, TaskStatus::Done));
        assert!(p.tasks.contains_key("1"));
    }
    #[test]
    fn background_requires_bash_id_and_notification_does_not_finish_on_parent_stop() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        let mut p = Parser::default();
        tool(
            &mut p,
            root,
            "bg",
            "Bash",
            json!({"command":"build","run_in_background":true}),
        );
        result(
            &mut p,
            root,
            "bg",
            "Command running in background with ID: b123. Output is being written to: /tmp/task",
            json!({"backgroundTaskId":"b123"}),
            false,
        );
        feed(
            &mut p,
            "claude",
            root,
            json!({"sessionId":"parent","type":"system","subtype":"stop"}),
        );
        assert!(matches!(p.background["b123"].status, TaskStatus::Running));
        tool(
            &mut p,
            root,
            "agent",
            "Task",
            json!({"run_in_background":true}),
        );
        result(
            &mut p,
            root,
            "agent",
            "",
            json!({"backgroundTaskId":"agent1"}),
            false,
        );
        feed(
            &mut p,
            "claude",
            root,
            json!({"sessionId":"parent","message":{"role":"user","content":"<task-notification>\n<task-id>agent1</task-id><status>completed</status></task-notification>"}}),
        );
        assert_eq!(p.background.len(), 1);
        feed(
            &mut p,
            "claude",
            root,
            json!({"sessionId":"parent","message":{"role":"user","content":"<task-notification>\n<task-id>b123</task-id><status>failed</status><summary>exit 1</summary></task-notification>"}}),
        );
        assert!(matches!(p.background["b123"].status, TaskStatus::Failed));
        assert_eq!(p.background["b123"].output.as_deref(), Some("exit 1"));
    }
    #[test]
    fn prefixed_notification_completes_only_confirmed_bash_id_inside_exact_block() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        let mut p = Parser::default();
        tool(
            &mut p,
            root,
            "bg",
            "Bash",
            json!({"command":"build","run_in_background":true}),
        );
        result(
            &mut p,
            root,
            "bg",
            "",
            json!({"backgroundTaskId":"b123"}),
            false,
        );
        let prefix =
            "[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event.\n";
        // Neither fields outside the block nor an unconfirmed child ID may
        // alter a confirmed Bash background task.
        p.notification(&format!("{prefix}<task-id>b123</task-id><status>completed</status><task-notification><task-id>agent1</task-id><status>completed</status></task-notification>"));
        assert_eq!(p.background.len(), 1);
        assert!(matches!(p.background["b123"].status, TaskStatus::Running));
        p.notification(&format!("{prefix}<task-notification><status>completed</status></task-notification><task-id>b123</task-id>"));
        assert!(matches!(p.background["b123"].status, TaskStatus::Running));
        p.notification(&format!(
            "{prefix}<task-notification><task-id>b123</task-id><status>completed</status>"
        ));
        assert!(matches!(p.background["b123"].status, TaskStatus::Running));
        feed(
            &mut p,
            "claude",
            root,
            json!({"sessionId":"parent","message":{"role":"user","content":[{"type":"text","text":format!("{prefix}<task-notification>\n<task-id>b123</task-id>\n<status>completed</status>\n<summary>build finished</summary>\n</task-notification>")}]}}),
        );
        assert!(matches!(p.background["b123"].status, TaskStatus::Done));
        assert_eq!(
            p.background["b123"].output.as_deref(),
            Some("build finished")
        );
        assert_eq!(p.background.len(), 1);
    }
    #[test]
    fn task_output_only_updates_existing_bash_task() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        let mut p = Parser::default();
        tool(&mut p, root, "bg", "Bash", json!({"command":"build"}));
        result(
            &mut p,
            root,
            "bg",
            "",
            json!({"backgroundTaskId":"b123"}),
            false,
        );
        tool(
            &mut p,
            root,
            "read",
            "TaskOutput",
            json!({"task_id":"b123"}),
        );
        result(
            &mut p,
            root,
            "read",
            "<task_id>b123</task_id><status>completed</status><output>ok</output>",
            Value::Null,
            false,
        );
        assert!(matches!(p.background["b123"].status, TaskStatus::Done));
    }
    #[test]
    fn completion_transports_match_real_five_command_session_and_are_isolated() {
        let root = tempfile::tempdir().unwrap();
        let mut p = Parser::default();
        for id in ["cargo", "build1", "build2", "build3", "build4"] {
            tool(
                &mut p,
                root.path(),
                id,
                "Bash",
                json!({"command":"build", "description":"Build installer"}),
            );
            result(
                &mut p,
                root.path(),
                id,
                "",
                json!({"backgroundTaskId":id}),
                false,
            );
        }
        let notice = |id: &str| {
            format!("<task-notification><task-id>{id}</task-id><tool-use-id>{id}</tool-use-id><status>completed</status><summary>finished</summary></task-notification>")
        };
        // The old CLI delivered these only as queue/attachment/system blobs.
        for event in [
            json!({"sessionId":"other", "type":"queue-operation", "operation":"enqueue", "content":notice("cargo")}),
            json!({"sessionId":"parent", "isSidechain":true, "type":"queue-operation", "operation":"enqueue", "content":notice("cargo")}),
            json!({"sessionId":"parent", "agentId":"child", "message":{"role":"system", "content":notice("cargo")}}),
        ] {
            feed(&mut p, "claude", root.path(), event);
        }
        assert!(matches!(p.background["cargo"].status, TaskStatus::Running));
        p.notification("<task-notification><task-id>cargo</task-id><tool-use-id>wrong</tool-use-id><status>completed</status></task-notification>");
        assert!(matches!(p.background["cargo"].status, TaskStatus::Running));
        feed(
            &mut p,
            "claude",
            root.path(),
            json!({"sessionId":"parent", "type":"queue-operation", "operation":"enqueue", "content":notice("cargo")}),
        );
        feed(
            &mut p,
            "claude",
            root.path(),
            json!({"sessionId":"parent", "type":"attachment", "attachment":{"type":"queued_command", "commandMode":"task-notification", "prompt":notice("build1")}}),
        );
        feed(
            &mut p,
            "claude",
            root.path(),
            json!({"sessionId":"parent", "type":"api-request-blob", "message":{"role":"system", "content":[{"type":"text", "text":format!("{}{}", "prefix ".repeat(TEXT_LIMIT), notice("build2"))}]}}),
        );
        feed(
            &mut p,
            "claude",
            root.path(),
            json!({"sessionId":"parent", "message":{"role":"user", "content":format!("{}{}", notice("build3"), notice("build4"))}}),
        );
        assert_eq!(p.snapshot(true).background_tasks.len(), 5);
        assert!(p
            .snapshot(true)
            .background_tasks
            .iter()
            .all(|t| matches!(t.status, TaskStatus::Done)));
        assert_eq!(p.background["cargo"].description, "Build installer");
        // A request snapshot or delayed running observation cannot resurrect it.
        feed(
            &mut p,
            "claude",
            root.path(),
            json!({"sessionId":"parent", "type":"api-request-blob", "message":{"role":"assistant", "content":[{"type":"tool_use", "id":"stale", "name":"Bash", "input":{"command":"build"}}]}}),
        );
        result(
            &mut p,
            root.path(),
            "stale",
            "",
            json!({"backgroundTaskId":"cargo"}),
            false,
        );
        tool(
            &mut p,
            root.path(),
            "poll",
            "TaskOutput",
            json!({"task_id":"cargo"}),
        );
        result(
            &mut p,
            root.path(),
            "poll",
            "",
            json!({"task":{"task_id":"cargo", "status":"running"}}),
            false,
        );
        assert!(matches!(p.background["cargo"].status, TaskStatus::Done));
    }
    #[test]
    fn task_output_and_stop_require_matched_successful_completion_evidence() {
        let root = tempfile::tempdir().unwrap();
        let mut p = Parser::default();
        for id in ["one", "two", "three"] {
            tool(&mut p, root.path(), id, "Bash", json!({"command":"build"}));
            result(
                &mut p,
                root.path(),
                id,
                "",
                json!({"backgroundTaskId":id}),
                false,
            );
        }
        tool(
            &mut p,
            root.path(),
            "mismatch",
            "TaskOutput",
            json!({"task_id":"one"}),
        );
        result(
            &mut p,
            root.path(),
            "mismatch",
            "",
            json!({"task":{"task_id":"two", "status":"completed"}}),
            false,
        );
        tool(
            &mut p,
            root.path(),
            "embedded",
            "TaskOutput",
            json!({"task_id":"one"}),
        );
        result(
            &mut p,
            root.path(),
            "embedded",
            "<output><task_id>one</task_id><status>completed</status></output>",
            Value::Null,
            false,
        );
        assert!(matches!(p.background["one"].status, TaskStatus::Running));
        tool(
            &mut p,
            root.path(),
            "exit",
            "TaskOutput",
            json!({"task_id":"one"}),
        );
        result(
            &mut p,
            root.path(),
            "exit",
            "<task_id>one</task_id><status>completed</status><exit_code>0</exit_code>",
            json!({"task":{"id":"one", "status":"completed", "exitCode":2, "output":"failed"}}),
            false,
        );
        assert!(matches!(p.background["one"].status, TaskStatus::Failed));
        tool(
            &mut p,
            root.path(),
            "stop-error",
            "TaskStop",
            json!({"task_id":"two"}),
        );
        result(
            &mut p,
            root.path(),
            "stop-error",
            "Task two successfully stopped",
            json!({"task_id":"two","task_type":"local_bash","message":"Task successfully stopped"}),
            true,
        );
        assert!(matches!(p.background["two"].status, TaskStatus::Running));
        tool(
            &mut p,
            root.path(),
            "stop",
            "TaskStop",
            json!({"task_id":"two"}),
        );
        result(
            &mut p,
            root.path(),
            "stop",
            "",
            json!({"task_id":"two","task_type":"local_bash","message":"Task successfully stopped"}),
            false,
        );
        assert!(matches!(p.background["two"].status, TaskStatus::Failed));
        tool(
            &mut p,
            root.path(),
            "text-array",
            "TaskOutput",
            json!({"task_id":"three"}),
        );
        feed(
            &mut p,
            "claude",
            root.path(),
            json!({"sessionId":"parent", "message":{"role":"user", "content":[{"type":"tool_result", "tool_use_id":"text-array", "content":[{"type":"text", "text":"<task_id>three</task_id><status>completed</status><exit_code>0</exit_code>"}]}]}}),
        );
        assert!(matches!(p.background["three"].status, TaskStatus::Done));
    }
    #[test]
    fn historical_launch_is_unknown_but_new_running_evidence_persists_until_completion() {
        use std::io::Write;
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("parent.jsonl");
        let launch = |id: &str| {
            format!(
                "{}\n{}\n",
                json!({"sessionId":"parent", "message":{"role":"assistant", "content":[{"type":"tool_use", "id":id, "name":"Bash", "input":{"command":"build"}}]}}),
                json!({"sessionId":"parent", "toolUseResult":{"backgroundTaskId":id}, "message":{"role":"user", "content":[{"type":"tool_result", "tool_use_id":id, "content":""}]}})
            )
        };
        fs::write(&path, launch("historical")).unwrap();
        let mut entry = Entry::new(path.clone());
        assert!(entry.refresh("claude", "parent", root.path()).unwrap());
        assert!(matches!(
            entry.parser.snapshot(true).background_tasks[0].status,
            TaskStatus::Unknown
        ));
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        write!(file, "{}", launch("live")).unwrap();
        assert!(entry.refresh("claude", "parent", root.path()).unwrap());
        assert!(entry.refresh("claude", "parent", root.path()).unwrap());
        let snapshot = entry.parser.snapshot(true);
        assert!(matches!(
            snapshot
                .background_tasks
                .iter()
                .find(|t| t.id == "live")
                .unwrap()
                .status,
            TaskStatus::Running
        ));
        assert!(matches!(
            snapshot
                .background_tasks
                .iter()
                .find(|t| t.id == "historical")
                .unwrap()
                .status,
            TaskStatus::Unknown
        ));
        writeln!(file, "{}", json!({"sessionId":"parent", "message":{"role":"assistant", "content":[{"type":"tool_use", "id":"poll-live", "name":"TaskOutput", "input":{"task_id":"historical"}}]}})).unwrap();
        writeln!(file, "{}", json!({"sessionId":"parent", "toolUseResult":{"task":{"task_id":"historical", "status":"running"}}, "message":{"role":"user", "content":[{"type":"tool_result", "tool_use_id":"poll-live", "content":""}]}})).unwrap();
        assert!(entry.refresh("claude", "parent", root.path()).unwrap());
        assert!(entry.refresh("claude", "parent", root.path()).unwrap());
        assert!(matches!(
            entry
                .parser
                .snapshot(true)
                .background_tasks
                .iter()
                .find(|t| t.id == "historical")
                .unwrap()
                .status,
            TaskStatus::Running
        ));
        writeln!(file, "{}", json!({"sessionId":"parent", "type":"queue-operation", "operation":"enqueue", "content":"<task-notification><task-id>historical</task-id><status>completed</status></task-notification>"})).unwrap();
        assert!(entry.refresh("claude", "parent", root.path()).unwrap());
        assert!(matches!(
            entry
                .parser
                .snapshot(true)
                .background_tasks
                .iter()
                .find(|t| t.id == "historical")
                .unwrap()
                .status,
            TaskStatus::Done
        ));
    }
    #[test]
    fn plan_association_uses_successful_exact_tool_path_never_latest_file() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        fs::create_dir(root.join("plans")).unwrap();
        fs::write(root.join("plans/unrelated.md"), "unrelated").unwrap();
        let mut p = Parser::default();
        tool(&mut p, root, "enter", "EnterPlanMode", json!({}));
        result(&mut p, root, "enter", "ok", Value::Null, false);
        assert!(p.plans["claude:plan"].content.is_empty());
        let path = root
            .join("plans/selected.md")
            .to_string_lossy()
            .into_owned();
        tool(
            &mut p,
            root,
            "write",
            "Write",
            json!({"file_path":path,"content":"chosen plan"}),
        );
        result(&mut p, root, "write", "ok", Value::Null, true);
        assert!(p.plans["claude:plan"].content.is_empty());
        tool(
            &mut p,
            root,
            "write2",
            "Write",
            json!({"file_path":path,"content":"chosen plan"}),
        );
        result(&mut p, root, "write2", "ok", Value::Null, false);
        assert_eq!(p.plans[&path].content, "chosen plan");
        tool(&mut p, root, "exit", "ExitPlanMode", json!({}));
        result(&mut p, root, "exit", "ok", Value::Null, false);
        assert!(matches!(p.plans[&path].status, TaskStatus::Pending));
        assert!(plan_path(root, &root.join("plans/../secret.md").to_string_lossy()).is_none());
        assert!(p.plans.values().all(|p| p.content != "unrelated"));
    }
    #[test]
    fn codex_plan_and_background_lifecycle_require_matching_outputs() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        let mut p = Parser::default();
        feed(
            &mut p,
            "codex",
            root,
            json!({"type":"session_meta","payload":{"id":"parent","source":"cli"}}),
        );
        codex_tool(
            &mut p,
            root,
            "plan1",
            "update_plan",
            json!({"plan":[{"step":"Build","status":"in_progress"}]}),
            "Plan updated",
        );
        assert!(matches!(
            p.tasks["codex:step:0"].status,
            TaskStatus::Running
        ));
        codex_tool(
            &mut p,
            root,
            "exec",
            "exec_command",
            json!({"cmd":"build"}),
            "Wall time: 1 seconds\nProcess running with session ID 123\nOutput:\n",
        );
        assert!(matches!(p.background["123"].status, TaskStatus::Running));
        codex_tool(
            &mut p,
            root,
            "wait",
            "write_stdin",
            json!({"session_id":123}),
            "Process exited with code 2\nOutput:\nfailed",
        );
        assert!(matches!(p.background["123"].status, TaskStatus::Failed));
        codex_tool(
            &mut p,
            root,
            "plan2",
            "functions.update_plan",
            json!({"plan":[{"step":"Build","status":"completed"}]}),
            "Plan updated",
        );
        assert!(matches!(p.plans["codex:plan"].status, TaskStatus::Done));
        feed(
            &mut p,
            "codex",
            root,
            json!({"type":"session_meta","payload":{"id":"other"}}),
        );
        codex_tool(
            &mut p,
            root,
            "plan3",
            "update_plan",
            json!({"plan":[]}),
            "Plan updated",
        );
        assert_eq!(p.tasks.len(), 1);
        assert!(matches!(
            p.snapshot(true).tasks[0].status,
            TaskStatus::Unknown
        ));
    }
    #[test]
    fn incomplete_and_malformed_transcripts_never_report_stale_completion() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("parent.jsonl");
        let line =
            json!({"sessionId":"parent","message":{"role":"assistant","content":[]}}).to_string();
        fs::write(&path, format!("{line}\n{{\"partial\"")).unwrap();
        let mut entry = Entry::new(path.clone());
        assert!(!entry.refresh("claude", "parent", root.path()).unwrap());
        assert_eq!(entry.offset, line.len() as u64 + 1);
        entry.parser.task(AgentTask {
            id: "1".into(),
            title: "done".into(),
            description: String::new(),
            status: TaskStatus::Done,
            detail: None,
        });
        assert!(matches!(
            entry.parser.snapshot(false).tasks[0].status,
            TaskStatus::Unknown
        ));
        fs::write(&path, format!("{line}\n")).unwrap();
        assert!(entry.refresh("claude", "parent", root.path()).unwrap());
        assert!(entry.parser.tasks.is_empty());
        assert!(entry.parser.claude_identity);
    }
    #[test]
    fn oversized_lines_are_skipped_and_poison_status_certainty() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("parent.jsonl");
        let mut data = vec![b'x'; MAX_LINE + 10];
        data.push(b'\n');
        data.extend_from_slice(
            json!({"sessionId":"parent","message":{"role":"assistant","content":[]}})
                .to_string()
                .as_bytes(),
        );
        data.push(b'\n');
        fs::write(&path, data).unwrap();
        let mut entry = Entry::new(path);
        assert!(entry.refresh("claude", "parent", root.path()).unwrap());
        assert!(entry.parser.uncertain);
        assert!(entry.parser.claude_identity);
        assert!(entry
            .parser
            .warnings
            .iter()
            .any(|s| s == "transcript_line_limit_reached"));
    }
    #[test]
    fn discovery_is_exact_and_task_files_are_scoped_to_parent() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        fs::create_dir_all(root.join("projects/project")).unwrap();
        fs::write(root.join("projects/project/parent.jsonl"), "").unwrap();
        fs::write(root.join("projects/project/other.jsonl"), "").unwrap();
        assert!(find_transcript("claude", "parent", "unmatched cwd", root)
            .unwrap()
            .ends_with("parent.jsonl"));
        fs::create_dir_all(root.join("tasks/parent")).unwrap();
        fs::create_dir_all(root.join("tasks/other")).unwrap();
        fs::write(
            root.join("tasks/parent/1.json"),
            json!({"id":"1","subject":"ours","status":"in_progress"}).to_string(),
        )
        .unwrap();
        fs::write(
            root.join("tasks/parent/2.json"),
            json!({"id":"9","subject":"mismatch","status":"completed"}).to_string(),
        )
        .unwrap();
        fs::write(
            root.join("tasks/other/3.json"),
            json!({"id":"3","subject":"wrong","status":"completed"}).to_string(),
        )
        .unwrap();
        let mut snapshot = AgentTasksSnapshot::default();
        file_tasks(root, "parent", &mut snapshot);
        assert_eq!(snapshot.tasks.len(), 1);
        assert_eq!(snapshot.tasks[0].title, "ours");
        assert!(matches!(snapshot.tasks[0].status, TaskStatus::Running));
        assert!(snapshot
            .warnings
            .iter()
            .any(|s| s == "task_file_identity_mismatch"));
        fs::create_dir_all(root.join("projects/duplicate")).unwrap();
        fs::write(root.join("projects/duplicate/parent.jsonl"), "").unwrap();
        assert_eq!(
            find_transcript("claude", "parent", "unmatched cwd", root).unwrap_err(),
            "transcript_ambiguous"
        );
    }
    #[test]
    fn input_and_transport_boundaries_are_explicit() {
        assert!(!safe_id("../parent"));
        assert!(!safe_id("/parent"));
        assert!(!safe_id("parent\\child"));
        assert!(
            get_snapshot("claude", "parent", "E:/work", None, None, Some("ssh"))
                .unwrap()
                .warnings
                .contains(&"ssh_agent_tasks_unsupported".into())
        );
        assert!(
            !get_snapshot("other", "parent", "E:/work", None, None, None)
                .unwrap()
                .supported
        );
        assert!(resolve_root("claude", "E:/work", Some("relative"), None).is_err());
        assert!(resolve_root(
            "claude",
            "\\\\wsl.localhost\\Ubuntu\\work",
            Some("\\\\wsl.localhost\\Debian\\home\\u\\.claude"),
            None
        )
        .is_err());
        let root = resolve_root(
            "claude",
            "/srv/work",
            Some("/home/u/.claude"),
            Some("Ubuntu"),
        )
        .unwrap();
        assert!(root.to_string_lossy().contains("Ubuntu"));
        assert_eq!(slug("E:/some.project"), "E--some-project");
    }
    #[test]
    fn transcript_polling_is_incremental_and_handles_partial_appends() {
        use std::io::Write;
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("parent.jsonl");
        let call = json!({"sessionId":"parent","message":{"role":"assistant","content":[{"type":"tool_use","id":"a","name":"TodoWrite","input":{"todos":[{"content":"work","status":"completed"}]}}]}}).to_string();
        let result = json!({"sessionId":"parent","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"a","content":"ok"}]}}).to_string();
        fs::write(&path, format!("{call}\n{}", &result[..result.len() / 2])).unwrap();
        let mut entry = Entry::new(path.clone());
        assert!(!entry.refresh("claude", "parent", root.path()).unwrap());
        let offset = entry.offset;
        assert!(!entry.refresh("claude", "parent", root.path()).unwrap());
        assert_eq!(entry.offset, offset);
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(file, "{}", &result[result.len() / 2..]).unwrap();
        assert!(entry.refresh("claude", "parent", root.path()).unwrap());
        assert!(matches!(
            entry.parser.tasks["todo:0"].status,
            TaskStatus::Done
        ));
        assert!(entry.parser.calls.is_empty());
        let offset = entry.offset;
        assert!(entry.refresh("claude", "parent", root.path()).unwrap());
        assert_eq!(entry.offset, offset);
    }
    #[test]
    #[ignore = "requires explicit local transcript opt-in; prints counts only"]
    fn local_transcript_smoke_counts_only() {
        let session = std::env::var("CLI_MANAGER_AGENT_TASKS_SMOKE_SESSION")
            .expect("explicit session required");
        let cwd =
            std::env::var("CLI_MANAGER_AGENT_TASKS_SMOKE_CWD").expect("explicit cwd required");
        let config = std::env::var("CLI_MANAGER_AGENT_TASKS_SMOKE_CONFIG")
            .expect("explicit config required");
        let deadline = Instant::now() + Duration::from_secs(15);
        let snapshot = loop {
            let snapshot =
                get_snapshot("claude", &session, &cwd, Some(&config), None, Some("local"))
                    .expect("local smoke read failed");
            if !snapshot
                .warnings
                .iter()
                .any(|s| s == "transcript_incomplete")
            {
                break snapshot;
            }
            assert!(Instant::now() < deadline, "smoke read budget exceeded");
        };
        println!(
            "tasks={} plans={} background={} done={} failed={} running={} unknown={} supported={}",
            snapshot.tasks.len(),
            snapshot.plans.len(),
            snapshot.background_tasks.len(),
            snapshot
                .background_tasks
                .iter()
                .filter(|t| matches!(t.status, TaskStatus::Done))
                .count(),
            snapshot
                .background_tasks
                .iter()
                .filter(|t| matches!(t.status, TaskStatus::Failed))
                .count(),
            snapshot
                .background_tasks
                .iter()
                .filter(|t| matches!(t.status, TaskStatus::Running))
                .count(),
            snapshot
                .background_tasks
                .iter()
                .filter(|t| matches!(t.status, TaskStatus::Unknown))
                .count(),
            snapshot.supported
        );
        if let Ok(expected) = std::env::var("CLI_MANAGER_AGENT_TASKS_SMOKE_EXPECT_DONE") {
            let expected = expected
                .parse::<usize>()
                .expect("expected count must be numeric");
            let ids = std::env::var("CLI_MANAGER_AGENT_TASKS_SMOKE_IDS").unwrap_or_default();
            let selected: Vec<_> = snapshot
                .background_tasks
                .iter()
                .filter(|t| ids.is_empty() || ids.split(',').any(|id| id == t.id))
                .collect();
            assert_eq!(selected.len(), expected);
            assert!(selected
                .iter()
                .all(|t| matches!(t.status, TaskStatus::Done)));
            println!(
                "selected_background={} selected_done={}",
                selected.len(),
                expected
            );
        }
        assert!(snapshot.supported);
    }
    #[test]
    fn serialization_is_the_public_camel_case_schema() {
        let value = serde_json::to_value(AgentTasksSnapshot {
            supported: true,
            background_tasks: vec![AgentBackgroundTask {
                id: "b1".into(),
                title: "build".into(),
                description: String::new(),
                status: TaskStatus::Unknown,
                output: None,
            }],
            ..Default::default()
        })
        .unwrap();
        assert_eq!(value["backgroundTasks"][0]["status"], "unknown");
        assert!(value.get("background_tasks").is_none());
        assert!(value["backgroundTasks"][0].get("output").is_none());
        assert!(value["warnings"].is_array());
    }
}
