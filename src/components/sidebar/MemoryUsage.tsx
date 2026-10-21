import { ChevronRight, Cpu, MemoryStick, RefreshCw, Terminal, X } from "lucide-react";
import { Close as PopoverClose } from "@radix-ui/react-popover";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { useTerminalMemory } from "../../hooks/useTerminalMemory";
import { useTerminalStore } from "../../stores/terminalStore";
import { useI18n } from "../../lib/i18n";
import { lazy, Suspense, useId, useRef, useState } from "react";

const SystemResourcesPanel = lazy(() => import("../terminal/SystemResourcesPanel").then((module) => ({ default: module.SystemResourcesPanel })));

export function formatMemory(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} B`;
}

export function MemoryUsage({ collapsed }: { collapsed: boolean }) {
  const { t, language } = useI18n();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"application" | "system">("application");
  const panelId = useId();
  const applicationTab = useRef<HTMLButtonElement>(null);
  const systemTab = useRef<HTMLButtonElement>(null);
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
        <button type="button" className={`ui-memory-trigger ui-focus-ring${collapsed ? " ui-memory-trigger-collapsed" : ""}`} aria-label={t("resources.title")} title={`${t("resources.title")} · ${formatMemory(snapshot?.totalBytes)}`} data-stale={error ? "true" : undefined}>
          <MemoryStick size={15} strokeWidth={1.5} aria-hidden="true" />
          {!collapsed && <span className="ui-memory-value">{formatMemory(snapshot?.totalBytes)}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent side={collapsed ? "right" : "top"} align="end" className="ui-memory-popover" data-memory-popover="true" data-view={view} aria-label={t("resources.title")}>
        <header className="ui-memory-heading">
          <div><h2>{t("resources.title")}</h2><span>{t("resources.applicationTotal")} · {formatMemory(snapshot?.totalBytes)}</span></div>
          {view === "application" && <button type="button" className="ui-flat-action ui-focus-ring ui-history-icon-button" onClick={refresh} aria-label={t("memory.refresh")} title={t("memory.refresh")}><RefreshCw size={13} /></button>}
          <PopoverClose asChild><button type="button" className="ui-flat-action ui-focus-ring ui-history-icon-button" aria-label={t("common.close")} title={t("common.close")}><X size={14} /></button></PopoverClose>
        </header>
        <div className="ui-resource-tabs" role="tablist" aria-label={t("resources.title")} onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === "Home" ? "application" : event.key === "End" ? "system" : view === "application" ? "system" : "application";
          setView(next);
          (next === "application" ? applicationTab : systemTab).current?.focus();
        }}>
          <button ref={applicationTab} type="button" role="tab" id={`${panelId}-application-tab`} aria-controls={`${panelId}-application`} aria-selected={view === "application"} tabIndex={view === "application" ? 0 : -1} className="ui-focus-ring" onClick={() => setView("application")}>{t("resources.application")}</button>
          <button ref={systemTab} type="button" role="tab" id={`${panelId}-system-tab`} aria-controls={`${panelId}-system`} aria-selected={view === "system"} tabIndex={view === "system" ? 0 : -1} className="ui-focus-ring" onClick={() => setView("system")}>{t("resources.system")}</button>
        </div>
        {view === "application" ? <div role="tabpanel" id={`${panelId}-application`} aria-labelledby={`${panelId}-application-tab`} className="ui-resource-application-content">
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
              <div key={session.id} className="ui-memory-tab" data-current={session.id === activeId}>
                <div className="ui-memory-tab-summary"><Terminal size={14} /><span className="ui-memory-name" title={session.title}>{session.title}</span>{session.id === activeId && <span className="ui-memory-current">{t("memory.current")}</span>}<span className="ui-memory-value">{formatMemory(memory?.totalBytes)}</span></div>
                {memory?.totalBytes == null && <p className="ui-memory-note">{t("memory.unavailable")}</p>}
                {localOnly && <p className="ui-memory-note">{t("memory.remoteNote")}</p>}
              </div>
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
        </div> : <div role="tabpanel" id={`${panelId}-system`} aria-labelledby={`${panelId}-system-tab`} className="ui-resource-system-content">
          <Suspense fallback={<p className="ui-memory-note">{t("common.loading")}</p>}><SystemResourcesPanel open={open} embedded dashboard /></Suspense>
        </div>}
      </PopoverContent>
    </Popover>
  );
}
