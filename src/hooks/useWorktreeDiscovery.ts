import { useEffect } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useProjectStore } from "../stores/projectStore";

export function useWorktreeDiscovery() {
  const loaded = useProjectStore(state => state.loaded);
  useEffect(() => {
    if (!loaded) return;
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      void useProjectStore.getState().refreshWorktrees();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const nativeUnlisten = isTauri()
      ? getCurrentWindow().onFocusChanged(({ payload }) => { if (payload) refresh(); }).catch(() => () => {})
      : Promise.resolve(() => {});
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      void nativeUnlisten.then(unlisten => unlisten());
    };
  }, [loaded]);
}
