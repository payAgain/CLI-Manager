import { useEffect, useRef } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { inboxTargetKey, resolveNotificationTarget, shouldAutoReadInbox } from "../lib/notificationInbox";
import { useNotificationInboxStore } from "../stores/notificationInboxStore";
import { useTerminalStore } from "../stores/terminalStore";

/** One application subscription. No timer or polling while idle. */
export function useNotificationInbox(): void {
  useEffect(() => {
    if (!isTauri()) return;
    const refresh = () => { void useNotificationInboxStore.getState().refresh(); };
    refresh();
    const unlisten = listen<{ event?: string; inboxPersistenceError?: boolean }>("claude-hook-notification", ({ payload }) => {
      if (payload.inboxPersistenceError) useNotificationInboxStore.setState({ persistenceError: true });
      if (["Notification", "PermissionRequest", "Stop", "StopFailure"].includes(payload.event ?? "")) refresh();
    }).catch(error => { useNotificationInboxStore.setState({ error: String(error) }); return null; });
    const onVisibility = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      void unlisten.then(fn => fn?.()).catch(() => {});
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
}

/** Pass the effective rendered session, never just a Workspan's active ID. */
export function useNotificationInboxAutoRead(sessionId: string | null, visible: boolean, focused: boolean): void {
  const targets = useNotificationInboxStore(state => state.unreadTargets);
  const sessions = useTerminalStore(state => state.sessions);
  const activeSessionId = useTerminalStore(state => state.activeSessionId);
  const previous = useRef<{ sessionId: string | null; keys: string[] }>({ sessionId: null, keys: [] });
  useEffect(() => {
    const matching = sessionId ? targets.filter(target => resolveNotificationTarget(target, sessions)?.id === sessionId) : [];
    if (previous.current.sessionId !== sessionId || !visible || activeSessionId !== sessionId) {
      useNotificationInboxStore.getState().releaseManualUnread(previous.current.keys);
      previous.current = { sessionId, keys: [] };
    }
    previous.current.keys = [...new Set([...previous.current.keys, ...matching.map(inboxTargetKey)])];
    if (!sessionId || !visible || !focused || !matching.length) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const canRead = () => {
      const element = document.activeElement?.closest<HTMLElement>("[data-terminal-session-id]");
      return element?.dataset.terminalSessionId === sessionId && element.dataset.terminalVisible === "true"
        && element.getClientRects().length > 0 && !useNotificationInboxStore.getState().isOpen;
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      if (!canRead()) return;
      timer = setTimeout(() => { void (async () => {
        let windowFocused = document.hasFocus(), windowVisible = document.visibilityState === "visible", minimized = false;
        if (isTauri()) {
          try { [windowFocused, windowVisible, minimized] = await Promise.all([getCurrentWindow().isFocused(), getCurrentWindow().isVisible(), getCurrentWindow().isMinimized()]); }
          catch { return; } // Unknown native visibility must not acknowledge work.
        }
        if (cancelled || !shouldAutoReadInbox({ visible, focused, windowFocused, windowVisible, minimized,
          documentVisible: document.visibilityState === "visible", terminalFocused: canRead() })) return;
        // The captured targets include their received sequence; arrivals during
        // this dwell are left for a fresh pass and cannot be consumed by accident.
        await useNotificationInboxStore.getState().readTargets(matching);
      })(); }, 600);
    };
    const cancel = () => { if (timer) clearTimeout(timer); };
    schedule();
    document.addEventListener("focusin", schedule);
    window.addEventListener("focus", schedule);
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", schedule);
    return () => {
      cancelled = true; cancel(); document.removeEventListener("focusin", schedule);
      window.removeEventListener("focus", schedule); window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [sessionId, visible, focused, targets, sessions, activeSessionId]);
  useEffect(() => () => { useNotificationInboxStore.getState().releaseManualUnread(previous.current.keys); }, []);
}
