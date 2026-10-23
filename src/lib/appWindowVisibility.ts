import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

let pending: Promise<boolean> | null = null;

/** Focus is deliberately excluded: another app can be focused while this window remains visible. */
export function readAppWindowVisibility(fresh = false): Promise<boolean> {
  if (document.visibilityState === "hidden") return Promise.resolve(false);
  if (!isTauri()) return Promise.resolve(true);
  if (!pending || fresh) {
    const appWindow = getCurrentWindow();
    const request = Promise.all([appWindow.isVisible(), appWindow.isMinimized()])
      .then(([visible, minimized]) => visible && !minimized && document.visibilityState !== "hidden")
      .catch(() => document.visibilityState !== "hidden")
      .finally(() => { if (pending === request) pending = null; });
    pending = request;
  }
  return pending;
}
