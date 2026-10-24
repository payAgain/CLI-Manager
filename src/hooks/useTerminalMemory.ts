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
    agents: Array<{ pid: number; name: string; memoryBytes: number; selfBytes: number; childBytes: number; processCount: number }>;
    processes: Array<{
      pid: number;
      parentPid: number | null;
      name: string;
      memoryBytes: number;
      kind: "shell" | "agent" | "tool" | "other";
      agentPid: number | null;
    }>;
  }>;
  unassignedBytes: number;
  totalBytes: number;
}

export interface TerminalMemoryHistoryPoint {
  sampledAt: number;
  totalBytes: number;
  frameworkBytes: number;
  terminals: Record<string, number | null>;
}

export function appendTerminalMemoryHistory(history: TerminalMemoryHistoryPoint[], snapshot: TerminalMemorySnapshot): TerminalMemoryHistoryPoint[] {
  const point: TerminalMemoryHistoryPoint = {
    sampledAt: snapshot.sampledAt, totalBytes: snapshot.totalBytes, frameworkBytes: snapshot.framework.totalBytes,
    terminals: Object.fromEntries(snapshot.terminals.map(terminal => [terminal.sessionId, terminal.totalBytes])),
  };
  return [...history.filter(entry => entry.sampledAt !== point.sampledAt), point].slice(-24);
}

export function useTerminalMemory() {
  const [snapshot, setSnapshot] = useState<TerminalMemorySnapshot | null>(null);
  const [history, setHistory] = useState<TerminalMemoryHistoryPoint[]>([]);
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
        if (!disposed) { setSnapshot(next); setHistory(previous => appendTerminalMemoryHistory(previous, next)); setError(false); }
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
  return { snapshot, history, error, refresh };
}
