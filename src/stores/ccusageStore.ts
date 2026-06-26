import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { getDb } from "../lib/db";
import type { CcusageSource } from "../lib/types";
import { useSettingsStore } from "./settingsStore";

const REPORT_KIND = "daily+session+blocks";
const LEGACY_REPORT_KIND = "daily";

interface CcusageToolStatus {
  bunAvailable: boolean;
  bunxAvailable: boolean;
  bunVersion: string | null;
  bunxVersion: string | null;
}

interface CcusageReportResponse {
  source: CcusageSource;
  reportKind: string;
  payload: unknown;
  refreshedAt: number;
}

export interface CcusageReport {
  source: CcusageSource;
  reportKind: string;
  payload: unknown;
  updatedAt: number;
  fromCache: boolean;
}

interface CcusageCacheRow {
  source: CcusageSource;
  report_kind: string;
  payload_json: string;
  updated_at: number;
}

interface CcusageStore {
  source: CcusageSource;
  toolStatus: CcusageToolStatus | null;
  report: CcusageReport | null;
  checkingStatus: boolean;
  installingTools: boolean;
  loadingCache: boolean;
  refreshing: boolean;
  error: string | null;
  setSource: (source: CcusageSource) => void;
  checkStatus: () => Promise<void>;
  installTools: () => Promise<void>;
  loadCachedReport: () => Promise<void>;
  refreshReport: () => Promise<void>;
}

const memoryCache = new Map<string, CcusageReport>();
let inFlightToolStatus: Promise<CcusageToolStatus> | null = null;
const inFlightReportRefreshes = new Map<string, Promise<CcusageReport>>();

function cacheKey(source: CcusageSource, reportKind = REPORT_KIND): string {
  return `${source}:${reportKind}`;
}

async function ensureCacheTable(): Promise<void> {
  const db = await getDb();
  await db.execute(`
    CREATE TABLE IF NOT EXISTS ccusage_cache (
      cache_key TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      report_kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  await db.execute("CREATE INDEX IF NOT EXISTS idx_ccusage_cache_source ON ccusage_cache(source, report_kind)");
}

function normalizeToolStatus(value: CcusageToolStatus): CcusageToolStatus {
  return {
    bunAvailable: Boolean(value.bunAvailable),
    bunxAvailable: Boolean(value.bunxAvailable),
    bunVersion: typeof value.bunVersion === "string" ? value.bunVersion : null,
    bunxVersion: typeof value.bunxVersion === "string" ? value.bunxVersion : null,
  };
}

async function readCachedReport(source: CcusageSource): Promise<CcusageReport | null> {
  const keys = [cacheKey(source), cacheKey(source, LEGACY_REPORT_KIND)];
  for (const key of keys) {
    const memory = memoryCache.get(key);
    if (memory) return memory;
  }

  await ensureCacheTable();
  const db = await getDb();
  const rows = await db.select<CcusageCacheRow[]>(
    "SELECT source, report_kind, payload_json, updated_at FROM ccusage_cache WHERE cache_key IN ($1, $2) ORDER BY CASE cache_key WHEN $1 THEN 0 ELSE 1 END LIMIT 1",
    keys
  );
  const row = rows[0];
  if (!row) return null;

  try {
    const report: CcusageReport = {
      source: row.source,
      reportKind: row.report_kind,
      payload: JSON.parse(row.payload_json),
      updatedAt: row.updated_at,
      fromCache: true,
    };
    memoryCache.set(cacheKey(row.source, row.report_kind), report);
    return report;
  } catch (err) {
    throw new Error(`ccusage 缓存 JSON 解析失败：${String(err)}`);
  }
}

async function writeCachedReport(report: CcusageReport): Promise<void> {
  await ensureCacheTable();
  const db = await getDb();
  const key = cacheKey(report.source);
  await db.execute(
    `INSERT INTO ccusage_cache (cache_key, source, report_kind, payload_json, updated_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT(cache_key) DO UPDATE SET
       source = excluded.source,
       report_kind = excluded.report_kind,
       payload_json = excluded.payload_json,
       updated_at = excluded.updated_at`,
    [key, report.source, report.reportKind, JSON.stringify(report.payload), report.updatedAt]
  );
  memoryCache.set(key, { ...report, fromCache: true });
}

function checkToolStatus(): Promise<CcusageToolStatus> {
  if (inFlightToolStatus) return inFlightToolStatus;
  inFlightToolStatus = invoke<CcusageToolStatus>("ccusage_get_status")
    .then(normalizeToolStatus)
    .finally(() => {
      inFlightToolStatus = null;
    });
  return inFlightToolStatus;
}

function refreshReportFromBackend(
  source: CcusageSource,
  claudeConfigDir: string | null,
  codexConfigDir: string | null
): Promise<CcusageReport> {
  const key = JSON.stringify([source, claudeConfigDir ?? "", codexConfigDir ?? ""]);
  const existing = inFlightReportRefreshes.get(key);
  if (existing) return existing;

  const request = (async () => {
    const response = await invoke<CcusageReportResponse>("ccusage_refresh_report", {
      source,
      claudeConfigDir,
      codexConfigDir,
    });
    const report: CcusageReport = {
      source: response.source,
      reportKind: response.reportKind,
      payload: response.payload,
      updatedAt: response.refreshedAt,
      fromCache: false,
    };
    await writeCachedReport(report);
    return report;
  })().finally(() => {
    if (inFlightReportRefreshes.get(key) === request) {
      inFlightReportRefreshes.delete(key);
    }
  });

  inFlightReportRefreshes.set(key, request);
  return request;
}

export const useCcusageStore = create<CcusageStore>((set, get) => ({
  source: "all",
  toolStatus: null,
  report: null,
  checkingStatus: false,
  installingTools: false,
  loadingCache: false,
  refreshing: false,
  error: null,

  setSource: (source) => {
    set({ source, error: null });
  },

  checkStatus: async () => {
    set({ checkingStatus: true, error: null });
    try {
      const status = await checkToolStatus();
      set({ toolStatus: status, checkingStatus: false });
    } catch (err) {
      set({ error: String(err), checkingStatus: false });
      throw err;
    }
  },

  installTools: async () => {
    set({ installingTools: true, error: null });
    try {
      const status = await invoke<CcusageToolStatus>("ccusage_install_tools");
      set({ toolStatus: normalizeToolStatus(status), installingTools: false });
    } catch (err) {
      set({ error: String(err), installingTools: false });
      throw err;
    }
  },

  loadCachedReport: async () => {
    const source = get().source;
    set({ loadingCache: true, error: null });
    try {
      const report = await readCachedReport(source);
      if (get().source === source) {
        set({ report, loadingCache: false });
      }
    } catch (err) {
      set({ error: String(err), loadingCache: false });
      throw err;
    }
  },

  refreshReport: async () => {
    const source = get().source;
    const settings = useSettingsStore.getState();
    set({ refreshing: true, error: null });
    try {
      const report = await refreshReportFromBackend(
        source,
        settings.claudeHookConfigDir,
        settings.codexHookConfigDir
      );
      if (get().source === source) {
        set({ report, refreshing: false });
      }
    } catch (err) {
      set({ error: String(err), refreshing: false });
      throw err;
    }
  },
}));
