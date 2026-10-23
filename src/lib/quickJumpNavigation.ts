import { useHistoryStore } from "../stores/historyStore";
import { useProjectStore } from "../stores/projectStore";
import { useTerminalStore } from "../stores/terminalStore";
import { collectWorkspanSessionIds, findWorkspanBySession } from "../stores/terminalWorkspan";
import { isLiveQuickJumpTerminal, type QuickJumpTarget } from "./quickJumpTargets";
import { projectSupportsCapability } from "./projectCapabilities";
import { ALL_TERMINALS_SCOPE } from "./terminalScope";
import { indexWorkspaceTerminals } from "./workspaceTerminals";
import type { Project, TerminalScope, WorktreeRecord } from "./types";

export interface QuickJumpWorkspaceActions {
  /** Keep Sidebar selection and its project/file view in sync, including compact mode. */
  selectWorkspace: (scope: TerminalScope) => void;
  /** Owned by Sidebar so isolation prompts, external terminals and launch policy stay shared. */
  createSession: (project: Project, worktree?: WorktreeRecord) => Promise<void>;
}

let workspaceActions: QuickJumpWorkspaceActions | null = null;

export function registerQuickJumpWorkspaceActions(actions: QuickJumpWorkspaceActions): () => void {
  workspaceActions = actions;
  return () => {
    if (workspaceActions === actions) workspaceActions = null;
  };
}

function selectWorkspace(scope: TerminalScope): void {
  useTerminalStore.getState().setTerminalScope(scope);
  workspaceActions?.selectWorkspace(scope);
  useHistoryStore.getState().closeHistory();
}

/** Navigation resolves current objects again; removed/exited results never become launches. */
export function activateQuickJumpTarget(target: QuickJumpTarget): boolean {
  if (target.intent !== "navigate") return false;
  const terminal = useTerminalStore.getState();
  const { projects, worktrees } = useProjectStore.getState();

  if (target.kind === "terminal") {
    const session = terminal.sessions.find(candidate => candidate.id === target.sessionId);
    if (!session || !isLiveQuickJumpTerminal(session, terminal.sessionStatuses)
      || !findWorkspanBySession(terminal.workspans, session.id)) return false;
    // A Workspan may span several projects. Reveal its complete split layout.
    selectWorkspace(ALL_TERMINALS_SCOPE);
    terminal.setActive(session.id);
    return true;
  }

  if (target.kind === "workspan") {
    const workspan = terminal.workspans.find(candidate => candidate.id === target.workspanId);
    if (!workspan || !collectWorkspanSessionIds(workspan)
      .some(id => terminal.sessions.some(session => session.id === id))) return false;
    selectWorkspace(ALL_TERMINALS_SCOPE);
    terminal.setActiveWorkspan(workspan.id);
    return true;
  }

  const project = projects.find(candidate => candidate.id === target.projectId);
  if (!project) return false;
  const worktree = target.kind === "worktree"
    ? worktrees.find(candidate => candidate.id === target.worktreeId && candidate.project_id === project.id)
    : undefined;
  if (target.kind === "worktree" && !worktree) return false;
  const liveSessions = terminal.sessions.filter(session => isLiveQuickJumpTerminal(session, terminal.sessionStatuses)
    && findWorkspanBySession(terminal.workspans, session.id));
  const index = indexWorkspaceTerminals(liveSessions, projects, worktrees);
  const candidates = (worktree ? index.byWorktree.get(worktree.id) : index.byProject.get(project.id)) ?? [];
  const session = candidates.find(candidate => candidate.id === terminal.activeSessionId)
    ?? (!worktree ? index.primaryByProject.get(project.id)?.[0] : undefined)
    ?? candidates[0];
  selectWorkspace(worktree
    ? { kind: "worktree", projectId: project.id, worktreeId: worktree.id }
    : { kind: "project", projectId: project.id });
  if (session) terminal.setActive(session.id);
  return true;
}

/** Wait only for a Sidebar that is being mounted after leaving terminal fullscreen. */
export async function requestQuickJumpCreate(target: QuickJumpTarget): Promise<boolean> {
  if (target.intent !== "create" || (target.kind !== "project" && target.kind !== "worktree")) return false;
  for (let frame = 0; !workspaceActions && frame < 2 && typeof window !== "undefined"; frame++) {
    await new Promise<void>(resolve => {
      let frameId: number | undefined;
      const finish = () => {
        clearTimeout(timeoutId);
        if (frameId !== undefined) window.cancelAnimationFrame(frameId);
        resolve();
      };
      // A window hidden to the tray can suspend animation frames mid-request.
      const timeoutId = setTimeout(finish, 50);
      frameId = window.requestAnimationFrame(finish);
    });
  }
  const actions = workspaceActions;
  if (!actions) return false;
  const { projects, worktrees } = useProjectStore.getState();
  const project = projects.find(candidate => candidate.id === target.projectId);
  if (!project) return false;
  const worktree = target.kind === "worktree"
    ? worktrees.find(candidate => candidate.id === target.worktreeId && candidate.project_id === project.id)
    : undefined;
  if (target.kind === "worktree" && (!worktree || worktree.status === "missing"
    || !projectSupportsCapability(project, "worktree"))) return false;
  selectWorkspace(worktree
    ? { kind: "worktree", projectId: project.id, worktreeId: worktree.id }
    : { kind: "project", projectId: project.id });
  await actions.createSession(project, worktree);
  return true;
}
