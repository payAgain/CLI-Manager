import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { GitFork, Copy } from "lucide-react";
import { toast } from "sonner";
import { useI18n } from "../../lib/i18n";
import { getHistoryPathArgs } from "../../lib/historyPathArgs";
import { inferWslDistroFromCwd, resolveSubagentBrowserIdentity, resolveSubagentConfigDir, type SubagentRecord } from "../../lib/subagentBrowser";
import { resolveSubagentPresentation } from "../../lib/subagentPresentation";
import { copyTextToClipboard } from "../../lib/systemClipboard";
import type { HistoryMessage, Project, TerminalSession } from "../../lib/types";
import type { SshAgentHistoryContext } from "../../lib/sshAgentHistory";
import { fetchRemoteSubagentDetail, fetchRemoteSubagentSessions } from "../../stores/historyStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { MarkdownContent } from "../ui/MarkdownContent";
import { TaskListItem, TaskSection, TaskStatus } from "./TaskList";

function SubagentRecordRow({ record, childSession, selected, onOpen }: {
  record: SubagentRecord;
  childSession?: TerminalSession;
  selected: boolean;
  onOpen: (record: SubagentRecord) => void;
}) {
  const { t } = useI18n();
  const nickname = useTerminalStore(state => childSession ? state.subagentTranscripts[childSession.id]?.lifecycle?.nickname : undefined);
  const status = useTerminalStore(state => childSession ? state.subagentTranscripts[childSession.id]?.status : undefined);
  const ended = useTerminalStore(state => childSession ? state.subagentTranscripts[childSession.id]?.ended : undefined);
  const sourceKind = useTerminalStore(state => childSession ? state.subagentTranscripts[childSession.id]?.source.kind : undefined);
  const label = resolveSubagentPresentation({
    agentId: record.agentId, session: childSession, nickname, recordTitle: record.title, fallbackTitle: t("subagentTranscript.title"),
  });
  const displayStatus = status ?? (ended ? "completed" : sourceKind === "pending" ? "pending" : childSession ? "unknown" : undefined);
  const copyId = async () => {
    try {
      await copyTextToClipboard(record.agentId);
      toast.success(t("subagentTranscript.idCopied"));
    } catch {
      toast.error(t("subagentTranscript.copyIdFailed"));
    }
  };
  return <TaskListItem title={label.title} icon={<GitFork size={16} strokeWidth={1.8} />} selected={selected} onOpen={() => onOpen(record)}
    metadata={<span className="task-row__id" title={record.agentId}>{label.shortId}</span>}
    status={<TaskStatus status={displayStatus === "completed" ? "done" : displayStatus} label={displayStatus ? t(`subagentTranscript.status.${displayStatus}`) : ""} />}
    actions={<button type="button" className="task-action ui-focus-ring" onClick={() => void copyId()}
      aria-label={t("subagentTranscript.copyId")} title={`${t("subagentTranscript.copyId")} · ${record.agentId}`}>
      <Copy size={12} aria-hidden="true" />
    </button>} />;
}

export function SubagentBrowserPanel({ session, project, refreshSeq = 0 }: { session: TerminalSession | null; project?: Project | null; refreshSeq?: number }) {
  const { t } = useI18n();
  const identity = resolveSubagentBrowserIdentity(session, project);
  const source = identity?.source;
  const parentSessionId = identity?.parentSessionId;
  const [records, setRecords] = useState<SubagentRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<SubagentRecord | null>(null);
  const [messages, setMessages] = useState<HistoryMessage[]>([]);
  const sessions = useTerminalStore(state => state.sessions);
  const activeSessionId = useTerminalStore(state => state.activeSessionId);
  const childSessions = useMemo(() => new Map(sessions
    .filter(child => child.kind === "subagent-transcript" && child.subagent?.parentSessionId === session?.id)
    .map(child => [child.subagent!.agentId, child])), [sessions, session?.id]);
  const selectedTitle = selected ? resolveSubagentPresentation({ agentId: selected.agentId, recordTitle: selected.title, fallbackTitle: t("subagentTranscript.title") }).title : undefined;
  const generation = useRef(0);
  const configDir = useRef<string | null>(null);
  const remoteContext = useRef<SshAgentHistoryContext | null>(null);
  const releaseRemote = useCallback(() => {
    const context = remoteContext.current;
    remoteContext.current = null;
    if (context) void invoke("history_remote_close", { hostId: context.hostId, consumerId: context.consumerId }).catch(() => {});
  }, []);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    releaseRemote();
    setRecords([]);
    setMessages([]);
    setSelected(null);
    setError(false);
    configDir.current = null;
    if (!session || !source || !parentSessionId) { setLoading(false); return; }
    setLoading(true);
    try {
      let result: SubagentRecord[];
      if (session.environmentType === "ssh" || project?.environment_type === "ssh") {
        if (!project) throw new Error("ssh_project_required");
        const remote = await fetchRemoteSubagentSessions({ ...project, cli_tool: source,
          cli_config_root: resolveSubagentConfigDir(source, session, project, {}) ?? "",
        }, parentSessionId, session.remoteHistorySourceInstanceId);
        if (request !== generation.current) {
          void invoke("history_remote_close", { hostId: remote.context.hostId, consumerId: remote.context.consumerId }).catch(() => {});
          return;
        }
        remoteContext.current = remote.context;
        result = remote.summaries.map(item => ({ agentId: item.session_id, title: item.subagent?.nickname || item.title || item.session_id, transcriptPath: item.file_path }));
      } else {
        const paths = await getHistoryPathArgs();
        const wslDistro = session.envVars?.WSL_DISTRO_NAME || inferWslDistroFromCwd(session.cwd);
        const root = resolveSubagentConfigDir(source, session, project, paths);
        result = await invoke<SubagentRecord[]>("subagent_transcript_list", {
          source, parentSessionId, cwd: session.cwd ?? "",
          configDir: root,
          parentTranscriptPath: null, wslDistroName: wslDistro,
        });
        if (request === generation.current) configDir.current = root;
      }
      if (request === generation.current) setRecords(result);
    } catch { if (request === generation.current) setError(true); }
    finally { if (request === generation.current) setLoading(false); }
  }, [session?.id, session?.cwd, session?.environmentType, session?.envVars, session?.remoteHistorySourceInstanceId, source, parentSessionId, project, releaseRemote]);
  useEffect(() => { void refresh(); return () => { generation.current += 1; releaseRemote(); }; }, [refresh, refreshSeq, releaseRemote]);

  const open = async (record: SubagentRecord) => {
    if (!session || !source || !parentSessionId) return;
    const request = ++generation.current;
    setError(false);
    try {
      if (remoteContext.current) {
        setSelected(record); setLoading(true);
        const detail = await fetchRemoteSubagentDetail(remoteContext.current, record.agentId);
        if (request === generation.current) setMessages(detail.messages);
      } else {
        await useTerminalStore.getState().openSubagentTranscript({
          tabId: session.id, event: "SubagentStop", source, sessionId: parentSessionId,
          cwd: session.cwd ?? null, agentId: record.agentId, agentType: record.title,
          agentTranscriptPath: record.transcriptPath, transcriptPath: record.parentTranscriptPath ?? null,
          wslDistroName: session.envVars?.WSL_DISTRO_NAME || inferWslDistroFromCwd(session.cwd),
        }, { manual: true, configDir: configDir.current });
      }
    } catch { if (request === generation.current) setError(true); }
    finally { if (request === generation.current) setLoading(false); }
  };

  return <TaskSection icon={<GitFork size={15} />} title={selectedTitle || t("terminal.subagents.title")} count={selected || error ? undefined : records.length} busy={loading}
    onBack={selected ? () => { generation.current += 1; setSelected(null); setMessages([]); setLoading(false); } : undefined}
    backLabel={t("terminal.subagents.back")}>
    <div>
      {error && <p role="alert" className="task-list-empty text-danger">{t("terminal.subagents.error")}</p>}
      {loading ? <p role="status" className="task-list-empty">{t("terminal.subagents.loading")}</p>
        : error ? null : selected ? messages.length ? messages.map((message, index) => <article key={index} className="border-b border-border p-2 text-xs">
          <div className="mb-2 text-[11px] text-text-muted">{t(message.role === "user" ? "subagentTranscript.task"
            : message.role === "tool" ? "subagentTranscript.toolResult" : "subagentTranscript.reply")}</div>
          {message.role === "tool" ? <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono">{message.content}</pre>
            : <MarkdownContent content={message.content} compact />}
        </article>) : <p className="task-list-empty">{t("subagentTranscript.noIndependentOutput")}</p> : records.length ? records.map(record => {
          const childSession = childSessions.get(record.agentId);
          return <SubagentRecordRow key={record.agentId} record={record} childSession={childSession}
            selected={Boolean(childSession && activeSessionId === childSession.id)} onOpen={record => void open(record)} />;
        }) : <p className="task-list-empty">{t(identity ? "terminal.subagents.empty" : "terminal.subagents.noIdentity")}</p>}
    </div>
  </TaskSection>;
}
