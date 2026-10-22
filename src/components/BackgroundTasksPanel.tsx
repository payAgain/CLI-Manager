import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useI18n, type TranslationKey } from "../lib/i18n";
import { useBackgroundOperationStore, type BackgroundOperation } from "../stores/backgroundOperationStore";
import { useProjectStore } from "../stores/projectStore";
import { useSessionStore } from "../stores/sessionStore";
import { useSshAgentIntegrationStore } from "../stores/sshAgentIntegrationStore";
import { useSshHostStore } from "../stores/sshHostStore";
import { useTerminalStore, type TabNotificationState } from "../stores/terminalStore";
import { ConfirmDialog } from "./ConfirmDialog";
import { Activity, AlertTriangle, Check, Copy, Layers, RefreshCw, X } from "./icons";

export interface BackgroundTaskMeta {
  sessionId: string;
  cwd?: string | null;
  shell?: string | null;
  environmentType?: string | null;
  sshHostId?: string | null;
  remotePath?: string | null;
  alive: boolean;
  taskStatus?: TabNotificationState | null;
  taskUpdatedAtMs?: number | null;
  createdAtMs: number;
}

interface Props {
  tasks: BackgroundTaskMeta[];
  onRefresh: () => Promise<void>;
  onRestored?: () => void;
  refreshSeq?: number;
}

type BackgroundTaskDisplayStatus = "running" | "attention" | "done" | "failed";

const AGENT_INSTALL_PHASE_KEYS: Record<string, TranslationKey> = {
  resolvingRelease: "settings.sshHosts.cliIntegration.agent.progress.resolvingRelease",
  detectingRemote: "settings.sshHosts.cliIntegration.agent.progress.detectingRemote",
  downloadingArtifact: "settings.sshHosts.cliIntegration.agent.progress.downloadingArtifact",
  installingRemote: "settings.sshHosts.cliIntegration.agent.progress.installingRemote",
  completed: "settings.sshHosts.cliIntegration.agent.progress.completed",
};

function resolveOperationError(error: string): { title: TranslationKey; hint: TranslationKey } {
  const normalized = error.toLowerCase();
  if (
    normalized.includes("database is locked")
    || normalized.includes("ssh_agent_hook_metadata_busy")
    || normalized.includes("ssh_agent_history_metadata_busy")
    || normalized.includes("history_catalog_busy")
  ) {
    return {
      title: "backgroundOperations.error.databaseBusy",
      hint: "backgroundOperations.error.databaseBusyHint",
    };
  }
  if (normalized.includes("ssh_agent_bridge_response_timeout")) {
    return {
      title: "backgroundOperations.error.bridgeTimeout",
      hint: "backgroundOperations.error.bridgeTimeoutHint",
    };
  }
  if (normalized.includes("daemon reply timeout")) {
    return {
      title: "backgroundOperations.error.daemonTimeout",
      hint: "backgroundOperations.error.daemonTimeoutHint",
    };
  }
  if (normalized.includes("history_index_busy")) {
    return {
      title: "backgroundOperations.error.historyBusy",
      hint: "backgroundOperations.error.historyBusyHint",
    };
  }
  return {
    title: "backgroundOperations.error.generic",
    hint: "backgroundOperations.error.genericHint",
  };
}

function operationDisplayStatus(operation: BackgroundOperation): BackgroundTaskDisplayStatus {
  if (operation.status === "succeeded") return "done";
  return operation.status === "failed" ? "failed" : "running";
}

function resolveTaskStatus(task: BackgroundTaskMeta): BackgroundTaskDisplayStatus {
  if (
    task.taskStatus === "running" ||
    task.taskStatus === "attention" ||
    task.taskStatus === "done" ||
    task.taskStatus === "failed"
  ) {
    return task.taskStatus;
  }
  return task.alive ? "running" : "done";
}

export function BackgroundTasksPanel({ tasks, onRefresh, onRestored, refreshSeq = 0 }: Props) {
  const { t, language } = useI18n();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    void onRefresh();
    return () => { mounted.current = false; };
  }, [onRefresh, refreshSeq]);
  const [discardIntent, setDiscardIntent] = useState<BackgroundTaskMeta | null>(null);
  const [discardPending, setDiscardPending] = useState(false);
  const persistedSessions = useSessionStore((state) => state.sessions);
  const projects = useProjectStore((state) => state.projects);
  const sshHosts = useSshHostStore((state) => state.hosts);
  const operations = useBackgroundOperationStore((state) => state.operations);
  const dismissOperation = useBackgroundOperationStore((state) => state.dismiss);
  const clearFinishedOperations = useBackgroundOperationStore((state) => state.clearFinished);
  const agentInstallJobs = useSshAgentIntegrationStore((state) => state.agentInstallJobs);
  const clearAgentInstallJob = useSshAgentIntegrationStore((state) => state.clearAgentInstallJob);
  const attachDaemonSession = useTerminalStore((state) => state.attachDaemonSession);
  const discardDaemonSession = useTerminalStore((state) => state.discardDaemonSession);

  const rows = useMemo(() => tasks.map((task) => {
    const session = persistedSessions.find((item) => item.id === task.sessionId);
    const project = session?.projectId
      ? projects.find((item) => item.id === session.projectId)
      : undefined;
    return {
      ...task,
      status: resolveTaskStatus(task),
      title: session?.title || project?.name || task.remotePath || task.cwd || t("terminal.backgroundTasks.untitled"),
      projectName: project?.name,
      location: task.environmentType === "ssh"
        ? `SSH · ${task.remotePath || task.sshHostId || "-"}`
        : task.cwd,
    };
  }), [persistedSessions, projects, t, tasks]);

  const handleRestore = async (sessionId: string) => {
    try {
      const restored = await attachDaemonSession(sessionId);
      if (!restored) {
        toast.error(t("terminal.backgroundTasks.restoreFailed"));
        await onRefresh();
        return;
      }
      if (mounted.current) onRestored?.();
    } catch (err) {
      toast.error(t("terminal.backgroundTasks.restoreFailed"), { description: String(err) });
    }
  };

  const confirmDiscard = async () => {
    if (!discardIntent || discardPending) return;
    setDiscardPending(true);
    try {
      await discardDaemonSession(discardIntent.sessionId);
      setDiscardIntent(null);
      await onRefresh();
    } catch (err) {
      toast.error(t("terminal.backgroundTasks.discardFailed"), { description: String(err) });
    } finally {
      setDiscardPending(false);
    }
  };
  const discardIntentStatus = discardIntent ? resolveTaskStatus(discardIntent) : null;
  const discardIntentTerminalState = discardIntentStatus === "done" || discardIntentStatus === "failed";
  const operationRows = useMemo(
    () => Object.values(operations).sort((left, right) => right.updatedAt - left.updatedAt),
    [operations],
  );
  const agentRows = useMemo(
    () => Object.values(agentInstallJobs).sort((left, right) => right.updatedAt - left.updatedAt),
    [agentInstallJobs],
  );
  const hasAnyTask = rows.length > 0 || operationRows.length > 0 || agentRows.length > 0;
  const hasFinishedOperation = operationRows.some((operation) => operation.status !== "running")
    || agentRows.some((job) => job.status !== "running");

  const clearFinished = () => {
    clearFinishedOperations();
    for (const job of agentRows) {
      if (job.status !== "running") clearAgentInstallJob(job.hostId);
    }
  };

  return (
    <>
      <section id="background-tasks-panel" className="background-tasks-panel ui-side-panel-section" data-empty={!hasAnyTask ? "true" : undefined} aria-label={t("terminal.backgroundTasks.title")}>
        <header className="ui-side-panel-section-header flex h-8 items-center gap-2 px-3">
          <Layers size={14} className="shrink-0 text-text-muted" />
          <h3 className="ui-side-panel-section-title text-[11px] font-medium text-text-primary">{t("terminal.backgroundTasks.title")}</h3>
          <span className="ui-side-panel-section-count text-[10px] tabular-nums text-text-muted">{rows.length + operationRows.length + agentRows.length}</span>
          <div className="ui-side-panel-section-actions ml-auto flex items-center gap-1">
            {hasFinishedOperation && (
              <button className="background-tasks-panel__action ui-flat-action px-2 py-1 text-[10px]" onClick={clearFinished}>
                {t("backgroundOperations.clearFinished")}
              </button>
            )}
          </div>
        </header>
        <div className="background-tasks-panel__list ui-side-panel-section-body">
          {!hasAnyTask ? (
            <p className="ui-side-panel-empty px-1 py-1 text-[11px] text-text-muted" title={t("terminal.backgroundTasks.emptyDescription")}>{t("terminal.backgroundTasks.empty")}</p>
          ) : null}

          {agentRows.map((job) => {
            const status = job.status === "succeeded" ? "done" : job.status;
            const hostName = sshHosts.find((host) => host.id === job.hostId)?.name ?? job.hostId;
            const phaseKey = AGENT_INSTALL_PHASE_KEYS[job.phase] ?? AGENT_INSTALL_PHASE_KEYS.resolvingRelease;
            const error = job.error ? resolveOperationError(job.error) : null;
            return (
              <div key={`agent:${job.hostId}`} className="background-tasks-panel__item px-1 py-2" role={job.status === "failed" ? "alert" : undefined}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="ui-side-panel-item-title truncate text-xs font-medium text-text-primary">{t("backgroundOperations.agentInstall.title")}</div>
                    <div className="ui-side-panel-item-meta truncate text-[10px] text-text-muted" title={hostName}>{hostName}</div>
                  </div>
                  <span className="background-tasks-panel__status flex shrink-0 items-center gap-1 text-[10px]" data-status={status}>
                    {status === "done" ? <Check size={11} /> : null}
                    {status === "failed" ? <AlertTriangle size={11} /> : null}
                    {status === "running" ? <Activity size={11} /> : null}
                    {t(`backgroundOperations.status.${job.status}` as TranslationKey)}
                  </span>
                </div>
                <div className="mt-1 text-[11px] text-text-muted">{job.status === "failed" && error ? t(error.title) : t(phaseKey)}</div>
                {job.status === "failed" && error && <div className="mt-1 text-[10px] text-text-muted">{t(error.hint)}</div>}
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-high" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.progress}>
                  <div className={job.status === "failed" ? "h-full rounded-full bg-danger" : "h-full rounded-full bg-primary transition-[width] duration-200"} style={{ width: `${job.progress}%` }} />
                </div>
                <div className="mt-2 flex justify-end gap-1.5">
                  {job.error && (
                    <button className="background-tasks-panel__action ui-flat-action px-2 py-1 text-[11px]" onClick={() => void navigator.clipboard.writeText(job.error)} title={t("backgroundOperations.copyDetails")}>
                      <Copy size={11} />
                      {t("backgroundOperations.copyDetails")}
                    </button>
                  )}
                  {job.status !== "running" && (
                    <button className="background-tasks-panel__action ui-flat-action px-2 py-1 text-[11px]" onClick={() => clearAgentInstallJob(job.hostId)} aria-label={t("common.close")}>
                      <X size={11} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {operationRows.map((operation) => {
            const status = operationDisplayStatus(operation);
            const error = operation.status === "failed" ? resolveOperationError(operation.error) : null;
            const progress = operation.progress ?? (operation.status === "running" ? 45 : operation.status === "succeeded" ? 100 : 0);
            return (
              <div key={operation.id} className="background-tasks-panel__item px-1 py-2" role={operation.status === "failed" ? "alert" : undefined}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="ui-side-panel-item-title truncate text-xs font-medium text-text-primary" title={t(operation.titleKey)}>{t(operation.titleKey)}</div>
                    {operation.contextLabel && <div className="ui-side-panel-item-meta truncate text-[10px] text-text-muted" title={operation.contextLabel}>{operation.contextLabel}</div>}
                  </div>
                  <span className="background-tasks-panel__status flex shrink-0 items-center gap-1 text-[10px]" data-status={status}>
                    {status === "done" ? <Check size={11} /> : null}
                    {status === "failed" ? <AlertTriangle size={11} /> : null}
                    {status === "running" ? <Activity size={11} /> : null}
                    {t(`backgroundOperations.status.${operation.status}` as TranslationKey)}
                  </span>
                </div>
                <div className="mt-1 text-[11px] text-text-muted">
                  {error ? t(error.title) : t(operation.detailKey, operation.detailParams)}
                </div>
                {error && <div className="mt-1 text-[10px] text-text-muted">{t(error.hint)}</div>}
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-high" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={operation.progress ?? undefined}>
                  <div className={`h-full rounded-full ${operation.status === "failed" ? "bg-danger" : "bg-primary transition-[width] duration-200"} ${operation.progress === null && operation.status === "running" ? "animate-pulse" : ""}`} style={{ width: `${progress}%` }} />
                </div>
                <div className="mt-2 flex justify-end gap-1.5">
                  {operation.status === "failed" && operation.retry && (
                    <button className="background-tasks-panel__action ui-flat-action px-2 py-1 text-[11px]" onClick={() => void operation.retry?.()}>
                      <RefreshCw size={11} />
                      {t("backgroundOperations.retry")}
                    </button>
                  )}
                  {operation.error && (
                    <button className="background-tasks-panel__action ui-flat-action px-2 py-1 text-[11px]" onClick={() => void navigator.clipboard.writeText(operation.error)} title={t("backgroundOperations.copyDetails")}>
                      <Copy size={11} />
                    </button>
                  )}
                  {operation.status !== "running" && (
                    <button className="background-tasks-panel__action ui-flat-action px-2 py-1 text-[11px]" onClick={() => dismissOperation(operation.id)} aria-label={t("common.close")}>
                      <X size={11} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          {rows.map((task) => {
            const terminalState = task.status === "done" || task.status === "failed";
            return (
              <div key={task.sessionId} className="background-tasks-panel__item px-1 py-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="ui-side-panel-item-title truncate text-xs font-medium text-text-primary" title={task.title}>{task.title}</div>
                    {(task.projectName || task.location) && (
                      <div className="ui-side-panel-item-meta truncate text-[10px] text-text-muted" title={task.location || task.projectName}>
                        {task.projectName}{task.projectName && task.location ? " · " : ""}{task.location}
                      </div>
                    )}
                  </div>
                  <span
                    className="background-tasks-panel__status flex shrink-0 items-center gap-1 text-[10px]"
                    data-status={task.status}
                  >
                    {task.status === "done" ? <Check size={11} /> : null}
                    {task.status === "failed" ? <X size={11} /> : null}
                    {task.status === "attention" ? <AlertTriangle size={11} /> : null}
                    {task.status === "running" ? <Activity size={11} /> : null}
                    {task.status === "running" ? t("terminal.backgroundTasks.running") : null}
                    {task.status === "attention" ? t("terminal.backgroundTasks.attention") : null}
                    {task.status === "done" ? t("terminal.backgroundTasks.completed") : null}
                    {task.status === "failed" ? t("terminal.backgroundTasks.failed") : null}
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className="text-[10px] text-text-muted" title={new Date(task.createdAtMs).toLocaleString(language, { hour12: false })}>
                    {new Date(task.createdAtMs).toLocaleString(language, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}
                  </span>
                  <div className="flex shrink-0 gap-1">
                    <button
                      className="background-tasks-panel__action ui-flat-action px-1.5 py-0.5 text-[10px]"
                      onClick={() => void handleRestore(task.sessionId)}
                    >
                      {t("terminal.backgroundTasks.restore")}
                    </button>
                    <button
                      className="background-tasks-panel__action background-tasks-panel__action--danger ui-flat-action px-1.5 py-0.5 text-[10px]"
                      onClick={() => setDiscardIntent(task)}
                    >
                      <X size={11} />
                      {terminalState
                        ? t("terminal.backgroundTasks.delete")
                        : t("terminal.backgroundTasks.discard")}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>
      <ConfirmDialog
        open={discardIntent !== null}
        title={discardIntentTerminalState
          ? t("terminal.backgroundTasks.confirmDeleteTitle")
          : t("terminal.backgroundTasks.confirmDiscardTitle")}
        message={discardIntentTerminalState
          ? t("terminal.backgroundTasks.confirmDelete")
          : t("terminal.backgroundTasks.confirmDiscard")}
        confirmText={discardIntentTerminalState
          ? t("terminal.backgroundTasks.delete")
          : t("terminal.backgroundTasks.discard")}
        cancelText={t("common.cancel")}
        danger
        onConfirm={() => {
          void confirmDiscard();
        }}
        onClose={() => {
          if (!discardPending) setDiscardIntent(null);
        }}
      />
    </>
  );
}
