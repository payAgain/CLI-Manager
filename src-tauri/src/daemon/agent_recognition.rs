//! Shared executable/package recognition; command text is never evidence.
pub(crate) fn executable_stem(value: &str) -> String {
    value
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(value)
        .to_ascii_lowercase()
        .trim_end_matches(".exe")
        .trim_end_matches(".js")
        .trim_end_matches(".cjs")
        .trim_end_matches(".mjs")
        .to_string()
}

fn agent_label(value: &str) -> Option<&'static str> {
    match value {
        "claude" => Some("Claude"),
        "codex" => Some("Codex"),
        "gemini" => Some("Gemini"),
        "pi" => Some("Pi"),
        "grok" => Some("Grok"),
        "opencode" => Some("OpenCode"),
        "aider" => Some("Aider"),
        "amp" => Some("Amp"),
        "copilot" => Some("Copilot"),
        "qwen" => Some("Qwen"),
        "kimi" => Some("Kimi"),
        _ => None,
    }
}

pub(crate) fn identify_agent(name: &str, command: &[String]) -> Option<&'static str> {
    // Claude's native installer uses ~/.local/share/claude/versions/<version>.
    // The executable path is authoritative even when the process name is just a version.
    let path = name.replace('\\', "/").to_ascii_lowercase();
    if let Some((_, version)) = path.rsplit_once("/.local/share/claude/versions/") {
        if version.chars().next().is_some_and(|c| c.is_ascii_digit())
            && version
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'))
        {
            return Some("Claude");
        }
    }
    let executable = executable_stem(name);
    if let Some(label) = agent_label(&executable) {
        return Some(label);
    }
    // Shell command text and arbitrary directory names are not agent identities.
    if !matches!(
        executable.as_str(),
        "node" | "nodejs" | "bun" | "deno" | "python" | "python3"
    ) && !executable
        .strip_prefix("python3.")
        .is_some_and(|version| version.chars().all(|c| c.is_ascii_digit() || c == '.'))
    {
        return None;
    }
    let mut args = command.iter().skip(1);
    let script = loop {
        let arg = args.next()?;
        if arg == "-m" && executable.starts_with("python") {
            return match args.next()?.as_str() {
                "aider" | "aider.main" => Some("Aider"),
                "kimi_cli" => Some("Kimi"),
                _ => None,
            };
        }
        // Evaluation strings and option values are not executable scripts.
        if arg.starts_with("--eval")
            || arg.starts_with("--print")
            || (arg.starts_with('-')
                && !arg.starts_with("--")
                && arg.chars().skip(1).any(|c| matches!(c, 'e' | 'p' | 'c')))
        {
            return None;
        }
        if matches!(
            arg.as_str(),
            "-r" | "--require" | "--loader" | "--import" | "--inspect-port"
        ) {
            args.next()?;
            continue;
        }
        if arg == "--" {
            break args.next()?;
        }
        if arg.starts_with('-') || (arg == "run" && matches!(executable.as_str(), "bun" | "deno")) {
            continue;
        }
        break arg;
    };
    if let Some(label) = agent_label(&executable_stem(script)) {
        return Some(label);
    }
    let script = script.replace('\\', "/").to_ascii_lowercase();
    for (package, label) in [
        ("/@anthropic-ai/claude-code/", "Claude"),
        ("/@openai/codex/", "Codex"),
        ("/@google/gemini-cli/", "Gemini"),
        ("/@earendil-works/pi-coding-agent/", "Pi"),
        ("/@mariozechner/pi-coding-agent/", "Pi"),
        ("/@vibe-kit/grok-cli/", "Grok"),
    ] {
        if script.contains(package) {
            return Some(label);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    fn recognize(name: &str, args: &[&str]) -> Option<&'static str> {
        identify_agent(
            name,
            &args.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        )
    }
    #[test]
    fn recognizes_native_and_known_package_launchers() {
        assert_eq!(recognize("codex.exe", &[]), Some("Codex"));
        assert_eq!(
            recognize("/Users/test/.local/share/claude/versions/2.1.278", &[]),
            Some("Claude")
        );
        assert_eq!(
            recognize("node", &["node", "/npm/@anthropic-ai/claude-code/cli.js"]),
            Some("Claude")
        );
        assert_eq!(
            recognize("bun", &["bun", "run", "/npm/@openai/codex/bin/codex.js"]),
            Some("Codex")
        );
        assert_eq!(
            recognize("python3.13", &["python3.13", "-m", "aider"]),
            Some("Aider")
        );
    }
    #[test]
    fn evaluation_text_directory_names_and_option_values_are_not_agents() {
        for (name, args) in [
            ("bash", vec!["bash", "-c", "codex"]),
            ("node", vec!["node", "-e", "codex"]),
            ("node", vec!["node", "--eval=codex"]),
            ("python3", vec!["python3", "-c", "claude"]),
            (
                "node",
                vec!["node", "--require", "/tmp/codex", "/project/main.js"],
            ),
            ("node", vec!["node", "/project/codex/main.js"]),
        ] {
            assert_eq!(recognize(name, &args), None, "{args:?}");
        }
    }

    #[test]
    fn pi_recognizes_current_and_legacy_packages_across_launchers() {
        for package in ["@earendil-works", "@mariozechner"] {
            let windows = format!(r"E:\dev-cache\npm-global\node_modules\{package}\pi-coding-agent\dist\bundle\cli.js");
            assert_eq!(recognize("node.exe", &["node.exe", &windows]), Some("Pi"));
            let unix = format!("/opt/npm/node_modules/{package}/pi-coding-agent/dist/cli.js");
            assert_eq!(recognize("node", &["node", &unix]), Some("Pi"));
            assert_eq!(recognize("bun", &["bun", "run", &unix]), Some("Pi"));
            assert_eq!(recognize("deno", &["deno", "run", "--allow-all", &unix]), Some("Pi"));
        }
        assert_eq!(recognize("pi.exe", &[]), Some("Pi"));
    }

    #[test]
    fn pi_package_text_and_unrelated_packages_are_not_agent_identities() {
        let script = "/npm/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
        for (name, args) in [
            ("node", vec!["node", "--eval", script]),
            ("node", vec!["node", "--require", script, "/project/main.js"]),
            ("bash", vec!["bash", "-c", script]),
            ("node", vec!["node", "/project/main.js", script]),
            ("node", vec!["node", "/project/pi/server.js"]),
            ("node", vec!["node", "/npm/@earendil-works/pi-coding-agent-tools/cli.js"]),
            ("node", vec!["node", "/npm/@someone/pi-coding-agent/cli.js"]),
        ] {
            assert_eq!(recognize(name, &args), None, "{args:?}");
        }
    }
}
