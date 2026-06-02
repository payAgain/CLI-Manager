use log::{error, info, warn};
use std::io::ErrorKind;
use std::path::PathBuf;
use std::process::Command;

use crate::shell_resolver::{resolve_git_bash_exe, GIT_BASH_NOT_FOUND_MESSAGE};

#[derive(serde::Deserialize)]
pub struct ExternalTab {
    pub cwd: Option<String>,
    pub title: String,
    pub startup_cmd: Option<String>,
    pub shell: Option<String>,
}

fn shell_exe(shell: &str) -> Result<(String, Option<&'static str>), String> {
    match shell {
        "cmd" => Ok(("cmd".to_string(), Some("/K"))),
        "pwsh" => Ok(("pwsh".to_string(), Some("-NoExit"))),
        "wsl" => Ok(("wsl".to_string(), None)),
        "gitbash" => resolve_git_bash_exe()
            .map(|path| (path.to_string_lossy().into_owned(), None))
            .ok_or_else(|| GIT_BASH_NOT_FOUND_MESSAGE.to_string()),
        "bash" => Ok(("bash".to_string(), None)),
        _ => Ok(("powershell".to_string(), Some("-NoExit"))),
    }
}

fn push_tab_args(args: &mut Vec<String>, tab: &ExternalTab) -> Result<(), String> {
    args.push("new-tab".into());
    if let Some(cwd) = &tab.cwd {
        args.push("-d".into());
        args.push(cwd.clone());
    }
    args.push("--title".into());
    args.push(tab.title.clone());
    args.push("--suppressApplicationTitle".into());

    let shell_key = tab.shell.as_deref().unwrap_or("powershell");
    let (exe, no_exit_flag) = shell_exe(shell_key)?;

    if let Some(cmd) = &tab.startup_cmd {
        let cmd = cmd.trim();
        if !cmd.is_empty() {
            args.push(exe.into());
            if let Some(flag) = no_exit_flag {
                args.push(flag.into());
            }
            if shell_key == "cmd" {
                args.push(cmd.into());
            } else if shell_key == "gitbash" {
                args.push("--login".into());
                args.push("-i".into());
                args.push("-c".into());
                args.push(format!("{}; exec bash --login -i", cmd));
            } else {
                args.push("-Command".into());
                args.push(cmd.into());
            }
            return Ok(());
        }
    }
    args.push(exe.into());
    Ok(())
}

fn windows_terminal_candidates() -> Vec<PathBuf> {
    let mut candidates = vec![PathBuf::from("wt"), PathBuf::from("wt.exe")];
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(local_app_data)
                .join("Microsoft")
                .join("WindowsApps")
                .join("wt.exe"),
        );
    }
    candidates
}

fn spawn_windows_terminal(args: &[String]) -> Result<PathBuf, std::io::Error> {
    let candidates = windows_terminal_candidates();
    let mut last_err: Option<std::io::Error> = None;

    for candidate in candidates {
        match Command::new(&candidate).args(args).spawn() {
            Ok(_) => return Ok(candidate),
            Err(err) => {
                warn!("Failed to spawn {:?}: {}", candidate, err);
                last_err = Some(err);
            }
        }
    }

    Err(last_err.unwrap_or_else(|| {
        std::io::Error::new(
            ErrorKind::NotFound,
            "Windows Terminal executable (wt.exe) not found",
        )
    }))
}

#[tauri::command]
pub async fn open_windows_terminal(tabs: Vec<ExternalTab>) -> Result<(), String> {
    if tabs.is_empty() {
        return Ok(());
    }

    let mut args: Vec<String> = vec!["-w".into(), "0".into()];
    for (i, tab) in tabs.iter().enumerate() {
        if i > 0 {
            args.push(";".into());
        }
        push_tab_args(&mut args, tab).map_err(|e| {
            error!(
                "Failed to resolve shell for Windows Terminal tab: shell={:?}, error={}",
                tab.shell, e
            );
            e
        })?;
    }

    info!("open_windows_terminal: wt {}", args.join(" "));

    spawn_windows_terminal(&args).map_err(|e| {
        error!("Failed to open Windows Terminal: {}", e);
        if e.kind() == ErrorKind::NotFound {
            "Failed to open Windows Terminal: Windows Terminal (wt.exe) not found. Please install Windows Terminal or disable external terminal mode in Settings.".to_string()
        } else {
            format!("Failed to open Windows Terminal: {}", e)
        }
    })?;

    Ok(())
}
