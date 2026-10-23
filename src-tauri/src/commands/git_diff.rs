use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

use super::git::{
    open_git_repo, resolve_wsl_mnt_git_project_path, run_wsl_git, validate_repo_relative_path,
};
use super::git_diff_display::{
    detect_file_diff_encoding, format_cli_diff, format_diff_for_display,
};
use crate::text_encoding::decode_text;

pub(super) const MAX_DIFF_BYTES: usize = 768 * 1024;
pub(super) const MAX_DIFF_LINES: usize = 20_000;

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum GitDiffWhitespaceMode {
    Exact,
    IgnoreEol,
    IgnoreAll,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitDiffOptions {
    pub whitespace: GitDiffWhitespaceMode,
    pub context_lines: u32,
}

impl Default for GitDiffOptions {
    fn default() -> Self {
        Self {
            whitespace: GitDiffWhitespaceMode::Exact,
            context_lines: 3,
        }
    }
}

impl GitDiffOptions {
    pub fn validate(self) -> Result<Self, String> {
        if matches!(self.context_lines, 3 | 10 | 20) {
            Ok(self)
        } else {
            Err("git_diff_options_invalid".to_string())
        }
    }

    pub(super) fn allows_partial_revert(self) -> bool {
        self.whitespace == GitDiffWhitespaceMode::Exact
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDiffPayload {
    pub content: String,
    pub can_revert_hunks: bool,
    pub byte_length: usize,
    pub line_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_fingerprint: Option<String>,
    pub review_version: u8,
}

pub(super) fn build_diff_payload(
    content: String,
    can_revert_hunks: bool,
) -> Result<GitFileDiffPayload, String> {
    let byte_length = content.len();
    let line_count = content.lines().count();
    if byte_length > MAX_DIFF_BYTES || line_count > MAX_DIFF_LINES {
        return Err("git_diff_too_large".to_string());
    }
    Ok(GitFileDiffPayload {
        content,
        can_revert_hunks,
        byte_length,
        line_count,
        content_fingerprint: None,
        review_version: 1,
    })
}

pub(super) fn get_file_diff(
    project_path: &str,
    file_path: &str,
    status: &str,
    options: GitDiffOptions,
) -> Result<GitFileDiffPayload, String> {
    validate_repo_relative_path(file_path)?;

    if let Some((distro, linux_path)) = crate::wsl::parse_wsl_unc_path(project_path) {
        if let Some(windows_path) = resolve_wsl_mnt_git_project_path(&distro, &linux_path) {
            return get_native_diff(Path::new(&windows_path), file_path, status, options);
        }
        return get_wsl_diff(
            project_path,
            &distro,
            &linux_path,
            file_path,
            status,
            options,
        );
    }

    let root = Path::new(project_path);
    if !root.exists() {
        return Err(format!("路径不存在: {project_path}"));
    }
    get_native_diff(root, file_path, status, options)
}

fn get_native_diff(
    root: &Path,
    file_path: &str,
    status: &str,
    options: GitDiffOptions,
) -> Result<GitFileDiffPayload, String> {
    if matches!(status, "U" | "??") {
        return untracked_diff(root, file_path);
    }

    let repo = open_git_repo(root).map_err(|error| format!("打开仓库失败: {error}"))?;
    let encoding = detect_file_diff_encoding(&repo, root, file_path)?;
    let mut diff_options = git2::DiffOptions::new();
    diff_options.pathspec(file_path);
    diff_options.context_lines(options.context_lines);
    diff_options.id_abbrev(40);
    diff_options.force_text(encoding.is_some());
    match options.whitespace {
        GitDiffWhitespaceMode::Exact => {}
        GitDiffWhitespaceMode::IgnoreEol => {
            diff_options.ignore_whitespace_eol(true);
        }
        GitDiffWhitespaceMode::IgnoreAll => {
            diff_options.ignore_whitespace(true);
        }
    }

    // Review the complete working change, including already-staged additions.
    let head_tree = match repo.head() {
        Ok(head) => Some(head.peel_to_tree().map_err(|error| format!("获取 HEAD tree 失败: {error}"))?),
        Err(error) if matches!(error.code(), git2::ErrorCode::UnbornBranch | git2::ErrorCode::NotFound) => None,
        Err(error) => return Err(format!("获取 HEAD 失败: {error}")),
    };
    let diff = repo.diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut diff_options))
        .map_err(|error| format!("生成 diff 失败: {error}"))?;

    let mut payload = format_diff_for_display(diff, file_path, encoding.as_ref(), options)?;
    // The existing partial-revert builder handles modifications, not /dev/null file headers.
    if status == "A" { payload.can_revert_hunks = false; }
    Ok(payload)
}

fn get_wsl_diff(
    unc_root: &str,
    distro: &str,
    linux_root: &str,
    file_path: &str,
    status: &str,
    options: GitDiffOptions,
) -> Result<GitFileDiffPayload, String> {
    if matches!(status, "U" | "??") {
        return untracked_diff(Path::new(unc_root), file_path);
    }

    let args = cli_diff_args(file_path, status, options);
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    let bytes = match run_wsl_git(distro, linux_root, &refs) {
        Ok(bytes) => bytes,
        Err(error) if status == "A" => {
            // An unborn repository has no HEAD; its new file is compared to an empty base.
            let unborn = run_wsl_git(distro, linux_root, &["status", "--porcelain=v2", "--branch", "--untracked-files=no", "--", file_path])
                .map(|output| String::from_utf8_lossy(&output).lines().any(|line| line == "# branch.oid (initial)"))
                .unwrap_or(false);
            if !unborn {
                return Err(error);
            }
            return untracked_diff(Path::new(unc_root), file_path);
        }
        Err(error) => return Err(error),
    };
    let mut payload = format_cli_diff(&bytes, file_path, options)?;
    if status == "A" { payload.can_revert_hunks = false; }
    Ok(payload)
}

fn cli_diff_args(file_path: &str, _status: &str, options: GitDiffOptions) -> Vec<String> {
    let mut args = vec![
        "-c".to_string(),
        "diff.external=".to_string(),
        "-c".to_string(),
        "pager.diff=false".to_string(),
        "-c".to_string(),
        "core.quotepath=false".to_string(),
        "diff".to_string(),
        "--no-ext-diff".to_string(),
        "--no-textconv".to_string(),
        "--no-color".to_string(),
        "--full-index".to_string(),
        format!("--unified={}", options.context_lines),
    ];
    match options.whitespace {
        GitDiffWhitespaceMode::Exact => {}
        GitDiffWhitespaceMode::IgnoreEol => args.push("--ignore-space-at-eol".to_string()),
        GitDiffWhitespaceMode::IgnoreAll => args.push("--ignore-all-space".to_string()),
    }
    args.push("HEAD".to_string());
    args.extend(["--".to_string(), file_path.to_string()]);
    args
}

fn untracked_diff(root: &Path, file_path: &str) -> Result<GitFileDiffPayload, String> {
    let full_path = root.join(file_path);
    let metadata = std::fs::symlink_metadata(&full_path).map_err(|error| format!("读取文件失败: {error}"))?;
    if metadata.file_type().is_symlink() { return Err("git_diff_symlink_unsupported".to_string()); }
    if !metadata.is_file() {
        return Err("该条目是目录（可能为嵌套 Git 仓库），无法显示文件 diff".to_string());
    }
    if metadata.len() > MAX_DIFF_BYTES as u64 { return Err("git_diff_too_large".to_string()); }
    let bytes = std::fs::read(&full_path).map_err(|error| format!("读取文件失败: {error}"))?;
    if bytes.len() > MAX_DIFF_BYTES { return Err("git_diff_too_large".to_string()); }
    let content = decode_text(&bytes)?.content;
    let line_count = content.lines().count();
    #[cfg(unix)]
    let mode = {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 != 0 { "100755" } else { "100644" }
    };
    #[cfg(not(unix))]
    let mode = "100644";
    let mut diff = format!(
        "diff --git a/{file_path} b/{file_path}\nnew file mode {mode}\n--- /dev/null\n+++ b/{file_path}\n@@ -0,0 +1,{line_count} @@\n"
    );
    for line in content.split_inclusive('\n') {
        diff.push('+');
        diff.push_str(line);
        if !line.ends_with('\n') { diff.push_str("\n\\ No newline at end of file\n"); }
    }
    let mut payload = build_diff_payload(diff, false)?;
    payload.content_fingerprint = Some(format!("{:x}", Sha256::digest(&bytes)));
    Ok(payload)
}

#[cfg(test)]
#[path = "git_diff_tests.rs"]
mod tests;
