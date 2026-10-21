import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Group,
  Select,
  Stack,
  Switch,
  Tabs,
  TextInput,
} from "@mantine/core";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ChevronRight, FolderOpen, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import {
  HISTORY_SOURCE_DESCRIPTORS,
  createHistorySourceInstanceId,
  inferHistorySourceEnvironment,
  type HistorySourceDescriptor,
  type HistorySourceId,
} from "../../../lib/historySources";
import { getLanguageLocale, pickByLanguage, useI18n } from "../../../lib/i18n";
import { useHistorySourceSettingsStore } from "../../../stores/historySourceSettingsStore";
import { resolveHistorySourceIconKey } from "../../../lib/cliTools";
import { CliToolIcon } from "../../CliToolIcon";
import { useAppConfirm } from "../../ui/useAppConfirm";

function sourcePath(descriptor: HistorySourceDescriptor, locations: Record<string, string> | undefined): string {
  const slot = descriptor.locations[0];
  return slot ? locations?.[slot.id] ?? "" : "";
}

function buildSourceSettings(descriptor: HistorySourceDescriptor, path: string) {
  const slot = descriptor.locations[0];
  const trimmed = path.trim();
  return {
    enabled: true,
    activeInstance: {
      id: createHistorySourceInstanceId(descriptor.id),
      environment: inferHistorySourceEnvironment(trimmed),
      locations: slot ? { [slot.id]: trimmed } : {},
    },
  };
}

interface HistorySourceValidateResult {
  valid: boolean;
  normalizedLocations: Record<string, string>;
  warnings: string[];
  errors: string[];
}

interface HistorySourceCandidate {
  sourceId: HistorySourceId;
  locationId: string;
  path: string;
  reason: string;
}

interface HistoryBackupRootStatus {
  root: string;
  environmentKind: string;
  environmentKey: string;
  maxBytes: number;
  retentionDays: number;
  totalBytes: number;
  retainedEntries: number;
  protectedEntries: number;
}

interface HistoryBackupRecoveryPlan {
  manifestPath?: string | null;
  backupPath: string;
  originalPath: string;
  canRestore: boolean;
  requiredToolClosed: boolean;
  conflict?: string | null;
  actions: string[];
}

interface HistoryBackupRestoreCandidate {
  originalPath: string;
  source: string;
  sourceSessionId: string;
  mutationKind: string;
  createdAt: number;
  state: string;
  backupPath: string;
  manifestPath: string;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatBackupTime(timestamp: number, language: string): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "-";
  return new Intl.DateTimeFormat(getLanguageLocale(language as "zh-CN" | "zh-TW" | "en-US"), {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

function validationMessage(code: string, text: (zh: string, en: string) => string): string {
  if (code.startsWith("missing_required_location:")) return text("缺少必填读取位置", "Required read location is missing");
  if (code.startsWith("location_not_directory:")) return text("读取位置必须是目录", "Read location must be a directory");
  if (code.startsWith("location_not_file:")) return text("读取位置必须是文件", "Read location must be a file");
  if (code === "claude_projects_dir_not_found") return text("未发现 Claude projects 目录，后续可能无法解析历史", "Claude projects directory was not found; history parsing may fail later");
  if (code === "codex_sessions_not_found") return text("未发现 Codex sessions/history.jsonl，后续可能无法解析历史", "Codex sessions/history.jsonl was not found; history parsing may fail later");
  return code;
}

export function HistorySourceSettingsPage() {
  const { language, t } = useI18n();
  const { confirm, confirmDialog } = useAppConfirm();
  const text = (zh: string, en: string) => pickByLanguage(language, zh, en);
  const { loaded, settings, load, setSourceSettings, clearSource } = useHistorySourceSettingsStore();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const savedPathsRef = useRef<Record<string, string>>({});
  const [expandedSourceId, setExpandedSourceId] = useState<HistorySourceId | null>(null);
  const [detectingSourceId, setDetectingSourceId] = useState<HistorySourceId | null>(null);
  const [backupStatus, setBackupStatus] = useState<HistoryBackupRootStatus | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [restoreCandidates, setRestoreCandidates] = useState<HistoryBackupRestoreCandidate[]>([]);
  const [restoreCandidatesLoading, setRestoreCandidatesLoading] = useState(false);
  const [restoreOriginalPath, setRestoreOriginalPath] = useState("");
  const [restoreSource, setRestoreSource] = useState("claude");
  const [restorePlan, setRestorePlan] = useState<HistoryBackupRecoveryPlan | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  useEffect(() => {
    const savedPaths: Record<string, string> = {};
    for (const descriptor of HISTORY_SOURCE_DESCRIPTORS) {
      savedPaths[descriptor.id] = sourcePath(descriptor, settings[descriptor.id]?.activeInstance?.locations);
    }
    const previousPaths = savedPathsRef.current;
    savedPathsRef.current = savedPaths;
    setDrafts((current) => Object.fromEntries(HISTORY_SOURCE_DESCRIPTORS.map(({ id }) => [
      id,
      previousPaths[id] !== savedPaths[id] ? savedPaths[id] : current[id] ?? savedPaths[id],
    ])));
  }, [settings]);

  const loadBackupStatus = async () => {
    const status = await invoke<HistoryBackupRootStatus>("history_backup_get_root_status");
    setBackupStatus(status);
  };

  const loadRestoreCandidates = async () => {
    setRestoreCandidatesLoading(true);
    try {
      const candidates = await invoke<HistoryBackupRestoreCandidate[]>("history_backup_list_restore_candidates");
      setRestoreCandidates(candidates);
    } finally {
      setRestoreCandidatesLoading(false);
    }
  };

  useEffect(() => {
    void Promise.all([loadBackupStatus(), loadRestoreCandidates()]).catch((error) => {
      console.warn("Failed to load history backup state", error);
    });
  }, []);

  useEffect(() => {
    if (restoreCandidates.length === 0) {
      setRestoreOriginalPath("");
      setRestorePlan(null);
      return;
    }
    const selected = restoreCandidates.find((candidate) => candidate.originalPath === restoreOriginalPath);
    if (selected) {
      setRestoreSource(selected.source);
      return;
    }
    const first = restoreCandidates[0];
    setRestoreOriginalPath(first.originalPath);
    setRestoreSource(first.source);
    setRestorePlan(null);
  }, [restoreCandidates, restoreOriginalPath]);

  const handleBackupCleanup = async () => {
    try {
      setBackupBusy(true);
      const status = await invoke<HistoryBackupRootStatus>("history_backup_cleanup");
      setBackupStatus(status);
      await loadRestoreCandidates();
      toast.success(t("historySources.backup.cleanupSuccess"));
    } catch (error) {
      toast.error(t("historySources.backup.cleanupFailed"), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBackupBusy(false);
    }
  };

  const handleBuildRestorePlan = async () => {
    const originalPath = restoreOriginalPath.trim();
    if (!originalPath) {
      toast.error(t("historySources.backup.restorePathRequired"));
      return;
    }
    try {
      setRestoreBusy(true);
      const plan = await invoke<HistoryBackupRecoveryPlan>("history_backup_build_restore_plan", {
        originalPath,
        source: restoreSource.trim() || undefined,
      });
      setRestorePlan(plan);
      if (plan.canRestore) {
        toast.success(t("historySources.backup.restorePlanReady"));
      } else {
        toast.warning(t("historySources.backup.restorePlanBlocked"), {
          description: restoreConflictText(plan.conflict) || undefined,
        });
      }
    } catch (error) {
      toast.error(t("historySources.backup.restorePlanFailed"), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRestoreBusy(false);
    }
  };

  const handleExecuteRestore = async () => {
    const originalPath = restoreOriginalPath.trim();
    if (!originalPath) {
      toast.error(t("historySources.backup.restorePathRequired"));
      return;
    }
    const confirmed = await confirm({
      title: t("historySources.backup.restore"),
      message: t("historySources.backup.restoreConfirm"),
      danger: true,
    });
    if (!confirmed) return;
    try {
      setRestoreBusy(true);
      const plan = await invoke<HistoryBackupRecoveryPlan>("history_backup_execute_restore", {
        originalPath,
        source: restoreSource.trim() || undefined,
      });
      setRestorePlan(plan);
      await loadBackupStatus();
      await loadRestoreCandidates();
      toast.success(t("historySources.backup.restoreSuccess"));
    } catch (error) {
      toast.error(t("historySources.backup.restoreFailed"), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRestoreBusy(false);
    }
  };

  const handleExportRestoreManifest = async () => {
    const backupPath = restorePlan?.backupPath;
    if (!backupPath) return;
    try {
      const manifestPath = restorePlan?.manifestPath
        ?? await invoke<string>("history_backup_export_manifest", { backupPath });
      await invoke("open_folder_in_explorer", { path: manifestPath, openFile: true });
    } catch (error) {
      toast.error(t("historySources.backup.exportManifestFailed"), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const activeCount = useMemo(
    () => HISTORY_SOURCE_DESCRIPTORS.filter((descriptor) => settings[descriptor.id]?.enabled).length,
    [settings]
  );

  const selectedRestoreCandidate = useMemo(
    () => restoreCandidates.find((candidate) => candidate.originalPath === restoreOriginalPath) ?? null,
    [restoreCandidates, restoreOriginalPath]
  );
  const restoreMutationLabel = (kind: string) => {
    if (kind === "delete" || kind === "sessionDelete") return t("history.edit.op.delete");
    if (kind === "insert") return t("history.edit.op.insert");
    if (kind === "restore") return t("history.edit.op.restore");
    return t("history.edit.op.edit");
  };
  const restoreCandidateOptions = useMemo(
    () => restoreCandidates.map((candidate) => ({
      value: candidate.originalPath,
      label: `${HISTORY_SOURCE_DESCRIPTORS.find((descriptor) => descriptor.id === candidate.source)
        ? t(HISTORY_SOURCE_DESCRIPTORS.find((descriptor) => descriptor.id === candidate.source)!.labelKey)
        : candidate.source} · ${candidate.sourceSessionId} · ${formatBackupTime(candidate.createdAt, language)}`,
    })),
    [language, restoreCandidates, t]
  );

  const handleRestoreCandidateChange = (originalPath: string | null) => {
    const candidate = restoreCandidates.find((item) => item.originalPath === originalPath);
    setRestoreOriginalPath(candidate?.originalPath ?? "");
    setRestoreSource(candidate?.source ?? "");
    setRestorePlan(null);
  };

  const handleOpenBackupRoot = async () => {
    if (!backupStatus?.root) return;
    try {
      await invoke("open_folder_in_explorer", { path: backupStatus.root });
    } catch (error) {
      toast.error(t("historySources.backup.openFailed"), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const restoreConflictText = (conflict: string | null | undefined) => {
    if (conflict === "history_target_tool_running") return t("historySources.backup.conflict.toolRunning");
    if (conflict === "history_backup_fingerprint_conflict") return t("historySources.backup.conflict.changed");
    if (conflict === "backup_not_found") return t("historySources.backup.conflict.backupMissing");
    if (conflict === "original_not_found") return t("historySources.backup.conflict.originalMissing");
    return conflict ?? "";
  };

  const handleBrowse = async (descriptor: HistorySourceDescriptor) => {
    const slot = descriptor.locations[0];
    const selected = await openDialog({
      directory: slot?.kind !== "database",
      multiple: false,
      title: text("选择历史读取位置", "Choose history read location"),
    });
    if (typeof selected === "string" && selected.trim()) {
      setDrafts((current) => ({ ...current, [descriptor.id]: selected }));
    }
  };

  const handleSave = async (descriptor: HistorySourceDescriptor) => {
    const path = drafts[descriptor.id]?.trim() ?? "";
    if (!path) {
      toast.error(text("请先填写历史读取位置", "Enter the history read location first"));
      return;
    }
    const slot = descriptor.locations[0];
    const result = await invoke<HistorySourceValidateResult>("history_sources_validate", {
      request: {
        sourceId: descriptor.id,
        locations: slot ? { [slot.id]: path } : {},
      },
    });
    if (!result.valid) {
      toast.error(text("历史读取位置无效", "Invalid history read location"), {
        description: result.errors.map((code) => validationMessage(code, text)).join("；"),
      });
      return;
    }
    const normalizedPath = slot ? result.normalizedLocations[slot.id] ?? path : path;
    await setSourceSettings(descriptor.id, buildSourceSettings(descriptor, normalizedPath));
    if (result.warnings.length > 0) {
      toast.warning(text("历史会话目录已保存，但存在提示", "History session location saved with warnings"), {
        description: result.warnings.map((code) => validationMessage(code, text)).join("；"),
      });
    } else {
      toast.success(text("历史会话目录已保存", "History session location saved"), { description: descriptor.defaultLabel });
    }
  };

  const handleDetect = async (descriptor: HistorySourceDescriptor) => {
    try {
      setDetectingSourceId(descriptor.id);
      const candidates = await invoke<HistorySourceCandidate[]>("history_sources_detect", {
        sourceId: descriptor.id,
      });
      const slot = descriptor.locations[0];
      const candidate = slot ? candidates.find((item) => item.locationId === slot.id) : candidates[0];
      if (!candidate) {
        toast.info(text("未检测到默认历史位置", "No default history location detected"));
        return;
      }
      setDrafts((current) => ({ ...current, [descriptor.id]: candidate.path }));
      toast.success(text("已填入检测到的候选位置，请确认后保存", "Detected candidate filled in; confirm and save"));
    } catch (error) {
      toast.error(text("检测历史会话目录失败", "Failed to detect history session location"), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setDetectingSourceId(null);
    }
  };

  const handleToggle = async (descriptor: HistorySourceDescriptor, enabled: boolean) => {
    const current = settings[descriptor.id];
    if (enabled && !current?.activeInstance) {
      setExpandedSourceId(descriptor.id);
      if (!drafts[descriptor.id]?.trim()) return;
      await handleSave(descriptor);
      return;
    }
    await setSourceSettings(descriptor.id, {
      enabled,
      ...(current?.activeInstance ? { activeInstance: current.activeInstance } : {}),
    });
  };

  const handleClear = async (sourceId: HistorySourceId) => {
    await clearSource(sourceId);
    setDrafts((current) => ({ ...current, [sourceId]: "" }));
  };

  return (
    <div className="ui-history-settings">
      <Tabs defaultValue="sources" keepMounted={false} className="ui-history-settings-tabs">
        <Tabs.List>
          <Tabs.Tab value="sources">{t("historySources.tabs.sources")}</Tabs.Tab>
          <Tabs.Tab value="backups">{t("historySources.backup.title")}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="sources">
          <div className="ui-history-source-intro">
            <p>{t("historySources.sourcesDescription")}</p>
            <span>{t("historySources.enabledCount", { count: activeCount })}</span>
          </div>
          <div className="ui-history-source-list">
            {HISTORY_SOURCE_DESCRIPTORS.map((descriptor) => {
              const current = settings[descriptor.id];
              const slot = descriptor.locations[0];
              const icon = resolveHistorySourceIconKey(descriptor.id);
              const draft = drafts[descriptor.id] ?? "";
              const savedPath = sourcePath(descriptor, current?.activeInstance?.locations);
              const expanded = expandedSourceId === descriptor.id;
              const status = !savedPath ? "unconfigured" : current?.enabled ? "enabled" : "disabled";
              const features = [
                descriptor.capabilities.list === "supported" && t("historySources.feature.browse"),
                descriptor.capabilities.resume === "supported" && t("historySources.feature.resume"),
                descriptor.capabilities.convertFrom === "supported" && t("historySources.feature.convertFrom"),
                descriptor.capabilities.convertTo === "supported" && t("historySources.feature.convertTo"),
              ].filter(Boolean).join(" · ");
              return (
                <div key={descriptor.id} className="ui-history-source" data-expanded={expanded}>
                  <div className="ui-history-source-row">
                    <button
                      type="button"
                      className="ui-history-source-toggle"
                      aria-expanded={expanded}
                      aria-controls={`history-source-${descriptor.id}-editor`}
                      onClick={() => setExpandedSourceId(expanded ? null : descriptor.id)}
                    >
                      <span className="ui-history-source-icon" aria-hidden="true">
                        {icon ? <CliToolIcon icon={icon} size={20} /> : <FolderOpen size={20} />}
                      </span>
                      <span className="ui-history-source-summary">
                        <span className="ui-history-source-name">{t(descriptor.labelKey)}</span>
                        <span className="ui-history-source-path" title={savedPath || undefined}>
                          {savedPath || t("historySources.chooseLocation")}
                        </span>
                      </span>
                      <span className="ui-history-source-status" data-status={status}>
                        {t(`historySources.status.${status}`)}
                      </span>
                      <ChevronRight size={14} className="ui-history-source-chevron" aria-hidden="true" />
                    </button>
                    <Switch
                      size="xs"
                      checked={Boolean(current?.enabled)}
                      onChange={(event) => void handleToggle(descriptor, event.currentTarget.checked)}
                      color="cliPrimary"
                      aria-label={t("historySources.enableSource", { source: t(descriptor.labelKey) })}
                    />
                  </div>
                  <div id={`history-source-${descriptor.id}-editor`} hidden={!expanded} className="ui-history-source-editor">
                    <div className="ui-history-source-location">
                      <TextInput
                        label={slot ? t(slot.labelKey) : t("historySources.readLocation")}
                        value={draft}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          setDrafts((currentDrafts) => ({ ...currentDrafts, [descriptor.id]: value }));
                        }}
                        placeholder={t(slot?.kind === "database" ? "historySources.chooseDatabase" : "historySources.chooseDirectory")}
                        size="xs"
                      />
                      <Button size="xs" variant="default" onClick={() => void handleBrowse(descriptor)}>
                        {t("historySources.browse")}
                      </Button>
                    </div>
                    {features && <p className="ui-history-source-features">{features}</p>}
                    <div className="ui-history-source-editor-footer">
                      <p>{t("historySources.detectHint")}</p>
                      <Group gap={6}>
                        <Button size="xs" variant="subtle" color="red" disabled={!current && !draft} onClick={() => void handleClear(descriptor.id)}>
                          {t("historySources.clear")}
                        </Button>
                        <Button
                          size="xs"
                          variant="default"
                          leftSection={<RefreshCw size={12} />}
                          loading={detectingSourceId === descriptor.id}
                          onClick={() => void handleDetect(descriptor)}
                        >
                          {t("historySources.detect")}
                        </Button>
                        <Button size="xs" disabled={!draft.trim()} onClick={() => void handleSave(descriptor)}>
                          {t("historySources.saveAndEnable")}
                        </Button>
                      </Group>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <p className="ui-history-settings-note">{t("historySources.hookSyncHint")}</p>
        </Tabs.Panel>
        <Tabs.Panel value="backups">
          <section className="ui-history-backup-section" aria-labelledby="history-backup-storage-title">
            <div className="ui-history-backup-heading">
              <h3 id="history-backup-storage-title">{t("historySources.backup.storage")}</h3>
              <Group gap={6}>
                <Button size="xs" variant="default" disabled={!backupStatus?.root} onClick={() => void handleOpenBackupRoot()}>
                  {t("historySources.backup.open")}
                </Button>
                <Button size="xs" variant="default" loading={backupBusy} onClick={() => void handleBackupCleanup()}>
                  {t("historySources.backup.cleanup")}
                </Button>
              </Group>
            </div>
            <p className="ui-history-settings-description">{t("historySources.backup.description")}</p>
            <p className="ui-history-backup-path">{backupStatus?.root ?? t("historySources.backup.loading")}</p>
            {backupStatus && (
              <dl className="ui-history-backup-metrics">
                <div><dt>{t("historySources.backup.space")}</dt><dd>{formatBytes(backupStatus.totalBytes)} <span>/ {formatBytes(backupStatus.maxBytes)}</span></dd></div>
                <div><dt>{t("historySources.backup.retention")}</dt><dd>{t("historySources.backup.days", { count: backupStatus.retentionDays })}</dd></div>
                <div><dt>{t("historySources.backup.protectedLabel")}</dt><dd>{backupStatus.protectedEntries}</dd></div>
                <div><dt>{t("historySources.backup.environment")}</dt><dd>{backupStatus.environmentKey}</dd></div>
              </dl>
            )}
          </section>
          <section className="ui-history-backup-section" aria-labelledby="history-backup-restore-title">
            <h3 id="history-backup-restore-title">{t("historySources.backup.restoreTitle")}</h3>
            <p className="ui-history-settings-description">{t("historySources.backup.restoreDescription")}</p>
            <Stack gap="sm" mt="md">
              <Select
                size="xs"
                searchable
                label={t("historySources.backup.restoreCandidate")}
                placeholder={t("historySources.backup.restoreCandidatePlaceholder")}
                nothingFoundMessage={t("historySources.backup.restoreCandidateEmpty")}
                data={restoreCandidateOptions}
                value={restoreOriginalPath || null}
                onChange={handleRestoreCandidateChange}
                disabled={restoreCandidatesLoading || restoreCandidateOptions.length === 0}
              />
              {selectedRestoreCandidate ? (
                <div className="ui-history-restore-details">
                  <p>
                    {HISTORY_SOURCE_DESCRIPTORS.find((descriptor) => descriptor.id === selectedRestoreCandidate.source)
                      ? t(HISTORY_SOURCE_DESCRIPTORS.find((descriptor) => descriptor.id === selectedRestoreCandidate.source)!.labelKey)
                      : selectedRestoreCandidate.source}
                    {" · "}{restoreMutationLabel(selectedRestoreCandidate.mutationKind)}
                    {" · "}{formatBackupTime(selectedRestoreCandidate.createdAt, language)}
                  </p>
                  <p>{t("historySources.backup.originalLocation", { path: selectedRestoreCandidate.originalPath })}</p>
                </div>
              ) : <p className="ui-history-settings-description">{t("historySources.backup.restoreCandidateEmpty")}</p>}
              <Group gap={6}>
                <Button size="xs" variant="default" loading={restoreBusy} disabled={!selectedRestoreCandidate} onClick={() => void handleBuildRestorePlan()}>
                  {t("historySources.backup.restorePlan")}
                </Button>
                <Button size="xs" variant="default" disabled={!restorePlan?.backupPath} onClick={() => void handleExportRestoreManifest()}>
                  {t("historySources.backup.exportManifest")}
                </Button>
                <Button size="xs" color="red" loading={restoreBusy} disabled={!restorePlan?.canRestore} onClick={() => void handleExecuteRestore()}>
                  {t("historySources.backup.restore")}
                </Button>
              </Group>
              {restorePlan && (
                <p className="ui-history-restore-result" data-ready={restorePlan.canRestore} role="status">
                  {t(restorePlan.canRestore ? "historySources.backup.restorePlanReady" : "historySources.backup.restorePlanBlocked")}
                  {restorePlan.conflict ? `: ${restoreConflictText(restorePlan.conflict)}` : ""}
                </p>
              )}
            </Stack>
          </section>
        </Tabs.Panel>
      </Tabs>
      {confirmDialog}
    </div>
  );
}
