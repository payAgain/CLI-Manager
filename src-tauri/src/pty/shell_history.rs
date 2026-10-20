use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::OnceLock;

pub const HISTORY_ENV: &str = "CLI_MANAGER_COMMAND_HISTORY";
pub const BASH_HISTORY: &str = include_str!("integration/history.bash");
const ZSH_HISTORY: &str = include_str!("integration/history.zsh");

pub fn enabled(env: Option<&HashMap<String, String>>) -> bool {
    env.and_then(|vars| vars.get(HISTORY_ENV))
        .is_some_and(|value| value == "1")
}

// These wrappers live in the app's own data directory, never in user dotfiles.
// Zsh still loads each original startup file, including a custom ZDOTDIR.
fn integration_dir() -> Result<&'static PathBuf, String> {
    static ROOT: OnceLock<Result<PathBuf, String>> = OnceLock::new();
    ROOT.get_or_init(|| {
        let root = crate::app_paths::cli_manager_data_dir()?.join("shell-history-v1");
        std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).map_err(|error| error.to_string())?;
        }
        let delegate = |name: &str| format!(
            "ZDOTDIR=\"${{__cli_manager_user_zdotdir-$HOME}}\"\n[[ ! -r $ZDOTDIR/{name} ]] || source \"$ZDOTDIR/{name}\"\n__cli_manager_user_zdotdir=\"${{ZDOTDIR-$HOME}}\"\n"
        );
        let restore = "ZDOTDIR=\"$__cli_manager_user_zdotdir\"\nsource \"$_CLI_MANAGER_HISTORY_DIR/history.zsh\"\n";
        let files = [
            (".zshenv", format!("__cli_manager_user_zdotdir=\"${{_CLI_MANAGER_USER_ZDOTDIR-$HOME}}\"\n{}ZDOTDIR=\"$_CLI_MANAGER_HISTORY_DIR\"\n", delegate(".zshenv"))),
            (".zprofile", format!("{}ZDOTDIR=\"$_CLI_MANAGER_HISTORY_DIR\"\n", delegate(".zprofile"))),
            (".zshrc", format!("{}if [[ -o login ]]; then ZDOTDIR=\"$_CLI_MANAGER_HISTORY_DIR\"; else\n{restore}fi\n", delegate(".zshrc"))),
            (".zlogin", format!("{}{restore}", delegate(".zlogin"))),
            ("history.zsh", ZSH_HISTORY.to_string()),
            ("history.bash", BASH_HISTORY.to_string()),
            ("bashrc", "if [[ $_CLI_MANAGER_HISTORY_LOGIN == 1 ]]; then\n  [[ ! -r /etc/profile ]] || source /etc/profile\n  for __cli_profile in ~/.bash_profile ~/.bash_login ~/.profile; do\n    if [[ -r $__cli_profile ]]; then source \"$__cli_profile\"; break; fi\n  done\nelse\n  [[ ! -r ~/.bashrc ]] || source ~/.bashrc\nfi\nsource \"$_CLI_MANAGER_HISTORY_DIR/history.bash\"\n".to_string()),
        ];
        for (name, content) in files {
            let temporary = root.join(format!("{name}.{}.tmp", std::process::id()));
            std::fs::write(&temporary, content).map_err(|error| error.to_string())?;
            std::fs::rename(temporary, root.join(name)).map_err(|error| error.to_string())?;
        }
        Ok(root)
    }).as_ref().map_err(Clone::clone)
}

pub fn prepare_zsh(env: &mut HashMap<String, String>) -> Result<(), String> {
    let root = integration_dir()?;
    let original = env
        .get("ZDOTDIR")
        .cloned()
        .or_else(|| std::env::var("ZDOTDIR").ok())
        .or_else(|| env.get("HOME").cloned())
        .or_else(|| std::env::var("HOME").ok())
        .ok_or("home_directory_unavailable")?;
    env.insert("_CLI_MANAGER_USER_ZDOTDIR".to_string(), original);
    env.insert(
        "_CLI_MANAGER_HISTORY_DIR".to_string(),
        root.to_string_lossy().into_owned(),
    );
    env.insert("ZDOTDIR".to_string(), root.to_string_lossy().into_owned());
    Ok(())
}

pub fn prepare_bash(env: &mut HashMap<String, String>, login: bool) -> Result<Vec<String>, String> {
    let root = integration_dir()?;
    env.insert(
        "_CLI_MANAGER_HISTORY_DIR".to_string(),
        root.to_string_lossy().into_owned(),
    );
    env.insert(
        "_CLI_MANAGER_HISTORY_LOGIN".to_string(),
        if login { "1" } else { "0" }.to_string(),
    );
    Ok(vec![
        "--rcfile".to_string(),
        root.join("bashrc").to_string_lossy().into_owned(),
        "-i".to_string(),
    ])
}
