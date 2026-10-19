import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Project } from "../lib/types";

// Read the checkout only. Sidebar refreshes must never fetch or change Git state.
export function useProjectBranch(project: Project | null) {
  const path = project?.environment_type === "ssh" ? null : project?.path;
  const [result, setResult] = useState<{ path: string; branch: string | null } | null>(null);
  useEffect(() => {
    if (!path) return;
    let disposed = false;
    let pending = false;
    const refresh = async () => {
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const branch = await invoke<string | null>("get_current_git_branch", { path });
        if (!disposed) setResult({ path, branch });
      } catch {
        if (!disposed) setResult({ path, branch: null });
      } finally { pending = false; }
    };
    void refresh();
    const onFocus = () => { void refresh(); };
    const timer = window.setInterval(() => {
      if (document.hasFocus()) void refresh();
    }, 15000);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [path]);
  return result && result.path === path ? result.branch : null;
}
