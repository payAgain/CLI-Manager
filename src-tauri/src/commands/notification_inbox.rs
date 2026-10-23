//! A small durable Hook inbox. Its SQLite file is independent of UI migrations so
//! the daemon can receive events while the WebView (or the entire app) is closed.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqliteSynchronous};
use sqlx::{Connection, Row, SqliteConnection};
use std::path::Path;
use std::sync::{mpsc, OnceLock};
use std::time::Duration;
use tauri::Emitter;

const MAX_ENTRIES: i64 = 2_000;
const RETENTION_MS: i64 = 90 * 24 * 60 * 60 * 1_000;
const MAX_PAGE_SIZE: i64 = 50;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxEntry {
    pub sequence: i64,
    pub event_id: String,
    pub event: String,
    pub source: String,
    pub tab_id: String,
    pub cli_session_id: Option<String>,
    pub agent_run_id: Option<String>,
    pub environment: String,
    pub host_id: Option<String>,
    pub wsl_distro: Option<String>,
    pub project_id: Option<String>,
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub message: Option<String>,
    pub tool_name: Option<String>,
    pub occurred_at: Option<String>,
    pub received_at: i64,
    pub read_at: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxPage {
    pub entries: Vec<InboxEntry>,
    pub unread_count: i64,
    pub latest_sequence: i64,
    pub next_before: Option<i64>,
    pub trimmed_count: i64,
    pub unread_targets: Vec<UnreadTarget>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxTarget {
    pub source: String,
    pub tab_id: String,
    pub cli_session_id: Option<String>,
    pub agent_run_id: Option<String>,
    pub environment: String,
    pub host_id: Option<String>,
    pub wsl_distro: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnreadTarget {
    #[serde(flatten)]
    pub target: InboxTarget,
    pub count: i64,
    pub latest_sequence: i64,
}

fn now_ms() -> i64 { chrono::Utc::now().timestamp_millis() }

fn text(value: &Value, key: &str, limit: usize) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::trim)
        .filter(|value| !value.is_empty()).map(|value| value.chars().take(limit).collect())
}

fn classify(payload: &Value) -> bool {
    let event = payload.get("event").and_then(Value::as_str).unwrap_or_default();
    if !matches!(event, "Notification" | "PermissionRequest" | "Stop" | "StopFailure") { return false; }
    // Child turns share a parent's tab and conversation. They must not create a
    // false parent-completed item; their lifecycle remains in the transcript UI.
    !(payload.get("source").and_then(Value::as_str) == Some("codex")
        && text(payload, "agentId", 256).is_some() && matches!(event, "Stop" | "StopFailure"))
}

fn entry_from_payload(payload: &Value, received_at: i64) -> InboxEntry {
    let environment = if text(payload, "environmentType", 16).as_deref() == Some("ssh") { "ssh" }
        else if text(payload, "wslDistroName", 256).is_some() || text(payload, "environmentType", 16).as_deref() == Some("wsl") { "wsl" }
        else { "local" }.to_string();
    let source = text(payload, "source", 32).unwrap_or_else(|| "claude".into());
    let host_id = if environment == "ssh" { text(payload, "remoteHostId", 256) } else { None };
    let wsl_distro = if environment == "wsl" { text(payload, "wslDistroName", 256) } else { None };
    // Older helpers did not send an ID. A timestamped payload still has a stable
    // fingerprint; timestamp-less events get a distinct ID rather than merging
    // unrelated completions with identical text.
    let raw_id = text(payload, "remoteEventId", 256).unwrap_or_else(|| {
        if text(payload, "timestamp", 128).is_some() { format!("legacy:{:x}", Sha256::digest(payload.to_string().as_bytes())) }
        else { uuid::Uuid::new_v4().to_string() }
    });
    let event_id = format!("{:x}", Sha256::digest(format!("{source}\0{environment}\0{}\0{}\0{raw_id}", host_id.as_deref().unwrap_or_default(), wsl_distro.as_deref().unwrap_or_default()).as_bytes()));
    InboxEntry {
        sequence: 0, event_id, event: text(payload, "event", 32).unwrap_or_default(), source,
        tab_id: text(payload, "tabId", 512).unwrap_or_default(),
        cli_session_id: text(payload, "sessionId", 512), agent_run_id: text(payload, "agentRunId", 512),
        environment, host_id, wsl_distro, project_id: text(payload, "remoteProjectId", 256),
        cwd: text(payload, "cwd", 4096), title: text(payload, "title", 160), message: text(payload, "message", 2048),
        tool_name: text(payload, "toolName", 256), occurred_at: text(payload, "timestamp", 128),
        received_at, read_at: None,
    }
}

async fn open_at(path: &Path) -> Result<SqliteConnection, String> {
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    let options = SqliteConnectOptions::new().filename(path).create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal).synchronous(SqliteSynchronous::Full)
        .busy_timeout(Duration::from_secs(3));
    let mut conn = SqliteConnection::connect_with(&options).await.map_err(|e| e.to_string())?;
    sqlx::query("CREATE TABLE IF NOT EXISTS inbox_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, received_at INTEGER NOT NULL, read_at INTEGER, entry_json TEXT NOT NULL)").execute(&mut conn).await.map_err(|e| e.to_string())?;
    sqlx::query("CREATE INDEX IF NOT EXISTS inbox_unread ON inbox_events(read_at, sequence)").execute(&mut conn).await.map_err(|e| e.to_string())?;
    sqlx::query("CREATE TABLE IF NOT EXISTS inbox_seen (event_id TEXT PRIMARY KEY, received_at INTEGER NOT NULL)").execute(&mut conn).await.map_err(|e| e.to_string())?;
    sqlx::query("CREATE TABLE IF NOT EXISTS inbox_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)").execute(&mut conn).await.map_err(|e| e.to_string())?;
    sqlx::query("CREATE INDEX IF NOT EXISTS inbox_received ON inbox_events(received_at)").execute(&mut conn).await.map_err(|e| e.to_string())?;
    sqlx::query("CREATE INDEX IF NOT EXISTS inbox_seen_received ON inbox_seen(received_at)").execute(&mut conn).await.map_err(|e| e.to_string())?;
    Ok(conn)
}

async fn open() -> Result<SqliteConnection, String> {
    open_at(&crate::app_paths::cli_manager_data_dir()?.join("notifications.sqlite3")).await
}

async fn insert(conn: &mut SqliteConnection, payload: &Value, received_at: i64) -> Result<bool, String> {
    if !classify(payload) { return Ok(true); }
    let entry = entry_from_payload(payload, received_at);
    let json = serde_json::to_string(&entry).map_err(|e| e.to_string())?;
    let mut tx = conn.begin().await.map_err(|e| e.to_string())?;
    let inserted = sqlx::query("INSERT OR IGNORE INTO inbox_seen(event_id, received_at) VALUES(?, ?)")
        .bind(&entry.event_id).bind(received_at).execute(&mut *tx).await.map_err(|e| e.to_string())?.rows_affected() > 0;
    if inserted {
        sqlx::query("INSERT INTO inbox_events(event_id, received_at, entry_json) VALUES(?, ?, ?)").bind(&entry.event_id).bind(received_at).bind(json).execute(&mut *tx).await.map_err(|e| e.to_string())?;
        let removed = sqlx::query("DELETE FROM inbox_events WHERE received_at < ? OR sequence NOT IN (SELECT sequence FROM inbox_events ORDER BY sequence DESC LIMIT ?)")
            .bind(received_at - RETENTION_MS).bind(MAX_ENTRIES).execute(&mut *tx).await.map_err(|e| e.to_string())?.rows_affected();
        if removed > 0 {
            sqlx::query("INSERT INTO inbox_meta(key, value) VALUES('trimmed', ?) ON CONFLICT(key) DO UPDATE SET value = value + excluded.value")
                .bind(removed as i64).execute(&mut *tx).await.map_err(|e| e.to_string())?;
        }
        // Tombstones survive clear-read and capacity eviction, preventing a replay
        // from turning an already handled notification into a new unread item.
        sqlx::query("DELETE FROM inbox_seen WHERE received_at < ? OR event_id NOT IN (SELECT event_id FROM inbox_seen ORDER BY received_at DESC LIMIT 20000)")
            .bind(received_at - RETENTION_MS).execute(&mut *tx).await.map_err(|e| e.to_string())?;
    }
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(inserted)
}

enum WriteReply {
    Blocking(mpsc::SyncSender<Result<bool, String>>),
    Legacy(tauri::AppHandle),
}
type WriteRequest = (Value, WriteReply);
static WRITER: OnceLock<Result<mpsc::SyncSender<WriteRequest>, String>> = OnceLock::new();

/// Hook HTTP and SSH bridge threads may block for the journal commit. PTY output
/// has its own transport and never enters this queue. Backpressure is explicit:
/// an overloaded/unavailable journal fails the Hook request, allowing retry.
fn journal_writer() -> Result<&'static mpsc::SyncSender<WriteRequest>, String> {
    WRITER.get_or_init(|| {
        let (sender, receiver) = mpsc::sync_channel::<WriteRequest>(128);
        std::thread::Builder::new().name("notification-inbox".into()).spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                Ok(runtime) => runtime, Err(error) => { log::error!("inbox runtime unavailable: {error}"); return; }
            };
            let mut conn = None;
            for (payload, reply) in receiver {
                let result = runtime.block_on(async {
                    if conn.is_none() { conn = Some(open().await?); }
                    insert(conn.as_mut().expect("opened inbox"), &payload, now_ms()).await
                });
                if result.is_err() { conn = None; }
                match reply {
                    WriteReply::Blocking(reply) => { let _ = reply.send(result); }
                    WriteReply::Legacy(app) => {
                        let mut payload = payload;
                        if let Err(error) = result {
                            log::error!("legacy daemon inbox persistence failed: {error}");
                            payload["inboxPersistenceError"] = Value::Bool(true);
                        }
                        let _ = app.emit("claude-hook-notification", payload);
                    }
                }
            }
        }).map_err(|e| e.to_string())?;
        Ok(sender)
    }).as_ref().map_err(Clone::clone)
}

pub(crate) fn record_hook(payload: &Value) -> Result<bool, String> {
    if !classify(payload) { return Ok(true); }
    let (reply, receive) = mpsc::sync_channel(1);
    journal_writer()?.try_send((payload.clone(), WriteReply::Blocking(reply))).map_err(|e| format!("notification_inbox_busy: {e}"))?;
    receive.recv_timeout(Duration::from_secs(8)).map_err(|e| format!("notification_inbox_timeout: {e}"))?
}

/// Older-daemon events enter the same bounded worker without waiting on disk in
/// the daemon control-frame reader. Completion emits the original Hook to UI.
pub(crate) fn record_legacy_hook(payload: Value, app: tauri::AppHandle) -> Result<(), String> {
    if !classify(&payload) { return app.emit("claude-hook-notification", payload).map_err(|e| e.to_string()); }
    journal_writer()?.try_send((payload, WriteReply::Legacy(app))).map_err(|e| format!("notification_inbox_busy: {e}"))
}

async fn page(conn: &mut SqliteConnection, before: Option<i64>, unread_only: bool, limit: i64) -> Result<InboxPage, String> {
    let mut tx = conn.begin().await.map_err(|e| e.to_string())?;
    let limit = limit.clamp(1, MAX_PAGE_SIZE);
    let rows = sqlx::query("SELECT sequence, entry_json, read_at FROM inbox_events WHERE (? IS NULL OR sequence < ?) AND (? = 0 OR read_at IS NULL) ORDER BY sequence DESC LIMIT ?")
        .bind(before).bind(before).bind(unread_only).bind(limit + 1).fetch_all(&mut *tx).await.map_err(|e| e.to_string())?;
    let has_more = rows.len() > limit as usize;
    let mut entries = Vec::new();
    for row in rows.into_iter().take(limit as usize) {
        let mut entry: InboxEntry = serde_json::from_str(row.get::<&str, _>("entry_json")).map_err(|e| e.to_string())?;
        entry.sequence = row.get("sequence"); entry.read_at = row.get("read_at"); entries.push(entry);
    }
    let summary = sqlx::query("SELECT COALESCE(SUM(read_at IS NULL), 0) AS unread, COALESCE(MAX(sequence), 0) AS latest FROM inbox_events").fetch_one(&mut *tx).await.map_err(|e| e.to_string())?;
    let trimmed = sqlx::query("SELECT value FROM inbox_meta WHERE key = 'trimmed'").fetch_optional(&mut *tx).await.map_err(|e| e.to_string())?.map(|row| row.get("value")).unwrap_or(0);
    let groups = sqlx::query("SELECT json_extract(entry_json, '$.source') AS source, json_extract(entry_json, '$.tabId') AS tab_id, json_extract(entry_json, '$.cliSessionId') AS cli_session_id, json_extract(entry_json, '$.agentRunId') AS agent_run_id, json_extract(entry_json, '$.environment') AS environment, json_extract(entry_json, '$.hostId') AS host_id, json_extract(entry_json, '$.wslDistro') AS wsl_distro, COUNT(*) AS count, MAX(sequence) AS latest FROM inbox_events WHERE read_at IS NULL GROUP BY source, tab_id, cli_session_id, agent_run_id, environment, host_id, wsl_distro")
        .fetch_all(&mut *tx).await.map_err(|e| e.to_string())?;
    let unread_targets = groups.into_iter().map(|row| UnreadTarget { target: InboxTarget {
        source: row.get("source"), tab_id: row.get("tab_id"), cli_session_id: row.get("cli_session_id"), agent_run_id: row.get("agent_run_id"), environment: row.get("environment"), host_id: row.get("host_id"), wsl_distro: row.get("wsl_distro"),
    }, count: row.get("count"), latest_sequence: row.get("latest") }).collect();
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(InboxPage { next_before: if has_more { entries.last().map(|entry| entry.sequence) } else { None }, entries,
        unread_count: summary.get("unread"), latest_sequence: summary.get("latest"), trimmed_count: trimmed, unread_targets })
}

#[tauri::command]
pub async fn notification_inbox_list(before: Option<i64>, unread_only: Option<bool>, limit: Option<i64>) -> Result<InboxPage, String> {
    let mut conn = open().await?;
    // Retention also runs on user access, so an otherwise idle installation does
    // not keep showing expired records indefinitely. No background sweep timer.
    let cutoff = now_ms() - RETENTION_MS;
    let mut tx = conn.begin().await.map_err(|e| e.to_string())?;
    let removed = sqlx::query("DELETE FROM inbox_events WHERE received_at < ?").bind(cutoff).execute(&mut *tx).await.map_err(|e| e.to_string())?.rows_affected();
    if removed > 0 {
        sqlx::query("INSERT INTO inbox_meta(key, value) VALUES('trimmed', ?) ON CONFLICT(key) DO UPDATE SET value = value + excluded.value")
            .bind(removed as i64).execute(&mut *tx).await.map_err(|e| e.to_string())?;
    }
    sqlx::query("DELETE FROM inbox_seen WHERE received_at < ?").bind(cutoff).execute(&mut *tx).await.map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    page(&mut conn, before, unread_only.unwrap_or(false), limit.unwrap_or(MAX_PAGE_SIZE)).await
}

#[tauri::command]
pub async fn notification_inbox_set_read(event_ids: Vec<String>, read: bool) -> Result<(), String> {
    if event_ids.len() > 200 || event_ids.iter().any(|id| id.len() > 128) { return Err("notification_inbox_invalid_ids".into()); }
    let mut conn = open().await?;
    let mut tx = conn.begin().await.map_err(|e| e.to_string())?;
    let read_at = if read { Some(now_ms()) } else { None };
    for id in event_ids { sqlx::query("UPDATE inbox_events SET read_at = ? WHERE event_id = ?").bind(read_at).bind(id).execute(&mut *tx).await.map_err(|e| e.to_string())?; }
    tx.commit().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn notification_inbox_mark_all_read(through_sequence: i64) -> Result<(), String> {
    sqlx::query("UPDATE inbox_events SET read_at = ? WHERE read_at IS NULL AND sequence <= ?").bind(now_ms()).bind(through_sequence).execute(&mut open().await?).await.map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn notification_inbox_clear_read() -> Result<(), String> {
    sqlx::query("DELETE FROM inbox_events WHERE read_at IS NOT NULL").execute(&mut open().await?).await.map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn notification_inbox_mark_target_read(target: InboxTarget, through_sequence: i64) -> Result<(), String> {
    if target.source.len() > 32 || target.tab_id.len() > 512 || target.cli_session_id.as_ref().is_some_and(|s| s.len() > 512)
        || target.agent_run_id.as_ref().is_some_and(|s| s.len() > 512) || target.host_id.as_ref().is_some_and(|s| s.len() > 256)
        || target.wsl_distro.as_ref().is_some_and(|s| s.len() > 256) || !matches!(target.environment.as_str(), "local" | "wsl" | "ssh") {
        return Err("notification_inbox_invalid_target".into());
    }
    sqlx::query("UPDATE inbox_events SET read_at = ? WHERE read_at IS NULL AND sequence <= ? AND json_extract(entry_json, '$.source') = ? AND json_extract(entry_json, '$.tabId') = ? AND json_extract(entry_json, '$.cliSessionId') IS ? AND json_extract(entry_json, '$.agentRunId') IS ? AND json_extract(entry_json, '$.environment') = ? AND json_extract(entry_json, '$.hostId') IS ? AND json_extract(entry_json, '$.wslDistro') IS ?")
        .bind(now_ms()).bind(through_sequence).bind(target.source).bind(target.tab_id).bind(target.cli_session_id).bind(target.agent_run_id)
        .bind(target.environment).bind(target.host_id).bind(target.wsl_distro)
        .execute(&mut open().await?).await.map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn event(id: &str) -> Value { json!({"tabId":"pty-1","source":"codex","event":"Stop","remoteEventId":id,"sessionId":"cli-1","cwd":"/work","timestamp":"2026-10-23T01:02:03Z"}) }

    #[tokio::test]
    async fn durable_unread_dedup_and_read_state_survive_reopen() {
        let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("inbox.sqlite3");
        let mut conn = open_at(&path).await.unwrap();
        assert!(insert(&mut conn, &event("one"), 1000).await.unwrap());
        assert!(!insert(&mut conn, &event("one"), 1001).await.unwrap());
        let entry = page(&mut conn, None, false, 50).await.unwrap().entries.remove(0);
        sqlx::query("UPDATE inbox_events SET read_at = 1002 WHERE event_id = ?").bind(&entry.event_id).execute(&mut conn).await.unwrap();
        conn.close().await.unwrap();
        let mut conn = open_at(&path).await.unwrap();
        let list = page(&mut conn, None, false, 50).await.unwrap();
        assert_eq!(list.entries.len(), 1); assert_eq!(list.unread_count, 0); assert_eq!(list.entries[0].read_at, Some(1002));
        sqlx::query("DELETE FROM inbox_events").execute(&mut conn).await.unwrap();
        assert!(!insert(&mut conn, &event("one"), 1003).await.unwrap());
    }

    #[tokio::test]
    async fn mark_all_cursor_does_not_consume_new_arrivals_and_hosts_are_isolated() {
        let dir = tempfile::tempdir().unwrap(); let mut conn = open_at(&dir.path().join("inbox.sqlite3")).await.unwrap();
        let mut a = event("same"); a["environmentType"] = json!("ssh"); a["remoteHostId"] = json!("host-a");
        let mut b = a.clone(); b["remoteHostId"] = json!("host-b");
        insert(&mut conn, &a, 1000).await.unwrap();
        let cursor = page(&mut conn, None, false, 50).await.unwrap().latest_sequence;
        insert(&mut conn, &b, 1001).await.unwrap();
        sqlx::query("UPDATE inbox_events SET read_at = 1002 WHERE sequence <= ?").bind(cursor).execute(&mut conn).await.unwrap();
        let list = page(&mut conn, None, true, 50).await.unwrap();
        assert_eq!(list.unread_count, 1); assert_eq!(list.entries[0].host_id.as_deref(), Some("host-b"));
    }

    #[tokio::test]
    async fn retention_is_bounded_and_reports_trimming() {
        let dir = tempfile::tempdir().unwrap(); let mut conn = open_at(&dir.path().join("inbox.sqlite3")).await.unwrap();
        insert(&mut conn, &event("old"), 1).await.unwrap();
        insert(&mut conn, &event("new"), RETENTION_MS + 2).await.unwrap();
        let list = page(&mut conn, None, false, 50).await.unwrap();
        assert_eq!(list.entries.len(), 1); assert_eq!(list.trimmed_count, 1);
        let mut child = event("child"); child["agentId"] = json!("agent");
        assert!(!classify(&child));
        for name in ["SessionStart", "ToolStart", "ToolStop", "UserPromptSubmit"] { let mut payload = event(name); payload["event"] = json!(name); assert!(!classify(&payload)); }
    }
}
