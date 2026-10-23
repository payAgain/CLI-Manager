import { findProjectByPath, findWorktreeByPath, normalizeProjectPath } from "./terminalProject";
import type { Project, TerminalSession, WorktreeRecord } from "./types";

export interface WorkspaceTerminalIndex {
  byProject: Map<string, TerminalSession[]>;
  primaryByProject: Map<string, TerminalSession[]>;
  byWorktree: Map<string, TerminalSession[]>;
  bySession: Map<string, { projectId: string; worktreeId?: string }>;
}

/** Match displayed terminal scopes without rewriting restored launch metadata. */
export function resolveTerminalWorkspace(
  session: TerminalSession, projects: Project[], worktrees: WorktreeRecord[],
  projectById = new Map(projects.map(project => [project.id, project])),
  worktreeById = new Map(worktrees.map(worktree => [worktree.id, worktree])),
): { projectId: string; worktreeId?: string } | null {
  if ((session.kind ?? "pty") !== "pty") return null;
  if (session.workspace !== undefined) {
    const owner = session.workspace;
    return owner && projectById.has(owner.projectId)
      ? { projectId: owner.projectId, worktreeId: owner.worktreeId }
      : null;
  }
  let project = projectById.get(session.projectId ?? "");
  let worktree = worktreeById.get(session.worktreeId ?? "");
  if (worktree && project && worktree.project_id !== project.id) worktree = undefined;
  if (!project && worktree) project = projectById.get(worktree.project_id);
  const explicitProject = Boolean(project);
  if (!project && session.environmentType === "ssh") {
    const path = (session.remotePath || session.cwd || "").replace(/\/+$/, "") || "/";
    if (session.sshHostId && (session.remotePath || session.cwd)) {
      project = projects.filter(candidate => {
        const root = candidate.remote_path.replace(/\/+$/, "") || "/";
        return candidate.environment_type === "ssh" && candidate.ssh_host_id === session.sshHostId
          && (path === root || path.startsWith(root === "/" ? "/" : `${root}/`));
      }).sort((left, right) => right.remote_path.length - left.remote_path.length)[0];
    }
  } else if (session.environmentType !== "ssh" && project?.environment_type !== "ssh") {
    const candidates = project ? [project] : projects.filter(candidate => candidate.environment_type !== "ssh"
      && (!session.environmentType || candidate.environment_type === session.environmentType));
    const inferredWorktree = worktree ?? findWorktreeByPath(worktrees.filter(candidate =>
      explicitProject ? candidate.project_id === project?.id
        : candidates.some(parent => parent.id === candidate.project_id)), session.cwd) ?? undefined;
    project ??= findProjectByPath(candidates, session.cwd) ?? undefined;
    if (!explicitProject && inferredWorktree && (!project
      || normalizeProjectPath(inferredWorktree.path).length > normalizeProjectPath(project.path).length)) {
      project = projectById.get(inferredWorktree.project_id);
    }
    if (inferredWorktree?.project_id === project?.id) worktree = inferredWorktree;
  }
  return project ? { projectId: project.id, worktreeId: worktree?.id } : null;
}

/** Share one snapshot across cards, counts, filters and activation. */
export function indexWorkspaceTerminals(
  sessions: TerminalSession[], projects: Project[], worktrees: WorktreeRecord[],
): WorkspaceTerminalIndex {
  const index: WorkspaceTerminalIndex = {
    byProject: new Map(), primaryByProject: new Map(), byWorktree: new Map(), bySession: new Map(),
  };
  const projectById = new Map(projects.map(project => [project.id, project]));
  const worktreeById = new Map(worktrees.map(worktree => [worktree.id, worktree]));
  const append = (map: Map<string, TerminalSession[]>, id: string, session: TerminalSession) => {
    const list = map.get(id);
    if (list) list.push(session);
    else map.set(id, [session]);
  };
  for (const session of sessions) {
    const workspace = resolveTerminalWorkspace(session, projects, worktrees, projectById, worktreeById);
    if (!workspace) continue;
    append(index.byProject, workspace.projectId, session);
    if (workspace.worktreeId) append(index.byWorktree, workspace.worktreeId, session);
    else append(index.primaryByProject, workspace.projectId, session);
    index.bySession.set(session.id, workspace);
  }
  return index;
}
