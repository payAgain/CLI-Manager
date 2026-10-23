import { CliToolIcon } from "../CliToolIcon";
import { CLI_TOOL_DESCRIPTORS, resolveCliToolIconKey } from "../../lib/cliTools";
import type { MouseEvent } from "react";
import { AlertTriangle, GitBranch, MoreHorizontal, Play, Terminal } from "../icons";
import { WorktreeIcon } from "../WorktreeIcon";
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

export function WorkspaceCard({ project, worktree, terminals, name, branch, selected, primary, compact, invalid, onSelect, onOpen, onContextMenu }: WorkspaceCardProps) {
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
  const branchValue = branch.trim();
  const workspacePath = worktree?.path || (project.environment_type === "ssh" ? project.remote_path : project.path);
  const workspaceHint = [name, branchValue && branchValue !== name.trim() ? branchValue : "",
    t("workspace.directory", { path: workspacePath })].filter(Boolean).join("\n");
  const metadataIsPath = /^(?:[a-z]:[\\/]|[\\/]|~[\\/])/i.test(branchValue);
  const showMetadata = !compact && Boolean(branchValue) && branchValue !== name.trim() && !metadataIsPath;
  const showPrimaryBadge = primary && name.trim() !== t("workspace.primaryName");
  const showTerminals = selected && !compact && terminals.length > 0;
  const hasActiveTerminal = terminals.some((session) => session.id === activeId);
  return (
    <div className="ui-workspace-card ui-focus-ring" data-selected={selected} data-status={status}
      data-compact={compact} data-invalid={invalid} data-has-meta={showMetadata} data-node-kind={primary ? "project" : "worktree"}
      data-terminals-expanded={showTerminals} data-active-terminal={hasActiveTerminal}
      onClick={onSelect} onDoubleClick={onOpen} onContextMenu={onContextMenu}>
      <div className="ui-workspace-card-title">
        <span className="ui-workspace-kind-icon" aria-hidden="true">{primary ? <GitBranch size={13} strokeWidth={1.6} /> : <WorktreeIcon className="h-3.5 w-3.5" />}</span>
        <span className="ui-workspace-card-identity" title={workspaceHint}>
          <span className="ui-workspace-card-name">{name}</span>
          {showMetadata && <span className="ui-workspace-card-branch">{branch}</span>}
        </span>
        {showPrimaryBadge && <span className="ui-workspace-primary-badge">{t("workspace.primary")}</span>}
        {project.environment_type !== "local" && <span className="ui-workspace-environment">{project.environment_type.toUpperCase()}</span>}
        {!showTerminals && terminals.length > 0 && <span className="ui-workspace-terminal-overview" title={t("workspace.terminalCount", { count: terminals.length })} aria-label={t("workspace.terminalCount", { count: terminals.length })}>
          <Terminal size={11} aria-hidden="true" /><span>{terminals.length}</span>
        </span>}
        <span className="ui-workspace-process-dot" title={t(`workspace.${status}`)} aria-label={t(`workspace.${status}`)} />
        {invalid && <AlertTriangle size={12} className="text-warning" aria-label={t("sidebar.tree.pathMissing")} />}
        <span className="ui-workspace-card-actions" onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") e.stopPropagation(); }}>
          <button className="ui-sidebar-tool ui-focus-ring" title={launchLabel} aria-label={launchLabel}
            onClick={(e) => { e.stopPropagation(); onOpen(); }}>{launchAction === "sidebar.menu.newBlankTerminal" ? <Terminal size={12} /> : <Play size={12} />}</button>
          <button className="ui-sidebar-tool ui-focus-ring" aria-label={t("workspace.actions")} title={t("workspace.actions")}
            onClick={(e) => { e.stopPropagation(); onContextMenu(e); }}><MoreHorizontal size={13} /></button>
        </span>
      </div>
      {showTerminals && <div className="ui-workspace-sessions" role="group" aria-label={t("workspace.terminalCount", { count: terminals.length })}>
        {terminals.map((session) => {
          const agent = session.runtimeAgent?.tool;
          const icon = resolveCliToolIconKey(agent);
          const agentName = agent === "pi" ? "Pi" : CLI_TOOL_DESCRIPTORS.find(tool => tool.id === agent)?.label ?? agent;
          const title = session.title.trim() || t("workspace.unnamedTerminal");
          const terminalHint = [agentName ? `${title} · ${agentName}` : title,
            t("workspace.terminalOwner", { name }), t("workspace.directory", { path: workspacePath }),
            session.cwd || session.remotePath ? t("workspace.terminalDirectory", { path: session.cwd || session.remotePath || "" }) : "",
            t("workspace.terminalBindingHint")].filter(Boolean).join("\n");
          return <button key={session.id} type="button" className="ui-workspace-session ui-focus-ring"
          data-active={session.id === activeId} data-notification={notifications[session.id] ?? "none"}
          aria-current={session.id === activeId ? "true" : undefined}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") e.stopPropagation(); }}
          onDoubleClick={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onSelect(e); setActive(session.id); }} title={terminalHint}>
          <span className="ui-workspace-session-agent" title={agentName || undefined} aria-hidden="true">
            {icon ? <CliToolIcon icon={icon} size={14} /> : <Terminal size={14} strokeWidth={1.5} />}
          </span>
          <span className="ui-workspace-session-title">{title}</span>
          {notifications[session.id] && notifications[session.id] !== "none" && <span className="ui-workspace-session-state" />}
        </button>;
        })}
      </div>}
    </div>
  );
}
