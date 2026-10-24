import { AppWindow, ChevronRight, Cpu, FolderGit2, Terminal } from "lucide-react";
import { type CSSProperties, type ReactNode, useMemo, useState } from "react";
import { Popover, PopoverTrigger } from "../ui/popover";
import { ResourceDetailPopover } from "../terminal/ResourceDetailPopover";
import { StatusBarButton } from "../terminal/StatusBarButton";
import { useTerminalMemory } from "../../hooks/useTerminalMemory";
import { useTerminalStore } from "../../stores/terminalStore";
import { useProjectStore } from "../../stores/projectStore";
import { groupTerminalMemory, sumMemorySamples, type MemoryTerminalRow, type TerminalMemoryEntry } from "../../lib/terminalMemoryPresentation";
import { useI18n } from "../../lib/i18n";

export function formatMemory(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} B`;
}

/** Missing observations create gaps; a single observation is not a trend. */
export function memoryTrendPath(points: Array<number | null>): string {
  const measured = points.filter((value): value is number => value != null && Number.isFinite(value) && value >= 0);
  if (measured.length < 2) return "";
  const low = Math.min(...measured);
  const high = Math.max(...measured);
  const span = Math.max(high - low, high * .08, 1);
  let connected = false;
  return points.map((value, index) => {
    if (value == null || !Number.isFinite(value) || value < 0) { connected = false; return ""; }
    const command = connected ? "L" : "M";
    connected = true;
    return `${command}${(index / Math.max(1, points.length - 1) * 64).toFixed(1)},${(18 - (value - low) / span * 14).toFixed(1)}`;
  }).join(" ");
}

function MemoryTrend({ points }: { points: Array<number | null> }) {
  const path = memoryTrendPath(points);
  return path ? <svg className="ui-memory-tree-trend" viewBox="0 0 64 22" aria-hidden="true"><path d={path} fill="none" stroke="currentColor" strokeWidth="1.2" /></svg> : null;
}

function MemoryCells({ name, bytes, icon, expandable = false, meta, trend, title }: {
  name: string; bytes: number | null | undefined; icon?: ReactNode; expandable?: boolean;
  meta?: ReactNode; trend?: Array<number | null>; title?: string;
}) {
  const { t } = useI18n();
  return <>
    <span className="ui-memory-tree-identity" title={title ?? name}>
      {expandable ? <ChevronRight size={11} className="ui-memory-tree-chevron" /> : <span className="ui-memory-tree-spacer" />}
      {icon && <span className="ui-memory-tree-icon">{icon}</span>}
      <span className="ui-memory-tree-label"><span>{name}</span>{meta && <small>{meta}</small>}</span>
      {trend && <MemoryTrend points={trend} />}
    </span>
    <span className="ui-memory-tree-cpu" title={t("memory.cpuUnavailable")}>—</span>
    <span className="ui-memory-tree-rss">{formatMemory(bytes)}</span>
  </>;
}

function MemoryProcess({ process, depth }: { process: TerminalMemoryEntry["processes"][number]; depth: number }) {
  const { t } = useI18n();
  const meta = `PID ${process.pid} · ${t(`memory.processKind.${process.kind}`)}`;
  return <div className="ui-memory-tree-row ui-memory-tree-process" style={{ "--memory-depth": depth } as CSSProperties}>
    <MemoryCells name={process.name} bytes={process.memoryBytes} meta={meta}
      title={[process.name, meta, process.parentPid == null ? "" : `PPID ${process.parentPid}`, process.agentPid == null ? "" : t("memory.agentOwner", { pid: process.agentPid })].filter(Boolean).join("\n")} />
  </div>;
}

function TerminalMemoryRow({ row, current }: { row: MemoryTerminalRow; current: boolean }) {
  const { t } = useI18n();
  const memory = row.memory;
  const session = row.session;
  const processes = memory?.processes ?? [];
  const agents = memory?.agents ?? [];
  const agentIds = new Set(agents.map(agent => agent.pid));
  const shellProcesses = processes.filter(process => process.kind === "shell");
  const otherProcesses = processes.filter(process => process.kind !== "shell" && !agentIds.has(process.pid) && (process.agentPid == null || !agentIds.has(process.agentPid)));
  const localOnly = memory?.localOnly || session?.environmentType === "ssh" || session?.environmentType === "wsl" || session?.shell?.toLowerCase().includes("wsl");
  return <details className="ui-memory-tree-group ui-memory-tree-terminal" data-current={current || undefined} open={current ? true : undefined}>
    <summary className="ui-memory-tree-row" style={{ "--memory-depth": 1 } as CSSProperties}>
      <MemoryCells name={session?.title ?? row.id} bytes={memory?.totalBytes} icon={<Terminal size={13} />} expandable
        meta={current ? t("memory.current") : undefined} />
    </summary>
    {memory?.totalBytes == null ? <p className="ui-memory-tree-note">{t("memory.unavailable")}</p> : <>
      <details className="ui-memory-tree-group">
        <summary className="ui-memory-tree-row" style={{ "--memory-depth": 2 } as CSSProperties}>
          <MemoryCells name={t("memory.shell")} bytes={memory.shellBytes} expandable />
        </summary>
        {shellProcesses.map(process => <MemoryProcess key={process.pid} process={process} depth={3} />)}
      </details>
      {agents.map(agent => <details className="ui-memory-tree-group" key={agent.pid}>
        <summary className="ui-memory-tree-row" style={{ "--memory-depth": 2 } as CSSProperties}>
          <MemoryCells name={agent.name} bytes={agent.memoryBytes} expandable meta={t("memory.processes", { count: agent.processCount })}
            title={`${agent.name} · PID ${agent.pid}\n${t("memory.agentSelf")}: ${formatMemory(agent.selfBytes)}\n${t("memory.agentChildren")}: ${formatMemory(agent.childBytes)}`} />
        </summary>
        <div className="ui-memory-tree-agent-parts">
          <span>{t("memory.agentSelf")} · {formatMemory(agent.selfBytes)}</span><span>{t("memory.agentChildren")} · {formatMemory(agent.childBytes)}</span>
        </div>
        {processes.filter(process => process.pid === agent.pid || process.agentPid === agent.pid).map(process => <MemoryProcess key={process.pid} process={process} depth={3} />)}
      </details>)}
      {(memory.otherBytes > 0 || otherProcesses.length > 0) && <details className="ui-memory-tree-group">
        <summary className="ui-memory-tree-row" style={{ "--memory-depth": 2 } as CSSProperties}>
          <MemoryCells name={t("memory.otherChildren")} bytes={memory.otherBytes} expandable />
        </summary>
        {otherProcesses.map(process => <MemoryProcess key={process.pid} process={process} depth={3} />)}
      </details>}
    </>}
    {localOnly && <p className="ui-memory-tree-note">{t("memory.remoteNote")}</p>}
  </details>;
}

export function MemoryUsage({ collapsed, statusBar = false }: { collapsed: boolean; statusBar?: boolean }) {
  const { t, language } = useI18n();
  const [open, setOpen] = useState(false);
  const { snapshot, history, error, refresh } = useTerminalMemory();
  const sessions = useTerminalStore(state => state.sessions);
  const activeId = useTerminalStore(state => state.activeSessionId);
  const projects = useProjectStore(state => state.projects);
  const worktrees = useProjectStore(state => state.worktrees);
  const groups = useMemo(() => groupTerminalMemory(sessions, projects, worktrees, snapshot), [sessions, projects, worktrees, snapshot]);
  const framework = snapshot?.framework;
  const workspaceCount = groups.filter(group => group.kind === "workspace").length;
  const time = snapshot ? new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(snapshot.sampledAt) : "";
  return (
    <Popover open={open} onOpenChange={nextOpen => { setOpen(nextOpen); if (nextOpen) refresh(); }}>
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
      <ResourceDetailPopover resource="application" title={t("resources.resourceManager")} icon={<AppWindow size={13} />}
        summary={<><span className="ui-resource-detail-value">{formatMemory(snapshot?.totalBytes)} <small>Σ {t("resources.rssColumn")}</small></span><span className="ui-resource-summary-cpu" title={t("memory.cpuUnavailable")}>{t("resources.cpuColumn")} —</span><span className="ui-resource-detail-summary-scope">{t("memory.workspaceCount", { count: workspaceCount })}</span></>}
        scope={t("resources.applicationTotal")} time={time}
        refreshLabel={t("memory.refresh")} onRefresh={refresh} side={collapsed ? "right" : "top"}>
        <div className="ui-resource-application-content">
          <div className="ui-memory-tree" aria-label={t("resources.resourceManager")}>
            <div className="ui-memory-tree-columns"><span>{t("resources.nameColumn")}</span><span>{t("resources.cpuColumn")}</span><span>{t("resources.rssColumn")}</span></div>
            {!snapshot && <p className="ui-memory-note">{t(error ? "memory.unavailable" : "memory.loading")}</p>}
            {groups.map(group => {
              const name = group.kind === "retained" ? t("memory.retainedWorkspace") : group.kind === "ungrouped" ? t("memory.ungrouped") : `${group.project!.name} / ${group.worktree?.name ?? t("workspace.primaryName")}`;
              return <details key={group.id} className="ui-memory-tree-group ui-memory-tree-workspace" open>
                <summary className="ui-memory-tree-row">
                  <MemoryCells name={name} bytes={group.totalBytes} icon={<FolderGit2 size={14} />} expandable
                    title={group.worktree?.path || group.project?.remote_path || group.project?.path || name}
                    trend={history.map(point => sumMemorySamples(group.terminals.map(row => point.terminals[row.id])))} />
                </summary>
                {group.terminals.map(row => <TerminalMemoryRow key={row.id} row={row} current={row.id === activeId} />)}
              </details>;
            })}
            {groups.length === 0 && <p className="ui-memory-note">{t("memory.noTerminals")}</p>}
            {framework && <details className="ui-memory-tree-group ui-memory-tree-framework">
              <summary className="ui-memory-tree-row"><MemoryCells name={t("memory.framework")} bytes={framework.totalBytes} icon={<Cpu size={14} />} expandable trend={history.map(point => point.frameworkBytes)} /></summary>
              {([["memory.app", framework.appBytes], ["memory.webview", framework.webviewBytes], ["memory.daemon", framework.daemonBytes], ["memory.helpers", framework.helperBytes]] as const).map(([label, bytes]) => <div className="ui-memory-tree-row" style={{ "--memory-depth": 1 } as CSSProperties} key={label}><MemoryCells name={t(label)} bytes={bytes} /></div>)}
            </details>}
            {(snapshot?.unassignedBytes ?? 0) > 0 && <div className="ui-memory-tree-row"><MemoryCells name={t("memory.unassigned")} bytes={snapshot!.unassignedBytes} /></div>}
          </div>
          <div className="ui-resource-detail-notes">
            {error && <p>{t(snapshot ? "memory.stale" : "memory.unavailable")}</p>}
            {snapshot && !snapshot.daemonAvailable && <p>{t("memory.daemonUnavailable")}</p>}
            {snapshot?.terminals.some(entry => entry.rootPid == null && entry.totalBytes == null) && <p>{t("memory.legacyDaemon")}</p>}
            <p>{t("memory.cpuUnavailable")}</p>
            <p>{t("memory.measurement")}</p>
          </div>
        </div>
      </ResourceDetailPopover>
    </Popover>
  );
}
