import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export interface TerminalMemorySnapshot {
  sampledAt: number;
  daemonAvailable: boolean;
  framework: { appBytes: number; webviewBytes: number; daemonBytes: number; helperBytes: number; totalBytes: number };
  terminals: Array<{
    sessionId: string;
    rootPid: number | null;
    totalBytes: number | null;
    shellBytes: number;
    otherBytes: number;
    localOnly: boolean;
    agents: Array<{ pid: number; name: string; memoryBytes: number; processCount: number }>;
  }>;
  unassignedBytes: number;
  totalBytes: number;
}

export function useTerminalMemory() {
  const [snapshot, setSnapshot] = useState<TerminalMemorySnapshot | null>(null);
  const [error, setError] = useState(false);
  const refreshRef = useRef<() => void>(() => {});
  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    const refresh = async () => {
      if (disposed || inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        if (isTauri()) {
          const appWindow = getCurrentWindow();
          const [visible, minimized] = await Promise.all([appWindow.isVisible(), appWindow.isMinimized()]);
          if (!visible || minimized || disposed) return;
        }
        const next = await invoke<TerminalMemorySnapshot>("terminal_memory_get_snapshot");
        if (!disposed) { setSnapshot(next); setError(false); }
      } catch {
        if (!disposed) setError(true);
      } finally { inFlight = false; }
    };
    refreshRef.current = () => { void refresh(); };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 5000);
    document.addEventListener("visibilitychange", refreshRef.current);
    const onVisibility = refreshRef.current;
    const unlisten = isTauri() ? getCurrentWindow().onFocusChanged(({ payload }) => { if (payload) void refresh(); }).catch(() => () => {}) : Promise.resolve(() => {});
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      refreshRef.current = () => {};
      void unlisten.then((stop) => stop());
    };
  }, []);
  const refresh = useCallback(() => refreshRef.current(), []);
  return { snapshot, error, refresh };
}
