import { GitBranch, Monitor, Terminal } from "lucide-react";
import { useTerminalStore } from "../stores/terminalStore";
import { useProjectStore } from "../stores/projectStore";
import { useWorktreeStore } from "../stores/worktreeStore";
import type { TerminalScope } from "../lib/types";
import { useI18n } from "../lib/i18n";
import { useProjectBranch } from "../hooks/useProjectBranch";
import { BottomResourceDock } from "./terminal/BottomResourceDock";

export function WorkspaceStatusBar({ terminalScope }: { terminalScope?: TerminalScope }) {
  const { t } = useI18n();
  const sessions = useTerminalStore((s) => s.sessions);
  const activeId = useTerminalStore((s) => s.activeSessionId);
  const projects = useProjectStore((s) => s.projects);
  const worktrees = useWorktreeStore((s) => s.worktrees);
  const active = sessions.find((s) => s.id === activeId);
  const scoped = terminalScope?.kind === "project" || terminalScope?.kind === "worktree";
  const project = projects.find((p) => p.id === (scoped ? terminalScope.projectId : active?.projectId)) ?? null;
  const worktreeId = terminalScope?.kind === "worktree" ? terminalScope.worktreeId : scoped ? null : active?.worktreeId;
  const worktreeBranch = worktrees.find((w) => w.id === worktreeId)?.branch;
  const primaryBranch = useProjectBranch(worktreeId ? null : project);
  const branch = worktreeBranch || primaryBranch;
  const count = sessions.filter((s) => (s.kind ?? "pty") === "pty").length;
  const environment = project?.environment_type ?? active?.environmentType ?? "local";
  return (
    <footer className="ui-workspace-statusbar" data-status-layout="aligned" aria-label={t("workspace.statusBar")}>
      <span className="ui-status-project" title={active?.cwd || project?.path}><span className="ui-status-ready-dot" />{project?.name ?? t("workspace.ready")}</span>
      {branch && <span className="ui-status-branch"><GitBranch size={11} />{branch}</span>}
      <div className="ui-status-spacer" />
      <BottomResourceDock />
      <span className="ui-status-context" title={t("memory.terminals", { count })}><Terminal size={13} strokeWidth={1.5} />{count}</span>
      <span className="ui-status-context"><Monitor size={13} strokeWidth={1.5} />{environment === "local" ? t("workspace.localHost") : environment.toUpperCase()}</span>
    </footer>
  );
}
