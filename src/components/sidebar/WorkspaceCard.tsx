import { CliToolIcon } from "../CliToolIcon";
import { CLI_TOOL_DESCRIPTORS, resolveCliToolIconKey } from "../../lib/cliTools";
import type { MouseEvent } from "react";
import { AlertTriangle, MoreHorizontal, Play, Terminal } from "../icons";
import { useTerminalStore } from "../../stores/terminalStore";
import type { Project, TerminalSession, WorktreeRecord } from "../../lib/types";
import { useI18n } from "../../lib/i18n";
import { projectTerminalLaunchLabel } from "../../lib/projectStartupCommand";

interface WorkspaceCardProps {
  project: Project;
  worktree?: WorktreeRecord;
  terminals: TerminalSession[];
  name: string;
  branch: string;
  selected: boolean;
  primary?: boolean;
  compact: boolean;
  invalid: boolean;
  onSelect: (e: MouseEvent) => void;
  onOpen: () => void;
  onContextMenu: (e: MouseEvent) => void;
}

export function WorkspaceCard({ project, terminals, name, branch, selected, primary, compact, invalid, onSelect, onOpen, onContextMenu }: WorkspaceCardProps) {
  const { t } = useI18n();
  const statuses = useTerminalStore((s) => s.sessionStatuses);
  const notifications = useTerminalStore((s) => s.tabNotifications);
  const activeId = useTerminalStore((s) => s.activeSessionId);
  const setActive = useTerminalStore((s) => s.setActive);
  const running = terminals.some((s) => statuses[s.id] === "running");
  const error = terminals.some((s) => statuses[s.id] === "error");
  const status = error ? "error" : running ? "running" : "idle";
  const launchAction = projectTerminalLaunchLabel(project);
  const launchLabel = t(launchAction);
  return (
    <div className="ui-workspace-card ui-focus-ring" data-selected={selected} data-status={status}
      data-compact={compact} data-invalid={invalid} data-node-kind={primary ? "project" : "worktree"}
      onClick={onSelect} onDoubleClick={onOpen} onContextMenu={onContextMenu}>
      <div className="ui-workspace-card-title">
        <span className="ui-workspace-process-dot" title={t(`workspace.${status}`)} />
        <span className="ui-workspace-card-name" title={name}>{name}</span>
        {primary && <span className="ui-workspace-primary-badge">{t("workspace.primary")}</span>}
        {project.environment_type !== "local" && <span className="ui-workspace-environment">{project.environment_type.toUpperCase()}</span>}
        {invalid && <AlertTriangle size={12} className="text-warning" aria-label={t("sidebar.tree.pathMissing")} />}
        <span className="ui-workspace-card-actions">
          <button className="ui-sidebar-tool ui-focus-ring" title={launchLabel} aria-label={launchLabel}
            onClick={(e) => { e.stopPropagation(); onOpen(); }}>{launchAction === "sidebar.menu.newBlankTerminal" ? <Terminal size={12} /> : <Play size={12} />}</button>
          <button className="ui-sidebar-tool ui-focus-ring" aria-label={t("workspace.actions")} title={t("workspace.actions")}
            onClick={(e) => { e.stopPropagation(); onContextMenu(e); }}><MoreHorizontal size={13} /></button>
        </span>
      </div>
      {!compact && <div className="ui-workspace-card-meta" title={branch}>{branch}</div>}
      {terminals.length > 0 && <div className="ui-workspace-sessions">
        <div className="ui-workspace-sessions-heading"><Terminal size={11} aria-hidden="true" />{t("workspace.terminalCount", { count: terminals.length })}</div>
        {selected && !compact && terminals.map((session) => {
          const agent = session.runtimeAgent?.tool;
          const icon = resolveCliToolIconKey(agent);
          const agentName = agent === "pi" ? "Pi" : CLI_TOOL_DESCRIPTORS.find(tool => tool.id === agent)?.label ?? agent;
          const title = session.title.trim() || t("workspace.unnamedTerminal");
          return <button key={session.id} type="button" className="ui-workspace-session ui-focus-ring"
          data-active={session.id === activeId} data-notification={notifications[session.id] ?? "none"}
          aria-current={session.id === activeId ? "true" : undefined}
          onDoubleClick={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onSelect(e); setActive(session.id); }} title={agentName ? `${title} · ${agentName}` : title}>
          <span className="ui-workspace-session-title">{title}</span>
          {agentName && <span className="ui-workspace-session-agent" title={agentName}>
            {icon && <CliToolIcon icon={icon} size={11} />}<span>{agentName}</span>
          </span>}
          {notifications[session.id] && notifications[session.id] !== "none" && <span className="ui-workspace-session-state" />}
        </button>;
        })}
      </div>}
    </div>
  );
}
