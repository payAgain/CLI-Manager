use crate::shell_resolver::{output_with_timeout, silent_command};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Connection, Row, SqliteConnection};
use std::collections::{BTreeMap, HashSet, VecDeque};
use std::env;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

const PROFILE_FILE_NAME: &str = "profile.json";
const CONFIG_FILE_NAME: &str = "config.toml";
const LOG_FILE_NAME: &str = "cc-connect.log";
const MAX_LOG_LINES: usize = 1_000;
const DEFAULT_LOG_PAGE_SIZE: usize = 200;
const MAX_LOG_PAGE_SIZE: usize = 500;
const MAX_CAPTURED_LOG_LINE_BYTES: usize = 8 * 1024;
const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(6);
const CONFIG_FORMAT_TIMEOUT: Duration = Duration::from_secs(8);
const TELEGRAM_TOKEN_ACCOUNT: &str = "cc-connect-telegram-token";
const FEISHU_APP_ID_ACCOUNT: &str = "cc-connect-feishu-app-id";
const FEISHU_APP_SECRET_ACCOUNT: &str = "cc-connect-feishu-app-secret";
const TELEGRAM_TOKEN_ENV: &str = "CLI_MANAGER_CC_TELEGRAM_TOKEN";
const FEISHU_APP_ID_ENV: &str = "CLI_MANAGER_CC_FEISHU_APP_ID";
const FEISHU_APP_SECRET_ENV: &str = "CLI_MANAGER_CC_FEISHU_APP_SECRET";
// Official v1.4.1 executable digests from the upstream release checksums.txt.
// Hash before executing --version so an arbitrary PATH candidate cannot run during detection.
const VERIFIED_V1_4_1_BINARY_SHA256: &[&str] = &[
    "C71905EA41981564ADE01EF9FC2A7BCC567E3A47A166D82F6176E520378D25BE",
    "9F1F99B9D5EC790E5B7C3CF929EDA6274DCD80A9DA28A95241C41E3217AA9A83",
    "FB0EE29DBBEDE9BF5F7D22BEC88EF89517B31FC0E46AFB639F26D3627B82CB11",
    "419FB47D77158408F63B124288A59C0EE61E80DB090EF08306F1CE96E372AD21",
    "D3F7B0C673A4D5539A461639C98ECA054D18B1FA38FC1AFC6422A7BBF3A2B18D",
    "A3CD94B23C84F5269534B0FC9316BDE0B9FEA8D8FC8EB9E4C13C22776D0D421",
];

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CcConnectAgent {
    Claude,
    Codex,
}

impl CcConnectAgent {
    fn config_type(self) -> &'static str {
        match self {
            Self::Claude => "claudecode",
            Self::Codex => "codex",
        }
    }
    fn safe_mode(self) -> &'static str {
        match self {
            Self::Claude => "default",
            Self::Codex => "suggest",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CcConnectPlatform {
    Telegram,
    Feishu,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CcConnectLanguage {
    Zh,
    En,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CcConnectProfile {
    pub auto_start: bool,
    pub executable_path: Option<String>,
    pub project_id: String,
    pub project_name: String,
    pub project_path: String,
    pub agent: CcConnectAgent,
    pub platform: CcConnectPlatform,
    pub allow_from: String,
    pub language: CcConnectLanguage,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CcConnectSaveProfileRequest {
    pub profile: CcConnectProfile,
    pub telegram_token: Option<String>,
    pub feishu_app_id: Option<String>,
    pub feishu_app_secret: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcConnectStatus {
    pub installed: bool,
    pub executable_path: Option<String>,
    pub version: Option<String>,
    pub sha256: Option<String>,
    pub compatible: bool,
    pub detection_error: Option<String>,
    pub config_path: String,
    pub data_dir: String,
    pub log_path: String,
    pub profile: Option<CcConnectProfile>,
    pub config_exists: bool,
    pub credentials_ready: bool,
    pub ready: bool,
    pub blockers: Vec<String>,
    pub warnings: Vec<String>,
    pub running: bool,
    pub starting: bool,
    pub pid: Option<u32>,
    pub started_at_ms: Option<i64>,
    pub last_exit_code: Option<i32>,
    pub last_exit_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcConnectLogLine {
    pub seq: u64,
    pub timestamp_ms: i64,
    pub source: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcConnectLogPage {
    pub lines: Vec<CcConnectLogLine>,
    pub next_seq: u64,
    pub log_path: String,
}

#[derive(Debug, Clone)]
struct DetectedBinary {
    path: PathBuf,
    version: Option<String>,
    sha256: String,
    compatible: bool,
}

#[derive(Debug, Clone)]
struct DetectionCache {
    requested_path: Option<String>,
    result: Result<DetectedBinary, String>,
}

struct ManagedProcess {
    child: Child,
    #[cfg(target_os = "windows")]
    job: ChildJob,
    started_at_ms: i64,
}

#[derive(Default)]
struct ProcessState {
    process: Option<ManagedProcess>,
    starting: bool,
    last_exit_code: Option<i32>,
    last_exit_at_ms: Option<i64>,
}

struct CcConnectLogBuffer {
    next_seq: u64,
    lines: VecDeque<CcConnectLogLine>,
}

impl Default for CcConnectLogBuffer {
    fn default() -> Self {
        Self {
            next_seq: 1,
            lines: VecDeque::new(),
        }
    }
}

impl CcConnectLogBuffer {
    fn push(&mut self, source: &str, message: String) {
        self.lines.push_back(CcConnectLogLine {
            seq: self.next_seq,
            timestamp_ms: now_millis(),
            source: source.to_string(),
            message,
        });
        self.next_seq = self.next_seq.saturating_add(1);
        while self.lines.len() > MAX_LOG_LINES {
            self.lines.pop_front();
        }
    }

    fn page(&self, after_seq: u64, limit: usize) -> Vec<CcConnectLogLine> {
        self.lines
            .iter()
            .filter(|line| line.seq > after_seq)
            .take(limit)
            .cloned()
            .collect()
    }
}

type SharedLogWriter = Arc<Mutex<Option<crate::log_rotation::DailyRollingLogWriter>>>;

#[derive(Clone)]
pub struct CcConnectManager {
    operation: Arc<Mutex<()>>,
    process: Arc<Mutex<ProcessState>>,
    logs: Arc<Mutex<CcConnectLogBuffer>>,
    log_writer: SharedLogWriter,
    detection: Arc<Mutex<Option<DetectionCache>>>,
}

impl Default for CcConnectManager {
    fn default() -> Self {
        Self {
            operation: Arc::new(Mutex::new(())),
            process: Arc::new(Mutex::new(ProcessState::default())),
            logs: Arc::new(Mutex::new(CcConnectLogBuffer::default())),
            log_writer: Arc::new(Mutex::new(None)),
            detection: Arc::new(Mutex::new(None)),
        }
    }
}

impl CcConnectManager {
    pub fn new() -> Self {
        Self::default()
    }

    fn ensure_log_writer(&self) -> Result<(), String> {
        let mut writer = self
            .log_writer
            .lock()
            .map_err(|_| "cc-connect log writer lock poisoned".to_string())?;
        if writer.is_none() {
            *writer = Some(
                crate::log_rotation::create_log_writer(
                    crate::app_paths::logs_dir()?,
                    LOG_FILE_NAME,
                )
                .map_err(|err| format!("create cc-connect log failed: {err}"))?,
            );
        }
        Ok(())
    }

    fn append_system_log(&self, message: impl Into<String>) {
        let _ = self.ensure_log_writer();
        push_log_line(&self.logs, &self.log_writer, "system", &message.into(), &[]);
    }

    fn detect(&self, explicit_path: Option<&str>, refresh: bool) -> Result<DetectedBinary, String> {
        let requested_path = explicit_path
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let requested_key = requested_path.map(ToOwned::to_owned);
        if !refresh {
            if let Ok(cache) = self.detection.lock() {
                if let Some(cache) = cache.as_ref() {
                    if cache.requested_path == requested_key {
                        return cache.result.clone();
                    }
                }
            }
        }
        let result = detect_binary_uncached(requested_path);
        if let Ok(mut cache) = self.detection.lock() {
            *cache = Some(DetectionCache {
                requested_path: requested_key,
                result: result.clone(),
            });
        }
        result
    }

    fn refresh_process_state(&self) {
        let exited = {
            let Ok(mut state) = self.process.lock() else {
                return;
            };
            let Some(process) = state.process.as_mut() else {
                return;
            };
            match process.child.try_wait() {
                Ok(Some(status)) => {
                    let code = status.code();
                    state.process.take();
                    state.last_exit_code = code;
                    state.last_exit_at_ms = Some(now_millis());
                    Some(code)
                }
                Ok(None) => None,
                Err(err) => {
                    state.process.take();
                    state.last_exit_code = None;
                    state.last_exit_at_ms = Some(now_millis());
                    self.append_system_log(format!("failed to inspect cc-connect process: {err}"));
                    Some(None)
                }
            }
        };
        if let Some(code) = exited {
            self.append_system_log(format!("cc-connect exited (code={code:?})"));
        }
    }

    fn log_page(
        &self,
        after_seq: Option<u64>,
        limit: Option<usize>,
    ) -> Result<CcConnectLogPage, String> {
        let after_seq = after_seq.unwrap_or(0);
        let limit = limit
            .unwrap_or(DEFAULT_LOG_PAGE_SIZE)
            .clamp(1, MAX_LOG_PAGE_SIZE);
        let logs = self
            .logs
            .lock()
            .map_err(|_| "cc-connect log buffer lock poisoned".to_string())?;
        let lines = logs.page(after_seq, limit);
        let next_seq = lines.last().map(|line| line.seq).unwrap_or(after_seq);
        Ok(CcConnectLogPage {
            lines,
            next_seq,
            log_path: path_string(&log_path()?),
        })
    }
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn remote_manager_dir() -> Result<PathBuf, String> {
    Ok(crate::app_paths::cli_manager_data_dir()?.join("remote-manager"))
}
fn profile_path() -> Result<PathBuf, String> {
    Ok(remote_manager_dir()?.join(PROFILE_FILE_NAME))
}
fn config_path() -> Result<PathBuf, String> {
    Ok(remote_manager_dir()?.join(CONFIG_FILE_NAME))
}
fn data_dir() -> Result<PathBuf, String> {
    Ok(remote_manager_dir()?.join("data"))
}
fn log_path() -> Result<PathBuf, String> {
    Ok(crate::app_paths::logs_dir()?.join(LOG_FILE_NAME))
}
fn path_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn detect_binary_uncached(explicit_path: Option<&str>) -> Result<DetectedBinary, String> {
    let candidates = executable_candidates(explicit_path)?;
    let mut failures = Vec::new();
    let mut incompatible = None;
    for candidate in candidates {
        if !candidate.is_file() {
            continue;
        }
        match inspect_binary(&candidate) {
            Ok(binary) if binary.compatible => return Ok(binary),
            Ok(binary) => {
                if incompatible.is_none() {
                    incompatible = Some(binary);
                }
            }
            Err(err) => failures.push(format!("{}: {err}", candidate.display())),
        }
    }
    if let Some(binary) = incompatible {
        return Ok(binary);
    }
    if failures.is_empty() {
        Err("cc-connect native executable not found in PATH".to_string())
    } else {
        Err(failures.join("; "))
    }
}

fn executable_candidates(explicit_path: Option<&str>) -> Result<Vec<PathBuf>, String> {
    let mut raw = Vec::new();
    if let Some(explicit) = explicit_path {
        let path = PathBuf::from(explicit);
        if !path.is_absolute() {
            return Err("cc-connect executable path must be absolute".to_string());
        }
        raw.extend(expand_native_candidate(&path));
    } else {
        if let Some(path) = env::var_os("CC_CONNECT_PATH") {
            raw.extend(expand_native_candidate(&PathBuf::from(path)));
        }
        if let Some(path_value) = env::var_os("PATH") {
            for dir in env::split_paths(&path_value) {
                #[cfg(target_os = "windows")]
                {
                    raw.push(
                        dir.join("node_modules")
                            .join("cc-connect")
                            .join("bin")
                            .join("cc-connect.exe"),
                    );
                    raw.push(dir.join("cc-connect.exe"));
                }
                #[cfg(not(target_os = "windows"))]
                raw.push(dir.join("cc-connect"));
            }
        }
    }
    let mut seen = HashSet::new();
    Ok(raw
        .into_iter()
        .filter(|path| seen.insert(path.to_string_lossy().to_lowercase()))
        .collect())
}

fn expand_native_candidate(path: &Path) -> Vec<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let mut candidates = Vec::new();
        if let Some(parent) = path.parent() {
            candidates.push(
                parent
                    .join("node_modules")
                    .join("cc-connect")
                    .join("bin")
                    .join("cc-connect.exe"),
            );
        }
        if path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("exe"))
        {
            candidates.insert(0, path.to_path_buf());
        }
        candidates
    }
    #[cfg(not(target_os = "windows"))]
    {
        vec![path.to_path_buf()]
    }
}

fn inspect_binary(path: &Path) -> Result<DetectedBinary, String> {
    if !path.is_file() {
        return Err("not a file".to_string());
    }
    let canonical = path
        .canonicalize()
        .map_err(|err| format!("canonicalize failed: {err}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if canonical
            .metadata()
            .map_err(|err| format!("read metadata failed: {err}"))?
            .permissions()
            .mode()
            & 0o111
            == 0
        {
            return Err("file is not executable".to_string());
        }
    }
    let sha256 = sha256_file(&canonical)?;
    if !is_verified_binary_hash(&sha256) {
        return Ok(DetectedBinary {
            path: canonical,
            version: None,
            sha256,
            compatible: false,
        });
    }
    let mut command = silent_command(&path_string(&canonical));
    command.arg("--version");
    let output = output_with_timeout(command, VERSION_PROBE_TIMEOUT)
        .map_err(|err| format!("version probe failed: {err}"))?;
    if !output.status.success() {
        return Err(format!(
            "version probe exited with {}: {}",
            output.status,
            output_text(&output.stdout, &output.stderr)
        ));
    }
    let version_output = output_text(&output.stdout, &output.stderr);
    let (version, compatible) = parse_version(&version_output)
        .ok_or_else(|| format!("unrecognized version output: {version_output}"))?;
    Ok(DetectedBinary {
        sha256,
        path: canonical,
        version: Some(version),
        compatible,
    })
}

fn is_verified_binary_hash(sha256: &str) -> bool {
    VERIFIED_V1_4_1_BINARY_SHA256
        .iter()
        .any(|expected| expected.eq_ignore_ascii_case(sha256))
}

fn output_text(stdout: &[u8], stderr: &[u8]) -> String {
    let stdout = String::from_utf8_lossy(stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(stderr).trim().to_string();
    if stdout.is_empty() {
        stderr
    } else {
        stdout
    }
}

fn parse_version(output: &str) -> Option<(String, bool)> {
    let token = output.split_whitespace().find(|token| {
        token
            .trim_start_matches('v')
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_digit())
    })?;
    let clean = token.trim_matches(|c: char| !(c.is_ascii_digit() || c == '.'));
    let mut parts = clean.split('.');
    let major = parts.next()?.parse::<u64>().ok()?;
    let minor = parts.next()?.parse::<u64>().ok()?;
    let patch = parts.next().unwrap_or("0").parse::<u64>().ok()?;
    Some((
        format!("{major}.{minor}.{patch}"),
        major == 1 && minor == 4 && patch == 1,
    ))
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|err| format!("open executable failed: {err}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|err| format!("read executable failed: {err}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:X}", hasher.finalize()))
}

#[derive(Serialize)]
struct ManagedConfig {
    data_dir: String,
    language: String,
    max_turn_time_mins: u32,
    queue: ManagedQueueConfig,
    rate_limit: ManagedRateLimitConfig,
    log: ManagedLogConfig,
    webhook: DisabledFeature,
    bridge: DisabledFeature,
    management: DisabledFeature,
    projects: Vec<ManagedProject>,
}
#[derive(Serialize)]
struct ManagedLogConfig {
    level: String,
}
#[derive(Serialize)]
struct ManagedQueueConfig {
    max_depth: u32,
}
#[derive(Serialize)]
struct ManagedRateLimitConfig {
    max_messages: u32,
    window_secs: u32,
}
#[derive(Serialize)]
struct DisabledFeature {
    enabled: bool,
}
#[derive(Serialize)]
struct ManagedProject {
    name: String,
    admin_from: String,
    disabled_commands: Vec<String>,
    reset_on_idle_mins: u32,
    agent: ManagedAgent,
    platforms: Vec<ManagedPlatform>,
}
#[derive(Serialize)]
struct ManagedAgent {
    #[serde(rename = "type")]
    kind: String,
    options: ManagedAgentOptions,
}
#[derive(Serialize)]
struct ManagedAgentOptions {
    work_dir: String,
    mode: String,
    env: BTreeMap<String, String>,
}
#[derive(Serialize)]
struct ManagedPlatform {
    #[serde(rename = "type")]
    kind: String,
    options: BTreeMap<String, toml::Value>,
}

fn build_managed_config(profile: &CcConnectProfile) -> Result<ManagedConfig, String> {
    let allow_from = normalize_allow_from(profile.platform, &profile.allow_from)?;
    let mut options = BTreeMap::new();
    options.insert("allow_from".to_string(), toml::Value::String(allow_from));
    options.insert("group_reply_all".to_string(), toml::Value::Boolean(false));
    options.insert(
        "share_session_in_channel".to_string(),
        toml::Value::Boolean(false),
    );
    match profile.platform {
        CcConnectPlatform::Telegram => {
            options.insert(
                "token".to_string(),
                toml::Value::String(format!("${{{}}}", TELEGRAM_TOKEN_ENV)),
            );
            options.insert("enable_reactions".to_string(), toml::Value::Boolean(false));
            options.insert(
                "progress_style".to_string(),
                toml::Value::String("compact".to_string()),
            );
        }
        CcConnectPlatform::Feishu => {
            options.insert(
                "app_id".to_string(),
                toml::Value::String(format!("${{{}}}", FEISHU_APP_ID_ENV)),
            );
            options.insert(
                "app_secret".to_string(),
                toml::Value::String(format!("${{{}}}", FEISHU_APP_SECRET_ENV)),
            );
            options.insert("group_only".to_string(), toml::Value::Boolean(false));
            options.insert("thread_isolation".to_string(), toml::Value::Boolean(false));
            options.insert("reply_to_trigger".to_string(), toml::Value::Boolean(true));
        }
    }
    Ok(ManagedConfig {
        data_dir: config_path_value(&data_dir()?),
        language: match profile.language {
            CcConnectLanguage::Zh => "zh",
            CcConnectLanguage::En => "en",
        }
        .to_string(),
        max_turn_time_mins: 15,
        queue: ManagedQueueConfig { max_depth: 2 },
        rate_limit: ManagedRateLimitConfig {
            max_messages: 10,
            window_secs: 60,
        },
        log: ManagedLogConfig {
            level: "info".to_string(),
        },
        webhook: DisabledFeature { enabled: false },
        bridge: DisabledFeature { enabled: false },
        management: DisabledFeature { enabled: false },
        projects: vec![ManagedProject {
            name: profile.project_name.clone(),
            admin_from: String::new(),
            // Preserve basic session controls while blocking commands that can
            // change authorization, persistence, providers, workspaces, or files.
            disabled_commands: [
                "list",
                "switch",
                "name",
                "current",
                "history",
                "allow",
                "mode",
                "provider",
                "memory",
                "cron",
                "timer",
                "heartbeat",
                "commands",
                "skills",
                "config",
                "doctor",
                "upgrade",
                "restart",
                "alias",
                "delete",
                "bind",
                "search",
                "shell",
                "show",
                "dir",
                "tts",
                "workspace",
                "web",
                "diff",
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
            reset_on_idle_mins: 0,
            agent: ManagedAgent {
                kind: profile.agent.config_type().to_string(),
                options: ManagedAgentOptions {
                    work_dir: config_path_value(Path::new(&profile.project_path)),
                    mode: profile.agent.safe_mode().to_string(),
                    // cc-connect resolves platform placeholders in its own process,
                    // then MergeEnv lets these empty values override inheritance into
                    // Claude/Codex child processes.
                    env: [
                        (TELEGRAM_TOKEN_ENV.to_string(), String::new()),
                        (FEISHU_APP_ID_ENV.to_string(), String::new()),
                        (FEISHU_APP_SECRET_ENV.to_string(), String::new()),
                    ]
                    .into_iter()
                    .collect(),
                },
            },
            platforms: vec![ManagedPlatform {
                kind: match profile.platform {
                    CcConnectPlatform::Telegram => "telegram",
                    CcConnectPlatform::Feishu => "feishu",
                }
                .to_string(),
                options,
            }],
        }],
    })
}

fn user_path_string(path: &Path) -> String {
    let value = path.to_string_lossy();
    #[cfg(target_os = "windows")]
    let value = if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = value.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        value.into_owned()
    };
    #[cfg(not(target_os = "windows"))]
    let value = value.into_owned();
    value
}

fn config_path_value(path: &Path) -> String {
    user_path_string(path).replace('\\', "/")
}

fn write_file_atomically(path: &Path, payload: &[u8], label: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{label} parent is missing"))?;
    fs::create_dir_all(parent).map_err(|err| format!("create {label} directory failed: {err}"))?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("cc-connect");
    let temp = parent.join(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        now_millis()
    ));
    let result = (|| {
        let mut file =
            File::create(&temp).map_err(|err| format!("create temporary {label} failed: {err}"))?;
        file.write_all(payload)
            .map_err(|err| format!("write temporary {label} failed: {err}"))?;
        file.sync_all()
            .map_err(|err| format!("sync temporary {label} failed: {err}"))?;
        replace_file(&temp, path).map_err(|err| format!("replace {label} failed: {err}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(target_os = "windows")]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(())
    }
}

#[cfg(not(target_os = "windows"))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(|err| err.to_string())
}

fn write_managed_config(profile: &CcConnectProfile) -> Result<PathBuf, String> {
    let dir = remote_manager_dir()?;
    fs::create_dir_all(&dir).map_err(|err| format!("create remote manager dir failed: {err}"))?;
    fs::create_dir_all(data_dir()?)
        .map_err(|err| format!("create cc-connect data dir failed: {err}"))?;
    let path = config_path()?;
    let payload = toml::to_string_pretty(&build_managed_config(profile)?)
        .map_err(|err| format!("serialize cc-connect config failed: {err}"))?;
    write_file_atomically(&path, payload.as_bytes(), "cc-connect config")?;
    Ok(path)
}

fn load_profile() -> Result<Option<CcConnectProfile>, String> {
    let path = profile_path()?;
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("read cc-connect profile failed: {err}")),
    };
    serde_json::from_str(&raw)
        .map(Some)
        .map_err(|err| format!("parse cc-connect profile failed: {err}"))
}

fn persist_profile(profile: &CcConnectProfile) -> Result<(), String> {
    let path = profile_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("create remote manager dir failed: {err}"))?;
    }
    let payload = serde_json::to_string_pretty(profile)
        .map_err(|err| format!("serialize cc-connect profile failed: {err}"))?;
    write_file_atomically(&path, payload.as_bytes(), "cc-connect profile")
}

fn normalize_profile(
    manager: &CcConnectManager,
    mut profile: CcConnectProfile,
) -> Result<CcConnectProfile, String> {
    profile.project_id = profile.project_id.trim().to_string();
    profile.project_name = profile.project_name.trim().to_string();
    profile.project_path = profile.project_path.trim().to_string();
    if profile.project_id.is_empty() || profile.project_name.is_empty() {
        return Err("a CLI-Manager project must be selected".to_string());
    }
    let project_path = PathBuf::from(&profile.project_path);
    if !project_path.is_absolute() || !project_path.is_dir() {
        return Err("selected project path must be an existing absolute directory".to_string());
    }
    profile.project_path = path_string(
        &project_path
            .canonicalize()
            .map_err(|err| format!("canonicalize project path failed: {err}"))?,
    );
    validate_registered_project(&profile)?;
    profile.allow_from = normalize_allow_from(profile.platform, &profile.allow_from)?;
    profile.executable_path = profile
        .executable_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    if let Some(explicit_path) = profile.executable_path.as_deref() {
        let binary = manager.detect(Some(explicit_path), true)?;
        profile.executable_path = Some(path_string(&binary.path));
    }
    Ok(profile)
}

fn normalize_allow_from(platform: CcConnectPlatform, raw: &str) -> Result<String, String> {
    let mut seen = HashSet::new();
    let mut values = Vec::new();
    for value in raw
        .split(|ch| matches!(ch, ',' | ';' | '\n' | '\r'))
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if value == "*" {
            return Err("allow_from wildcard is forbidden".to_string());
        }
        let valid = match platform {
            CcConnectPlatform::Telegram => value.chars().all(|ch| ch.is_ascii_digit()),
            CcConnectPlatform::Feishu => value.starts_with("ou_") && value.len() > 3,
        };
        if !valid {
            return Err(match platform {
                CcConnectPlatform::Telegram => {
                    "Telegram allow_from must contain numeric user IDs".to_string()
                }
                CcConnectPlatform::Feishu => {
                    "Feishu allow_from must contain ou_ open IDs".to_string()
                }
            });
        }
        if seen.insert(value.to_string()) {
            values.push(value.to_string());
        }
    }
    if values.is_empty() {
        return Err("allow_from must contain at least one explicit user ID".to_string());
    }
    Ok(values.join(","))
}

fn profile_issue_codes(profile: &CcConnectProfile) -> Vec<String> {
    let mut issues = Vec::new();
    if profile.project_id.trim().is_empty() || profile.project_name.trim().is_empty() {
        issues.push("project_missing".to_string());
    }
    let path = Path::new(&profile.project_path);
    if !path.is_absolute() || !path.is_dir() {
        issues.push("project_path_missing".to_string());
    }
    if normalize_allow_from(profile.platform, &profile.allow_from).is_err() {
        issues.push("allowlist_invalid".to_string());
    }
    issues
}

fn validate_registered_project(profile: &CcConnectProfile) -> Result<(), String> {
    let database_path = crate::app_paths::db_path()?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|err| format!("create project validation runtime failed: {err}"))?;
    runtime.block_on(async {
        let options = SqliteConnectOptions::new()
            .filename(&database_path)
            .read_only(true)
            .busy_timeout(Duration::from_secs(3));
        let mut connection = SqliteConnection::connect_with(&options)
            .await
            .map_err(|err| format!("open CLI-Manager project database failed: {err}"))?;
        let row = sqlx::query("SELECT name, path FROM projects WHERE id = ? LIMIT 1")
            .bind(&profile.project_id)
            .fetch_optional(&mut connection)
            .await
            .map_err(|err| format!("query CLI-Manager project failed: {err}"))?
            .ok_or_else(|| "selected project is no longer registered in CLI-Manager".to_string())?;
        let current_name: String = row
            .try_get("name")
            .map_err(|err| format!("read project name failed: {err}"))?;
        let current_path: String = row
            .try_get("path")
            .map_err(|err| format!("read project path failed: {err}"))?;
        let current_path = PathBuf::from(current_path)
            .canonicalize()
            .map_err(|err| format!("canonicalize registered project path failed: {err}"))?;
        let profile_path = PathBuf::from(&profile.project_path)
            .canonicalize()
            .map_err(|err| format!("canonicalize remote profile project path failed: {err}"))?;
        if current_name != profile.project_name || current_path != profile_path {
            return Err(
                "remote profile is stale; save it again from the current project list".to_string(),
            );
        }
        Ok(())
    })
}

#[cfg(target_os = "windows")]
fn set_credential(account: &str, value: &str) -> Result<(), String> {
    crate::credential_store::entry(account)?
        .set_password(value)
        .map_err(|err| format!("save cc-connect credential failed: {err}"))
}
#[cfg(target_os = "windows")]
fn get_credential(account: &str) -> Result<Option<String>, String> {
    match crate::credential_store::entry(account)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring_core::Error::NoEntry) => Ok(None),
        Err(err) => Err(format!("read cc-connect credential failed: {err}")),
    }
}
#[cfg(target_os = "windows")]
fn delete_credential(account: &str) -> Result<(), String> {
    match crate::credential_store::entry(account)?.delete_credential() {
        Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
        Err(err) => Err(format!("delete cc-connect credential failed: {err}")),
    }
}
#[cfg(not(target_os = "windows"))]
fn set_credential(_account: &str, _value: &str) -> Result<(), String> {
    Err("secure cc-connect credential storage is only available on Windows".to_string())
}
#[cfg(not(target_os = "windows"))]
fn get_credential(_account: &str) -> Result<Option<String>, String> {
    Ok(None)
}
#[cfg(not(target_os = "windows"))]
fn delete_credential(_account: &str) -> Result<(), String> {
    Ok(())
}

fn save_request_credentials(request: &CcConnectSaveProfileRequest) -> Result<(), String> {
    match request.profile.platform {
        CcConnectPlatform::Telegram => {
            if let Some(value) = request
                .telegram_token
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                set_credential(TELEGRAM_TOKEN_ACCOUNT, value)?;
            }
        }
        CcConnectPlatform::Feishu => {
            if let Some(value) = request
                .feishu_app_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                set_credential(FEISHU_APP_ID_ACCOUNT, value)?;
            }
            if let Some(value) = request
                .feishu_app_secret
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                set_credential(FEISHU_APP_SECRET_ACCOUNT, value)?;
            }
        }
    }
    Ok(())
}

fn credentials_ready(platform: CcConnectPlatform) -> Result<bool, String> {
    Ok(match platform {
        CcConnectPlatform::Telegram => {
            get_credential(TELEGRAM_TOKEN_ACCOUNT)?.is_some_and(|value| !value.trim().is_empty())
        }
        CcConnectPlatform::Feishu => {
            get_credential(FEISHU_APP_ID_ACCOUNT)?.is_some_and(|value| !value.trim().is_empty())
                && get_credential(FEISHU_APP_SECRET_ACCOUNT)?
                    .is_some_and(|value| !value.trim().is_empty())
        }
    })
}

fn credential_environment(
    platform: CcConnectPlatform,
) -> Result<(Vec<(String, String)>, Vec<String>), String> {
    match platform {
        CcConnectPlatform::Telegram => {
            let token = get_credential(TELEGRAM_TOKEN_ACCOUNT)?
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "Telegram credential is missing".to_string())?;
            Ok((
                vec![(TELEGRAM_TOKEN_ENV.to_string(), token.clone())],
                vec![token],
            ))
        }
        CcConnectPlatform::Feishu => {
            let app_id = get_credential(FEISHU_APP_ID_ACCOUNT)?
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "Feishu app ID is missing".to_string())?;
            let app_secret = get_credential(FEISHU_APP_SECRET_ACCOUNT)?
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "Feishu app secret is missing".to_string())?;
            Ok((
                vec![
                    (FEISHU_APP_ID_ENV.to_string(), app_id.clone()),
                    (FEISHU_APP_SECRET_ENV.to_string(), app_secret.clone()),
                ],
                vec![app_id, app_secret],
            ))
        }
    }
}

struct CredentialSnapshot {
    entries: Vec<(&'static str, Option<String>)>,
}

impl CredentialSnapshot {
    fn capture(platform: Option<CcConnectPlatform>) -> Result<Self, String> {
        let accounts: Vec<&'static str> = match platform {
            Some(CcConnectPlatform::Telegram) => vec![TELEGRAM_TOKEN_ACCOUNT],
            Some(CcConnectPlatform::Feishu) => {
                vec![FEISHU_APP_ID_ACCOUNT, FEISHU_APP_SECRET_ACCOUNT]
            }
            None => vec![
                TELEGRAM_TOKEN_ACCOUNT,
                FEISHU_APP_ID_ACCOUNT,
                FEISHU_APP_SECRET_ACCOUNT,
            ],
        };
        let mut entries = Vec::with_capacity(accounts.len());
        for account in accounts {
            entries.push((account, get_credential(account)?));
        }
        Ok(Self { entries })
    }

    fn restore(&self) -> Result<(), String> {
        let mut errors = Vec::new();
        for (account, value) in &self.entries {
            if let Err(err) = restore_credential(account, value.as_deref()) {
                errors.push(err);
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
}

fn restore_credential(account: &str, value: Option<&str>) -> Result<(), String> {
    match value {
        Some(value) => set_credential(account, value),
        None => delete_credential(account),
    }
}

struct FileSnapshot {
    path: PathBuf,
    contents: Option<Vec<u8>>,
    label: &'static str,
}

impl FileSnapshot {
    fn capture(path: PathBuf, label: &'static str) -> Result<Self, String> {
        let contents = match fs::read(&path) {
            Ok(contents) => Some(contents),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
            Err(err) => return Err(format!("snapshot {label} failed: {err}")),
        };
        Ok(Self {
            path,
            contents,
            label,
        })
    }

    fn restore(&self) -> Result<(), String> {
        if let Some(contents) = self.contents.as_deref() {
            write_file_atomically(&self.path, contents, self.label)
        } else {
            match fs::remove_file(&self.path) {
                Ok(()) => Ok(()),
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(err) => Err(format!("remove rolled back {} failed: {err}", self.label)),
            }
        }
    }
}

impl CcConnectManager {
    fn save_profile(&self, request: CcConnectSaveProfileRequest) -> Result<(), String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "cc-connect operation lock poisoned".to_string())?;
        self.refresh_process_state();
        {
            let state = self
                .process
                .lock()
                .map_err(|_| "cc-connect process lock poisoned".to_string())?;
            if state.process.is_some() || state.starting {
                return Err(
                    "stop cc-connect before changing its profile or credentials".to_string()
                );
            }
        }
        let profile = normalize_profile(self, request.profile.clone())?;
        let credential_snapshot = CredentialSnapshot::capture(Some(request.profile.platform))?;
        let config_snapshot = FileSnapshot::capture(config_path()?, "cc-connect config")?;
        let profile_snapshot = FileSnapshot::capture(profile_path()?, "cc-connect profile")?;
        if let Err(save_error) = (|| {
            save_request_credentials(&request)?;
            write_managed_config(&profile)?;
            persist_profile(&profile)
        })() {
            let mut rollback_errors = Vec::new();
            if let Err(err) = profile_snapshot.restore() {
                rollback_errors.push(err);
            }
            if let Err(err) = config_snapshot.restore() {
                rollback_errors.push(err);
            }
            if let Err(err) = credential_snapshot.restore() {
                rollback_errors.push(err);
            }
            if rollback_errors.is_empty() {
                return Err(save_error);
            }
            return Err(format!(
                "{save_error}; rollback failed: {}",
                rollback_errors.join("; ")
            ));
        }
        if let Ok(mut cache) = self.detection.lock() {
            *cache = None;
        }
        self.append_system_log(format!(
            "cc-connect profile saved for project '{}' ({:?})",
            profile.project_name, profile.platform
        ));
        Ok(())
    }

    fn clear_credentials(&self, platform: Option<CcConnectPlatform>) -> Result<(), String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "cc-connect operation lock poisoned".to_string())?;
        self.refresh_process_state();
        {
            let state = self
                .process
                .lock()
                .map_err(|_| "cc-connect process lock poisoned".to_string())?;
            if state.process.is_some() || state.starting {
                return Err("stop cc-connect before clearing its credentials".to_string());
            }
        }
        let snapshot = CredentialSnapshot::capture(platform)?;
        let result = (|| {
            match platform {
                Some(CcConnectPlatform::Telegram) => delete_credential(TELEGRAM_TOKEN_ACCOUNT)?,
                Some(CcConnectPlatform::Feishu) => {
                    delete_credential(FEISHU_APP_ID_ACCOUNT)?;
                    delete_credential(FEISHU_APP_SECRET_ACCOUNT)?;
                }
                None => {
                    delete_credential(TELEGRAM_TOKEN_ACCOUNT)?;
                    delete_credential(FEISHU_APP_ID_ACCOUNT)?;
                    delete_credential(FEISHU_APP_SECRET_ACCOUNT)?;
                }
            }
            Ok(())
        })();
        if let Err(clear_error) = result {
            return match snapshot.restore() {
                Ok(()) => Err(clear_error),
                Err(rollback_error) => {
                    Err(format!("{clear_error}; rollback failed: {rollback_error}"))
                }
            };
        }
        self.append_system_log("cc-connect credentials cleared");
        Ok(())
    }

    fn status(&self, refresh_detection: bool) -> Result<CcConnectStatus, String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "cc-connect operation lock poisoned".to_string())?;
        self.refresh_process_state();
        let profile = load_profile()?;
        let explicit_path = profile
            .as_ref()
            .and_then(|profile| profile.executable_path.as_deref());
        let detection = self.detect(explicit_path, refresh_detection);
        let config_path = config_path()?;
        let config_exists = config_path.is_file();
        let mut blockers = Vec::new();
        let mut warnings = vec![
            "independent_sessions".to_string(),
            "current_user_permissions".to_string(),
        ];
        if let Some(profile) = profile.as_ref() {
            blockers.extend(profile_issue_codes(profile));
        } else {
            blockers.push("profile_missing".to_string());
        }
        if profile.is_some() && !config_exists {
            blockers.push("config_missing".to_string());
        }
        let (credentials_ready, credential_error) = match profile.as_ref() {
            Some(profile) => match credentials_ready(profile.platform) {
                Ok(ready) => (ready, None),
                Err(err) => (false, Some(err)),
            },
            None => (false, None),
        };
        if profile.is_some() && !credentials_ready {
            blockers.push(if credential_error.is_some() {
                "credential_store_error".to_string()
            } else {
                "credentials_missing".to_string()
            });
        }
        if credential_error.is_some() {
            warnings.push("credential_store_unavailable".to_string());
        }
        let (installed, executable_path, version, sha256, compatible, detection_error) =
            match detection {
                Ok(binary) => {
                    if !binary.compatible {
                        blockers.push("binary_incompatible".to_string());
                    }
                    (
                        true,
                        Some(user_path_string(&binary.path)),
                        binary.version,
                        Some(binary.sha256),
                        binary.compatible,
                        None,
                    )
                }
                Err(err) => {
                    blockers.push("binary_missing".to_string());
                    (
                        false,
                        explicit_path.map(ToOwned::to_owned),
                        None,
                        None,
                        false,
                        Some(err),
                    )
                }
            };
        blockers.sort();
        blockers.dedup();
        warnings.sort();
        warnings.dedup();
        let process = self
            .process
            .lock()
            .map_err(|_| "cc-connect process lock poisoned".to_string())?;
        let running = process.process.is_some();
        let pid = process.process.as_ref().map(|process| process.child.id());
        let started_at_ms = process
            .process
            .as_ref()
            .map(|process| process.started_at_ms);
        let starting = process.starting;
        let last_exit_code = process.last_exit_code;
        let last_exit_at_ms = process.last_exit_at_ms;
        drop(process);
        Ok(CcConnectStatus {
            installed,
            executable_path,
            version,
            sha256,
            compatible,
            detection_error,
            config_path: path_string(&config_path),
            data_dir: path_string(&data_dir()?),
            log_path: path_string(&log_path()?),
            profile,
            config_exists,
            credentials_ready,
            ready: blockers.is_empty(),
            blockers,
            warnings,
            running,
            starting,
            pid,
            started_at_ms,
            last_exit_code,
            last_exit_at_ms,
        })
    }

    fn start(&self) -> Result<(), String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "cc-connect operation lock poisoned".to_string())?;
        self.start_inner()
    }

    fn start_inner(&self) -> Result<(), String> {
        self.refresh_process_state();
        {
            let mut state = self
                .process
                .lock()
                .map_err(|_| "cc-connect process lock poisoned".to_string())?;
            if state.process.is_some() {
                return Err("cc-connect is already running under CLI-Manager".to_string());
            }
            if state.starting {
                return Err("cc-connect is already starting".to_string());
            }
            state.starting = true;
        }
        let result = self.prepare_process();
        let mut state = self
            .process
            .lock()
            .map_err(|_| "cc-connect process lock poisoned".to_string())?;
        state.starting = false;
        match result {
            Ok(process) => {
                state.process = Some(process);
                drop(state);
                self.append_system_log("cc-connect managed process started");
                Ok(())
            }
            Err(err) => {
                drop(state);
                self.append_system_log(format!("cc-connect start failed: {err}"));
                Err(err)
            }
        }
    }

    fn prepare_process(&self) -> Result<ManagedProcess, String> {
        let profile =
            load_profile()?.ok_or_else(|| "cc-connect profile is not configured".to_string())?;
        let issues = profile_issue_codes(&profile);
        if !issues.is_empty() {
            return Err(format!(
                "cc-connect profile is invalid: {}",
                issues.join(", ")
            ));
        }
        validate_registered_project(&profile)?;
        let binary = self.detect(profile.executable_path.as_deref(), true)?;
        if !binary.compatible {
            return Err(format!(
                "cc-connect {} is not the verified v1.4.1 build",
                binary.version.as_deref().unwrap_or("binary")
            ));
        }
        let config_path = write_managed_config(&profile)?;
        format_and_check_config_syntax(&binary.path, &config_path)?;
        let (environment, secrets) = credential_environment(profile.platform)?;
        self.ensure_log_writer()?;
        let mut command = silent_command(&path_string(&binary.path));
        command
            .arg("--config")
            .arg(&config_path)
            .current_dir(
                config_path
                    .parent()
                    .ok_or_else(|| "cc-connect config parent is missing".to_string())?,
            )
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (key, value) in environment {
            command.env(key, value);
        }
        let mut child = command
            .spawn()
            .map_err(|err| format!("spawn cc-connect failed: {err}"))?;
        #[cfg(target_os = "windows")]
        let job = match ChildJob::assign(&child) {
            Ok(job) => job,
            Err(err) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(err);
            }
        };
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let secrets = Arc::new(secrets);
        if let Some(stdout) = stdout {
            spawn_log_reader(
                stdout,
                "stdout",
                self.logs.clone(),
                self.log_writer.clone(),
                secrets.clone(),
            );
        }
        if let Some(stderr) = stderr {
            spawn_log_reader(
                stderr,
                "stderr",
                self.logs.clone(),
                self.log_writer.clone(),
                secrets,
            );
        }
        std::thread::sleep(Duration::from_millis(350));
        if let Some(status) = child
            .try_wait()
            .map_err(|err| format!("inspect cc-connect startup failed: {err}"))?
        {
            return Err(format!(
                "cc-connect exited during startup (code={:?})",
                status.code()
            ));
        }
        Ok(ManagedProcess {
            child,
            #[cfg(target_os = "windows")]
            job,
            started_at_ms: now_millis(),
        })
    }

    fn stop(&self) -> Result<(), String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "cc-connect operation lock poisoned".to_string())?;
        self.stop_inner()
    }

    fn stop_inner(&self) -> Result<(), String> {
        self.refresh_process_state();
        let mut process = {
            let mut state = self
                .process
                .lock()
                .map_err(|_| "cc-connect process lock poisoned".to_string())?;
            if state.starting {
                return Err("cc-connect is still starting".to_string());
            }
            state.process.take()
        };
        let Some(mut process) = process.take() else {
            return Ok(());
        };
        #[cfg(target_os = "windows")]
        process.job.terminate();
        let _ = process.child.kill();
        #[cfg(target_os = "windows")]
        let status = {
            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            loop {
                match process.child.try_wait() {
                    Ok(Some(status)) => break Some(status),
                    Ok(None) if std::time::Instant::now() < deadline => {
                        std::thread::sleep(Duration::from_millis(50))
                    }
                    Ok(None) => {
                        self.append_system_log("cc-connect stop timed out; closing the Job Object");
                        break None;
                    }
                    Err(err) => {
                        self.append_system_log(format!("inspect cc-connect stop failed: {err}"));
                        break None;
                    }
                }
            }
        };
        #[cfg(not(target_os = "windows"))]
        let status = process.child.wait().ok();
        let exit_code = status.as_ref().and_then(|status| status.code());
        {
            let mut state = self
                .process
                .lock()
                .map_err(|_| "cc-connect process lock poisoned".to_string())?;
            state.last_exit_code = exit_code;
            state.last_exit_at_ms = Some(now_millis());
        }
        self.append_system_log(format!("cc-connect stopped (code={exit_code:?})"));
        Ok(())
    }

    fn restart(&self) -> Result<(), String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "cc-connect operation lock poisoned".to_string())?;
        self.stop_inner()?;
        self.start_inner()
    }

    fn auto_start_if_enabled(&self) -> Result<(), String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "cc-connect operation lock poisoned".to_string())?;
        let Some(profile) = load_profile()? else {
            return Ok(());
        };
        if !profile.auto_start {
            return Ok(());
        }
        self.start_inner()
    }

    pub fn shutdown(&self) {
        if let Err(err) = self.stop() {
            log::warn!("cc-connect shutdown cleanup failed: {err}");
        }
    }
}

fn format_and_check_config_syntax(executable: &Path, config: &Path) -> Result<(), String> {
    let mut command = silent_command(&path_string(executable));
    command.args(["config", "format", "--config"]).arg(config);
    let output = output_with_timeout(command, CONFIG_FORMAT_TIMEOUT)
        .map_err(|err| format!("cc-connect config syntax check failed: {err}"))?;
    if output.status.success() {
        return Ok(());
    }
    Err(format!(
        "cc-connect could not parse managed config: {}",
        output_text(&output.stdout, &output.stderr)
    ))
}

fn spawn_log_reader<R: Read + Send + 'static>(
    reader: R,
    source: &'static str,
    logs: Arc<Mutex<CcConnectLogBuffer>>,
    writer: SharedLogWriter,
    secrets: Arc<Vec<String>>,
) {
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut chunk = [0u8; 4 * 1024];
        let mut line = Vec::with_capacity(4 * 1024);
        let mut truncated = false;
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => {
                    push_captured_log_line(&logs, &writer, source, &line, truncated, &secrets);
                    break;
                }
                Ok(read) => {
                    for byte in &chunk[..read] {
                        if *byte == b'\n' {
                            push_captured_log_line(
                                &logs, &writer, source, &line, truncated, &secrets,
                            );
                            line.clear();
                            truncated = false;
                        } else if *byte != b'\r' {
                            if line.len() < MAX_CAPTURED_LOG_LINE_BYTES {
                                line.push(*byte);
                            } else {
                                truncated = true;
                            }
                        }
                    }
                }
                Err(err) => {
                    push_log_line(
                        &logs,
                        &writer,
                        "system",
                        &format!("cc-connect {source} reader failed: {err}"),
                        &[],
                    );
                    break;
                }
            }
        }
    });
}

fn push_captured_log_line(
    logs: &Arc<Mutex<CcConnectLogBuffer>>,
    writer: &SharedLogWriter,
    source: &str,
    bytes: &[u8],
    truncated: bool,
    secrets: &[String],
) {
    if bytes.is_empty() && !truncated {
        return;
    }
    let mut line = String::from_utf8_lossy(bytes).to_string();
    if truncated {
        line.push_str("...[truncated]");
    }
    push_log_line(logs, writer, source, &line, secrets);
}

fn push_log_line(
    logs: &Arc<Mutex<CcConnectLogBuffer>>,
    writer: &SharedLogWriter,
    source: &str,
    raw: &str,
    secrets: &[String],
) {
    let message = redact_log_line(raw, secrets);
    if let Ok(mut logs) = logs.lock() {
        logs.push(source, message.clone());
    }
    if let Ok(mut writer) = writer.lock() {
        if let Some(writer) = writer.as_mut() {
            let _ = writeln!(writer, "{} [{}] {}", now_millis(), source, message);
            let _ = writer.flush();
        }
    }
}

fn redact_log_line(raw: &str, secrets: &[String]) -> String {
    let mut value = raw.to_string();
    for secret in secrets.iter().filter(|secret| secret.len() >= 4) {
        value = value.replace(secret, "[REDACTED]");
    }
    let lower = value.to_ascii_lowercase();
    if [
        "token",
        "secret",
        "password",
        "api_key",
        "api key",
        "authorization",
    ]
    .iter()
    .any(|keyword| lower.contains(keyword))
    {
        value = "[sensitive output redacted]".to_string();
    }
    const MAX_CHARS: usize = 4_000;
    if value.chars().count() > MAX_CHARS {
        value = value.chars().take(MAX_CHARS).collect::<String>() + "...";
    }
    value
}

#[cfg(target_os = "windows")]
struct ChildJob(windows_sys::Win32::Foundation::HANDLE);
#[cfg(target_os = "windows")]
unsafe impl Send for ChildJob {}
#[cfg(target_os = "windows")]
impl ChildJob {
    fn assign(child: &Child) -> Result<Self, String> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(format!(
                    "create cc-connect job object failed: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                let err = std::io::Error::last_os_error();
                CloseHandle(job);
                return Err(format!("configure cc-connect job object failed: {err}"));
            }
            if AssignProcessToJobObject(job, child.as_raw_handle() as _) == 0 {
                let err = std::io::Error::last_os_error();
                CloseHandle(job);
                return Err(format!("assign cc-connect process to job failed: {err}"));
            }
            Ok(Self(job))
        }
    }
    fn terminate(&self) {
        unsafe {
            let _ = windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0, 1);
        }
    }
}
#[cfg(target_os = "windows")]
impl Drop for ChildJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[tauri::command]
pub async fn cc_connect_get_status(
    manager: State<'_, CcConnectManager>,
    refresh_detection: Option<bool>,
) -> Result<CcConnectStatus, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.status(refresh_detection.unwrap_or(false)))
        .await
        .map_err(|err| format!("cc-connect status task failed: {err}"))?
}
#[tauri::command]
pub async fn cc_connect_save_profile(
    manager: State<'_, CcConnectManager>,
    request: CcConnectSaveProfileRequest,
) -> Result<CcConnectStatus, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.save_profile(request)?;
        manager.status(true)
    })
    .await
    .map_err(|err| format!("cc-connect save task failed: {err}"))?
}
#[tauri::command]
pub async fn cc_connect_clear_credentials(
    manager: State<'_, CcConnectManager>,
    platform: Option<CcConnectPlatform>,
) -> Result<CcConnectStatus, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.clear_credentials(platform)?;
        manager.status(false)
    })
    .await
    .map_err(|err| format!("cc-connect credential task failed: {err}"))?
}
#[tauri::command]
pub async fn cc_connect_start(
    manager: State<'_, CcConnectManager>,
) -> Result<CcConnectStatus, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.start()?;
        manager.status(false)
    })
    .await
    .map_err(|err| format!("cc-connect start task failed: {err}"))?
}
#[tauri::command]
pub async fn cc_connect_stop(
    manager: State<'_, CcConnectManager>,
) -> Result<CcConnectStatus, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.stop()?;
        manager.status(false)
    })
    .await
    .map_err(|err| format!("cc-connect stop task failed: {err}"))?
}
#[tauri::command]
pub async fn cc_connect_restart(
    manager: State<'_, CcConnectManager>,
) -> Result<CcConnectStatus, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.restart()?;
        manager.status(false)
    })
    .await
    .map_err(|err| format!("cc-connect restart task failed: {err}"))?
}
#[tauri::command]
pub fn cc_connect_get_logs(
    manager: State<'_, CcConnectManager>,
    after_seq: Option<u64>,
    limit: Option<usize>,
) -> Result<CcConnectLogPage, String> {
    manager.log_page(after_seq, limit)
}

pub fn auto_start(app: &AppHandle) -> Result<(), String> {
    app.state::<CcConnectManager>().auto_start_if_enabled()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample_profile(project_path: &Path) -> CcConnectProfile {
        CcConnectProfile {
            auto_start: false,
            executable_path: None,
            project_id: "project-1".to_string(),
            project_name: "Example".to_string(),
            project_path: path_string(project_path),
            agent: CcConnectAgent::Claude,
            platform: CcConnectPlatform::Telegram,
            allow_from: "123456789".to_string(),
            language: CcConnectLanguage::Zh,
        }
    }
    #[test]
    fn parses_supported_and_unsupported_versions() {
        assert_eq!(
            parse_version("cc-connect v1.4.1 (commit abc)"),
            Some(("1.4.1".to_string(), true))
        );
        assert_eq!(
            parse_version("cc-connect v1.3.9"),
            Some(("1.3.9".to_string(), false))
        );
        assert_eq!(
            parse_version("cc-connect v1.4.2"),
            Some(("1.4.2".to_string(), false))
        );
        assert_eq!(
            parse_version("cc-connect v2.0.0"),
            Some(("2.0.0".to_string(), false))
        );
        assert!(is_verified_binary_hash(VERIFIED_V1_4_1_BINARY_SHA256[0]));
        assert!(!is_verified_binary_hash(
            "0000000000000000000000000000000000000000000000000000000000000000"
        ));
    }
    #[test]
    fn allowlist_is_fail_closed_and_normalized() {
        assert_eq!(
            normalize_allow_from(
                CcConnectPlatform::Telegram,
                "123456789, 987654321,123456789"
            )
            .unwrap(),
            "123456789,987654321"
        );
        assert!(normalize_allow_from(CcConnectPlatform::Telegram, "*").is_err());
        assert!(normalize_allow_from(CcConnectPlatform::Telegram, "alice").is_err());
        assert_eq!(
            normalize_allow_from(CcConnectPlatform::Feishu, "ou_owner").unwrap(),
            "ou_owner"
        );
    }
    #[cfg(target_os = "windows")]
    #[test]
    fn config_paths_strip_windows_extended_prefixes() {
        assert_eq!(
            user_path_string(Path::new(r"\\?\D:\npm\cc-connect.exe")),
            r"D:\npm\cc-connect.exe"
        );
        assert_eq!(
            config_path_value(Path::new(r"\\?\F:\test\work")),
            "F:/test/work"
        );
        assert_eq!(
            config_path_value(Path::new(r"\\?\UNC\server\share\repo")),
            "//server/share/repo"
        );
        assert_eq!(
            config_path_value(Path::new(r"F:\test\work")),
            "F:/test/work"
        );
    }
    #[test]
    fn managed_config_is_safe() {
        let project = tempfile::tempdir().unwrap();
        let raw = toml::to_string(&build_managed_config(&sample_profile(project.path())).unwrap())
            .unwrap();
        let value = toml::from_str::<toml::Value>(&raw).unwrap();
        assert_eq!(value["management"]["enabled"].as_bool(), Some(false));
        assert_eq!(value["bridge"]["enabled"].as_bool(), Some(false));
        assert_eq!(value["webhook"]["enabled"].as_bool(), Some(false));
        assert_eq!(
            value["projects"][0]["agent"]["type"].as_str(),
            Some("claudecode")
        );
        assert_eq!(
            value["projects"][0]["agent"]["options"]["mode"].as_str(),
            Some("default")
        );
        assert_eq!(
            value["projects"][0]["agent"]["options"]["env"][TELEGRAM_TOKEN_ENV].as_str(),
            Some("")
        );
        assert_eq!(value["projects"][0]["admin_from"].as_str(), Some(""));
        let disabled = value["projects"][0]["disabled_commands"]
            .as_array()
            .unwrap();
        assert!(disabled.iter().any(|item| item.as_str() == Some("mode")));
        assert!(disabled.iter().any(|item| item.as_str() == Some("config")));
        assert!(!disabled.iter().any(|item| item.as_str() == Some("new")));
    }
    #[test]
    fn log_redaction_and_cursor_work() {
        assert_eq!(
            redact_log_line("connected with abcdefgh", &["abcdefgh".to_string()]),
            "connected with [REDACTED]"
        );
        assert_eq!(
            redact_log_line("telegram token=abcdefgh", &[]),
            "[sensitive output redacted]"
        );
        let mut logs = CcConnectLogBuffer::default();
        for index in 0..(MAX_LOG_LINES + 5) {
            logs.push("stdout", format!("line-{index}"));
        }
        assert_eq!(logs.lines.len(), MAX_LOG_LINES);
        let first_seq = logs.lines.front().unwrap().seq;
        assert_eq!(logs.page(first_seq, 3).len(), 3);
    }
}
