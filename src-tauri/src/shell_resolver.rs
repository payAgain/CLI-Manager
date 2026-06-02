use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

pub const GIT_BASH_NOT_FOUND_MESSAGE: &str =
    "Git Bash executable not found. Please install Git for Windows or add Git Bash to PATH.";

const GIT_BASH_CANDIDATES: [&str; 4] = [
    r"C:\Program Files\Git\bin\bash.exe",
    r"C:\Program Files\Git\usr\bin\bash.exe",
    r"C:\Program Files (x86)\Git\bin\bash.exe",
    r"C:\Program Files (x86)\Git\usr\bin\bash.exe",
];

pub fn resolve_git_bash_exe() -> Option<PathBuf> {
    fixed_path_candidate()
        .or_else(path_git_candidate)
        .or_else(registry_git_candidate)
}

fn fixed_path_candidate() -> Option<PathBuf> {
    GIT_BASH_CANDIDATES
        .iter()
        .map(PathBuf::from)
        .find(|candidate| candidate.exists())
}

fn path_git_candidate() -> Option<PathBuf> {
    env::var_os("PATH").and_then(|path| {
        env::split_paths(&path)
            .filter(is_git_path_dir)
            .map(|dir| dir.join("bash.exe"))
            .find(|candidate| candidate.exists())
    })
}

fn is_git_path_dir(dir: &PathBuf) -> bool {
    let normalized = dir.to_string_lossy().replace('\\', "/").to_lowercase();
    normalized.ends_with("/git/bin") || normalized.ends_with("/git/usr/bin")
}

#[cfg(windows)]
fn registry_git_candidate() -> Option<PathBuf> {
    app_paths_candidate().or_else(uninstall_key_candidate)
}

#[cfg(not(windows))]
fn registry_git_candidate() -> Option<PathBuf> {
    None
}

#[cfg(windows)]
fn app_paths_candidate() -> Option<PathBuf> {
    const APP_PATH_KEYS: [&str; 4] = [
        r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\bash.exe",
        r"HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\bash.exe",
        r"HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\bash.exe",
        r"HKCU\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\bash.exe",
    ];

    APP_PATH_KEYS
        .iter()
        .filter_map(|key| reg_query_value(key, None))
        .map(PathBuf::from)
        .find(|candidate| candidate.exists() && is_git_bash_path(candidate))
}

#[cfg(windows)]
fn uninstall_key_candidate() -> Option<PathBuf> {
    const UNINSTALL_KEYS: [&str; 4] = [
        r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        r"HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        r"HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        r"HKCU\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
    ];

    UNINSTALL_KEYS.iter().find_map(|key| {
        let output = Command::new("reg")
            .args(["query", key, "/s", "/f", "Git", "/d"])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }

        let text = String::from_utf8_lossy(&output.stdout);
        install_locations_from_reg_output(&text)
            .into_iter()
            .flat_map(git_bash_candidates_from_install_dir)
            .find(|candidate| candidate.exists())
    })
}

#[cfg(windows)]
fn reg_query_value(key: &str, value: Option<&str>) -> Option<String> {
    let mut args = vec!["query", key];
    if let Some(value) = value {
        args.extend(["/v", value]);
    } else {
        args.push("/ve");
    }

    let output = Command::new("reg").args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }

    parse_reg_value(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(windows)]
fn parse_reg_value(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let trimmed = line.trim();
        let value_start = trimmed.find("REG_")?;
        let value = trimmed[value_start..].split_once(char::is_whitespace)?.1;
        let cleaned = clean_registry_path(value.trim());
        (!cleaned.is_empty()).then_some(cleaned)
    })
}

#[cfg(windows)]
fn install_locations_from_reg_output(output: &str) -> Vec<PathBuf> {
    output
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if !trimmed.starts_with("InstallLocation") {
                return None;
            }
            parse_reg_value(trimmed).map(PathBuf::from)
        })
        .collect()
}

#[cfg(windows)]
fn clean_registry_path(value: &str) -> String {
    let trimmed = value.trim().trim_matches('"');
    let without_icon_index = trimmed
        .strip_suffix(",0")
        .or_else(|| trimmed.strip_suffix(",-0"))
        .unwrap_or(trimmed);
    without_icon_index.trim_matches('"').to_string()
}

#[cfg(windows)]
fn git_bash_candidates_from_install_dir(dir: PathBuf) -> Vec<PathBuf> {
    vec![
        dir.join("bin").join("bash.exe"),
        dir.join("usr").join("bin").join("bash.exe"),
    ]
}

#[cfg(windows)]
fn is_git_bash_path(path: &Path) -> bool {
    let normalized = path.to_string_lossy().replace('\\', "/").to_lowercase();
    (normalized.ends_with("/git/bin/bash.exe") || normalized.ends_with("/git/usr/bin/bash.exe"))
        && path.exists()
}
