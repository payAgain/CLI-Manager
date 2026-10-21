import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, Bot, ChevronRight } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { getHistoryPathArgs } from "../../lib/historyPathArgs";
import { inferWslDistroFromCwd, resolveSubagentBrowserIdentity, resolveSubagentConfigDir, type SubagentRecord } from "../../lib/subagentBrowser";
import type { HistoryMessage, Project, TerminalSession } from "../../lib/types";
import type { SshAgentHistoryContext } from "../../lib/sshAgentHistory";
import { fetchRemoteSubagentDetail, fetchRemoteSubagentSessions } from "../../stores/historyStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { MarkdownContent } from "../ui/MarkdownContent";

export function SubagentBrowserPanel({ session, project, refreshSeq = 0 }: { session: TerminalSession | null; project?: Project | null; refreshSeq?: number }) {
  const { t } = useI18n();
  const identity = resolveSubagentBrowserIdentity(session, project);
  const source = identity?.source;
  const parentSessionId = identity?.parentSessionId;
  const [records, setRecords] = useState<SubagentRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<HistoryMessage[]>([]);
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
        setSelected(record.title); setLoading(true);
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

  return <section className="border-b border-border" aria-label={t("terminal.subagents.title")}>
    <header className="flex h-8 items-center gap-2 px-3">
      {selected ? <button className="ui-focus-ring ui-icon-action" aria-label={t("terminal.subagents.back")} onClick={() => { generation.current += 1; setSelected(null); setMessages([]); setLoading(false); }}><ArrowLeft size={13} /></button> : <Bot size={14} />}
      <h3 className="min-w-0 truncate text-[11px] font-medium">{selected || t("terminal.subagents.title")}</h3>
      {!selected && !loading && <span className="text-[10px] tabular-nums text-text-muted">{records.length}</span>}
      {session && <span className="min-w-0 flex-1 truncate text-right text-[10px] text-text-muted" title={session.title}>{session.title}</span>}
    </header>
    <div className="pb-1">
      {error && <p role="alert" className="p-2 text-xs text-danger">{t("terminal.subagents.error")}</p>}
      {loading ? <p role="status" className="p-2 text-xs text-text-muted">{t("terminal.subagents.loading")}</p>
        : selected ? messages.length ? messages.map((message, index) => <article key={index} className="border-b border-border p-2 text-xs">
          <div className="mb-2 text-[10px] text-text-muted">{t(message.role === "user" ? "subagentTranscript.task"
            : message.role === "tool" ? "subagentTranscript.toolResult" : "subagentTranscript.reply")}</div>
          {message.role === "tool" ? <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono">{message.content}</pre>
            : <MarkdownContent content={message.content} compact />}
        </article>) : <p className="p-3 text-xs text-text-muted">{t("subagentTranscript.noIndependentOutput")}</p> : records.length ? records.map(record => <button key={record.agentId} onClick={() => void open(record)}
          title={record.title} className="ui-focus-ring flex h-8 w-full items-center gap-2 px-3 text-left hover:bg-surface-container-high">
          <Bot size={12} className="shrink-0 text-text-muted" /><span className="min-w-0 flex-1 truncate text-xs">{record.title}</span><ChevronRight size={12} />
        </button>) : <p className="px-3 py-2 text-[11px] leading-relaxed text-text-muted">{t(identity ? "terminal.subagents.empty" : "terminal.subagents.noIdentity")}</p>}
    </div>
  </section>;
}
