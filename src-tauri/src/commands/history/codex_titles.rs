//! Codex Desktop's saved name takes precedence over a transcript excerpt.
use super::*;

#[derive(PartialEq, Eq)]
struct MetadataFingerprint {
    index: (Option<SystemTime>, u64),
    database_path: PathBuf,
    database: (Option<SystemTime>, u64),
    wal: (Option<SystemTime>, u64),
}

struct CachedTitles {
    fingerprint: MetadataFingerprint,
    titles: HashMap<String, String>,
}

static TITLE_CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedTitles>>> = OnceLock::new();

pub(super) fn saved_title(path: &Path, session_id: &str) -> Option<String> {
    let root = path.ancestors().find_map(|ancestor| {
        matches!(
            ancestor.file_name().and_then(|name| name.to_str()),
            Some("sessions" | "archived_sessions")
        )
        .then(|| ancestor.parent().map(Path::to_path_buf))
        .flatten()
    })?;
    let roots = HistoryRoots {
        claude_config_dir: None,
        codex_config_dir: Some(root.clone()),
    };
    let database_path = resolve_codex_state_db_path(&roots);
    let index_path = root.join("session_index.jsonl");
    let wal_path = PathBuf::from(format!("{}-wal", database_path.to_string_lossy()));
    let fingerprint = MetadataFingerprint {
        index: fingerprint(&index_path),
        database: fingerprint(&database_path),
        wal: fingerprint(&wal_path),
        database_path: database_path.clone(),
    };
    let mut cache = TITLE_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .ok()?;
    if let Some(cached) = cache
        .get(&root)
        .filter(|cached| cached.fingerprint == fingerprint)
    {
        return cached.titles.get(session_id).cloned();
    }
    let mut titles = read_index(&index_path);
    match read_database(&database_path) {
        Ok(database) => {
            // A saved Desktop name overrides the index; the database's legacy
            // title is only a fallback when no saved name/index title exists.
            for (id, name, title) in database {
                if let Some(name) = name {
                    titles.insert(id, name);
                } else if let Some(title) = title {
                    titles.entry(id).or_insert(title);
                }
            }
        }
        Err(error) => {
            debug!("Codex title metadata unavailable: {error}");
            // Do not cache a transient lock/read error as a definitive absence.
            return titles.get(session_id).cloned();
        }
    }
    let result = titles.get(session_id).cloned();
    cache.insert(
        root,
        CachedTitles {
            fingerprint,
            titles,
        },
    );
    result
}

fn clean_title(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn fingerprint(path: &Path) -> (Option<SystemTime>, u64) {
    fs::metadata(path)
        .map(|metadata| (metadata.modified().ok(), metadata.len()))
        .unwrap_or_default()
}

fn read_index(path: &Path) -> HashMap<String, String> {
    let mut titles = HashMap::new();
    let Ok(file) = File::open(path) else {
        return titles;
    };
    // session_index is append-only: the last valid record for an ID wins.
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let (Some(id), Some(title)) = (
            value.get("id").and_then(Value::as_str),
            clean_title(value.get("thread_name").and_then(Value::as_str)),
        ) {
            titles.insert(id.to_string(), title);
        }
    }
    titles
}

type DatabaseTitle = (String, Option<String>, Option<String>);

fn read_database(path: &Path) -> Result<Vec<DatabaseTitle>, String> {
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let path = path.to_path_buf();
    let read = move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| e.to_string())?;
        runtime.block_on(async move {
            let options = SqliteConnectOptions::new()
                .filename(path)
                .read_only(true)
                .busy_timeout(Duration::from_millis(100));
            let mut conn = SqliteConnection::connect_with(&options)
                .await
                .map_err(|e| e.to_string())?;
            let columns = sqlx::query("PRAGMA table_info(threads)")
                .fetch_all(&mut conn)
                .await
                .map_err(|e| e.to_string())?;
            let has = |column: &str| {
                columns
                    .iter()
                    .any(|row| row.try_get::<String, _>("name").ok().as_deref() == Some(column))
            };
            if !has("id") {
                return Ok(Vec::new());
            }
            let query = format!(
                "SELECT id, {} AS name, {} AS title FROM threads",
                if has("name") { "name" } else { "NULL" },
                if has("title") { "title" } else { "NULL" }
            );
            let rows = sqlx::query(&query)
                .fetch_all(&mut conn)
                .await
                .map_err(|e| e.to_string())?;
            rows.into_iter()
                .map(|row| {
                    Ok((
                        row.try_get("id").map_err(|e| e.to_string())?,
                        clean_title(
                            row.try_get::<Option<String>, _>("name")
                                .ok()
                                .flatten()
                                .as_deref(),
                        ),
                        clean_title(
                            row.try_get::<Option<String>, _>("title")
                                .ok()
                                .flatten()
                                .as_deref(),
                        )
                        .filter(|title| title_candidate_from_text(title).is_some()),
                    ))
                })
                .collect()
        })
    };
    if tokio::runtime::Handle::try_current().is_ok() {
        std::thread::spawn(read)
            .join()
            .map_err(|_| "codex_title_reader_panicked".to_string())?
    } else {
        read()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rollout(root: &Path) -> PathBuf {
        let path = root.join("sessions/2026/10/rollout-thread.jsonl");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread\"}}\n{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"original user request\"}]}}\n").unwrap();
        path
    }

    #[tokio::test]
    async fn desktop_name_wins_and_wal_rename_does_not_require_transcript_changes() {
        let temp = tempfile::TempDir::new().unwrap();
        let path = rollout(temp.path());
        let before = session_file_fingerprint(&path);
        fs::write(
            temp.path().join("session_index.jsonl"),
            "{\"id\":\"thread\",\"thread_name\":\"older index name\"}\n",
        )
        .unwrap();
        let options = SqliteConnectOptions::new()
            .filename(temp.path().join("state_5.sqlite"))
            .create_if_missing(true)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);
        let mut conn = SqliteConnection::connect_with(&options).await.unwrap();
        sqlx::query("CREATE TABLE threads(id TEXT PRIMARY KEY, name TEXT, title TEXT)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO threads VALUES ('thread', '合并 UI 分支并编译', 'original user request')",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        assert_eq!(
            saved_title(&path, "thread").as_deref(),
            Some("合并 UI 分支并编译")
        );
        let previous = HistoryIndexEntry {
            file_ref: SessionFileRef {
                source: "codex".into(),
                project_key: "project".into(),
                path: path.clone(),
            },
            fingerprint: before,
            computed: scan_session_computation(&path, 1, 2),
        };
        assert_eq!(previous.computed.title, "合并 UI 分支并编译");
        sqlx::query("UPDATE threads SET name = 'Desktop 中修改的新名称' WHERE id = 'thread'")
            .execute(&mut conn)
            .await
            .unwrap();
        assert_eq!(
            saved_title(&path, "thread").as_deref(),
            Some("Desktop 中修改的新名称")
        );
        let (computed, messages) = scan_session_computation_with_messages(&path, 1, 2);
        assert_eq!(computed.title, "Desktop 中修改的新名称");
        let next = HistoryIndexEntry {
            computed,
            ..previous.clone()
        };
        assert!(!history_index_entries_match(&[previous], &[next]));
        assert_eq!(messages[0].content, "original user request");
        assert!(before == session_file_fingerprint(&path));
    }

    #[test]
    fn latest_index_name_is_scoped_to_its_codex_root_and_supports_archives() {
        let first = tempfile::TempDir::new().unwrap();
        let second = tempfile::TempDir::new().unwrap();
        let first_path = rollout(first.path());
        let second_path = rollout(second.path());
        fs::write(first.path().join("session_index.jsonl"), "{\"id\":\"thread\",\"thread_name\":\"old\"}\ninvalid\n{\"id\":\"thread\",\"thread_name\":\"合并 UI 分支并编译\"}\n{partial").unwrap();
        fs::write(
            second.path().join("session_index.jsonl"),
            "{\"id\":\"thread\",\"thread_name\":\"another root\"}\n",
        )
        .unwrap();
        assert_eq!(
            saved_title(&first_path, "thread").as_deref(),
            Some("合并 UI 分支并编译")
        );
        assert_eq!(
            saved_title(&second_path, "thread").as_deref(),
            Some("another root")
        );
        assert_eq!(
            saved_title(
                &first.path().join("archived_sessions/rollout-thread.jsonl"),
                "thread"
            )
            .as_deref(),
            Some("合并 UI 分支并编译")
        );
        assert_eq!(saved_title(&first_path, "unknown"), None);
    }

    #[tokio::test]
    async fn older_databases_without_name_use_the_index_before_the_legacy_title() {
        let temp = tempfile::TempDir::new().unwrap();
        let path = rollout(temp.path());
        let mut conn = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(temp.path().join("state_5.sqlite"))
                .create_if_missing(true),
        )
        .await
        .unwrap();
        sqlx::query("CREATE TABLE threads(id TEXT, title TEXT)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO threads VALUES ('thread', 'legacy saved title')")
            .execute(&mut conn)
            .await
            .unwrap();
        assert_eq!(
            saved_title(&path, "thread").as_deref(),
            Some("legacy saved title")
        );
        fs::write(
            temp.path().join("session_index.jsonl"),
            "{\"id\":\"thread\",\"thread_name\":\"saved index name\"}\n",
        )
        .unwrap();
        assert_eq!(
            saved_title(&path, "thread").as_deref(),
            Some("saved index name")
        );
    }
}
