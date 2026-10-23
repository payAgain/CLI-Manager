import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, RefreshCw, Server, Terminal, TerminalSquare, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { useI18n, type TranslationKey } from "../lib/i18n";
import { copyTextToClipboard } from "../lib/systemClipboard";
import { backgroundTaskStatus, compareTaskActivity, taskProgress, type TaskDisplayStatus } from "../lib/taskPresentation";
import { useBackgroundOperationStore, type BackgroundOperation } from "../stores/backgroundOperationStore";
import { useProjectStore } from "../stores/projectStore";
import { useSessionStore } from "../stores/sessionStore";
import { useSshAgentIntegrationStore } from "../stores/sshAgentIntegrationStore";
import { useSshHostStore } from "../stores/sshHostStore";
import { useTerminalStore, type TabNotificationState } from "../stores/terminalStore";
import { ConfirmDialog } from "./ConfirmDialog";
import { TaskListItem, TaskSection, TaskStatus } from "./terminal/TaskList";

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

const AGENT_INSTALL_PHASE_KEYS: Record<string, TranslationKey> = {
  resolvingRelease: "settings.sshHosts.cliIntegration.agent.progress.resolvingRelease",
  detectingRemote: "settings.sshHosts.cliIntegration.agent.progress.detectingRemote",
  downloadingArtifact: "settings.sshHosts.cliIntegration.agent.progress.downloadingArtifact",
  installingRemote: "settings.sshHosts.cliIntegration.agent.progress.installingRemote",
  completed: "settings.sshHosts.cliIntegration.agent.progress.completed",
};

function resolveOperationError(error: string): { title: TranslationKey; hint: TranslationKey } {
  const normalized = error.toLowerCase();
  if (["database is locked", "ssh_agent_hook_metadata_busy", "ssh_agent_history_metadata_busy", "history_catalog_busy"].some(value => normalized.includes(value))) {
    return { title: "backgroundOperations.error.databaseBusy", hint: "backgroundOperations.error.databaseBusyHint" };
  }
  if (normalized.includes("ssh_agent_bridge_response_timeout")) {
    return { title: "backgroundOperations.error.bridgeTimeout", hint: "backgroundOperations.error.bridgeTimeoutHint" };
  }
  if (normalized.includes("daemon reply timeout")) {
    return { title: "backgroundOperations.error.daemonTimeout", hint: "backgroundOperations.error.daemonTimeoutHint" };
  }
  if (normalized.includes("history_index_busy")) {
    return { title: "backgroundOperations.error.historyBusy", hint: "backgroundOperations.error.historyBusyHint" };
  }
  return { title: "backgroundOperations.error.generic", hint: "backgroundOperations.error.genericHint" };
}

function operationStatus(operation: { status: BackgroundOperation["status"] }): TaskDisplayStatus {
  return operation.status === "succeeded" ? "done" : operation.status;
}

export function BackgroundTasksPanel({ tasks, onRefresh, onRestored, refreshSeq = 0 }: Props) {
  const { t, language } = useI18n();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => { void onRefresh(); }, [onRefresh, refreshSeq]);
  const [discardIntent, setDiscardIntent] = useState<BackgroundTaskMeta | null>(null);
  const [discardPending, setDiscardPending] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const persistedSessions = useSessionStore(state => state.sessions);
  const projects = useProjectStore(state => state.projects);
  const sshHosts = useSshHostStore(state => state.hosts);
  const operations = useBackgroundOperationStore(state => state.operations);
  const dismissOperation = useBackgroundOperationStore(state => state.dismiss);
  const clearFinishedOperations = useBackgroundOperationStore(state => state.clearFinished);
  const agentInstallJobs = useSshAgentIntegrationStore(state => state.agentInstallJobs);
  const clearAgentInstallJob = useSshAgentIntegrationStore(state => state.clearAgentInstallJob);
  const attachDaemonSession = useTerminalStore(state => state.attachDaemonSession);
  const discardDaemonSession = useTerminalStore(state => state.discardDaemonSession);

  const rows = useMemo(() => {
    const sessionsById = new Map(persistedSessions.map(session => [session.id, session]));
    const projectsById = new Map(projects.map(project => [project.id, project]));
    return tasks.map(task => {
      const session = sessionsById.get(task.sessionId);
      const project = session?.projectId ? projectsById.get(session.projectId) : undefined;
      return {
        ...task,
        status: backgroundTaskStatus(task),
        title: session?.title || project?.name || task.remotePath || task.cwd || t("terminal.backgroundTasks.untitled"),
        context: [project?.name, task.environmentType === "ssh" ? `SSH · ${task.remotePath || task.sshHostId || "-"}` : task.cwd].filter(Boolean).join(" · "),
      };
    });
  }, [persistedSessions, projects, t, tasks]);
  const entries = useMemo(() => [
    ...rows.map(task => ({ kind: "terminal" as const, id: `terminal:${task.sessionId}`, task, status: task.status, updatedAt: task.taskUpdatedAtMs ?? task.createdAtMs })),
    ...Object.values(operations).map(operation => ({ kind: "operation" as const, id: `operation:${operation.id}`, operation, status: operationStatus(operation), updatedAt: operation.updatedAt })),
    ...Object.values(agentInstallJobs).map(job => ({ kind: "install" as const, id: `install:${job.hostId}`, job, status: operationStatus(job), updatedAt: job.updatedAt })),
  ].sort(compareTaskActivity), [rows, operations, agentInstallJobs]);
  const hasFinishedOperation = Object.values(operations).some(operation => operation.status !== "running")
    || Object.values(agentInstallJobs).some(job => job.status !== "running");

  const clearFinished = () => {
    clearFinishedOperations();
    for (const job of Object.values(agentInstallJobs)) {
      if (job.status !== "running") clearAgentInstallJob(job.hostId);
    }
  };
  const copyDetails = async (details: string) => {
    try { await copyTextToClipboard(details); }
    catch { toast.error(t("terminal.tasks.copyFailed")); }
  };
  const handleRestore = async (sessionId: string) => {
    if (restoringId) return;
    setRestoringId(sessionId);
    try {
      const restored = await attachDaemonSession(sessionId);
      if (!restored) {
        toast.error(t("terminal.backgroundTasks.restoreFailed"));
        await onRefresh();
      } else if (mounted.current) onRestored?.();
    } catch (err) {
      toast.error(t("terminal.backgroundTasks.restoreFailed"), { description: String(err) });
    } finally {
      if (mounted.current) setRestoringId(null);
    }
  };
  const confirmDiscard = async () => {
    if (!discardIntent || discardPending) return;
    setDiscardPending(true);
    try {
      await discardDaemonSession(discardIntent.sessionId);
      if (mounted.current) setDiscardIntent(null);
      await onRefresh();
    } catch (err) {
      toast.error(t("terminal.backgroundTasks.discardFailed"), { description: String(err) });
    } finally {
      if (mounted.current) setDiscardPending(false);
    }
  };
  const discardIsFinished = discardIntent && ["done", "failed"].includes(backgroundTaskStatus(discardIntent));
  const discardTitle = rows.find(task => task.sessionId === discardIntent?.sessionId)?.title ?? t("terminal.backgroundTasks.untitled");

  return <>
    <div id="background-tasks-panel">
      {(["terminals", "operations"] as const).map(group => {
        const groupEntries = entries.filter(entry => group === "terminals" ? entry.kind === "terminal" : entry.kind !== "terminal");
        return <TaskSection key={group} icon={group === "terminals" ? <TerminalSquare size={15} /> : <RefreshCw size={15} />}
          title={t(group === "terminals" ? "terminal.backgroundTasks.title" : "backgroundOperations.sectionTitle")} count={groupEntries.length}
          actions={group === "operations" && hasFinishedOperation && <button type="button" className="task-action task-action--text ui-focus-ring" onClick={clearFinished}>{t("backgroundOperations.clearFinished")}</button>}>
        {!groupEntries.length && <p className="task-list-empty">{t(group === "terminals" ? "terminal.backgroundTasks.emptyDescription" : "terminal.agentTasks.operationsEmpty")}</p>}
        {groupEntries.map(entry => {
          const statusLabel = entry.kind === "terminal"
            ? t(entry.status === "done" ? "terminal.backgroundTasks.completed" : `terminal.backgroundTasks.${entry.status}` as TranslationKey)
            : t(`backgroundOperations.status.${entry.kind === "operation" ? entry.operation.status : entry.job.status}` as TranslationKey);
          const status = <TaskStatus status={entry.status} label={statusLabel} />;
          if (entry.kind === "terminal") {
            const task = entry.task;
            const finished = task.status === "done" || task.status === "failed";
            const date = new Date(task.createdAtMs).toLocaleString(language, { hour12: false });
            return <TaskListItem key={entry.id} title={task.title} titleHint={`${task.title}\n${date}`} icon={<Terminal size={14} />} status={status}
              metadata={<span title={[task.context, date].filter(Boolean).join(" · ")}>{task.context || date}</span>}
              actions={<>
                <button type="button" className="task-action task-action--text ui-focus-ring" aria-label={t("terminal.backgroundTasks.restore")} disabled={restoringId !== null} onClick={() => void handleRestore(task.sessionId)}>
                  {restoringId === task.sessionId ? <RefreshCw size={12} className="animate-spin" aria-hidden="true" /> : t("terminal.backgroundTasks.restore")}
                </button>
                <button type="button" className="task-action task-action--danger ui-focus-ring" onClick={() => setDiscardIntent(task)}
                  title={t(finished ? "terminal.backgroundTasks.delete" : "terminal.backgroundTasks.discard")}
                  aria-label={`${t(finished ? "terminal.backgroundTasks.delete" : "terminal.backgroundTasks.discard")} · ${task.title}`}>
                  <Trash2 size={12} aria-hidden="true" />
                </button>
              </>} />;
          }
          const job = entry.kind === "install" ? entry.job : null;
          const operation = entry.kind === "operation" ? entry.operation : null;
          const errorText = job?.error || operation?.error;
          const error = entry.status === "failed" && errorText ? resolveOperationError(errorText) : null;
          const title = job ? t("backgroundOperations.agentInstall.title") : t(operation!.titleKey);
          const context = job ? sshHosts.find(host => host.id === job.hostId)?.name ?? job.hostId : operation!.contextLabel;
          const detail = error ? t(error.title) : job ? t(AGENT_INSTALL_PHASE_KEYS[job.phase] ?? AGENT_INSTALL_PHASE_KEYS.resolvingRelease)
            : t(operation!.detailKey, operation!.detailParams);
          return <TaskListItem key={entry.id} title={title} icon={job ? <Server size={14} /> : <RefreshCw size={14} />} status={status} alert={Boolean(error)}
            metadata={<span title={[context, detail].filter(Boolean).join(" · ")}>{[context, detail].filter(Boolean).join(" · ")}</span>}
            progress={entry.status === "running" ? taskProgress(job ? job.progress : operation!.progress) : undefined}
            actions={<>
              {operation?.status === "failed" && operation.retry && <button type="button" className="task-action task-action--text ui-focus-ring" onClick={() => void operation.retry?.()}>{t("backgroundOperations.retry")}</button>}
              {errorText && <button type="button" className="task-action ui-focus-ring" onClick={() => void copyDetails(errorText)} title={t("backgroundOperations.copyDetails")} aria-label={t("backgroundOperations.copyDetails")}><Copy size={12} aria-hidden="true" /></button>}
              {entry.status !== "running" && <button type="button" className="task-action ui-focus-ring" onClick={() => job ? clearAgentInstallJob(job.hostId) : dismissOperation(operation!.id)} title={t("common.close")} aria-label={t("common.close")}><X size={12} aria-hidden="true" /></button>}
            </>}>
            {error && <p className="task-row__error-hint">{t(error.hint)}</p>}
          </TaskListItem>;
        })}
      </TaskSection>;
      })}
    </div>
    <ConfirmDialog open={discardIntent !== null}
      title={t(discardIsFinished ? "terminal.backgroundTasks.confirmDeleteTitle" : "terminal.backgroundTasks.confirmDiscardTitle")}
      message={t(discardIsFinished ? "terminal.backgroundTasks.confirmDelete" : "terminal.backgroundTasks.confirmDiscard", { title: discardTitle })}
      confirmText={t(discardIsFinished ? "terminal.backgroundTasks.delete" : "terminal.backgroundTasks.discard")} cancelText={t("common.cancel")} danger
      onConfirm={() => void confirmDiscard()} onClose={() => { if (!discardPending) setDiscardIntent(null); }} />
  </>;
}
