import { useCallback, useMemo, useSyncExternalStore } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { readAppWindowVisibility } from "../lib/appWindowVisibility";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { Project, ProjectEnvironmentType } from "../lib/types";
import { createProjectBranchQueries, projectBranchTarget } from "../lib/projectBranchQueries";

const queries = createProjectBranchQueries({ read: path => invoke<string | null>("get_current_git_branch", { path }) });
let subscribers = 0;
let stopWatching: (() => void) | undefined;

function watch() {
  let disposed = false;
  let checkSequence = 0;
  queries.setEnabled(false);
  const refresh = async (force = false, fresh = false) => {
    const sequence = ++checkSequence;
    // Stop draining queued repositories immediately on a DOM hide event.
    if (document.visibilityState === "hidden") queries.setEnabled(false);
    const visible = await readAppWindowVisibility(fresh);
    if (disposed || sequence !== checkSequence) return;
    queries.setEnabled(visible);
    if (visible) queries.refresh(force);
  };
  void refresh(false, true);
  const timer = window.setInterval(() => { void refresh(); }, 15_000);
  const onChange = () => { void refresh(false, true); };
  const onFocus = () => { void refresh(true, true); };
  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", onChange);
  document.addEventListener("visibilitychange", onChange);
  const appWindow = isTauri() ? getCurrentWindow() : null;
  const stops = appWindow
    ? [appWindow.onFocusChanged(onChange), appWindow.onResized(onChange)].map(stop => stop.catch(() => () => {}))
    : [];
  return () => {
    disposed = true;
    queries.setEnabled(false);
    window.clearInterval(timer);
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("blur", onChange);
    document.removeEventListener("visibilitychange", onChange);
    for (const stop of stops) void stop.then(unlisten => unlisten());
  };
}

// Read the checkout only. Sidebar and stats refreshes never fetch or change Git state.
export function useCheckoutBranch(path: string | null | undefined, environment: ProjectEnvironmentType = "local") {
  const target = useMemo(() => projectBranchTarget(path, environment), [path, environment]);
  const subscribe = useCallback((listener: () => void) => {
    if (!target) return () => {};
    if (subscribers++ === 0) stopWatching = watch();
    const stop = queries.subscribe(target, listener);
    return () => { stop(); if (--subscribers === 0) { stopWatching?.(); stopWatching = undefined; } };
  }, [target]);
  const snapshot = useCallback(() => queries.getSnapshot(target), [target]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function useProjectBranch(project: Project | null) {
  return useCheckoutBranch(project?.path, project?.environment_type);
}
