import { ChevronRight, Cpu, MemoryStick, RefreshCw, Terminal, X } from "lucide-react";
import { Close as PopoverClose } from "@radix-ui/react-popover";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { useTerminalMemory } from "../../hooks/useTerminalMemory";
import { useTerminalStore } from "../../stores/terminalStore";
import { useI18n } from "../../lib/i18n";

export function formatMemory(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} B`;
}

export function MemoryUsage({ collapsed }: { collapsed: boolean }) {
  const { t, language } = useI18n();
  const { snapshot, error, refresh } = useTerminalMemory();
  const sessions = useTerminalStore((state) => state.sessions);
  const activeId = useTerminalStore((state) => state.activeSessionId);
  const terminals = sessions.filter((session) => !session.kind || session.kind === "pty");
  const openedIds = new Set(terminals.map((session) => session.id));
  const backgroundBytes = snapshot?.terminals.reduce((total, terminal) => total + (openedIds.has(terminal.sessionId) ? 0 : terminal.totalBytes ?? 0), 0) ?? 0;
  const framework = snapshot?.framework;
  const time = snapshot ? new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(snapshot.sampledAt) : "";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={`ui-memory-trigger ui-focus-ring${collapsed ? " ui-memory-trigger-collapsed" : ""}`} aria-label={t("memory.title")} title={`${t("memory.title")} · ${formatMemory(snapshot?.totalBytes)}`} data-stale={error ? "true" : undefined}>
          <MemoryStick size={15} strokeWidth={1.5} aria-hidden="true" />
          {!collapsed && <><span>{t("memory.short")}</span><span className="ui-memory-value">{formatMemory(snapshot?.totalBytes)}</span></>}
        </button>
      </PopoverTrigger>
      <PopoverContent side={collapsed ? "right" : "top"} align="start" className="ui-memory-popover" data-memory-popover="true" aria-label={t("memory.title")}>
        <header className="ui-memory-heading">
          <div><h2>{t("memory.title")}</h2><span>{t("memory.localTotal")} · {formatMemory(snapshot?.totalBytes)}</span></div>
          <button type="button" className="ui-flat-action ui-focus-ring ui-history-icon-button" onClick={refresh} aria-label={t("memory.refresh")} title={t("memory.refresh")}><RefreshCw size={13} /></button>
          <PopoverClose asChild><button type="button" className="ui-flat-action ui-focus-ring ui-history-icon-button" aria-label={t("common.close")} title={t("common.close")}><X size={14} /></button></PopoverClose>
        </header>
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
              <details key={session.id} className="ui-memory-group" open={session.id === activeId}>
                <summary><ChevronRight size={12} className="ui-memory-chevron" /><Terminal size={14} /><span className="ui-memory-name" title={session.title}>{session.title}</span>{session.id === activeId && <span className="ui-memory-current">{t("memory.current")}</span>}<span className="ui-memory-value">{formatMemory(memory?.totalBytes)}</span></summary>
                <div className="ui-memory-children">
                  {memory?.totalBytes != null ? <>
                    <div className="ui-memory-row"><span>{t("memory.shell")}</span><span className="ui-memory-value">{formatMemory(memory.shellBytes)}</span></div>
                    {memory.agents.map((agent) => <div className="ui-memory-row" key={agent.pid} title={`PID ${agent.pid}`}><span>{agent.name} <small>{t("memory.processes", { count: agent.processCount })}</small></span><span className="ui-memory-value">{formatMemory(agent.memoryBytes)}</span></div>)}
                    {memory.otherBytes > 0 && <div className="ui-memory-row"><span>{t("memory.otherChildren")}</span><span className="ui-memory-value">{formatMemory(memory.otherBytes)}</span></div>}
                    {memory.agents.length === 0 && !localOnly && <p className="ui-memory-note">{t("memory.noAgents")}</p>}
                  </> : <p className="ui-memory-note">{t("memory.unavailable")}</p>}
                  {localOnly && <p className="ui-memory-note">{t("memory.remoteNote")}</p>}
                </div>
              </details>
            );
          })}
          {backgroundBytes > 0 && <div className="ui-memory-row"><span>{t("memory.background")}</span><span className="ui-memory-value">{formatMemory(backgroundBytes)}</span></div>}
          {(snapshot?.unassignedBytes ?? 0) > 0 && <div className="ui-memory-row"><span>{t("memory.unassigned")}</span><span className="ui-memory-value">{formatMemory(snapshot!.unassignedBytes)}</span></div>}
        </div>
        <footer className="ui-memory-footer">
          {error && <p>{t(snapshot ? "memory.stale" : "memory.unavailable")}</p>}
          {snapshot && !snapshot.daemonAvailable && <p>{t("memory.daemonUnavailable")}</p>}
          {snapshot?.terminals.some((entry) => entry.rootPid == null && entry.totalBytes == null) && <p>{t("memory.legacyDaemon")}</p>}
          <p>{t("memory.measurement")}</p>
          {snapshot && <p>{t("memory.updated", { time })}</p>}
        </footer>
      </PopoverContent>
    </Popover>
  );
}
