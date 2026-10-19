import type { MouseEvent } from "react";
import { AlertTriangle, MoreHorizontal, Play, Terminal } from "../icons";
import { useTerminalStore } from "../../stores/terminalStore";
import type { Project, WorktreeRecord } from "../../lib/types";
import { useI18n } from "../../lib/i18n";

interface WorkspaceCardProps {
  project: Project;
  worktree?: WorktreeRecord;
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

export function WorkspaceCard({ project, worktree, name, branch, selected, primary, compact, invalid, onSelect, onOpen, onContextMenu }: WorkspaceCardProps) {
  const { t } = useI18n();
  const sessions = useTerminalStore((s) => s.sessions);
  const statuses = useTerminalStore((s) => s.sessionStatuses);
  const notifications = useTerminalStore((s) => s.tabNotifications);
  const activeId = useTerminalStore((s) => s.activeSessionId);
  const setActive = useTerminalStore((s) => s.setActive);
  const terminals = sessions.filter((s) => s.projectId === project.id && (s.worktreeId ?? null) === (worktree?.id ?? null) && (s.kind ?? "pty") === "pty");
  const running = terminals.some((s) => statuses[s.id] === "running");
  const error = terminals.some((s) => statuses[s.id] === "error");
  const status = error ? "error" : running ? "running" : "idle";
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
          <button className="ui-sidebar-tool ui-focus-ring" title={t("sidebar.tree.openTerminal")} aria-label={t("sidebar.tree.openTerminal")}
            onClick={(e) => { e.stopPropagation(); onOpen(); }}><Play size={12} /></button>
          <button className="ui-sidebar-tool ui-focus-ring" aria-label={t("workspace.actions")} title={t("workspace.actions")}
            onClick={(e) => { e.stopPropagation(); onContextMenu(e); }}><MoreHorizontal size={13} /></button>
        </span>
      </div>
      {!compact && <div className="ui-workspace-card-meta" title={branch}>{branch}</div>}
      {selected && terminals.length > 0 && <div className="ui-workspace-sessions">
        {terminals.map((session) => <button key={session.id} type="button" className="ui-workspace-session ui-focus-ring"
          data-active={session.id === activeId} data-notification={notifications[session.id] ?? "none"}
          onDoubleClick={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onSelect(e); setActive(session.id); }} title={session.title}>
          <Terminal size={11} /><span>{session.title}</span>
          {notifications[session.id] && notifications[session.id] !== "none" && <span className="ui-workspace-session-state" />}
        </button>)}
      </div>}
    </div>
  );
}
