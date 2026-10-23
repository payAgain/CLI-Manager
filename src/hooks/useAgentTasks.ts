import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AgentTasksSnapshot } from "../lib/agentTasks";
import { getHistoryPathArgs } from "../lib/historyPathArgs";
import { inferWslDistroFromCwd, resolveSubagentBrowserIdentity, resolveSubagentConfigDir } from "../lib/subagentBrowser";
import type { Project, TerminalSession } from "../lib/types";
import { createVisibleResourcePoller } from "../lib/visibleResourcePolling";

export function useAgentTasks(session: TerminalSession | null, project: Project | null | undefined, refreshSeq: number) {
  const identity = resolveSubagentBrowserIdentity(session, project);
  const source = identity?.source;
  const parentSessionId = identity?.parentSessionId;
  const remote = session?.environmentType === "ssh" || project?.environment_type === "ssh";
  const key = JSON.stringify([session?.id, source, parentSessionId, session?.cwd, session?.envVars, project?.cli_config_root, remote]);
  const [state, setState] = useState<{ key: string; snapshot: AgentTasksSnapshot | null; error: string | null; loading: boolean }>({ key, snapshot: null, error: null, loading: false });
  const refreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    let disposed = false;
    const poller = createVisibleResourcePoller({
      isVisible: async () => {
        if (document.visibilityState === "hidden" || !session || !source || !parentSessionId || remote) return false;
        if (!isTauri()) return true;
        const appWindow = getCurrentWindow();
        const [visible, minimized] = await Promise.all([appWindow.isVisible(), appWindow.isMinimized()]);
        return visible && !minimized;
      },
      read: async () => {
        const defaults = await getHistoryPathArgs();
        if (disposed) throw new Error("disposed");
        return invoke<AgentTasksSnapshot>("agent_tasks_get_snapshot", {
          source, parentSessionId, cwd: session!.cwd ?? "",
          configDir: resolveSubagentConfigDir(source!, session!, project, defaults),
          wslDistroName: session!.envVars?.WSL_DISTRO_NAME || inferWslDistroFromCwd(session!.cwd),
          transportKind: "local",
        });
      },
      onSnapshot: snapshot => setState({ key, snapshot, error: null, loading: false }),
      onError: error => setState(previous => ({ key, snapshot: previous.key === key ? previous.snapshot : null, error: String(error), loading: false })),
      onLoading: loading => setState(previous => previous.key === key ? { ...previous, loading } : previous),
    });
    const read = () => poller.refresh();
    setState({ key, snapshot: null, error: null, loading: Boolean(session && source && parentSessionId && !remote) });
    refreshRef.current = () => { void read(); };
    void read();
    const interval = window.setInterval(() => { void read(); }, 3000);
    const onVisible = () => { void read(); };
    document.addEventListener("visibilitychange", onVisible);
    const unlisten = isTauri() ? getCurrentWindow().onFocusChanged(({ payload }) => { if (payload) void read(); }).catch(() => () => {}) : Promise.resolve(() => {});
    return () => {
      disposed = true;
      poller.dispose();
      refreshRef.current = () => {};
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      void unlisten.then(stop => stop());
    };
  }, [key]);

  useEffect(() => { refreshRef.current(); }, [refreshSeq]);
  return {
    snapshot: state.key === key ? state.snapshot : null,
    error: state.key === key ? state.error : null,
    loading: state.key === key && state.loading,
    hasIdentity: Boolean(identity),
    remote,
  };
}
