import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { readAppWindowVisibility } from "../lib/appWindowVisibility";

export function useAppWindowVisible(enabled: boolean) {
  const [visible, setVisible] = useState(false);
  const lifetime = useRef(0);
  const checkSequence = useRef(0);
  const check = useCallback(async (fresh = false) => {
    const current = lifetime.current;
    const sequence = ++checkSequence.current;
    const next = await readAppWindowVisibility(fresh);
    const currentRequest = current === lifetime.current && sequence === checkSequence.current;
    if (currentRequest) setVisible(next);
    return next && currentRequest;
  }, []);
  useEffect(() => {
    lifetime.current++;
    if (!enabled) { setVisible(false); return; }
    const onChange = () => { void check(true); };
    onChange();
    window.addEventListener("focus", onChange);
    window.addEventListener("blur", onChange);
    document.addEventListener("visibilitychange", onChange);
    const appWindow = isTauri() ? getCurrentWindow() : null;
    const stops = appWindow
      ? [appWindow.onFocusChanged(onChange), appWindow.onResized(onChange)].map(stop => stop.catch(() => () => {}))
      : [];
    return () => {
      lifetime.current++;
      window.removeEventListener("focus", onChange);
      window.removeEventListener("blur", onChange);
      document.removeEventListener("visibilitychange", onChange);
      for (const stop of stops) void stop.then(unlisten => unlisten()).catch(() => {});
    };
  }, [enabled, check]);
  return { visible: enabled && visible, check };
}
