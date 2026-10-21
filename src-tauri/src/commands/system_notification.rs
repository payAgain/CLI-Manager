use log::warn;
use notify_rust::NotificationResponse;
use serde::Serialize;
use std::{env, fs, process::Stdio};
use tauri::{AppHandle, Emitter, Manager};

const MAX_NOTIFICATION_TITLE_CHARS: usize = 200;
const MAX_NOTIFICATION_BODY_CHARS: usize = 1000;
const MAX_NOTIFICATION_ACTION_LABEL_CHARS: usize = 80;
const MAX_NOTIFICATION_TAB_ID_CHARS: usize = 200;
const SYSTEM_NOTIFICATION_ACTION_EVENT: &str = "system-notification-action";
const MIN_TASKBAR_FLASH_COUNT: u32 = 1;
const MAX_TASKBAR_FLASH_COUNT: u32 = 20;

#[cfg(target_os = "windows")]
#[derive(Debug, PartialEq, Eq)]
struct TaskbarFlashParams {
    flags: u32,
    count: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemNotificationActionPayload {
    tab_id: String,
}

/// 检测当前是否运行在 WSL 环境中。
///
/// 优先检查 WSL 注入的环境变量，再读取 `/proc/version`，若包含
/// "microsoft" 或 "wsl" 关键字则判定为 WSL。若文件不存在或读取失败
/// （非 Linux），返回 false。
#[tauri::command]
pub fn is_wsl() -> bool {
    if cfg!(windows) {
        return false;
    }

    if env::var_os("WSL_DISTRO_NAME").is_some() || env::var_os("WSL_INTEROP").is_some() {
        return true;
    }

    fs::read_to_string("/proc/version")
        .map(|s| {
            let lower = s.to_lowercase();
            lower.contains("microsoft") || lower.contains("wsl")
        })
        .unwrap_or(false)
}

/// WSL 环境下通过 Windows 主机发送系统通知。
///
/// 使用 PowerShell + WinRT Toast API（Windows 原生），无需额外依赖。
/// 通知从 WSL 内调用 `powershell.exe`，桥接到 Windows 宿主的通知中心。
///
/// 注意：
/// - 标题和正文会做长度与 NUL 字符校验。
/// - 标题和正文中的 XML 特殊字符会自动转义。
/// - PowerShell 单引号会被转义（`'` → `''`）。
/// - 使用 `spawn()` 而非 `output()` 以避免阻塞调用者（异步发送）。
#[tauri::command]
pub async fn send_notification_via_windows(title: String, body: String) -> Result<(), String> {
    if !is_wsl() {
        return Err("windows_notification_bridge_requires_wsl".into());
    }

    validate_notification_title(&title)?;
    validate_notification_body(&body)?;

    let xml = format!(
        r#"<toast><visual><binding template="ToastGeneric"><text>{}</text><text>{}</text><text placement="attribution">来自 CLI-Manager</text></binding></visual></toast>"#,
        xml_escape(&title),
        xml_escape(&body)
    );

    let script = format!(
        r#"
        [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;
        [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null;
        $xml = [Windows.Data.Xml.Dom.XmlDocument]::new();
        $xml.LoadXml('{}');
        $toast = [Windows.UI.Notifications.ToastNotification]::new($xml);
        try {{
          $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('com.cli-manager.app');
          $notifier.Show($toast);
        }} catch {{
          [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('CLI-Manager').Show($toast);
        }}
        "#,
        xml.replace('\'', "''")
    );

    spawn_powershell_notification(&script)
}

#[tauri::command]
pub async fn send_interactive_system_notification(
    app: AppHandle,
    title: String,
    body: String,
    tab_id: String,
    action_label: String,
) -> Result<(), String> {
    validate_notification_title(&title)?;
    validate_notification_body(&body)?;
    validate_notification_text(
        &tab_id,
        MAX_NOTIFICATION_TAB_ID_CHARS,
        "notification_tab_id",
    )?;
    if tab_id.trim().is_empty() {
        return Err("notification_tab_id_empty".into());
    }
    validate_notification_text(
        &action_label,
        MAX_NOTIFICATION_ACTION_LABEL_CHARS,
        "notification_action_label",
    )?;
    if action_label.trim().is_empty() {
        return Err("notification_action_label_empty".into());
    }

    let app_id = app.config().identifier.clone();
    let mut notification = notify_rust::Notification::new();
    notification
        .summary(&title)
        .body(&body)
        .appname("CLI-Manager")
        .auto_icon()
        .action("default", &action_label);

    #[cfg(target_os = "windows")]
    {
        let icon_dir = app
            .path()
            .app_local_data_dir()
            .map_err(|err| err.to_string())?;
        register_windows_notification_identity(&app_id, &icon_dir)?;
        notification.app_id(&app_id);
    }

    #[cfg(target_os = "macos")]
    {
        let _ = notify_rust::set_application(if tauri::is_dev() {
            "com.apple.Terminal"
        } else {
            app_id.as_str()
        });
    }

    let handle = notification
        .show()
        .map_err(|err| format!("notification_show_failed: {}", err))?;
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(err) = handle.wait_for_response(|response: &NotificationResponse| {
            if matches!(
                response,
                NotificationResponse::Default | NotificationResponse::Action(_)
            ) {
                let payload = SystemNotificationActionPayload {
                    tab_id: tab_id.clone(),
                };
                if let Err(err) = app_handle.emit(SYSTEM_NOTIFICATION_ACTION_EVENT, payload) {
                    warn!("system notification action emit failed: {}", err);
                }
            }
        }) {
            warn!("system notification response wait failed: {}", err);
        }
    });

    Ok(())
}

#[tauri::command]
pub fn set_taskbar_attention(
    app: AppHandle,
    mode: Option<String>,
    flash_count: Option<u32>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::mem::size_of;
        use windows_sys::Win32::UI::WindowsAndMessaging::{FlashWindowEx, FLASHWINFO};

        let params = taskbar_flash_params(mode.as_deref(), flash_count)?;
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "taskbar_main_window_missing".to_string())?;
        let hwnd = window
            .hwnd()
            .map_err(|err| format!("taskbar_window_handle_failed: {err}"))?;
        let info = FLASHWINFO {
            cbSize: size_of::<FLASHWINFO>() as u32,
            hwnd: hwnd.0 as _,
            dwFlags: params.flags,
            uCount: params.count,
            dwTimeout: 0,
        };
        unsafe {
            FlashWindowEx(&info);
        }
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        validate_taskbar_attention_request(mode.as_deref(), flash_count)
    }
}

fn validate_taskbar_attention_request(
    mode: Option<&str>,
    flash_count: Option<u32>,
) -> Result<(), String> {
    match mode {
        None => Ok(()),
        Some("finite") => match flash_count {
            Some(count) if (MIN_TASKBAR_FLASH_COUNT..=MAX_TASKBAR_FLASH_COUNT).contains(&count) => {
                Ok(())
            }
            _ => Err("taskbar_flash_count_out_of_range".into()),
        },
        Some("untilFocused") => Ok(()),
        Some(_) => Err("taskbar_attention_mode_invalid".into()),
    }
}

#[cfg(target_os = "windows")]
fn taskbar_flash_params(
    mode: Option<&str>,
    flash_count: Option<u32>,
) -> Result<TaskbarFlashParams, String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{FLASHW_STOP, FLASHW_TIMERNOFG, FLASHW_TRAY};

    validate_taskbar_attention_request(mode, flash_count)?;
    Ok(match mode {
        None => TaskbarFlashParams {
            flags: FLASHW_STOP,
            count: 0,
        },
        Some("finite") => TaskbarFlashParams {
            flags: FLASHW_TRAY,
            count: flash_count.expect("validated finite flash count"),
        },
        Some("untilFocused") => TaskbarFlashParams {
            flags: FLASHW_TRAY | FLASHW_TIMERNOFG,
            count: u32::MAX,
        },
        Some(_) => unreachable!("mode validated above"),
    })
}

#[cfg(windows)]
fn spawn_powershell_notification(script: &str) -> Result<(), String> {
    crate::shell_resolver::silent_command("powershell.exe")
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-Command")
        .arg(script)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to spawn powershell.exe: {}", e))
}

/// Standalone EXEs have no installer-provided AUMID. Register our per-user identity
/// before WinRT delivery so Show() cannot silently succeed for an unknown sender.
#[cfg(target_os = "windows")]
fn register_windows_notification_identity(
    app_id: &str,
    icon_dir: &std::path::Path,
) -> Result<(), String> {
    let register = || -> Result<(), Box<dyn std::error::Error>> {
        fs::create_dir_all(icon_dir)?;
        let icon_path = icon_dir.join("notification-icon.png");
        let icon = include_bytes!("../../icons/32x32.png");
        if fs::read(&icon_path).ok().as_deref() != Some(icon.as_slice()) {
            fs::write(&icon_path, icon)?;
        }
        let user = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
        let (key, _) = user.create_subkey(format!(r"Software\Classes\AppUserModelId\{app_id}"))?;
        key.set_value("DisplayName", &"CLI-Manager")?;
        key.set_value("IconBackgroundColor", &"0")?;
        key.set_value("IconUri", &icon_path.as_os_str())?;
        Ok(())
    };
    register().map_err(|err| format!("notification_identity_registration_failed: {err}"))
}

#[cfg(not(windows))]
fn spawn_powershell_notification(script: &str) -> Result<(), String> {
    std::process::Command::new("powershell.exe")
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-Command")
        .arg(script)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to spawn powershell.exe: {}", e))
}

fn validate_notification_title(title: &str) -> Result<(), String> {
    if title.trim().is_empty() {
        return Err("notification_title_empty".into());
    }
    validate_notification_text(title, MAX_NOTIFICATION_TITLE_CHARS, "notification_title")
}

fn validate_notification_body(body: &str) -> Result<(), String> {
    validate_notification_text(body, MAX_NOTIFICATION_BODY_CHARS, "notification_body")
}

fn validate_notification_text(value: &str, max_chars: usize, field: &str) -> Result<(), String> {
    if value.contains('\0') {
        return Err(format!("{}_contains_nul", field));
    }
    if value.chars().count() > max_chars {
        return Err(format!("{}_too_long", field));
    }
    Ok(())
}

/// XML 特殊字符转义（用于 Toast XML），并替换 XML 1.0 不允许的控制字符。
fn xml_escape(s: &str) -> String {
    let mut escaped = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&apos;"),
            '\t' | '\n' | '\r' => escaped.push(ch),
            ch if ch.is_control() => escaped.push(' '),
            ch => escaped.push(ch),
        }
    }
    escaped
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::{FLASHW_STOP, FLASHW_TIMERNOFG, FLASHW_TRAY};

    #[test]
    fn standalone_notification_identity_registers_and_repairs_its_icon() {
        let app_id = format!("com.cli-manager.notification-test.{}", uuid::Uuid::new_v4());
        let directory = tempfile::tempdir().unwrap();
        let user = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
        let subkey = format!(r"Software\Classes\AppUserModelId\{app_id}");
        register_windows_notification_identity(&app_id, directory.path()).unwrap();
        let key = user.open_subkey(&subkey).unwrap();
        assert_eq!(
            key.get_value::<String, _>("DisplayName").unwrap(),
            "CLI-Manager"
        );
        let icon_path = directory.path().join("notification-icon.png");
        assert_eq!(
            key.get_value::<String, _>("IconUri").unwrap(),
            icon_path.to_string_lossy()
        );
        fs::write(&icon_path, b"outdated icon").unwrap();
        register_windows_notification_identity(&app_id, directory.path()).unwrap();
        assert_eq!(
            fs::read(icon_path).unwrap(),
            include_bytes!("../../icons/32x32.png")
        );
        drop(key);
        user.delete_subkey_all(subkey).unwrap();
    }

    #[test]
    #[ignore = "displays a real Windows toast; run explicitly for desktop verification"]
    fn native_notification_smoke() {
        let icon_dir = std::path::PathBuf::from(env::var_os("LOCALAPPDATA").unwrap())
            .join("com.cli-manager.app");
        register_windows_notification_identity("com.cli-manager.app", &icon_dir).unwrap();
        let handle = notify_rust::Notification::new()
            .app_id("com.cli-manager.app")
            .summary("CLI-Manager")
            .body("Windows 原生通知测试：任务已完成。")
            .action("default", "查看")
            .show()
            .unwrap();
        std::thread::sleep(std::time::Duration::from_secs(4));
        drop(handle);
    }

    #[test]
    fn finite_taskbar_attention_accepts_boundaries() {
        assert_eq!(
            taskbar_flash_params(Some("finite"), Some(1)).unwrap(),
            TaskbarFlashParams {
                flags: FLASHW_TRAY,
                count: 1,
            }
        );
        assert_eq!(
            taskbar_flash_params(Some("finite"), Some(20)).unwrap(),
            TaskbarFlashParams {
                flags: FLASHW_TRAY,
                count: 20,
            }
        );
    }

    #[test]
    fn finite_taskbar_attention_rejects_out_of_range_counts() {
        assert!(taskbar_flash_params(Some("finite"), Some(0)).is_err());
        assert!(taskbar_flash_params(Some("finite"), Some(21)).is_err());
        assert!(taskbar_flash_params(Some("finite"), None).is_err());
    }

    #[test]
    fn until_focused_and_stop_use_expected_flags() {
        assert_eq!(
            taskbar_flash_params(Some("untilFocused"), None).unwrap(),
            TaskbarFlashParams {
                flags: FLASHW_TRAY | FLASHW_TIMERNOFG,
                count: u32::MAX,
            }
        );
        assert_eq!(
            taskbar_flash_params(None, None).unwrap(),
            TaskbarFlashParams {
                flags: FLASHW_STOP,
                count: 0,
            }
        );
    }
}
