import type { Group, Project, TerminalScope, TerminalSession, WorktreeRecord } from "./types";
import { projectWithWorktreePath, resolveProjectForSessionFileContext } from "./terminalProject";
import { collectProjectIdsForGroup, sessionMatchesTerminalScope } from "./terminalScope";
import { resolveTerminalWorkspace } from "./workspaceTerminals";

interface QuickJumpFileContextOptions {
  projects: Project[];
  worktrees: WorktreeRecord[];
  sessions: TerminalSession[];
  activeSessionId: string | null;
  terminalScope: TerminalScope;
  groups?: Group[];
}

/** Explicit workspace selection must win over a terminal left active in another scope. */
export function resolveQuickJumpFileProject({
  projects, worktrees, sessions, activeSessionId, terminalScope, groups = [],
}: QuickJumpFileContextOptions): Project | null {
  const projectById = new Map(projects.map((project) => [project.id, project]));
  let activeSession = sessions.find((session) => session.id === activeSessionId) ?? null;
  const visited = new Set<string>();
  while (activeSession?.kind === "subagent-transcript") {
    if (visited.has(activeSession.id)) return null;
    visited.add(activeSession.id);
    const parentId = activeSession.subagent?.parentSessionId;
    activeSession = sessions.find((session) => session.id === parentId) ?? null;
  }
  const groupProjectIds = terminalScope.kind === "group"
    ? collectProjectIdsForGroup(groups, projects, terminalScope.groupId)
    : null;
  const activeInScope = activeSession && sessionMatchesTerminalScope(
    activeSession, terminalScope, sessions, projects, projectById, worktrees, groupProjectIds,
  );

  if (terminalScope.kind === "worktree") {
    const project = projectById.get(terminalScope.projectId);
    const worktree = worktrees.find((candidate) => candidate.id === terminalScope.worktreeId
      && candidate.project_id === terminalScope.projectId);
    return project && worktree ? projectWithWorktreePath(project, worktree) : null;
  }

  if (activeSession && activeInScope) {
    // Restored shell sessions may only carry a cwd or SSH host/path, not a project id.
    const workspace = resolveTerminalWorkspace(activeSession, projects, worktrees, projectById);
    if (workspace) {
      const project = projectById.get(workspace.projectId);
      const worktree = workspace.worktreeId
        ? worktrees.find((candidate) => candidate.id === workspace.worktreeId)
        : null;
      if (project) return worktree ? projectWithWorktreePath(project, worktree) : project;
    }
    const project = resolveProjectForSessionFileContext(
      activeSession, sessions, projects, projectById, worktrees,
    );
    if (project) return project;
  }

  return terminalScope.kind === "project" ? projectById.get(terminalScope.projectId) ?? null : null;
}

/** Keep result ownership exact, including case-sensitive remote roots and host changes. */
export function quickJumpFileContextKey(project: Project | null): string {
  return project ? JSON.stringify([
    project.id, project.environment_type, project.path, project.ssh_host_id, project.remote_path,
  ]) : "";
}
