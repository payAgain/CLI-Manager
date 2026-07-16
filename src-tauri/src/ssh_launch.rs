use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshLaunchPlan {
    pub host_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub config_alias: String,
    pub auth_mode: String,
    pub identity_file: String,
    pub jump_target: String,
    pub proxy_command: String,
    pub connect_timeout_sec: u64,
    pub server_alive_interval_sec: u64,
    pub server_alive_count_max: u32,
    pub remote_path: String,
    #[serde(default)]
    pub environment_overrides: HashMap<String, String>,
    #[serde(default)]
    pub initialization_command: Option<String>,
    pub startup_command: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshProcessLaunch {
    pub executable: String,
    pub args: Vec<String>,
}

impl SshLaunchPlan {
    pub fn build_process_launch(&self) -> Result<SshProcessLaunch, String> {
        self.validate()?;
        let mut args = vec![
            "-tt".to_string(),
            "-o".to_string(),
            format!("ConnectTimeout={}", self.connect_timeout_sec),
            "-o".to_string(),
            format!("ServerAliveInterval={}", self.server_alive_interval_sec),
            "-o".to_string(),
            format!("ServerAliveCountMax={}", self.server_alive_count_max),
        ];
        if self.config_alias.trim().is_empty() {
            args.extend(["-p".to_string(), self.port.to_string()]);
        }
        if !self.identity_file.trim().is_empty() {
            args.extend(["-i".to_string(), self.identity_file.trim().to_string()]);
        }
        match self.auth_mode.as_str() {
            "identity_file" => args.extend(["-o".to_string(), "IdentitiesOnly=yes".to_string()]),
            "password_prompt" => args.extend([
                "-o".to_string(),
                "PubkeyAuthentication=no".to_string(),
                "-o".to_string(),
                "PreferredAuthentications=password,keyboard-interactive".to_string(),
            ]),
            _ => {}
        }
        if !self.jump_target.trim().is_empty() {
            args.extend(["-J".to_string(), self.jump_target.trim().to_string()]);
        }
        if !self.proxy_command.trim().is_empty() {
            args.extend([
                "-o".to_string(),
                format!("ProxyCommand={}", self.proxy_command.trim()),
            ]);
        }
        args.push(self.target());
        args.push(self.remote_command());
        Ok(SshProcessLaunch {
            executable: "ssh".to_string(),
            args,
        })
    }

    fn validate(&self) -> Result<(), String> {
        if self.host_id.trim().is_empty() {
            return Err("ssh_host_not_found".to_string());
        }
        if self.config_alias.trim().is_empty() && self.host.trim().is_empty() {
            return Err("ssh_host_address_required".to_string());
        }
        if self.config_alias.trim().is_empty() && self.port == 0 {
            return Err("ssh_host_port_invalid".to_string());
        }
        if self.connect_timeout_sec == 0 || self.connect_timeout_sec > 300 {
            return Err("ssh_connect_timeout_invalid".to_string());
        }
        if self.server_alive_count_max > 100 {
            return Err("ssh_server_alive_count_invalid".to_string());
        }
        if !matches!(
            self.auth_mode.as_str(),
            "ssh_config"
                | "agent"
                | "identity_file"
                | "password_prompt"
                | "interactive"
                | "credential_ref"
        ) {
            return Err("ssh_auth_mode_invalid".to_string());
        }
        if self.auth_mode == "identity_file" && self.identity_file.trim().is_empty() {
            return Err("ssh_identity_file_required".to_string());
        }
        if self.auth_mode == "credential_ref" {
            return Err("ssh_credential_ref_not_supported".to_string());
        }
        for value in [
            &self.config_alias,
            &self.host,
            &self.username,
            &self.identity_file,
            &self.jump_target,
            &self.proxy_command,
        ] {
            validate_single_line(value)?;
        }
        if contains_url_credentials(&self.proxy_command) {
            return Err("ssh_proxy_credentials_forbidden".to_string());
        }
        validate_remote_path(&self.remote_path)?;
        if self
            .environment_overrides
            .keys()
            .any(|key| !is_valid_environment_key(key))
        {
            return Err("ssh_environment_key_invalid".to_string());
        }
        if self
            .environment_overrides
            .values()
            .any(|value| value.contains('\0'))
        {
            return Err("ssh_environment_value_invalid".to_string());
        }
        if self
            .initialization_command
            .as_deref()
            .is_some_and(|command| command.contains('\0'))
            || self
                .startup_command
                .as_deref()
                .is_some_and(|command| command.contains('\0'))
        {
            return Err("ssh_startup_command_invalid".to_string());
        }
        Ok(())
    }

    fn target(&self) -> String {
        if !self.config_alias.trim().is_empty() {
            return self.config_alias.trim().to_string();
        }
        if self.username.trim().is_empty() {
            self.host.trim().to_string()
        } else {
            format!("{}@{}", self.username.trim(), self.host.trim())
        }
    }

    fn remote_command(&self) -> String {
        let mut setup = vec![format!("cd -- {}", posix_quote(self.remote_path.trim()))];
        let mut environment: Vec<_> = self.environment_overrides.iter().collect();
        environment.sort_by(|left, right| left.0.cmp(right.0));
        setup.extend(
            environment
                .into_iter()
                .map(|(key, value)| format!("export {key}={}", posix_quote(value))),
        );
        if let Some(command) = self
            .initialization_command
            .as_deref()
            .map(str::trim)
            .filter(|command| !command.is_empty())
        {
            setup.push(format!(
                "\"${{SHELL:-/bin/sh}}\" -lc {}",
                posix_quote(command)
            ));
        }
        let setup = setup.join(" && ");
        match self.startup_command.as_deref().map(str::trim) {
            Some(command) if !command.is_empty() => format!(
                "{setup} && exec \"${{SHELL:-/bin/sh}}\" -lc {}",
                posix_quote(command)
            ),
            _ => format!("{setup} && exec \"${{SHELL:-/bin/sh}}\" -l"),
        }
    }
}

fn validate_single_line(value: &str) -> Result<(), String> {
    if value.contains(['\0', '\r', '\n']) {
        return Err("ssh_launch_argument_invalid".to_string());
    }
    Ok(())
}

fn validate_remote_path(path: &str) -> Result<(), String> {
    let path = path.trim();
    if !path.starts_with('/') || path.contains(['\0', '\r', '\n']) {
        return Err("ssh_remote_path_invalid".to_string());
    }
    if path.split('/').any(|part| part == "..") {
        return Err("ssh_remote_path_parent_forbidden".to_string());
    }
    Ok(())
}

fn posix_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn is_valid_environment_key(key: &str) -> bool {
    let mut chars = key.chars();
    matches!(chars.next(), Some('_' | 'A'..='Z' | 'a'..='z'))
        && chars.all(|ch| matches!(ch, '_' | 'A'..='Z' | 'a'..='z' | '0'..='9'))
}

fn contains_url_credentials(value: &str) -> bool {
    value.split_whitespace().any(|token| {
        let Some((_, remainder)) = token.split_once("://") else {
            return false;
        };
        let authority = remainder.split('/').next().unwrap_or(remainder);
        authority
            .split_once('@')
            .is_some_and(|(userinfo, _)| userinfo.contains(':'))
    })
}

#[cfg(test)]
mod tests {
    use super::SshLaunchPlan;

    fn plan() -> SshLaunchPlan {
        SshLaunchPlan {
            host_id: "host-1".into(),
            host: "example.com".into(),
            port: 2222,
            username: "dev".into(),
            config_alias: String::new(),
            auth_mode: "identity_file".into(),
            identity_file: "C:/Users/dev/.ssh/id key".into(),
            jump_target: "bastion".into(),
            proxy_command: String::new(),
            connect_timeout_sec: 15,
            server_alive_interval_sec: 30,
            server_alive_count_max: 3,
            remote_path: "/srv/project name/开发".into(),
            environment_overrides: [("APP_MODE".to_string(), "remote dev".to_string())].into(),
            initialization_command: None,
            startup_command: Some("printf '%s\\n' \"it's ready\"".into()),
        }
    }

    #[test]
    fn builds_structured_ssh_arguments_and_quotes_remote_values() {
        let launch = plan().build_process_launch().unwrap();
        assert_eq!(launch.executable, "ssh");
        assert!(launch.args.windows(2).any(|pair| pair == ["-p", "2222"]));
        assert!(launch
            .args
            .windows(2)
            .any(|pair| pair == ["-i", "C:/Users/dev/.ssh/id key"]));
        assert!(launch.args.windows(2).any(|pair| pair == ["-J", "bastion"]));
        assert!(launch.args.iter().any(|arg| arg == "IdentitiesOnly=yes"));
        assert_eq!(launch.args[launch.args.len() - 2], "dev@example.com");
        assert_eq!(launch.args.last().unwrap(), "cd -- '/srv/project name/开发' && export APP_MODE='remote dev' && exec \"${SHELL:-/bin/sh}\" -lc 'printf '\\''%s\\n'\\'' \"it'\\''s ready\"'");
    }

    #[test]
    fn config_alias_owns_host_and_port_resolution() {
        let mut value = plan();
        value.config_alias = "prod".into();
        value.host.clear();
        value.port = 0;
        let launch = value.build_process_launch().unwrap();
        assert!(!launch.args.iter().any(|arg| arg == "-p"));
        assert_eq!(launch.args[launch.args.len() - 2], "prod");
    }

    #[test]
    fn interactive_shell_is_started_when_no_startup_command_exists() {
        let mut value = plan();
        value.startup_command = None;
        assert_eq!(value.build_process_launch().unwrap().args.last().unwrap(), "cd -- '/srv/project name/开发' && export APP_MODE='remote dev' && exec \"${SHELL:-/bin/sh}\" -l");
    }

    #[test]
    fn rejects_parent_traversal_and_multiline_arguments() {
        let mut value = plan();
        value.remote_path = "/srv/../root".into();
        assert_eq!(
            value.build_process_launch().unwrap_err(),
            "ssh_remote_path_parent_forbidden"
        );
        let mut value = plan();
        value.jump_target = "host\n-o BatchMode=yes".into();
        assert_eq!(
            value.build_process_launch().unwrap_err(),
            "ssh_launch_argument_invalid"
        );
    }

    #[test]
    fn password_mode_disables_public_key_authentication() {
        let mut value = plan();
        value.auth_mode = "password_prompt".into();
        value.identity_file.clear();
        let launch = value.build_process_launch().unwrap();
        assert!(launch
            .args
            .iter()
            .any(|arg| arg == "PubkeyAuthentication=no"));
        assert!(launch
            .args
            .iter()
            .any(|arg| arg == "PreferredAuthentications=password,keyboard-interactive"));
    }
}
