import { invoke } from "@tauri-apps/api/core";
import { useHistoryStore } from "../stores/historyStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useTerminalStore } from "../stores/terminalStore";
import { findWorkspanBySession } from "../stores/terminalWorkspan";
import { resolveNotificationTarget, type InboxTarget } from "./notificationInbox";
import { ALL_TERMINALS_SCOPE } from "./terminalScope";

/** A notification only navigates to an existing live PTY; it never launches one. */
export async function activateNotificationTarget(target: InboxTarget): Promise<boolean> {
  const initial = resolveNotificationTarget(target, useTerminalStore.getState().sessions);
  if (!initial) return false;
  const live = await invoke<Array<{ sessionId: string; alive: boolean }>>("pty_daemon_sessions");
  if (!live.some(session => session.sessionId === initial.id && session.alive)) return false;
  // Revalidate after IPC: a tab can close or switch CLI conversations meanwhile.
  const current = useTerminalStore.getState();
  const resolved = resolveNotificationTarget(target, current.sessions);
  if (resolved?.id !== initial.id || !findWorkspanBySession(current.workspans, initial.id)) return false;
  // Activate before remounting the standard view from compact mode.
  useHistoryStore.getState().closeHistory();
  current.setTerminalScope(ALL_TERMINALS_SCOPE);
  current.setActive(initial.id);
  if (useSettingsStore.getState().viewMode === "compact") {
    await useSettingsStore.getState().update("viewMode", "standard");
  }
  return resolveNotificationTarget(target, useTerminalStore.getState().sessions)?.id === initial.id;
}
