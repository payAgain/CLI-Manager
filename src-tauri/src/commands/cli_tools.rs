use std::collections::HashMap;
use std::process::Command;
use std::time::Duration;

use super::ssh::{cli_tools_probe_command, SshConnectionSpec};
use crate::pty::manager::PtyManager;
use crate::shell_resolver::{output_with_timeout, silent_command};
use crate::ssh_transport::posix_quote;

const TOOLS: &[&str] = &[
    "claude", "codex", "opencode", "kimi", "grok", "qwen", "gemini", "copilot", "cline", "goose",
    "amp", "aider", "crush", "pi",
];
const BEGIN: &str = "CLI_MANAGER_TOOLS_BEGIN_1";
const END: &str = "CLI_MANAGER_TOOLS_END_1";

fn posix_script() -> String {
    format!(
        "printf '%s\\n' '{BEGIN}'; for tool in {}; do if command -v \"$tool\" >/dev/null 2>&1; then printf '%s\\n' \"$tool\"; fi; done; printf '%s\\n' '{END}'",
        TOOLS.join(" ")
    )
}

fn fish_script() -> String {
    format!(
        "printf '%s\\n' '{BEGIN}'; for tool in {}; if type -q $tool; printf '%s\\n' $tool; end; end; printf '%s\\n' '{END}'",
        TOOLS.join(" ")
    )
}

fn powershell_script() -> String {
    let names = TOOLS
        .iter()
        .map(|name| format!("'{name}'"))
        .collect::<Vec<_>>()
        .join(",");
    format!("[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Write-Output '{BEGIN}'; foreach ($cliManagerTool in @({names})) {{ if (Get-Command -Name $cliManagerTool -ErrorAction SilentlyContinue) {{ Write-Output $cliManagerTool }} }}; Write-Output '{END}'")
}

fn cmd_script() -> String {
    let checks = TOOLS
        .iter()
        .map(|name| format!("(where {name} >nul 2>nul && echo {name})"))
        .collect::<Vec<_>>()
        .join(" & ");
    format!("echo {BEGIN} & {checks} & echo {END}")
}

fn parse_tools(output: &[u8]) -> Result<Vec<String>, String> {
    let text = String::from_utf8_lossy(output);
    let mut inside = false;
    let mut found = Vec::new();
    for line in text.lines().map(str::trim) {
        if line == BEGIN {
            inside = true;
            found.clear();
            continue;
        }
        if inside && line == END {
            return Ok(found);
        }
        if inside && TOOLS.contains(&line) && !found.iter().any(|tool| tool == line) {
            found.push(line.to_string());
        }
    }
    Err("cli_tools_probe_incomplete".to_string())
}

fn validate_environment(env: &HashMap<String, String>) -> Result<(), String> {
    if env
        .iter()
        .any(|(key, value)| key.is_empty() || key.contains(['=', '\0']) || value.contains('\0'))
    {
        return Err("cli_tools_environment_invalid".to_string());
    }
    Ok(())
}

fn remote_script(cwd: Option<&str>, env: &HashMap<String, String>) -> Result<String, String> {
    let mut setup = String::new();
    if let Some(path) = cwd.filter(|path| !path.is_empty()) {
        if !path.starts_with('/') || path.contains(['\0', '\r', '\n']) {
            return Err("ssh_remote_path_invalid".to_string());
        }
        setup.push_str(&format!("cd -- {} && ", posix_quote(path)));
    }
    let mut variables = env.iter().collect::<Vec<_>>();
    variables.sort_by_key(|(key, _)| *key);
    // env operands remain separate quoted arguments, including PATH and values containing spaces.
    let environment = variables
        .iter()
        .map(|(key, value)| posix_quote(&format!("{key}={value}")))
        .collect::<Vec<_>>()
        .join(" ");
    Ok(format!("{setup}case \"${{SHELL:-/bin/sh}}\" in *fish) exec env {environment} \"${{SHELL:-/bin/sh}}\" -ic {} ;; *) exec env {environment} \"${{SHELL:-/bin/sh}}\" -lic {} ;; esac", posix_quote(&fish_script()), posix_quote(&posix_script())))
}

fn local_command(shell: &str, cwd: Option<&str>) -> Result<Command, String> {
    let normalized = shell.trim().to_ascii_lowercase();
    let requested = if !shell.contains(['/', '\\']) {
        normalized.trim_end_matches(".exe")
    } else {
        shell
    };
    let (executable, args) = PtyManager::resolve_shell(requested)?;
    let name = executable
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(&executable)
        .to_ascii_lowercase();
    let name = name.trim_end_matches(".exe");
    let mut command = silent_command(&executable);
    command.args(&args);
    match name {
        "powershell" | "pwsh" => {
            command.args(["-Command", &powershell_script()]);
        }
        "cmd" => {
            command.args(["/S", "/C", &cmd_script()]);
        }
        "fish" => {
            command.args(["-i", "-c", &fish_script()]);
        }
        "bash" | "zsh" | "sh" => {
            if !args.iter().any(|arg| arg == "-i") {
                command.arg("-i");
            }
            command.args(["-c", &posix_script()]);
        }
        "wsl" if cfg!(target_os = "windows") => {
            if let Some((distro, _)) = cwd.and_then(crate::wsl::parse_wsl_unc_path) {
                command.args(["--distribution", &distro]);
            }
            command.args(["--exec", "sh", "-c", &remote_script(None, &HashMap::new())?]);
        }
        _ => return Err("cli_tools_shell_unsupported".to_string()),
    }
    if let Some(path) = cwd.filter(|path| std::path::Path::new(path).is_dir()) {
        command.current_dir(path);
    }
    Ok(command)
}

fn scan(
    shell: Option<&str>,
    cwd: Option<&str>,
    env: HashMap<String, String>,
    ssh_spec: Option<SshConnectionSpec>,
) -> Result<Vec<String>, String> {
    validate_environment(&env)?;
    let mut command = if let Some(mut spec) = ssh_spec {
        spec.validate()?;
        spec.connect_timeout_sec = spec.connect_timeout_sec.min(8);
        cli_tools_probe_command(
            &spec,
            &format!("sh -c {}", posix_quote(&remote_script(cwd, &env)?)),
        )?
    } else {
        let mut command = local_command(shell.unwrap_or(""), cwd)?;
        command.envs(&env);
        command
    };
    // Do not launch any Agent or inspect credentials; only resolve names inside its Shell.
    command.env("CLI_MANAGER_TOOL_SCAN", "1");
    let output =
        output_with_timeout(command, Duration::from_secs(12)).map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err("cli_tools_probe_failed".to_string());
    }
    parse_tools(&output.stdout)
}

#[tauri::command]
pub async fn cli_tools_scan(
    shell: Option<String>,
    cwd: Option<String>,
    env_vars: Option<HashMap<String, String>>,
    ssh_spec: Option<SshConnectionSpec>,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        scan(
            shell.as_deref(),
            cwd.as_deref(),
            env_vars.unwrap_or_default(),
            ssh_spec,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_known_names_inside_a_complete_frame() {
        assert_eq!(
            parse_tools(
                format!("codex\n{BEGIN}\nclaude\ncodex\ncodex\nunknown\n{END}\ngemini").as_bytes()
            )
            .unwrap(),
            vec!["claude", "codex"]
        );
        assert_eq!(
            parse_tools(format!("{BEGIN}\r\n{END}\r\n").as_bytes()).unwrap(),
            Vec::<String>::new()
        );
        assert!(parse_tools(format!("{BEGIN}\ncodex").as_bytes()).is_err());
        assert!(parse_tools(b"codex").is_err());
    }

    #[test]
    fn remote_probe_quotes_context_and_never_runs_a_cli() {
        let script = remote_script(
            Some("/home/dev/my repo"),
            &HashMap::from([("CUSTOM".into(), "x'; touch /tmp/no".into())]),
        )
        .unwrap();
        assert!(script.contains("cd -- '/home/dev/my repo'"));
        assert!(script.contains("command -v"));
        assert!(!script.contains("--version"));
        assert!(!script.contains("--yolo"));
        assert!(remote_script(Some("relative"), &HashMap::new()).is_err());
        assert!(validate_environment(&HashMap::from([("X=BAD".into(), "x".into())])).is_err());
    }

    #[test]
    fn remote_scan_keeps_ssh_validation_and_interactive_auth_guard() {
        let mut spec: SshConnectionSpec = serde_json::from_value(serde_json::json!({
            "host": "example.invalid", "port": 22, "username": "dev", "configAlias": "",
            "authMode": "interactive", "identityFile": "", "jumpTarget": "",
            "connectTimeoutSec": 5, "serverAliveIntervalSec": 30, "serverAliveCountMax": 3
        }))
        .unwrap();
        assert_eq!(
            cli_tools_probe_command(&spec, "true").unwrap_err(),
            "ssh_interactive_auth_required"
        );
        spec.auth_mode = "password_prompt".into();
        assert_eq!(
            cli_tools_probe_command(&spec, "true").unwrap_err(),
            "ssh_interactive_auth_required"
        );
        spec.host.clear();
        assert!(cli_tools_probe_command(&spec, "true").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn finds_executable_files_without_executing_them() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("cli-manager-tools-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let executable = root.join("codex");
        let marker = root.join("must-not-execute");
        std::fs::write(
            &executable,
            format!("#!/bin/sh\ntouch '{}'\n", marker.display()),
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        let result = scan(
            Some("/bin/sh"),
            Some(root.to_str().unwrap()),
            HashMap::from([
                ("PATH".into(), root.to_string_lossy().into_owned()),
                ("ENV".into(), String::new()),
            ]),
            None,
        );
        assert_eq!(result.unwrap(), vec!["codex"]);
        assert!(!marker.exists());
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o644)).unwrap();
        let result = scan(
            Some("/bin/sh"),
            None,
            HashMap::from([
                ("PATH".into(), root.to_string_lossy().into_owned()),
                ("ENV".into(), String::new()),
            ]),
            None,
        );
        assert!(result.unwrap().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn scans_real_macos_login_shell() {
        let tools = scan(Some("zsh"), None, HashMap::new(), None).unwrap();
        assert!(tools.iter().all(|tool| TOOLS.contains(&tool.as_str())));
        eprintln!("installed tools in zsh: {tools:?}");
        let tools = scan(
            Some("zsh"),
            None,
            HashMap::from([("PATH".into(), "/usr/bin:/bin:/usr/sbin:/sbin".into())]),
            None,
        )
        .unwrap();
        assert!(tools.iter().all(|tool| TOOLS.contains(&tool.as_str())));
        eprintln!("installed tools after login startup with minimal GUI PATH: {tools:?}");
    }
}
