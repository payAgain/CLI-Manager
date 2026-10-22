import { resolveHistoryProjectPath } from "./historyProjectPaths";
import { collectProjectIdsForGroup } from "./terminalScope";
import { findWorktreeForSession, resolveProjectForSession } from "./terminalProject";
import { resolveTerminalWorkspace } from "./workspaceTerminals";
import type { Group, Project, TerminalScope, TerminalSession, WorktreeRecord } from "./types";

export interface HistoryProjectScope {
  projectPath: string | null;
  projectId: string | null;
  scopedProjectPath: string | null;
}

interface HistoryScopeContext {
  terminalScope: TerminalScope;
  activeSessionId: string | null;
  sessions: TerminalSession[];
  projects: Project[];
  groups: Group[];
  worktrees: WorktreeRecord[];
}

export function hasExplicitHistoryScope(options?: Partial<HistoryProjectScope>): boolean {
  return options?.projectPath !== undefined
    || options?.projectId !== undefined
    || options?.scopedProjectPath !== undefined;
}

/** Omitted scope follows the workspace; explicit null keeps the All Projects choice. */
export function resolveHistoryOpenScope(
  options: Partial<HistoryProjectScope> | undefined,
  { terminalScope, activeSessionId, sessions, projects, groups, worktrees }: HistoryScopeContext,
): HistoryProjectScope {
  if (hasExplicitHistoryScope(options)) {
    return {
      projectPath: options?.projectPath?.trim() || null,
      projectId: options?.projectId?.trim() || null,
      scopedProjectPath: options?.scopedProjectPath?.trim() || null,
    };
  }

  let session = sessions.find((item) => item.id === activeSessionId) ?? null;
  const seen = new Set<string>();
  while (session?.kind === "subagent-transcript") {
    if (seen.has(session.id)) {
      session = null;
      break;
    }
    seen.add(session.id);
    const parentId = session.subagent?.parentSessionId;
    session = sessions.find((item) => item.id === parentId) ?? null;
  }

  const projectById = new Map(projects.map((project) => [project.id, project]));
  const workspace = session ? resolveTerminalWorkspace(session, projects, worktrees, projectById) : null;
  const sessionProject = (session?.kind ?? "pty") === "pty"
    ? projectById.get(workspace?.projectId ?? "") ?? null
    : resolveProjectForSession(session, sessions, projects, projectById);
  const sessionWorktree = findWorktreeForSession(session, sessions, worktrees);
  let project = sessionProject;
  let worktree = sessionWorktree?.project_id === project?.id ? sessionWorktree : null;

  if (terminalScope.kind === "project" || terminalScope.kind === "worktree") {
    project = projectById.get(terminalScope.projectId) ?? null;
    worktree = terminalScope.kind === "worktree"
      ? worktrees.find((item) => item.id === terminalScope.worktreeId && item.project_id === project?.id) ?? null
      : sessionProject?.id === project?.id ? worktree : null;
  } else if (terminalScope.kind === "group") {
    const projectIds = collectProjectIdsForGroup(groups, projects, terminalScope.groupId);
    if (!project || !projectIds.has(project.id)) {
      return { projectPath: null, projectId: null, scopedProjectPath: null };
    }
  }

  const fallbackPath = terminalScope.kind === "all" && session?.environmentType !== "ssh"
    ? session?.fileEditor?.projectPath || session?.cwd
    : null;
  const projectPath = resolveHistoryProjectPath(project) || fallbackPath?.trim() || null;
  return {
    projectPath,
    projectId: projectPath ? project?.id ?? null : null,
    scopedProjectPath: worktree?.path.trim() || null,
  };
}
