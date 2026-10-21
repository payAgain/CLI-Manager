import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createVisibleResourcePoller } from "../lib/visibleResourcePolling";

export interface SystemResourceSnapshot {
  ipAddress: string | null;
  osName: string;
  hostName: string | null;
  uptimeSeconds: number;
  sampledAt: number;
  cpu: {
    usagePercent: number;
    physicalCoreCount: number;
    logicalProcessorCount: number;
  };
  cpuCores: Array<{
    index: number;
    usagePercent: number;
  }>;
  gpu: {
    usagePercent: number;
  } | null;
  memory: {
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    cachedBytes: number;
    freeBytes: number;
  };
  network: {
    uploadBytesPerSec: number;
    downloadBytesPerSec: number;
    totalUploadedBytes: number;
    totalDownloadedBytes: number;
    todayUploadedBytes: number;
    todayDownloadedBytes: number;
  };
  disks: Array<{
    name: string;
    mountPoint: string;
    fileSystem: string;
    totalBytes: number;
    availableBytes: number;
    usedBytes: number;
    readBytesPerSec: number;
    writeBytesPerSec: number;
  }>;
  topProcesses: Array<{
    pid: string;
    name: string;
    command: string;
    displayName: string | null;
    iconDataUrl: string | null;
    cpuUsagePercent: number;
    memoryBytes: number;
    memoryUsagePercent: number;
  }>;
}

export interface SystemResourceSnapshotOptions {
  fullDetail?: boolean;
  system?: boolean;
  cpu?: boolean;
  memory?: boolean;
  network?: boolean;
  disk?: boolean;
  gpu?: boolean;
  processes?: boolean;
}

function defaultIntervalMs(options: boolean | SystemResourceSnapshotOptions): number {
  return typeof options === "boolean" && !options ? 3000 : 2500;
}

interface SystemResourceRuntimeCacheEntry {
  snapshot: SystemResourceSnapshot | null;
  history: SystemResourceSnapshot[];
}

const SYSTEM_RESOURCE_HISTORY_LIMIT = 48;
const systemResourceRuntimeCache = new Map<string, SystemResourceRuntimeCacheEntry>();

function appendHistory(
  history: SystemResourceSnapshot[],
  snapshot: SystemResourceSnapshot
): SystemResourceSnapshot[] {
  const next = [...history, snapshot];
  if (next.length <= SYSTEM_RESOURCE_HISTORY_LIMIT) return next;
  return next.slice(next.length - SYSTEM_RESOURCE_HISTORY_LIMIT);
}

export function useSystemResources(
  enabled: boolean,
  options: boolean | SystemResourceSnapshotOptions,
  intervalMs = defaultIntervalMs(options),
  runtimeCacheKey?: string
) {
  const cached = runtimeCacheKey ? systemResourceRuntimeCache.get(runtimeCacheKey) : undefined;
  const [snapshot, setSnapshot] = useState<SystemResourceSnapshot | null>(() => cached?.snapshot ?? null);
  const [history, setHistory] = useState<SystemResourceSnapshot[]>(() => cached?.history ?? []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshRef = useRef<(showLoading?: boolean) => Promise<void>>(async () => {});
  const historyRef = useRef(history);
  const refresh = useCallback((showLoading = false) => refreshRef.current(showLoading), []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      setError(null);
      return;
    }
    const poller = createVisibleResourcePoller({
      isVisible: async () => {
        if (document.visibilityState === "hidden") return false;
        if (!isTauri()) return true;
        const appWindow = getCurrentWindow();
        const [visible, minimized] = await Promise.all([appWindow.isVisible(), appWindow.isMinimized()]);
        return visible && !minimized;
      },
      read: () => invoke<SystemResourceSnapshot>("system_resources_get_snapshot", typeof options === "boolean" ? { fullDetail: options } : { options }),
      onSnapshot: (result) => {
        const nextHistory = appendHistory(historyRef.current, result);
        historyRef.current = nextHistory;
        if (runtimeCacheKey) systemResourceRuntimeCache.set(runtimeCacheKey, { snapshot: result, history: nextHistory });
        setSnapshot(result);
        setHistory(nextHistory);
        setError(null);
      },
      onError: (err) => setError(String(err)),
      onLoading: setLoading,
    });
    refreshRef.current = poller.refresh;
    void poller.refresh(true);
    const timer = window.setInterval(() => void poller.refresh(), intervalMs);
    const onVisible = () => { void poller.refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    const unlisten = isTauri() ? getCurrentWindow().onFocusChanged(({ payload }) => {
      if (payload) onVisible();
    }).catch(() => () => {}) : Promise.resolve(() => {});
    return () => {
      poller.dispose();
      refreshRef.current = async () => {};
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      void unlisten.then((stop) => stop());
    };
  }, [enabled, intervalMs, options, runtimeCacheKey]);

  return { snapshot, history, loading, error, refresh };
}
