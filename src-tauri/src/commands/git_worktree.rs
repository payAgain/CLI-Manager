use crate::daemon::{client::DaemonBridge, protocol::SessionMeta};
use git2::Repository;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::fs;
#[cfg(test)]
use std::io;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
#[cfg(test)]
use std::thread;
use std::time::Duration;
use std::time::Instant;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

const WORKTREE_BRANCH_PREFIX: &str = "wt/";
const MAX_TASK_NAME_LEN: usize = 64;
#[cfg(test)]
const WORKTREE_REMOVE_RETRY_ATTEMPTS: usize = 5;
#[cfg(test)]
const WORKTREE_REMOVE_RETRY_DELAY_MS: u64 = 250;
const RESERVED_WINDOWS_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeCreateRequest {
    pub project_path: String,
    pub task_name: String,
    pub worktree_root: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeCreateResult {
    pub name: String,
    pub branch: String,
    pub path: String,
    pub base_branch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeMergeResult {
    pub merged: bool,
    pub output: String,
    pub conflict_files: Vec<String>,
    pub skipped: bool,
    pub skip_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeDepsCheckResult {
    pub needs_install: bool,
    pub command: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug)]
struct GitCommandOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

impl GitCommandOutput {
    fn combined(&self) -> String {
        format!("{}{}", self.stdout, self.stderr).trim().to_string()
    }
}

const GIT_CREATE_ERROR_SNIPPET_LEN: usize = 300;

fn git_create_error_snippet(output: &str) -> String {
    let normalized = output.replace('\r', "\n");
    let lines = normalized
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let chars = lines.chars().collect::<Vec<_>>();
    if chars.len() <= GIT_CREATE_ERROR_SNIPPET_LEN {
        return lines;
    }
    let start = chars.len() - GIT_CREATE_ERROR_SNIPPET_LEN;
    format!("...{}", chars[start..].iter().collect::<String>())
}

fn strip_windows_extended_path_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("\\\\?\\") {
        if let Some(unc_tail) = rest.strip_prefix("UNC\\") {
            return format!("\\\\{unc_tail}");
        }
        return rest.to_string();
    }
    if let Some(rest) = path.strip_prefix("//?/") {
        if let Some(unc_tail) = rest.strip_prefix("UNC/") {
            return format!("//{unc_tail}");
        }
        return rest.to_string();
    }
    path.to_string()
}

fn local_path_from_input(path: &str) -> PathBuf {
    PathBuf::from(strip_windows_extended_path_prefix(path.trim()))
}

fn path_to_git_arg(path: &Path) -> String {
    strip_windows_extended_path_prefix(&path.to_string_lossy())
}

fn is_wsl_path(path: &str) -> bool {
    let plain = strip_windows_extended_path_prefix(path);
    let normalized = plain.replace('/', "\\").to_lowercase();
    normalized.starts_with("\\\\wsl$\\") || normalized.starts_with("\\\\wsl.localhost\\")
}

fn is_unc_or_remote_path(path: &str) -> bool {
    let plain = strip_windows_extended_path_prefix(path.trim());
    let normalized = plain.replace('/', "\\").to_lowercase();
    normalized.starts_with("\\\\") || normalized.contains("://") || normalized.starts_with("git@")
}

fn ensure_supported_local_path(path: &str) -> Result<(), String> {
    if is_wsl_path(path) {
        return Err("unsupported_wsl".to_string());
    }
    if is_unc_or_remote_path(path) {
        return Err("unsupported_remote_path".to_string());
    }
    Ok(())
}

fn open_main_repo(project_path: &str) -> Result<Repository, String> {
    ensure_supported_local_path(project_path)?;
    let path = local_path_from_input(project_path);
    if !path.exists() {
        return Err("path_not_found".to_string());
    }
    if !path.is_dir() {
        return Err("path_not_directory".to_string());
    }
    let repo = Repository::open(&path).map_err(|_| "not_git_repository".to_string())?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| "bare_repository_unsupported".to_string())?;
    if normalize_path_for_compare(workdir) != normalize_path_for_compare(&path) {
        return Err("project_path_not_repo_root".to_string());
    }
    Ok(repo)
}

fn validate_task_name(task_name: &str) -> Result<String, String> {
    let trimmed = task_name.trim();
    if trimmed.is_empty() {
        return Err("task_name_empty".to_string());
    }
    if trimmed.len() > MAX_TASK_NAME_LEN {
        return Err("task_name_too_long".to_string());
    }
    if trimmed.starts_with('-') {
        return Err("task_name_invalid".to_string());
    }
    if !trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err("task_name_invalid".to_string());
    }
    if RESERVED_WINDOWS_NAMES
        .iter()
        .any(|reserved| trimmed.eq_ignore_ascii_case(reserved))
    {
        return Err("task_name_reserved".to_string());
    }
    Ok(trimmed.to_string())
}

fn validate_worktree_branch(branch: &str) -> Result<(), String> {
    let task_name = branch
        .strip_prefix(WORKTREE_BRANCH_PREFIX)
        .ok_or_else(|| "branch_not_worktree".to_string())?;
    validate_task_name(task_name)?;
    Ok(())
}

fn validate_plain_branch_name(branch: &str) -> Result<(), String> {
    let trimmed = branch.trim();
    if trimmed.is_empty() {
        return Err("base_branch_empty".to_string());
    }
    if trimmed != branch
        || trimmed.starts_with('-')
        || trimmed.starts_with('/')
        || trimmed.ends_with('/')
    {
        return Err("base_branch_invalid".to_string());
    }
    if trimmed.contains("..") || trimmed.ends_with(".lock") {
        return Err("base_branch_invalid".to_string());
    }
    if trimmed
        .chars()
        .any(|ch| ch.is_control() || matches!(ch, ' ' | '~' | '^' | ':' | '?' | '*' | '[' | '\\'))
    {
        return Err("base_branch_invalid".to_string());
    }
    Ok(())
}

fn current_branch_name(repo: &Repository) -> Result<String, String> {
    let head = repo.head().map_err(|_| "head_not_found".to_string())?;
    if !head.is_branch() {
        return Err("detached_head".to_string());
    }
    head.shorthand()
        .map(|value| value.to_string())
        .ok_or_else(|| "branch_name_unknown".to_string())
}

fn default_worktree_root(project_path: &Path) -> Result<PathBuf, String> {
    let project_name = project_path
        .file_name()
        .and_then(OsStr::to_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "project_name_unknown".to_string())?;
    let parent = project_path
        .parent()
        .ok_or_else(|| "project_parent_unknown".to_string())?;
    Ok(parent.join(format!("{project_name}-worktrees")))
}

fn resolve_worktree_target_path(
    project_path: &Path,
    task_name: &str,
    worktree_root: Option<&str>,
) -> Result<PathBuf, String> {
    let raw_root = match worktree_root
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(root) => {
            ensure_supported_local_path(root)?;
            let path = local_path_from_input(root);
            if !path.is_absolute() {
                return Err("worktree_root_not_absolute".to_string());
            }
            path
        }
        None => default_worktree_root(project_path)?,
    };

    fs::create_dir_all(&raw_root).map_err(|e| format!("create_worktree_root_failed: {e}"))?;
    let root = raw_root
        .canonicalize()
        .map_err(|e| format!("canonicalize_worktree_root_failed: {e}"))?;
    let target = root.join(task_name);
    if target.exists() {
        return Err("worktree_path_exists".to_string());
    }
    if !target.starts_with(&root) {
        return Err("worktree_path_escape".to_string());
    }
    Ok(target)
}

fn run_git_raw<I, S>(cwd: &Path, args: I) -> Result<GitCommandOutput, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    if !cwd.exists() {
        return Err("path_not_found".to_string());
    }

    let mut cmd = Command::new("git");
    cmd.current_dir(cwd).args(args);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "git_not_found".to_string()
        } else {
            format!("spawn_failed: {e}")
        }
    })?;

    Ok(GitCommandOutput {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

fn run_git_checked<I, S>(cwd: &Path, args: I) -> Result<String, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let output = run_git_raw(cwd, args)?;
    if output.success {
        Ok(output.combined())
    } else {
        let combined = output.combined();
        let snippet: String = combined.chars().take(300).collect();
        Err(format!("git_failed: {snippet}"))
    }
}

#[cfg(test)]
fn is_retryable_worktree_remove_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    normalized.contains("permission denied")
        || normalized.contains("failed to delete")
        || normalized.contains("unable to unlink")
        || normalized.contains("being used by another process")
        || normalized.contains("os error 32")
        || normalized.contains("device or resource busy")
}

#[cfg(test)]
fn is_stale_worktree_remove_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    normalized.contains("is not a working tree")
        || normalized.contains("validation failed, cannot remove working tree")
        || (normalized.contains(".git") && normalized.contains("does not exist"))
        || normalized.contains("gitdir file points to non-existent location")
}

fn append_output_line(output: &mut String, line: &str) {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }
    if !output.is_empty() {
        output.push('\n');
    }
    output.push_str(trimmed);
}

#[cfg(test)]
fn remove_worktree_path_with_retry<F>(target_path: &Path, mut remove: F) -> Result<(), String>
where
    F: FnMut(&Path) -> io::Result<()>,
{
    let mut last_error = String::new();
    for attempt in 0..=WORKTREE_REMOVE_RETRY_ATTEMPTS {
        match remove(target_path) {
            Ok(()) => return Ok(()),
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(err)
                if attempt < WORKTREE_REMOVE_RETRY_ATTEMPTS
                    && is_retryable_worktree_remove_error(&err.to_string()) =>
            {
                last_error = err.to_string();
                thread::sleep(Duration::from_millis(WORKTREE_REMOVE_RETRY_DELAY_MS));
            }
            Err(err) => return Err(format!("remove_stale_worktree_dir_failed: {err}")),
        }
    }
    Err(format!("remove_stale_worktree_dir_failed: {last_error}"))
}

#[cfg(test)]
fn remove_registered_stale_worktree_dir(target_path: &Path) -> Result<String, String> {
    if !target_path.exists() {
        return Ok("stale_registered_worktree_path_missing".to_string());
    }
    if !target_path.is_dir() {
        return Err("worktree_path_not_directory".to_string());
    }
    remove_worktree_path_with_retry(target_path, |path| fs::remove_dir_all(path))?;
    Ok("removed_stale_registered_worktree_dir".to_string())
}

fn branch_exists(project_path: &Path, branch: &str) -> Result<bool, String> {
    let branch_ref = format!("refs/heads/{branch}");
    let output = run_git_raw(project_path, ["rev-parse", "--verify", branch_ref.as_str()])?;
    Ok(output.success)
}

fn has_branch_content_diff(
    project_path: &Path,
    base_branch: &str,
    worktree_branch: &str,
) -> Result<bool, String> {
    let output = run_git_checked(
        project_path,
        ["diff", "--name-only", base_branch, worktree_branch],
    )?;
    Ok(output.lines().any(|line| !line.trim().is_empty()))
}

fn should_cleanup_worktree_branch_after_failed_add(
    branch: &str,
    branch_existed_before_add: bool,
) -> bool {
    !branch_existed_before_add && validate_worktree_branch(branch).is_ok()
}

fn cleanup_worktree_branch_after_failed_add(
    project_path: &Path,
    branch: &str,
    branch_existed_before_add: bool,
) {
    if !should_cleanup_worktree_branch_after_failed_add(branch, branch_existed_before_add) {
        return;
    }
    let _ = run_git_raw(project_path, ["branch", "-D", branch]);
}

#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq)]
struct WorktreeListEntry {
    path: PathBuf,
    branch: Option<String>,
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WorktreeRegistration {
    Matched,
    Mismatched,
    Missing,
}

#[cfg(test)]
fn parse_worktree_list_entries(output: &str) -> Vec<WorktreeListEntry> {
    let mut entries = Vec::new();
    let mut current_path: Option<PathBuf> = None;
    let mut current_branch: Option<String> = None;

    let flush = |entries: &mut Vec<WorktreeListEntry>,
                 path: &mut Option<PathBuf>,
                 branch: &mut Option<String>| {
        if let Some(path) = path.take() {
            entries.push(WorktreeListEntry {
                path,
                branch: branch.take(),
            });
        } else {
            let _ = branch.take();
        }
    };

    for line in output.lines() {
        if line.trim().is_empty() {
            flush(&mut entries, &mut current_path, &mut current_branch);
            continue;
        }
        if let Some(path) = line.strip_prefix("worktree ") {
            flush(&mut entries, &mut current_path, &mut current_branch);
            current_path = Some(PathBuf::from(path));
            continue;
        }
        if let Some(branch) = line.strip_prefix("branch refs/heads/") {
            current_branch = Some(branch.to_string());
        }
    }
    flush(&mut entries, &mut current_path, &mut current_branch);
    entries
}

fn normalize_path_for_compare(path: &Path) -> String {
    let normalized_path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let mut value = normalized_path.to_string_lossy().replace('\\', "/");
    while value.ends_with('/') && value.len() > 1 {
        value.pop();
    }
    if cfg!(target_os = "windows") {
        value.to_lowercase()
    } else {
        value
    }
}

#[cfg(test)]
fn classify_worktree_registration(
    entries: &[WorktreeListEntry],
    worktree_path: &Path,
    branch: &str,
) -> WorktreeRegistration {
    let target = normalize_path_for_compare(worktree_path);
    let mut path_found = false;
    let mut branch_found = false;

    for registered in entries {
        let same_path = normalize_path_for_compare(&registered.path) == target;
        let same_branch = registered.branch.as_deref() == Some(branch);
        if same_path && same_branch {
            return WorktreeRegistration::Matched;
        }
        path_found |= same_path;
        branch_found |= same_branch;
    }

    if path_found || branch_found {
        WorktreeRegistration::Mismatched
    } else {
        WorktreeRegistration::Missing
    }
}

fn is_empty_dir(path: &Path) -> Result<bool, String> {
    let mut entries =
        fs::read_dir(path).map_err(|e| format!("read_stale_worktree_dir_failed: {e}"))?;
    Ok(entries.next().is_none())
}

/// worktree 移除后，若其所在的根目录（如 `<project>-worktrees`）已空，顺手清掉，
/// 避免（尤其是批量）删除后残留一个空文件夹。`fs::remove_dir` 仅能删空目录，
/// 非空/出错都安全忽略；git 下次 `worktree add` 会通过 create_dir_all 自动重建根目录。
fn cleanup_empty_worktree_parent(worktree_path: &Path) {
    if let Some(parent) = worktree_path.parent() {
        if is_empty_dir(parent).unwrap_or(false) {
            let _ = fs::remove_dir(parent);
        }
    }
}

#[cfg(test)]
fn cleanup_stale_unregistered_worktree(
    project_path: &Path,
    target_path: &Path,
    branch: &str,
    delete_branch: bool,
) -> Result<String, String> {
    let mut output = String::new();
    if target_path.exists() {
        if !target_path.is_dir() || !is_empty_dir(target_path)? {
            return Err("worktree_not_registered".to_string());
        }
        remove_worktree_path_with_retry(target_path, |path| fs::remove_dir(path))?;
        output.push_str("removed_stale_empty_worktree_dir");
    } else {
        output.push_str(&run_git_checked(project_path, ["worktree", "prune"])?);
    }

    if delete_branch && branch_exists(project_path, branch)? {
        append_output_line(
            &mut output,
            &run_git_checked(project_path, ["branch", "-D", branch])?,
        );
    }

    Ok(output.trim().to_string())
}

fn check_dependency_need(path: &Path) -> GitWorktreeDepsCheckResult {
    let node_modules_missing = !path.join("node_modules").exists();
    if path.join("pnpm-lock.yaml").exists() && node_modules_missing {
        return GitWorktreeDepsCheckResult {
            needs_install: true,
            command: Some("pnpm install".to_string()),
            reason: Some("pnpm-lock.yaml exists but node_modules is missing".to_string()),
        };
    }
    if path.join("yarn.lock").exists() && node_modules_missing {
        return GitWorktreeDepsCheckResult {
            needs_install: true,
            command: Some("yarn install".to_string()),
            reason: Some("yarn.lock exists but node_modules is missing".to_string()),
        };
    }
    if (path.join("package-lock.json").exists() || path.join("package.json").exists())
        && node_modules_missing
    {
        return GitWorktreeDepsCheckResult {
            needs_install: true,
            command: Some("npm install".to_string()),
            reason: Some("package.json exists but node_modules is missing".to_string()),
        };
    }
    if path.join("Cargo.toml").exists() && !path.join("target").exists() {
        return GitWorktreeDepsCheckResult {
            needs_install: true,
            command: Some("cargo fetch".to_string()),
            reason: Some("Cargo.toml exists but target is missing".to_string()),
        };
    }

    GitWorktreeDepsCheckResult {
        needs_install: false,
        command: None,
        reason: None,
    }
}

fn conflict_files(project_path: &Path) -> Vec<String> {
    match run_git_raw(project_path, ["diff", "--name-only", "--diff-filter=U"]) {
        Ok(output) => output
            .stdout
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(ToString::to_string)
            .collect(),
        Err(_) => Vec::new(),
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitDiscoveredWorktree {
    pub path: String,
    pub branch: String,
    pub head: String,
    pub missing: bool,
}

// NUL porcelain keeps spaces, newlines and non-ASCII paths intact. Never use
// status/fetch/prune here: discovery only reads Git's worktree registrations.
fn parse_discovered_worktrees(output: &str) -> Vec<GitDiscoveredWorktree> {
    output
        .split("\0\0")
        .filter_map(|record| {
            let mut entry = GitDiscoveredWorktree {
                path: String::new(),
                branch: String::new(),
                head: String::new(),
                missing: false,
            };
            for field in record.split('\0') {
                if field == "bare" {
                    return None;
                }
                if let Some(path) = field.strip_prefix("worktree ") {
                    entry.path = path.to_string();
                }
                if let Some(branch) = field.strip_prefix("branch refs/heads/") {
                    entry.branch = branch.to_string();
                }
                if let Some(head) = field.strip_prefix("HEAD ") {
                    entry.head = head.to_string();
                }
                if field == "prunable" || field.starts_with("prunable ") {
                    entry.missing = true;
                }
            }
            (!entry.path.is_empty()).then_some(entry)
        })
        .collect()
}

fn discover_git_worktrees(project_path: &str) -> Result<Vec<GitDiscoveredWorktree>, String> {
    let repo = open_main_repo(project_path)?;
    let root = repo.workdir().ok_or("bare_repository_unsupported")?;
    let output = run_git_raw(root, ["worktree", "list", "--porcelain", "-z"])?;
    if !output.success {
        return Err(format!("git_failed: {}", output.combined()));
    }
    let root_key = normalize_path_for_compare(root);
    Ok(parse_discovered_worktrees(&output.stdout)
        .into_iter()
        .filter_map(|mut entry| {
            let path = local_path_from_input(&entry.path);
            if normalize_path_for_compare(&path) == root_key {
                return None;
            }
            entry.path = path_to_git_arg(&path);
            entry.missing |= !path.is_dir();
            Some(entry)
        })
        .collect())
}

#[tauri::command]
pub async fn git_worktree_list(project_path: String) -> Result<Vec<GitDiscoveredWorktree>, String> {
    tokio::task::spawn_blocking(move || discover_git_worktrees(&project_path))
        .await
        .map_err(|e| format!("task_failed: {e}"))?
}

#[tauri::command]
pub async fn git_worktree_validate(project_path: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        if is_wsl_path(&project_path) {
            return Ok(false);
        }
        let path = local_path_from_input(&project_path);
        if !path.exists() || !path.is_dir() {
            return Ok(false);
        }
        Ok(open_main_repo(&project_path).is_ok())
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

#[tauri::command]
pub async fn git_worktree_create(
    req: GitWorktreeCreateRequest,
) -> Result<GitWorktreeCreateResult, String> {
    let task_name = validate_task_name(&req.task_name)?;
    tokio::task::spawn_blocking(move || {
        let repo = open_main_repo(&req.project_path)?;
        let base_branch = current_branch_name(&repo)?;
        let project_path = local_path_from_input(&req.project_path)
            .canonicalize()
            .map_err(|e| format!("canonicalize_project_path_failed: {e}"))?;
        let target_path =
            resolve_worktree_target_path(&project_path, &task_name, req.worktree_root.as_deref())?;
        let branch = format!("{WORKTREE_BRANCH_PREFIX}{task_name}");
        validate_worktree_branch(&branch)?;
        let branch_existed_before_add = branch_exists(&project_path, &branch)?;

        let target_arg = path_to_git_arg(&target_path);
        let add_output = run_git_raw(
            &project_path,
            [
                "worktree",
                "add",
                "-b",
                branch.as_str(),
                target_arg.as_str(),
                "HEAD",
            ],
        )?;
        if !add_output.success {
            cleanup_worktree_branch_after_failed_add(
                &project_path,
                &branch,
                branch_existed_before_add,
            );
            let snippet = git_create_error_snippet(&add_output.combined());
            return Err(format!("git_failed: {snippet}"));
        }

        Ok(GitWorktreeCreateResult {
            name: task_name,
            branch,
            path: path_to_git_arg(&target_path),
            base_branch,
        })
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

#[tauri::command]
pub async fn git_worktree_check_deps(
    worktree_path: String,
) -> Result<GitWorktreeDepsCheckResult, String> {
    ensure_supported_local_path(&worktree_path)?;
    tokio::task::spawn_blocking(move || {
        let path = local_path_from_input(&worktree_path);
        if !path.exists() {
            return Err("path_not_found".to_string());
        }
        if !path.is_dir() {
            return Err("path_not_directory".to_string());
        }
        Ok(check_dependency_need(&path))
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

#[tauri::command]
pub async fn git_worktree_merge(
    project_path: String,
    worktree_branch: String,
    base_branch: String,
) -> Result<GitWorktreeMergeResult, String> {
    validate_worktree_branch(&worktree_branch)?;
    validate_plain_branch_name(&base_branch)?;
    tokio::task::spawn_blocking(move || {
        let repo = open_main_repo(&project_path)?;
        let current_branch = current_branch_name(&repo)?;
        let project_path = local_path_from_input(&project_path)
            .canonicalize()
            .map_err(|e| format!("canonicalize_project_path_failed: {e}"))?;

        let status = run_git_checked(&project_path, ["status", "--porcelain"])?;
        if !status.trim().is_empty() {
            return Err("dirty_main_worktree".to_string());
        }
        if !branch_exists(&project_path, &base_branch)? {
            return Err("branch_not_found".to_string());
        }
        if !branch_exists(&project_path, &worktree_branch)? {
            return Err("worktree_branch_not_found".to_string());
        }
        if !has_branch_content_diff(&project_path, &base_branch, &worktree_branch)? {
            return Ok(GitWorktreeMergeResult {
                merged: false,
                output: format!(
                    "merge_skipped: no_diff_between {} and {}",
                    base_branch, worktree_branch
                ),
                conflict_files: Vec::new(),
                skipped: true,
                skip_reason: Some("no_diff".to_string()),
            });
        }
        if current_branch != base_branch {
            run_git_checked(&project_path, ["checkout", base_branch.as_str()])?;
        }

        let merge_output = run_git_raw(
            &project_path,
            ["merge", "--no-ff", "--no-edit", worktree_branch.as_str()],
        )?;
        if merge_output.success {
            return Ok(GitWorktreeMergeResult {
                merged: true,
                output: merge_output.combined(),
                conflict_files: Vec::new(),
                skipped: false,
                skip_reason: None,
            });
        }

        let files = conflict_files(&project_path);
        if !files.is_empty() {
            let _ = run_git_raw(&project_path, ["merge", "--abort"]);
            return Ok(GitWorktreeMergeResult {
                merged: false,
                output: format!("merge_conflict: {}", merge_output.combined()),
                conflict_files: files,
                skipped: false,
                skip_reason: None,
            });
        }

        let _ = run_git_raw(&project_path, ["merge", "--abort"]);
        let snippet: String = merge_output.combined().chars().take(300).collect();
        Err(format!("merge_failed: {snippet}"))
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

const WORKTREE_CONFIRMATION_LIFETIME: Duration = Duration::from_secs(600);
const WORKTREE_CONFIRMATION_LIMIT: usize = 4096;
static WORKTREE_REMOVAL_SNAPSHOTS: OnceLock<Mutex<HashMap<String, WorktreeRemovalSnapshot>>> =
    OnceLock::new();
static WORKTREE_REMOVAL_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRemovalSession {
    pub session_id: String,
    pub cwd: Option<String>,
    pub workspace_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRemovalProcess {
    pub pid: u32,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeRemovePreflight {
    pub confirmation_token: String,
    pub worktree_path: String,
    pub branch: Option<String>,
    pub detached: bool,
    pub head: String,
    pub locked: bool,
    pub dirty: bool,
    pub staged_count: usize,
    pub unstaged_count: usize,
    pub untracked_count: usize,
    pub changed_paths: Vec<String>,
    pub changed_count: usize,
    pub running_sessions: Vec<WorktreeRemovalSession>,
    pub external_processes: Vec<WorktreeRemovalProcess>,
}

#[derive(Debug, Clone)]
struct WorktreeRemovalSnapshot {
    created_at: Instant,
    project_path: PathBuf,
    target_path: PathBuf,
    branch: Option<String>,
    head: String,
    fingerprint: String,
    dirty: bool,
}

#[derive(Debug)]
struct RemovalRegistration {
    path: PathBuf,
    branch: Option<String>,
    head: String,
    locked: bool,
    primary: bool,
}

fn removal_registrations(project_path: &Path) -> Result<Vec<RemovalRegistration>, String> {
    let output = run_git_raw(project_path, ["worktree", "list", "--porcelain", "-z"])?;
    if !output.success {
        return Err("worktree_remove_inspection_failed".into());
    }
    let mut entries = Vec::new();
    for record in output
        .stdout
        .split("\0\0")
        .filter(|record| !record.is_empty())
    {
        let mut path = None;
        let mut branch = None;
        let mut head = String::new();
        let mut locked = false;
        let mut bare = false;
        for field in record.split('\0') {
            if let Some(value) = field.strip_prefix("worktree ") {
                path = Some(local_path_from_input(value));
            }
            if let Some(value) = field.strip_prefix("branch refs/heads/") {
                branch = Some(value.to_string());
            }
            if let Some(value) = field.strip_prefix("HEAD ") {
                head = value.to_string();
            }
            locked |= field == "locked" || field.starts_with("locked ");
            bare |= field == "bare";
        }
        if let Some(path) = path {
            let primary = entries.is_empty();
            if bare {
                return Err("bare_repository_unsupported".into());
            }
            entries.push(RemovalRegistration {
                path,
                branch,
                head,
                locked,
                primary,
            });
        }
    }
    Ok(entries)
}

fn canonical_removal_path(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("worktree_path_not_absolute".into());
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| "worktree_remove_path_missing")?;
    if canonical.to_str().is_none() {
        return Err("worktree_remove_inspection_failed".into());
    }
    Ok(canonical)
}

fn repository_common_dir(repo: &Repository) -> Result<PathBuf, String> {
    let pointer = repo.path().join("commondir");
    let path = if pointer.is_file() {
        repo.path().join(
            fs::read_to_string(pointer)
                .map_err(|_| "worktree_remove_inspection_failed")?
                .trim(),
        )
    } else {
        repo.path().to_path_buf()
    };
    path.canonicalize()
        .map_err(|_| "worktree_remove_inspection_failed".into())
}

fn removal_registration(
    project_input: &str,
    target_input: &str,
    expected_branch: &str,
) -> Result<(PathBuf, PathBuf, RemovalRegistration), String> {
    ensure_supported_local_path(target_input)?;
    let project = open_main_repo(project_input)?;
    let project_path = canonical_removal_path(&local_path_from_input(project_input))?;
    let target_input = local_path_from_input(target_input);
    let target_path = canonical_removal_path(&target_input)?;
    let registrations = removal_registrations(&project_path)?;
    let index = registrations
        .iter()
        .position(|entry| {
            normalize_path_for_compare(&entry.path) == normalize_path_for_compare(&target_path)
        })
        .ok_or("worktree_not_registered")?;
    let registration = &registrations[index];
    if registration.primary || target_path == project_path {
        return Err("worktree_remove_primary".into());
    }
    if registration.locked {
        return Err("worktree_remove_locked".into());
    }
    if registrations
        .iter()
        .enumerate()
        .any(|(other_index, entry)| {
            other_index != index && path_is_within(&entry.path.to_string_lossy(), &target_path)
        })
    {
        return Err("worktree_remove_nested_worktree".into());
    }
    let registration = registrations
        .into_iter()
        .nth(index)
        .ok_or("worktree_not_registered")?;
    match registration.branch.as_deref() {
        Some(actual) if actual != expected_branch => return Err("worktree_branch_mismatch".into()),
        None if !expected_branch.is_empty()
            && !(expected_branch.len() >= 7 && registration.head.starts_with(expected_branch)) =>
        {
            return Err("worktree_branch_mismatch".into())
        }
        _ => {}
    }
    if let Some(branch) = registration.branch.as_deref() {
        validate_plain_branch_name(branch)?;
    }
    let target = Repository::open(&target_path).map_err(|_| "worktree_remove_inspection_failed")?;
    if target
        .workdir()
        .and_then(|path| path.canonicalize().ok())
        .as_ref()
        != Some(&target_path)
        || repository_common_dir(&project)? != repository_common_dir(&target)?
    {
        return Err("worktree_not_registered".into());
    }
    Ok((project_path, target_path, registration))
}

fn removal_git_bytes(cwd: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let mut command = Command::new("git");
    command
        .current_dir(cwd)
        .args(["-c", "core.fsmonitor=false"])
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let output = command
        .output()
        .map_err(|_| "worktree_remove_inspection_failed")?;
    if !output.status.success() {
        return Err("worktree_remove_inspection_failed".into());
    }
    Ok(output.stdout)
}

fn removal_relative_path(bytes: &[u8]) -> Result<PathBuf, String> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        Ok(PathBuf::from(OsStr::from_bytes(bytes)))
    }
    #[cfg(not(unix))]
    {
        Ok(PathBuf::from(
            std::str::from_utf8(bytes).map_err(|_| "worktree_remove_inspection_failed")?,
        ))
    }
}

fn hash_removal_path(hasher: &mut Sha256, root: &Path, relative: &[u8]) -> Result<(), String> {
    hasher.update((relative.len() as u64).to_le_bytes());
    hasher.update(relative);
    let relative = removal_relative_path(relative)?;
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("worktree_remove_inspection_failed".into());
    }
    let path = root.join(relative);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            hasher.update(b"missing");
            return Ok(());
        }
        Err(_) => return Err("worktree_remove_inspection_failed".into()),
    };
    hasher.update([u8::from(metadata.permissions().readonly())]);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        hasher.update(metadata.permissions().mode().to_le_bytes());
    }
    if metadata.file_type().is_symlink() {
        hasher.update(b"symlink");
        let target = fs::read_link(&path).map_err(|_| "worktree_remove_inspection_failed")?;
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStrExt;
            hasher.update(target.as_os_str().as_bytes());
        }
        #[cfg(not(unix))]
        hasher.update(target.to_string_lossy().as_bytes());
    } else if metadata.is_file() {
        hasher.update(b"file");
        let mut file = fs::File::open(&path).map_err(|_| "worktree_remove_inspection_failed")?;
        let mut buffer = [0u8; 65536];
        loop {
            let count = file
                .read(&mut buffer)
                .map_err(|_| "worktree_remove_inspection_failed")?;
            if count == 0 {
                break;
            }
            hasher.update(&buffer[..count]);
        }
        let after = fs::symlink_metadata(&path).map_err(|_| "worktree_remove_inspection_failed")?;
        if after.len() != metadata.len() || after.modified().ok() != metadata.modified().ok() {
            return Err("worktree_remove_changed".into());
        }
    } else {
        return Err("worktree_remove_inspection_failed".into());
    }
    Ok(())
}

fn removal_working_state(
    target: &Path,
    registration: &RemovalRegistration,
) -> Result<(String, usize, usize, usize, Vec<String>, usize), String> {
    let status = removal_git_bytes(
        target,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    let mut staged = 0;
    let mut unstaged = 0;
    let mut untracked = 0;
    let mut paths = Vec::new();
    let mut changed_paths = Vec::new();
    let mut seen_paths = HashSet::new();
    let mut fields = status
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty());
    while let Some(field) = fields.next() {
        if field.len() < 4 || field[2] != b' ' {
            return Err("worktree_remove_inspection_failed".into());
        }
        let x = field[0];
        let y = field[1];
        if x == b'?' && y == b'?' {
            untracked += 1;
        } else {
            staged += usize::from(x != b' ' && x != b'?');
            unstaged += usize::from(y != b' ' && y != b'?');
        }
        if seen_paths.insert(field[3..].to_vec()) {
            paths.push(String::from_utf8_lossy(&field[3..]).into_owned());
            changed_paths.push(field[3..].to_vec());
        }
        if matches!(x, b'R' | b'C') || matches!(y, b'R' | b'C') {
            let _ = fields.next();
        }
    }
    let mut hasher = Sha256::new();
    hasher.update(registration.head.as_bytes());
    hasher.update(registration.branch.as_deref().unwrap_or("").as_bytes());
    hasher.update(&status);
    // Index object IDs preserve staged content and conflict stages without
    // materializing potentially huge binary patches in the app process.
    hasher.update(removal_git_bytes(target, &["ls-files", "--stage", "-z"])?);
    for path in changed_paths {
        hash_removal_path(&mut hasher, target, &path)?;
    }
    Ok((
        format!("{:x}", hasher.finalize()),
        staged,
        unstaged,
        untracked,
        paths,
        seen_paths.len(),
    ))
}

fn path_is_within(candidate: &str, target: &Path) -> bool {
    let candidate = local_path_from_input(candidate);
    let candidate = candidate.canonicalize().unwrap_or(candidate);
    let target = target
        .canonicalize()
        .unwrap_or_else(|_| target.to_path_buf());
    #[cfg(target_os = "windows")]
    {
        let candidate = normalize_path_for_compare(&candidate);
        let target = normalize_path_for_compare(&target);
        candidate == target || candidate.starts_with(&(target + "/"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        candidate.starts_with(target)
    }
}

fn process_belongs_to_root(system: &System, pid: Pid, roots: &HashSet<Pid>) -> bool {
    let mut current = pid;
    let mut visited = HashSet::new();
    while visited.insert(current) {
        if roots.contains(&current) {
            return true;
        }
        let Some(parent) = system.process(current).and_then(|process| process.parent()) else {
            break;
        };
        current = parent;
    }
    false
}

/// Host inspection is limited to process cwd values the current OS/user can
/// read. It never enters WSL/SSH guests or terminates external processes.
fn removal_activity(
    target: &Path,
    sessions: &[SessionMeta],
) -> (Vec<WorktreeRemovalSession>, Vec<WorktreeRemovalProcess>) {
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_cwd(UpdateKind::Always)
            .without_tasks(),
    );
    let local_sessions = sessions
        .iter()
        .filter(|session| {
            session.alive
                && session.environment_type.as_deref() != Some("ssh")
                && session.ssh_host_id.is_none()
        })
        .collect::<Vec<_>>();
    let managed_roots = local_sessions
        .iter()
        .filter_map(|session| {
            let pid = Pid::from_u32(session.root_pid?);
            let process = system.process(pid)?;
            (session.root_started_at == Some(process.start_time())).then_some(pid)
        })
        .collect::<HashSet<_>>();
    let in_directory = system
        .processes()
        .iter()
        .filter_map(|(pid, process)| {
            process
                .cwd()
                .filter(|cwd| path_is_within(&cwd.to_string_lossy(), target))
                .map(|_| *pid)
        })
        .collect::<HashSet<_>>();
    let running_sessions = local_sessions
        .into_iter()
        .filter_map(|session| {
            let workspace_path = session
                .workspace
                .as_ref()
                .and_then(|workspace| workspace.get("path"))
                .and_then(serde_json::Value::as_str);
            let root = session.root_pid.map(Pid::from_u32);
            let belongs = workspace_path.is_some_and(|path| path_is_within(path, target))
                || session
                    .cwd
                    .as_deref()
                    .is_some_and(|cwd| path_is_within(cwd, target))
                || root.is_some_and(|root| {
                    in_directory
                        .iter()
                        .any(|pid| process_belongs_to_root(&system, *pid, &HashSet::from([root])))
                });
            belongs.then(|| WorktreeRemovalSession {
                session_id: session.session_id.clone(),
                cwd: session.cwd.clone(),
                workspace_path: workspace_path.map(ToString::to_string),
            })
        })
        .collect();
    let mut external_processes = in_directory
        .into_iter()
        .filter(|pid| !process_belongs_to_root(&system, *pid, &managed_roots))
        .filter_map(|pid| {
            system.process(pid).map(|process| WorktreeRemovalProcess {
                pid: pid.as_u32(),
                name: process.name().to_string_lossy().into_owned(),
            })
        })
        .collect::<Vec<_>>();
    external_processes.sort_by_key(|process| process.pid);
    (running_sessions, external_processes)
}

fn ensure_no_wsl_removal_sessions(
    running: &[WorktreeRemovalSession],
    sessions: &[SessionMeta],
) -> Result<(), String> {
    let wsl = sessions
        .iter()
        .filter(|session| {
            session.alive
                && (session.environment_type.as_deref() == Some("wsl")
                    || session.shell.as_deref().is_some_and(|shell| {
                        let shell = shell.replace('\\', "/").to_ascii_lowercase();
                        matches!(shell.rsplit('/').next(), Some("wsl" | "wsl.exe"))
                    }))
        })
        .map(|session| session.session_id.as_str())
        .collect::<HashSet<_>>();
    if running
        .iter()
        .any(|session| wsl.contains(session.session_id.as_str()))
    {
        return Err("worktree_remove_wsl_sessions".into());
    }
    Ok(())
}

fn inspect_worktree_removal(
    project_input: &str,
    target_input: &str,
    branch: &str,
    sessions: &[SessionMeta],
) -> Result<(GitWorktreeRemovePreflight, WorktreeRemovalSnapshot), String> {
    let (project_path, target_path, registration) =
        removal_registration(project_input, target_input, branch)?;
    let (fingerprint, staged, unstaged, untracked, paths, changed_count) =
        removal_working_state(&target_path, &registration)?;
    let (running_sessions, external_processes) = removal_activity(&target_path, sessions);
    ensure_no_wsl_removal_sessions(&running_sessions, sessions)?;
    let dirty = staged + unstaged + untracked > 0;
    let token = uuid::Uuid::new_v4().to_string();
    let preview = GitWorktreeRemovePreflight {
        confirmation_token: token,
        worktree_path: path_to_git_arg(&target_path),
        branch: registration.branch.clone(),
        detached: registration.branch.is_none(),
        head: registration.head.clone(),
        locked: false,
        dirty,
        staged_count: staged,
        unstaged_count: unstaged,
        untracked_count: untracked,
        changed_paths: paths.into_iter().take(100).collect(),
        changed_count,
        running_sessions,
        external_processes,
    };
    let snapshot = WorktreeRemovalSnapshot {
        created_at: Instant::now(),
        project_path,
        target_path,
        branch: registration.branch,
        head: registration.head,
        fingerprint,
        dirty,
    };
    Ok((preview, snapshot))
}

fn cache_worktree_removal_snapshot(
    snapshots: &mut HashMap<String, WorktreeRemovalSnapshot>,
    token: String,
    snapshot: WorktreeRemovalSnapshot,
    capacity: usize,
) {
    snapshots.retain(|_, snapshot| snapshot.created_at.elapsed() < WORKTREE_CONFIRMATION_LIFETIME);
    if !snapshots.contains_key(&token) && snapshots.len() >= capacity.max(1) {
        let oldest = snapshots
            .iter()
            .min_by_key(|(_, snapshot)| snapshot.created_at)
            .map(|(token, _)| token.clone());
        if let Some(oldest) = oldest {
            snapshots.remove(&oldest);
        }
    }
    snapshots.insert(token, snapshot);
}

#[tauri::command]
pub async fn git_worktree_remove_preflight(
    project_path: String,
    worktree_path: String,
    branch: String,
    daemon_bridge: tauri::State<'_, DaemonBridge>,
) -> Result<GitWorktreeRemovePreflight, String> {
    let client = daemon_bridge
        .get()
        .ok_or("worktree_remove_sessions_unavailable")?;
    tokio::task::spawn_blocking(move || {
        let sessions = client
            .list()
            .map_err(|_| "worktree_remove_sessions_unavailable")?;
        let (preview, snapshot) =
            inspect_worktree_removal(&project_path, &worktree_path, &branch, &sessions)?;
        let mut snapshots = WORKTREE_REMOVAL_SNAPSHOTS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .map_err(|_| "worktree_remove_inspection_failed")?;
        cache_worktree_removal_snapshot(
            &mut snapshots,
            preview.confirmation_token.clone(),
            snapshot,
            WORKTREE_CONFIRMATION_LIMIT,
        );
        Ok(preview)
    })
    .await
    .map_err(|error| format!("task_failed: {error}"))?
}

fn remove_confirmed_worktree(
    project_input: &str,
    target_input: &str,
    expected_branch: &str,
    confirmation_token: &str,
    discard_changes: bool,
    delete_branch: bool,
    sessions: &[SessionMeta],
    final_sessions: impl FnOnce() -> Result<Vec<SessionMeta>, String>,
) -> Result<String, String> {
    let snapshot = WORKTREE_REMOVAL_SNAPSHOTS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "worktree_remove_inspection_failed")?
        .remove(confirmation_token)
        .ok_or("worktree_remove_confirmation_required")?;
    if snapshot.created_at.elapsed() >= WORKTREE_CONFIRMATION_LIFETIME {
        return Err("worktree_remove_confirmation_expired".into());
    }
    let (preview, current) =
        inspect_worktree_removal(project_input, target_input, expected_branch, sessions)?;
    if snapshot.project_path != current.project_path
        || snapshot.target_path != current.target_path
        || snapshot.branch != current.branch
        || snapshot.head != current.head
        || snapshot.fingerprint != current.fingerprint
    {
        return Err("worktree_remove_changed".into());
    }
    if !preview.running_sessions.is_empty() {
        return Err("worktree_remove_sessions_running".into());
    }
    if !preview.external_processes.is_empty() {
        return Err("worktree_remove_processes_running".into());
    }
    if snapshot.dirty && !discard_changes {
        return Err("worktree_remove_changes_confirmation_required".into());
    }
    if delete_branch && current.branch.is_none() {
        return Err("worktree_remove_detached_branch".into());
    }
    let final_sessions = final_sessions()?;
    let (running_sessions, external_processes) =
        removal_activity(&current.target_path, &final_sessions);
    ensure_no_wsl_removal_sessions(&running_sessions, &final_sessions)?;
    if !running_sessions.is_empty() {
        return Err("worktree_remove_sessions_running".into());
    }
    if !external_processes.is_empty() {
        return Err("worktree_remove_processes_running".into());
    }
    if delete_branch
        && removal_registrations(&current.project_path)?
            .iter()
            .any(|entry| {
                normalize_path_for_compare(&entry.path)
                    != normalize_path_for_compare(&current.target_path)
                    && entry.branch == current.branch
            })
    {
        return Err("worktree_remove_branch_in_use".into());
    }
    let (_, final_path, final_registration) =
        removal_registration(project_input, target_input, expected_branch)?;
    let (final_fingerprint, _, _, _, _, _) =
        removal_working_state(&final_path, &final_registration)?;
    if final_path != current.target_path
        || final_registration.head != snapshot.head
        || final_registration.branch != snapshot.branch
        || final_fingerprint != snapshot.fingerprint
    {
        return Err("worktree_remove_changed".into());
    }
    let target_arg = path_to_git_arg(&current.target_path);
    let mut args = vec!["worktree", "remove"];
    if snapshot.dirty && discard_changes {
        args.push("--force");
    }
    args.push("--");
    args.push(&target_arg);
    let mut output = run_git_checked(&current.project_path, args)?;
    if delete_branch {
        let branch = current
            .branch
            .as_deref()
            .ok_or("worktree_remove_detached_branch")?;
        match run_git_checked(&current.project_path, ["branch", "-D", "--", branch]) {
            Ok(result) => append_output_line(&mut output, &result),
            Err(error) => {
                append_output_line(&mut output, &format!("branch_delete_failed: {error}"))
            }
        }
    }
    cleanup_empty_worktree_parent(&current.target_path);
    Ok(output)
}

#[tauri::command]
pub async fn git_worktree_remove(
    project_path: String,
    worktree_path: String,
    branch: String,
    delete_branch: bool,
    confirmation_token: String,
    discard_changes: bool,
    daemon_bridge: tauri::State<'_, DaemonBridge>,
) -> Result<String, String> {
    let client = daemon_bridge
        .get()
        .ok_or("worktree_remove_sessions_unavailable")?;
    tokio::task::spawn_blocking(move || {
        let _operation = WORKTREE_REMOVAL_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .map_err(|_| "worktree_remove_inspection_failed")?;
        let sessions = client
            .list()
            .map_err(|_| "worktree_remove_sessions_unavailable")?;
        remove_confirmed_worktree(
            &project_path,
            &worktree_path,
            &branch,
            &confirmation_token,
            discard_changes,
            delete_branch,
            &sessions,
            || {
                client
                    .list()
                    .map_err(|_| "worktree_remove_sessions_unavailable".into())
            },
        )
    })
    .await
    .map_err(|error| format!("task_failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::{
        check_dependency_need, classify_worktree_registration, cleanup_empty_worktree_parent,
        cleanup_stale_unregistered_worktree, default_worktree_root, git_create_error_snippet,
        is_retryable_worktree_remove_error, is_stale_worktree_remove_error,
        parse_worktree_list_entries, path_to_git_arg, remove_registered_stale_worktree_dir,
        remove_worktree_path_with_retry, resolve_worktree_target_path,
        should_cleanup_worktree_branch_after_failed_add, validate_plain_branch_name,
        validate_task_name, validate_worktree_branch, WorktreeRegistration,
    };
    use std::fs;
    use std::io;
    use std::path::{Path, PathBuf};

    #[test]
    fn discovery_parses_nul_paths_detached_locked_and_prunable_entries() {
        let entries = super::parse_discovered_worktrees(
            "worktree /repo/bare\0bare\0\0worktree /trees/中文 with\nnewline\0HEAD abc123\0branch refs/heads/codex/task\0locked keep\0\0worktree /trees/detached\0HEAD def456\0detached\0\0worktree /trees/gone\0HEAD aaaa\0prunable gitdir missing\0\0",
        );
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].path, "/trees/中文 with\nnewline");
        assert_eq!(entries[0].branch, "codex/task");
        assert!(!entries[0].missing);
        assert_eq!(entries[1].head, "def456");
        assert!(entries[1].branch.is_empty());
        assert!(entries[2].missing);
    }

    #[test]
    fn discovery_reads_external_worktrees_from_main_or_linked_checkout_without_mutation() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        let repo = git2::Repository::init(&root).unwrap();
        let tree_id = repo.index().unwrap().write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let signature = git2::Signature::now("Test", "test@example.invalid").unwrap();
        repo.commit(Some("HEAD"), &signature, &signature, "fixture", &tree, &[])
            .unwrap();
        let external = temp.path().join("external with spaces");
        let detached = temp.path().join("detached");
        super::run_git_checked(
            &root,
            [
                "worktree",
                "add",
                "-b",
                "codex/external",
                external.to_str().unwrap(),
            ],
        )
        .unwrap();
        super::run_git_checked(&root, ["worktree", "lock", external.to_str().unwrap()]).unwrap();
        super::run_git_checked(
            &root,
            ["worktree", "add", "--detach", detached.to_str().unwrap()],
        )
        .unwrap();
        let before = super::run_git_raw(&root, ["worktree", "list", "--porcelain", "-z"])
            .unwrap()
            .stdout;
        let status = super::run_git_checked(&root, ["status", "--porcelain"]).unwrap();
        let entries = super::discover_git_worktrees(root.to_str().unwrap()).unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries
            .iter()
            .any(|entry| entry.branch == "codex/external" && !entry.missing));
        assert!(entries
            .iter()
            .any(|entry| entry.branch.is_empty() && !entry.head.is_empty()));
        let linked_entries = super::discover_git_worktrees(external.to_str().unwrap()).unwrap();
        assert_eq!(linked_entries.len(), 2);
        assert!(linked_entries
            .iter()
            .all(|entry| entry.branch != "codex/external"));
        assert_eq!(
            before,
            super::run_git_raw(&root, ["worktree", "list", "--porcelain", "-z"])
                .unwrap()
                .stdout
        );
        assert_eq!(
            status,
            super::run_git_checked(&root, ["status", "--porcelain"]).unwrap()
        );
    }

    #[test]
    fn validates_task_names() {
        assert_eq!(
            validate_task_name("task-0705_1200").unwrap(),
            "task-0705_1200"
        );
        assert_eq!(validate_task_name("").unwrap_err(), "task_name_empty");
        assert_eq!(validate_task_name("-bad").unwrap_err(), "task_name_invalid");
        assert_eq!(
            validate_task_name("bad/name").unwrap_err(),
            "task_name_invalid"
        );
        assert_eq!(
            validate_task_name("bad name").unwrap_err(),
            "task_name_invalid"
        );
        assert_eq!(validate_task_name("con").unwrap_err(), "task_name_reserved");
        assert_eq!(
            validate_task_name(&"a".repeat(65)).unwrap_err(),
            "task_name_too_long"
        );
    }

    #[test]
    fn validates_worktree_branch_prefix() {
        assert!(validate_worktree_branch("wt/task-1").is_ok());
        assert_eq!(
            validate_worktree_branch("feature/task-1").unwrap_err(),
            "branch_not_worktree"
        );
        assert_eq!(
            validate_worktree_branch("wt/bad/name").unwrap_err(),
            "task_name_invalid"
        );
    }

    #[test]
    fn keeps_final_git_error_after_checkout_progress() {
        let output = format!(
            "Preparing worktree\r{}fatal: unable to checkout files",
            "Checking out files: 30%\r".repeat(30)
        );
        let snippet = git_create_error_snippet(&output);
        assert!(snippet.contains("fatal: unable to checkout files"));
    }

    #[test]
    fn detects_retryable_worktree_remove_errors() {
        assert!(is_retryable_worktree_remove_error(
            "git_failed: error: failed to delete 'task-1': Permission denied"
        ));
        assert!(is_retryable_worktree_remove_error(
            "fatal: unable to unlink old-file: Device or resource busy"
        ));
        assert!(is_retryable_worktree_remove_error(
            "The process cannot access the file because it is being used by another process"
        ));
        assert!(is_retryable_worktree_remove_error(
            "remove_stale_worktree_dir_failed: 另一个程序正在使用此文件，进程无法访问。 (os error 32)"
        ));
        assert!(!is_retryable_worktree_remove_error(
            "git_failed: branch not found"
        ));
    }

    #[test]
    fn detects_stale_worktree_remove_errors() {
        assert!(is_stale_worktree_remove_error(
            "git_failed: fatal: 'F:\\repo\\worktrees\\task-1' is not a working tree"
        ));
        assert!(is_stale_worktree_remove_error(
            "git_failed: fatal: validation failed, cannot remove working tree: 'C:/repo/wt/.git' does not exist"
        ));
        assert!(is_stale_worktree_remove_error(
            "prunable gitdir file points to non-existent location"
        ));
        assert!(!is_stale_worktree_remove_error(
            "git_failed: error: failed to delete 'task-1': Permission denied"
        ));
    }

    #[test]
    fn computes_default_worktree_root_next_to_project() {
        let project_path = Path::new("/repo/demo-app");
        let root = default_worktree_root(project_path).unwrap();
        assert_eq!(root, PathBuf::from("/repo/demo-app-worktrees"));
    }

    #[test]
    fn resolves_target_path_under_custom_root() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        let root = temp.path().join("custom-root");
        fs::create_dir_all(&project).unwrap();
        let target =
            resolve_worktree_target_path(&project, "task-1", Some(root.to_str().unwrap())).unwrap();
        assert_eq!(target, root.canonicalize().unwrap().join("task-1"));
    }

    #[test]
    fn git_path_args_do_not_keep_windows_extended_prefix() {
        assert_eq!(
            path_to_git_arg(Path::new("\\\\?\\D:\\repo\\worktrees\\task-1")),
            "D:\\repo\\worktrees\\task-1"
        );
        assert_eq!(
            path_to_git_arg(Path::new("//?/D:/repo/worktrees/task-1")),
            "D:/repo/worktrees/task-1"
        );
    }

    #[test]
    fn cleanup_after_failed_add_is_limited_to_new_wt_branches() {
        assert!(should_cleanup_worktree_branch_after_failed_add(
            "wt/task-1",
            false
        ));
        assert!(!should_cleanup_worktree_branch_after_failed_add(
            "wt/task-1",
            true
        ));
        assert!(!should_cleanup_worktree_branch_after_failed_add(
            "main", false
        ));
        assert!(!should_cleanup_worktree_branch_after_failed_add(
            "feature/task-1",
            false
        ));
    }

    #[test]
    fn validates_base_branch_names() {
        assert!(validate_plain_branch_name("main").is_ok());
        assert!(validate_plain_branch_name("release/1.0").is_ok());
        assert_eq!(
            validate_plain_branch_name("-bad").unwrap_err(),
            "base_branch_invalid"
        );
        assert_eq!(
            validate_plain_branch_name("bad branch").unwrap_err(),
            "base_branch_invalid"
        );
        assert_eq!(
            validate_plain_branch_name("bad..branch").unwrap_err(),
            "base_branch_invalid"
        );
    }

    #[test]
    fn parses_porcelain_worktree_entries() {
        let output = "worktree C:/repo/main\nHEAD abc\nbranch refs/heads/main\n\nworktree C:/repo/wt/task\nHEAD def\nbranch refs/heads/wt/task\n";
        let entries = parse_worktree_list_entries(output);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[1].path, PathBuf::from("C:/repo/wt/task"));
        assert_eq!(entries[1].branch.as_deref(), Some("wt/task"));
    }

    #[test]
    fn classifies_worktree_registration() {
        let entries = parse_worktree_list_entries(
            "worktree C:/repo/main\nHEAD abc\nbranch refs/heads/main\n\nworktree C:/repo/wt/task\nHEAD def\nbranch refs/heads/wt/task\n",
        );
        assert_eq!(
            classify_worktree_registration(&entries, Path::new("C:/repo/wt/task"), "wt/task"),
            WorktreeRegistration::Matched
        );
        assert_eq!(
            classify_worktree_registration(&entries, Path::new("C:/repo/wt/task"), "wt/other"),
            WorktreeRegistration::Mismatched
        );
        assert_eq!(
            classify_worktree_registration(&entries, Path::new("C:/repo/wt/other"), "wt/task"),
            WorktreeRegistration::Mismatched
        );
        assert_eq!(
            classify_worktree_registration(&entries, Path::new("C:/repo/wt/missing"), "wt/missing"),
            WorktreeRegistration::Missing
        );
    }

    #[test]
    fn cleanup_empty_worktree_parent_removes_only_empty_root() {
        let temp = tempfile::tempdir().unwrap();

        // 空根目录：删掉最后一个 worktree 后，根目录应被清理
        let root = temp.path().join("proj-worktrees");
        let wt = root.join("task-1");
        fs::create_dir_all(&wt).unwrap();
        fs::remove_dir(&wt).unwrap(); // 模拟 git 已移除该 worktree 目录
        cleanup_empty_worktree_parent(&wt);
        assert!(!root.exists());

        // 非空根目录（还有其它 worktree）：保持不动
        let root2 = temp.path().join("proj2-worktrees");
        let wt_a = root2.join("task-a");
        let wt_b = root2.join("task-b");
        fs::create_dir_all(&wt_a).unwrap();
        fs::create_dir_all(&wt_b).unwrap();
        fs::remove_dir(&wt_a).unwrap();
        cleanup_empty_worktree_parent(&wt_a);
        assert!(root2.exists());
        assert!(wt_b.exists());
    }

    #[test]
    fn cleanup_stale_unregistered_worktree_removes_empty_dir_only() {
        let temp = tempfile::tempdir().unwrap();
        let empty = temp.path().join("empty");
        fs::create_dir(&empty).unwrap();
        let output =
            cleanup_stale_unregistered_worktree(temp.path(), &empty, "wt/task", false).unwrap();
        assert_eq!(output, "removed_stale_empty_worktree_dir");
        assert!(!empty.exists());

        let non_empty = temp.path().join("non-empty");
        fs::create_dir(&non_empty).unwrap();
        fs::write(non_empty.join("keep.txt"), "data").unwrap();
        assert_eq!(
            cleanup_stale_unregistered_worktree(temp.path(), &non_empty, "wt/task", false)
                .unwrap_err(),
            "worktree_not_registered"
        );
        assert!(non_empty.exists());
    }

    #[test]
    fn registered_stale_worktree_cleanup_can_remove_non_empty_dir() {
        let temp = tempfile::tempdir().unwrap();
        let stale = temp.path().join("stale");
        fs::create_dir(&stale).unwrap();
        fs::write(stale.join("leftover.txt"), "data").unwrap();

        let output = remove_registered_stale_worktree_dir(&stale).unwrap();
        assert_eq!(output, "removed_stale_registered_worktree_dir");
        assert!(!stale.exists());
    }

    #[test]
    fn stale_worktree_path_remove_retries_windows_file_lock_errors() {
        let temp = tempfile::tempdir().unwrap();
        let stale = temp.path().join("stale");
        fs::create_dir(&stale).unwrap();
        fs::write(stale.join("leftover.txt"), "data").unwrap();

        let mut attempts = 0;
        remove_worktree_path_with_retry(&stale, |path| {
            attempts += 1;
            if attempts < 3 {
                Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "os error 32",
                ))
            } else {
                fs::remove_dir_all(path)
            }
        })
        .unwrap();

        assert_eq!(attempts, 3);
        assert!(!stale.exists());
    }

    #[test]
    fn detects_dependency_install_matrix() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("package.json"), "{}").unwrap();
        let npm = check_dependency_need(temp.path());
        assert!(npm.needs_install);
        assert_eq!(npm.command.as_deref(), Some("npm install"));

        fs::create_dir(temp.path().join("node_modules")).unwrap();
        let none = check_dependency_need(temp.path());
        assert!(!none.needs_install);

        let cargo_dir = tempfile::tempdir().unwrap();
        fs::write(cargo_dir.path().join("Cargo.toml"), "[package]\nname='x'\n").unwrap();
        let cargo = check_dependency_need(cargo_dir.path());
        assert!(cargo.needs_install);
        assert_eq!(cargo.command.as_deref(), Some("cargo fetch"));
    }
}

#[cfg(test)]
mod removal_tests {
    use super::*;

    fn fixture(detached: bool) -> (tempfile::TempDir, PathBuf, PathBuf, String) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("main");
        let repo = Repository::init(&root).unwrap();
        let hooks = temp.path().join("empty-hooks");
        fs::create_dir(&hooks).unwrap();
        repo.config()
            .unwrap()
            .set_str("core.hooksPath", hooks.to_str().unwrap())
            .unwrap();
        repo.config()
            .unwrap()
            .set_bool("commit.gpgsign", false)
            .unwrap();
        fs::write(root.join("tracked.txt"), "original\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("tracked.txt")).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let signature = git2::Signature::now("Test", "test@example.invalid").unwrap();
        repo.commit(Some("HEAD"), &signature, &signature, "fixture", &tree, &[])
            .unwrap();
        let target = temp.path().join("external ' worktree");
        if detached {
            run_git_checked(
                &root,
                ["worktree", "add", "--detach", target.to_str().unwrap()],
            )
            .unwrap();
        } else {
            run_git_checked(
                &root,
                [
                    "worktree",
                    "add",
                    "-b",
                    "codex/external",
                    target.to_str().unwrap(),
                ],
            )
            .unwrap();
        }
        let branch = if detached {
            run_git_checked(&target, ["rev-parse", "--short=8", "HEAD"]).unwrap()
        } else {
            "codex/external".to_string()
        };
        (temp, root, target, branch)
    }

    fn inspect(root: &Path, target: &Path, branch: &str) -> GitWorktreeRemovePreflight {
        let (preview, snapshot) = inspect_worktree_removal(
            root.to_str().unwrap(),
            target.to_str().unwrap(),
            branch,
            &[],
        )
        .unwrap();
        WORKTREE_REMOVAL_SNAPSHOTS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap()
            .insert(preview.confirmation_token.clone(), snapshot);
        preview
    }

    fn remove(
        root: &Path,
        target: &Path,
        branch: &str,
        token: &str,
        discard: bool,
        delete_branch: bool,
    ) -> Result<String, String> {
        remove_confirmed_worktree(
            root.to_str().unwrap(),
            target.to_str().unwrap(),
            branch,
            token,
            discard,
            delete_branch,
            &[],
            || Ok(Vec::new()),
        )
    }

    #[test]
    fn external_worktree_removal_requires_an_opaque_confirmation_and_keeps_branch_by_default() {
        let (_temp, root, target, branch) = fixture(false);
        assert_eq!(
            remove(&root, &target, &branch, "forged", false, false).unwrap_err(),
            "worktree_remove_confirmation_required"
        );
        assert!(target.exists());
        let preview = inspect(&root, &target, &branch);
        assert!(!preview.dirty);
        assert!(!preview.detached);
        assert!(preview.external_processes.is_empty());
        remove(
            &root,
            &target,
            &branch,
            &preview.confirmation_token,
            false,
            false,
        )
        .unwrap();
        assert!(!target.exists());
        assert!(branch_exists(&root, &branch).unwrap());
        assert_eq!(
            remove(
                &root,
                &target,
                &branch,
                &preview.confirmation_token,
                false,
                false
            )
            .unwrap_err(),
            "worktree_remove_confirmation_required"
        );
    }

    #[test]
    fn staged_unstaged_and_untracked_changes_need_explicit_discard_consent() {
        let (_temp, root, target, branch) = fixture(false);
        fs::write(target.join("tracked.txt"), "staged\n").unwrap();
        run_git_checked(&target, ["add", "tracked.txt"]).unwrap();
        fs::write(target.join("tracked.txt"), "new unstaged\n").unwrap();
        fs::write(target.join("untracked.txt"), "new data\n").unwrap();
        let preview = inspect(&root, &target, &branch);
        assert!(preview.dirty);
        assert_eq!(preview.staged_count, 1);
        assert_eq!(preview.unstaged_count, 1);
        assert_eq!(preview.untracked_count, 1);
        assert_eq!(
            remove(
                &root,
                &target,
                &branch,
                &preview.confirmation_token,
                false,
                false
            )
            .unwrap_err(),
            "worktree_remove_changes_confirmation_required"
        );
        assert!(target.join("untracked.txt").exists());
        let preview = inspect(&root, &target, &branch);
        remove(
            &root,
            &target,
            &branch,
            &preview.confirmation_token,
            true,
            false,
        )
        .unwrap();
        assert!(!target.exists());
    }

    #[test]
    fn same_status_but_changed_tracked_or_untracked_contents_invalidate_consent() {
        for untracked in [false, true] {
            let (_temp, root, target, branch) = fixture(false);
            let file = target.join(if untracked {
                "untracked.txt"
            } else {
                "tracked.txt"
            });
            fs::write(&file, "first\n").unwrap();
            let preview = inspect(&root, &target, &branch);
            fs::write(&file, "other\n").unwrap();
            assert_eq!(
                remove(
                    &root,
                    &target,
                    &branch,
                    &preview.confirmation_token,
                    true,
                    false
                )
                .unwrap_err(),
                "worktree_remove_changed"
            );
            assert_eq!(fs::read_to_string(file).unwrap(), "other\n");
        }
    }

    #[test]
    fn main_locked_mismatched_and_unregistered_paths_are_never_deleted() {
        let (temp, root, target, branch) = fixture(false);
        let main_branch = current_branch_name(&Repository::open(&root).unwrap()).unwrap();
        assert_eq!(
            removal_registration(root.to_str().unwrap(), root.to_str().unwrap(), &main_branch)
                .unwrap_err(),
            "worktree_remove_primary"
        );
        assert_eq!(
            removal_registration(
                root.to_str().unwrap(),
                target.to_str().unwrap(),
                "codex/other"
            )
            .unwrap_err(),
            "worktree_branch_mismatch"
        );
        run_git_checked(&root, ["worktree", "lock", target.to_str().unwrap()]).unwrap();
        assert_eq!(
            removal_registration(root.to_str().unwrap(), target.to_str().unwrap(), &branch)
                .unwrap_err(),
            "worktree_remove_locked"
        );
        let unknown = temp.path().join("unknown");
        fs::create_dir(&unknown).unwrap();
        fs::write(unknown.join("keep"), "safe").unwrap();
        assert_eq!(
            removal_registration(
                root.to_str().unwrap(),
                unknown.to_str().unwrap(),
                "codex/other"
            )
            .unwrap_err(),
            "worktree_not_registered"
        );
        assert!(target.exists());
        assert!(unknown.join("keep").exists());
    }

    #[test]
    fn detached_worktree_can_be_removed_but_never_treats_display_head_as_a_branch() {
        let (_temp, root, target, branch) = fixture(true);
        let preview = inspect(&root, &target, &branch);
        assert!(preview.detached);
        assert!(preview.branch.is_none());
        assert_eq!(
            remove(
                &root,
                &target,
                &branch,
                &preview.confirmation_token,
                false,
                true
            )
            .unwrap_err(),
            "worktree_remove_detached_branch"
        );
        assert!(target.exists());
        let preview = inspect(&root, &target, &branch);
        remove(
            &root,
            &target,
            &branch,
            &preview.confirmation_token,
            false,
            false,
        )
        .unwrap();
        assert!(!target.exists());
    }

    #[test]
    fn running_daemon_session_and_a_new_session_before_mutation_block_removal() {
        let (_temp, root, target, branch) = fixture(false);
        let preview = inspect(&root, &target, &branch);
        let session: SessionMeta = serde_json::from_value(serde_json::json!({
            "sessionId":"hidden-tab", "cwd":target, "shell":"zsh", "alive":true,
            "environmentType":"local", "createdAtMs":0, "taskStatus":null,"taskUpdatedAtMs":null,
            "workspace":{"path":target,"environmentType":"local"}
        }))
        .unwrap();
        let error = remove_confirmed_worktree(
            root.to_str().unwrap(),
            target.to_str().unwrap(),
            &branch,
            &preview.confirmation_token,
            false,
            false,
            &[],
            || Ok(vec![session]),
        )
        .unwrap_err();
        assert_eq!(error, "worktree_remove_sessions_running");
        assert!(target.exists());
    }

    #[test]
    fn expired_confirmation_and_a_late_lock_cannot_remove_the_target() {
        let (_temp, root, target, branch) = fixture(false);
        let preview = inspect(&root, &target, &branch);
        WORKTREE_REMOVAL_SNAPSHOTS
            .get()
            .unwrap()
            .lock()
            .unwrap()
            .get_mut(&preview.confirmation_token)
            .unwrap()
            .created_at = Instant::now() - WORKTREE_CONFIRMATION_LIFETIME - Duration::from_secs(1);
        assert_eq!(
            remove(
                &root,
                &target,
                &branch,
                &preview.confirmation_token,
                false,
                false
            )
            .unwrap_err(),
            "worktree_remove_confirmation_expired"
        );
        let preview = inspect(&root, &target, &branch);
        run_git_checked(&root, ["worktree", "lock", target.to_str().unwrap()]).unwrap();
        assert_eq!(
            remove(
                &root,
                &target,
                &branch,
                &preview.confirmation_token,
                false,
                false
            )
            .unwrap_err(),
            "worktree_remove_locked"
        );
        assert!(target.exists());
    }

    #[test]
    fn branch_deletion_is_a_separate_explicit_choice_and_rechecks_head_changes() {
        let (_temp, root, target, branch) = fixture(false);
        let preview = inspect(&root, &target, &branch);
        run_git_checked(
            &target,
            [
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "--allow-empty",
                "-m",
                "late commit",
            ],
        )
        .unwrap();
        assert_eq!(
            remove(
                &root,
                &target,
                &branch,
                &preview.confirmation_token,
                false,
                true
            )
            .unwrap_err(),
            "worktree_remove_changed"
        );
        assert!(target.exists());
        assert!(branch_exists(&root, &branch).unwrap());
        let preview = inspect(&root, &target, &branch);
        remove(
            &root,
            &target,
            &branch,
            &preview.confirmation_token,
            false,
            true,
        )
        .unwrap();
        assert!(!target.exists());
        assert!(!branch_exists(&root, &branch).unwrap());
    }

    #[test]
    fn confirmation_cache_evicts_only_the_oldest_entry_and_preserves_other_live_confirmations() {
        let now = Instant::now();
        let snapshot = |age| WorktreeRemovalSnapshot {
            created_at: now - Duration::from_secs(age),
            project_path: PathBuf::from("/repo"),
            target_path: PathBuf::from("/tree"),
            branch: Some("branch".into()),
            head: "head".into(),
            fingerprint: "fingerprint".into(),
            dirty: false,
        };
        let mut snapshots = HashMap::new();
        cache_worktree_removal_snapshot(&mut snapshots, "oldest".into(), snapshot(3), 2);
        cache_worktree_removal_snapshot(&mut snapshots, "confirmed".into(), snapshot(2), 2);
        cache_worktree_removal_snapshot(&mut snapshots, "fresh-check".into(), snapshot(1), 2);
        assert_eq!(snapshots.len(), 2);
        assert!(!snapshots.contains_key("oldest"));
        assert!(snapshots.contains_key("confirmed"));
        assert!(snapshots.contains_key("fresh-check"));
        // Replacing an existing key cannot evict an unrelated active review.
        cache_worktree_removal_snapshot(&mut snapshots, "fresh-check".into(), snapshot(0), 2);
        assert!(snapshots.contains_key("confirmed"));
        assert_eq!(snapshots.len(), 2);
        // Expired entries are reclaimed before capacity pressure affects live tokens.
        snapshots.insert(
            "expired".into(),
            snapshot(WORKTREE_CONFIRMATION_LIFETIME.as_secs() + 1),
        );
        cache_worktree_removal_snapshot(&mut snapshots, "fresh-check".into(), snapshot(0), 2);
        assert!(!snapshots.contains_key("expired"));
        assert!(snapshots.contains_key("confirmed"));
    }

    #[test]
    fn an_outer_worktree_cannot_delete_another_registered_nested_worktree() {
        let (_temp, root, target, branch) = fixture(false);
        let nested = target.join("nested");
        run_git_checked(
            &root,
            [
                "worktree",
                "add",
                "-b",
                "codex/nested",
                nested.to_str().unwrap(),
            ],
        )
        .unwrap();
        assert_eq!(
            inspect_worktree_removal(
                root.to_str().unwrap(),
                target.to_str().unwrap(),
                &branch,
                &[]
            )
            .unwrap_err(),
            "worktree_remove_nested_worktree"
        );
        assert!(target.exists());
        assert!(nested.join("tracked.txt").exists());
        assert!(branch_exists(&root, "codex/nested").unwrap());
    }

    #[test]
    fn preview_counts_all_unique_changes_while_only_returning_the_first_hundred_paths() {
        let (_temp, root, target, branch) = fixture(false);
        for index in 0..105 {
            fs::write(target.join(format!("file-{index:03}.txt")), "data").unwrap();
        }
        let preview = inspect(&root, &target, &branch);
        assert_eq!(preview.changed_count, 105);
        assert_eq!(preview.untracked_count, 105);
        assert_eq!(preview.changed_paths.len(), 100);
    }

    #[test]
    fn staged_index_content_changes_invalidate_confirmation_even_with_the_same_working_file() {
        let (_temp, root, target, branch) = fixture(false);
        fs::write(target.join("tracked.txt"), "stage one\n").unwrap();
        run_git_checked(&target, ["add", "tracked.txt"]).unwrap();
        fs::write(target.join("tracked.txt"), "working\n").unwrap();
        let preview = inspect(&root, &target, &branch);
        fs::write(target.join("tracked.txt"), "stage two\n").unwrap();
        run_git_checked(&target, ["add", "tracked.txt"]).unwrap();
        fs::write(target.join("tracked.txt"), "working\n").unwrap();
        assert_eq!(
            remove(
                &root,
                &target,
                &branch,
                &preview.confirmation_token,
                true,
                false
            )
            .unwrap_err(),
            "worktree_remove_changed"
        );
        assert!(target.exists());
    }

    #[test]
    fn active_wsl_requires_manual_guest_shutdown_while_exited_and_ssh_metadata_do_not_block() {
        let (_temp, root, target, branch) = fixture(false);
        let session = |environment: &str, alive: bool| -> SessionMeta {
            serde_json::from_value(serde_json::json!({
                "sessionId":"guest-tab", "cwd":target, "shell":if environment == "wsl" { "wsl" } else { "zsh" }, "alive":alive,
                "environmentType":environment, "createdAtMs":0, "taskStatus":null,"taskUpdatedAtMs":null,
                "sshHostId":if environment == "ssh" { Some("host") } else { None },
                "workspace":{"path":target,"environmentType":"local"}
            })).unwrap()
        };
        let inspect_with = |sessions: &[SessionMeta]| {
            inspect_worktree_removal(
                root.to_str().unwrap(),
                target.to_str().unwrap(),
                &branch,
                sessions,
            )
        };
        assert_eq!(
            inspect_with(&[session("wsl", true)]).unwrap_err(),
            "worktree_remove_wsl_sessions"
        );
        assert!(inspect_with(&[session("wsl", false)])
            .unwrap()
            .0
            .running_sessions
            .is_empty());
        assert!(inspect_with(&[session("ssh", true)])
            .unwrap()
            .0
            .running_sessions
            .is_empty());
        let preview = inspect(&root, &target, &branch);
        let error = remove_confirmed_worktree(
            root.to_str().unwrap(),
            target.to_str().unwrap(),
            &branch,
            &preview.confirmation_token,
            false,
            false,
            &[],
            || Ok(vec![session("wsl", true)]),
        )
        .unwrap_err();
        assert_eq!(error, "worktree_remove_wsl_sessions");
        assert!(target.exists());
    }

    #[cfg(unix)]
    #[test]
    fn external_process_in_worktree_is_reported_and_never_terminated() {
        let (_temp, root, target, branch) = fixture(false);
        let mut child = Command::new("sleep")
            .arg("30")
            .current_dir(&target)
            .spawn()
            .unwrap();
        struct Cleanup<'a>(&'a mut std::process::Child);
        impl Drop for Cleanup<'_> {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let cleanup = Cleanup(&mut child);
        let preview = inspect(&root, &target, &branch);
        assert!(preview
            .external_processes
            .iter()
            .any(|process| process.pid == cleanup.0.id()));
        assert_eq!(
            remove(
                &root,
                &target,
                &branch,
                &preview.confirmation_token,
                false,
                false
            )
            .unwrap_err(),
            "worktree_remove_processes_running"
        );
        assert!(cleanup.0.try_wait().unwrap().is_none());
        assert!(target.exists());
    }
}
