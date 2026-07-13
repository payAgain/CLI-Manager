//! 主进程的 [`PtyEventSink`] 实现：把 PTY 输出/状态转成 Tauri 事件发给前端。
//!
//! 事件名与历史行为完全一致（`pty-output-{id}` 携带 base64 输出、
//! `pty-status-{id}` 携带 [`PtyProcessStatus`]），前端零感知。

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use tauri::{AppHandle, Emitter};

use crate::pty::manager::{PtyEventSink, PtyProcessStatus};

pub struct TauriPtyEventSink {
    app_handle: AppHandle,
}

impl TauriPtyEventSink {
    pub fn new(app_handle: AppHandle) -> Self {
        Self { app_handle }
    }
}

impl PtyEventSink for TauriPtyEventSink {
    fn on_output(&self, session_id: &str, data: &[u8]) {
        let encoded = STANDARD.encode(data);
        let _ = self
            .app_handle
            .emit(&format!("pty-output-{session_id}"), encoded);
    }

    fn on_status(&self, session_id: &str, status: PtyProcessStatus) {
        let _ = self
            .app_handle
            .emit(&format!("pty-status-{session_id}"), status);
    }
}
