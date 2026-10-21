import type { Group, Project, TerminalSession, TerminalScope, WorktreeRecord } from "./types";
import { findWorktreeForSession, resolveProjectForSession } from "./terminalProject";
import { resolveTerminalWorkspace } from "./workspaceTerminals";

export const ALL_TERMINALS_SCOPE: TerminalScope = { kind: "all" };

export function collectProjectIdsForGroup(groups: Group[], projects: Project[], groupId: string): Set<string> {
  const groupIds = new Set<string>([groupId]);
  let changed = true;

  while (changed) {
    changed = false;
    for (const group of groups) {
      if (!group.parent_id || !groupIds.has(group.parent_id) || groupIds.has(group.id)) continue;
      groupIds.add(group.id);
      changed = true;
    }
  }

  return new Set(projects.filter((project) => project.group_id && groupIds.has(project.group_id)).map((project) => project.id));
}

export function sessionMatchesTerminalScope(
  session: TerminalSession,
  scope: TerminalScope,
  sessions: TerminalSession[],
  projects: Project[],
  projectById: Map<string, Project>,
  worktrees: WorktreeRecord[],
  groupProjectIds?: Set<string> | null
): boolean {
  if (scope.kind === "all") return true;

  if ((session.kind ?? "pty") === "pty") {
    const workspace = resolveTerminalWorkspace(session, projects, worktrees, projectById);
    if (!workspace) return false;
    if (scope.kind === "worktree") return workspace.projectId === scope.projectId && workspace.worktreeId === scope.worktreeId;
    if (scope.kind === "project") return workspace.projectId === scope.projectId;
    return Boolean(groupProjectIds?.has(workspace.projectId));
  }

  if (scope.kind === "worktree") {
    return findWorktreeForSession(session, sessions, worktrees)?.id === scope.worktreeId;
  }

  const projectId =
    resolveProjectForSession(session, sessions, projects, projectById)?.id ??
    findWorktreeForSession(session, sessions, worktrees)?.project_id ??
    null;
  if (!projectId) return false;

  if (scope.kind === "project") {
    return projectId === scope.projectId;
  }

  return Boolean(groupProjectIds?.has(projectId));
}
