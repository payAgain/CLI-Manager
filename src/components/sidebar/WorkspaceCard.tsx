import { CliToolIcon } from "../CliToolIcon";
import { CLI_TOOL_DESCRIPTORS, resolveCliToolIconKey } from "../../lib/cliTools";
import type { MouseEvent } from "react";
import { AlertTriangle, GitBranch, MoreHorizontal, Play, Terminal } from "../icons";
import { useTerminalStore } from "../../stores/terminalStore";
import type { Project, TerminalSession, WorktreeRecord } from "../../lib/types";
import { useI18n } from "../../lib/i18n";
import { projectTerminalLaunchLabel } from "../../lib/projectStartupCommand";
import { workspaceDisplayStatus, workspaceTerminalStatus } from "../../lib/workspaceStatus";

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

export function WorkspaceCard({ project, worktree, terminals, name, branch, selected, primary, compact, invalid, onSelect, onOpen, onContextMenu }: WorkspaceCardProps) {
  const { t } = useI18n();
  const statuses = useTerminalStore(state => state.sessionStatuses);
  const notifications = useTerminalStore(state => state.tabNotifications);
  const activeId = useTerminalStore(state => state.activeSessionId);
  const status = workspaceDisplayStatus(terminals, statuses, notifications, invalid);
  const statusLabel = t(`workspace.status.${status}`);
  const launchAction = projectTerminalLaunchLabel(project);
  const launchLabel = t(launchAction);
  const branchValue = branch.trim();
  const workspacePath = worktree?.path || (project.environment_type === "ssh" ? project.remote_path : project.path);
  const workspaceHint = [name, t("workspace.directory", { path: workspacePath })].join("\n");
  const showBranch = Boolean(branchValue) && branchValue !== name.trim() && !/^(?:[a-z]:[\\/]|[\\/]|~[\\/])/i.test(branchValue);
  const showTerminals = terminals.length > 0;
  const hasActiveTerminal = terminals.some(session => session.id === activeId);
  return <div className="ui-workspace-card ui-focus-ring" data-selected={selected} data-status={status}
    data-compact={compact} data-invalid={invalid} data-node-kind={primary ? "project" : "worktree"}
    data-terminals-expanded={showTerminals} data-active-terminal={hasActiveTerminal}
    onClick={onSelect} onDoubleClick={onOpen} onContextMenu={onContextMenu}>
    <div className="ui-workspace-card-title">
      <span className="ui-workspace-process-dot" title={statusLabel} role="img" aria-label={statusLabel} />
      <span className="ui-workspace-card-name" title={workspaceHint}>{name}</span>
      {primary && <span className="ui-workspace-primary-badge">{t("workspace.primary")}</span>}
      {project.environment_type !== "local" && <span className="ui-workspace-environment">{project.environment_type.toUpperCase()}</span>}
      {invalid && <AlertTriangle size={12} className="text-warning" aria-label={t("sidebar.tree.pathMissing")} />}
      <span className="ui-workspace-card-actions" onKeyDown={event => { if (event.key === "Enter" || event.key === " ") event.stopPropagation(); }}>
        <button type="button" className="ui-sidebar-tool ui-focus-ring" title={launchLabel} aria-label={launchLabel}
          onClick={event => { event.stopPropagation(); onOpen(); }}>{launchAction === "sidebar.menu.newBlankTerminal" ? <Terminal size={12} /> : <Play size={12} />}</button>
        <button type="button" className="ui-sidebar-tool ui-focus-ring" title={t("workspace.actions")} aria-label={t("workspace.actions")}
          onClick={event => { event.stopPropagation(); onContextMenu(event); }}><MoreHorizontal size={13} /></button>
      </span>
    </div>
    <div className="ui-workspace-card-meta">
      <span className="ui-workspace-card-branch" title={showBranch ? branchValue : workspacePath}>
        {showBranch && <><GitBranch size={11} aria-hidden="true" /><span>{branchValue}</span></>}
        {!showBranch && <span>{t("workspace.terminalCount", { count: terminals.length })}</span>}
      </span>
    </div>
    {showTerminals && <div className="ui-workspace-sessions" role="group" aria-label={t("workspace.terminalCount", { count: terminals.length })}>
      {terminals.map(session => {
        const agent = session.runtimeAgent?.tool;
        const icon = resolveCliToolIconKey(agent);
        const agentName = agent === "pi" ? "Pi" : CLI_TOOL_DESCRIPTORS.find(tool => tool.id === agent)?.label ?? agent;
        const title = session.title.trim() || t("workspace.unnamedTerminal");
        const terminalStatus = workspaceTerminalStatus(session, statuses[session.id], notifications[session.id]);
        const terminalStatusLabel = t(`workspace.status.${terminalStatus}`);
        const hint = [agentName ? `${title} · ${agentName}` : title, terminalStatusLabel,
          t("workspace.terminalOwner", { name }),
          t("workspace.terminalDirectory", { path: session.cwd || session.remotePath || workspacePath })].join("\n");
        return <button key={session.id} type="button" className="ui-workspace-session ui-focus-ring"
          data-active={session.id === activeId} data-status={terminalStatus} aria-current={session.id === activeId ? "true" : undefined}
          title={hint} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") event.stopPropagation(); }}
          onDoubleClick={event => event.stopPropagation()}
          onClick={event => { event.stopPropagation(); onSelect(event); useTerminalStore.getState().setActive(session.id); }}>
          <span className="ui-workspace-session-state" title={terminalStatusLabel} role="img" aria-label={terminalStatusLabel} />
          <span className="ui-workspace-session-agent" title={agentName || undefined} aria-hidden="true">
            {icon ? <CliToolIcon icon={icon} size={14} /> : <Terminal size={14} strokeWidth={1.5} />}
          </span>
          <span className="ui-workspace-session-title">{title}</span>
        </button>;
      })}
    </div>}
  </div>;
}
