import { AppWindow, ChevronRight, Cpu, Terminal } from "lucide-react";
import { Popover, PopoverTrigger } from "../ui/popover";
import { ResourceDetailPopover } from "../terminal/ResourceDetailPopover";
import { StatusBarButton } from "../terminal/StatusBarButton";
import { useTerminalMemory } from "../../hooks/useTerminalMemory";
import { useTerminalStore } from "../../stores/terminalStore";
import { useI18n } from "../../lib/i18n";
import { useState } from "react";


export function formatMemory(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} B`;
}

export function MemoryUsage({ collapsed, statusBar = false }: { collapsed: boolean; statusBar?: boolean }) {
  const { t, language } = useI18n();
  const [open, setOpen] = useState(false);
  const { snapshot, error, refresh } = useTerminalMemory();
  const sessions = useTerminalStore((state) => state.sessions);
  const activeId = useTerminalStore((state) => state.activeSessionId);
  const terminals = sessions.filter((session) => !session.kind || session.kind === "pty");
  const openedIds = new Set(terminals.map((session) => session.id));
  const backgroundBytes = snapshot?.terminals.reduce((total, terminal) => total + (openedIds.has(terminal.sessionId) ? 0 : terminal.totalBytes ?? 0), 0) ?? 0;
  const framework = snapshot?.framework;
  const time = snapshot ? new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(snapshot.sampledAt) : "";
  return (
    <Popover open={open} onOpenChange={(nextOpen) => { setOpen(nextOpen); if (nextOpen) refresh(); }}>
      <PopoverTrigger asChild>
        {statusBar ? <StatusBarButton icon={<AppWindow size={13} strokeWidth={1.5} />}
          reading={formatMemory(snapshot?.totalBytes)} className="ui-app-memory-status"
          aria-label={t("resources.applicationMemory")} title={`${t("resources.applicationMemory")} · ${formatMemory(snapshot?.totalBytes)}`}
          data-stale={error ? "true" : undefined} /> :
        <button type="button" className={`ui-memory-trigger ui-focus-ring${collapsed ? " ui-memory-trigger-collapsed" : ""}`} aria-label={t("resources.applicationMemory")} title={`${t("resources.applicationMemory")} · ${formatMemory(snapshot?.totalBytes)}`} data-stale={error ? "true" : undefined}>
          <AppWindow size={15} strokeWidth={1.5} aria-hidden="true" />
          {!collapsed && <><span className="ui-memory-value">{formatMemory(snapshot?.totalBytes)}</span><ChevronRight size={10} aria-hidden="true" /></>}
        </button>}
      </PopoverTrigger>
      <ResourceDetailPopover resource="application" title={t("resources.applicationMemory")} icon={<AppWindow size={13} />}
        value={formatMemory(snapshot?.totalBytes)} scope={t("resources.applicationTotal")} time={time}
        refreshLabel={t("memory.refresh")} onRefresh={refresh} side={collapsed ? "right" : "top"}>
        <div className="ui-resource-application-content">
        <div className="ui-memory-content">
          {!snapshot && <p className="ui-memory-note">{t(error ? "memory.unavailable" : "memory.loading")}</p>}
          {framework && (
            <details className="ui-memory-group">
              <summary><ChevronRight size={12} className="ui-memory-chevron" /><Cpu size={14} /><span className="ui-memory-name">{t("memory.framework")}</span><span className="ui-memory-value">{formatMemory(framework.totalBytes)}</span></summary>
              <div className="ui-memory-children">
                {([["memory.app", framework.appBytes], ["memory.webview", framework.webviewBytes], ["memory.daemon", framework.daemonBytes], ["memory.helpers", framework.helperBytes]] as const).map(([label, bytes]) => <div className="ui-memory-row" key={label}><span>{t(label)}</span><span className="ui-memory-value">{formatMemory(bytes)}</span></div>)}
              </div>
            </details>
          )}
          <div className="ui-memory-section-label">{t("memory.terminals", { count: terminals.length })}</div>
          {terminals.length === 0 && <p className="ui-memory-note">{t("memory.noTerminals")}</p>}
          {terminals.map((session) => {
            const memory = snapshot?.terminals.find((entry) => entry.sessionId === session.id);
            const localOnly = memory?.localOnly || session.environmentType === "ssh" || session.environmentType === "wsl" || session.shell?.toLowerCase().includes("wsl");
            return (
              <details key={session.id} className="ui-memory-tab ui-memory-group" data-current={session.id === activeId} open={session.id === activeId ? true : undefined}>
                <summary className="ui-memory-tab-summary"><ChevronRight size={12} className="ui-memory-chevron" /><Terminal size={14} /><span className="ui-memory-name" title={session.title}>{session.title}</span>{session.id === activeId && <span className="ui-memory-current">{t("memory.current")}</span>}<span className="ui-memory-value">{formatMemory(memory?.totalBytes)}</span></summary>
                <div className="ui-memory-terminal-details">
                  {memory?.totalBytes == null ? <p className="ui-memory-note">{t("memory.unavailable")}</p> : <>
                    <div className="ui-memory-row"><span>{t("memory.shell")}</span><span className="ui-memory-value">{formatMemory(memory.shellBytes)}</span></div>
                    {memory.agents.map((agent) => <div className="ui-memory-agent" key={agent.pid}>
                      <div className="ui-memory-row"><span className="ui-memory-name">{agent.name}</span><small>{t("memory.processes", { count: agent.processCount })}</small><span className="ui-memory-value">{formatMemory(agent.memoryBytes)}</span></div>
                      <div className="ui-memory-agent-parts">
                        <div className="ui-memory-row"><span>{t("memory.agentSelf")}</span><span className="ui-memory-value">{formatMemory(agent.selfBytes)}</span></div>
                        <div className="ui-memory-row"><span>{t("memory.agentChildren")}</span><span className="ui-memory-value">{formatMemory(agent.childBytes)}</span></div>
                      </div>
                    </div>)}
                    {memory.otherBytes > 0 && <div className="ui-memory-row"><span>{t("memory.otherChildren")}</span><span className="ui-memory-value">{formatMemory(memory.otherBytes)}</span></div>}
                    <details className="ui-memory-processes" open>
                      <summary><ChevronRight size={12} className="ui-memory-chevron" /><span>{t("memory.processDetails")}</span><small>{t("memory.processes", { count: memory.processes?.length ?? 0 })}</small></summary>
                      <div className="ui-memory-process-list">
                        {memory.processes?.map((process) => <div className="ui-memory-process" key={process.pid} title={[process.name, `PID ${process.pid}`, process.parentPid == null ? "" : `PPID ${process.parentPid}`, process.agentPid == null ? "" : t("memory.agentOwner", { pid: process.agentPid })].filter(Boolean).join("\n")}>
                          <div className="ui-memory-process-identity"><span className="ui-memory-name">{process.name}</span><small>PID {process.pid} · {t(`memory.processKind.${process.kind}`)}</small></div>
                          <span className="ui-memory-value">{formatMemory(process.memoryBytes)}</span>
                        </div>)}
                      </div>
                    </details>
                  </>}
                  {localOnly && <p className="ui-memory-note">{t("memory.remoteNote")}</p>}
                </div>
              </details>
            );
          })}
          {backgroundBytes > 0 && <div className="ui-memory-row"><span>{t("memory.background")}</span><span className="ui-memory-value">{formatMemory(backgroundBytes)}</span></div>}
          {(snapshot?.unassignedBytes ?? 0) > 0 && <div className="ui-memory-row"><span>{t("memory.unassigned")}</span><span className="ui-memory-value">{formatMemory(snapshot!.unassignedBytes)}</span></div>}
        </div>
        <div className="ui-resource-detail-notes">
          {error && <p>{t(snapshot ? "memory.stale" : "memory.unavailable")}</p>}
          {snapshot && !snapshot.daemonAvailable && <p>{t("memory.daemonUnavailable")}</p>}
          {snapshot?.terminals.some((entry) => entry.rootPid == null && entry.totalBytes == null) && <p>{t("memory.legacyDaemon")}</p>}
          <p>{t("memory.measurement")}</p>
        </div>
        </div>
      </ResourceDetailPopover>
    </Popover>
  );
}
