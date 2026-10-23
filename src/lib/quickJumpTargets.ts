import { collectWorkspanSessionIds, type TerminalWorkspan } from "../stores/terminalWorkspan";
import { projectSupportsCapability } from "./projectCapabilities";
import { indexWorkspaceTerminals } from "./workspaceTerminals";
import type { Project, ProjectEnvironmentType, TerminalSession, WorktreeRecord } from "./types";

export type QuickJumpKind = "project" | "worktree" | "terminal" | "workspan";
export type QuickJumpIntent = "navigate" | "create";

export interface QuickJumpTarget {
  id: string;
  kind: QuickJumpKind;
  intent: QuickJumpIntent;
  label: string;
  description: string;
  searchText: string;
  projectId?: string;
  worktreeId?: string;
  sessionId?: string;
  workspanId?: string;
  environment?: ProjectEnvironmentType;
  sshHostId?: string;
  active: boolean;
  terminalCount?: number;
  sessionCount?: number;
  missing?: boolean;
}

export interface QuickJumpSnapshot {
  projects: Project[];
  worktrees: WorktreeRecord[];
  sessions: TerminalSession[];
  sessionStatuses: Readonly<Record<string, string | undefined>>;
  workspans: TerminalWorkspan[];
  activeSessionId: string | null;
  activeWorkspanId: string | null;
  workspanEnabled: boolean;
  includeCreate?: boolean;
  /** Compact mode has no embedded terminal surface. */
  includeTerminals?: boolean;
  externalMode?: boolean;
}

/** A persisted or exited tab is not a live terminal. Synced history panes own a PTY. */
export function isLiveQuickJumpTerminal(
  session: TerminalSession,
  statuses: QuickJumpSnapshot["sessionStatuses"],
): boolean {
  return (!session.kind || session.kind === "pty" || session.kind === "synced-history")
    && statuses[session.id] === "running";
}

function joinDetails(values: Array<string | null | undefined>): string {
  return Array.from(new Set(values.map(value => value?.trim()).filter(Boolean))).join(" · ");
}

function projectPath(project: Project): string {
  return project.environment_type === "ssh" ? project.remote_path : project.path;
}

/** Build from one snapshot; ranking never depends on output activity or Hook status. */
export function buildQuickJumpTargets(snapshot: QuickJumpSnapshot): QuickJumpTarget[] {
  const { projects, worktrees, sessions, sessionStatuses, workspans } = snapshot;
  const liveSessions = sessions.filter(session => isLiveQuickJumpTerminal(session, sessionStatuses));
  const index = indexWorkspaceTerminals(liveSessions, projects, worktrees);
  const projectsById = new Map(projects.map(project => [project.id, project]));
  const worktreesById = new Map(worktrees.map(worktree => [worktree.id, worktree]));
  const sessionsById = new Map(sessions.map(session => [session.id, session]));
  const targets: QuickJumpTarget[] = [];
  const seen = new Set<string>();
  const add = (target: QuickJumpTarget) => {
    if (seen.has(target.id)) return;
    seen.add(target.id);
    targets.push(target);
  };
  const canCreate = (project: Project) => snapshot.includeCreate !== false
    && (!snapshot.externalMode || projectSupportsCapability(project, "externalTerminal"));

  for (const project of projects) {
    const description = projectPath(project);
    const workspaceSessions = index.byProject.get(project.id) ?? [];
    const target: QuickJumpTarget = {
      id: `navigate:project:${project.id}`,
      kind: "project", intent: "navigate", label: project.name, description,
      searchText: joinDetails([project.name, description, project.group_name, project.cli_tool, project.shell,
        project.environment_type, project.ssh_host_id]),
      projectId: project.id, environment: project.environment_type, sshHostId: project.ssh_host_id ?? undefined,
      active: workspaceSessions.some(session => session.id === snapshot.activeSessionId),
      terminalCount: workspaceSessions.length,
    };
    add(target);
    if (canCreate(project)) add({ ...target, id: `create:project:${project.id}`, intent: "create", active: false });
  }

  for (const worktree of worktrees) {
    const project = projectsById.get(worktree.project_id);
    if (!project) continue;
    const workspaceSessions = index.byWorktree.get(worktree.id) ?? [];
    const description = joinDetails([project.name, worktree.branch, worktree.path]);
    const target: QuickJumpTarget = {
      id: `navigate:worktree:${worktree.id}`,
      kind: "worktree", intent: "navigate", label: worktree.name, description,
      searchText: joinDetails([worktree.name, description, project.group_name, project.cli_tool, project.shell, project.environment_type]),
      projectId: project.id, worktreeId: worktree.id, environment: project.environment_type,
      sshHostId: project.ssh_host_id ?? undefined,
      active: workspaceSessions.some(session => session.id === snapshot.activeSessionId),
      terminalCount: workspaceSessions.length, missing: worktree.status === "missing",
    };
    add(target);
    if (worktree.status !== "missing" && canCreate(project) && projectSupportsCapability(project, "worktree")) {
      add({ ...target, id: `create:worktree:${worktree.id}`, intent: "create", active: false });
    }
  }

  if (snapshot.includeTerminals !== false) {
    for (const session of liveSessions) {
      const workspace = index.bySession.get(session.id);
      const project = projectsById.get(workspace?.projectId ?? session.projectId ?? "");
      const worktree = worktreesById.get(workspace?.worktreeId ?? session.worktreeId ?? "");
      const description = joinDetails([project?.name, worktree?.name, session.remotePath || session.cwd]);
      add({
        id: `navigate:terminal:${session.id}`, kind: "terminal", intent: "navigate",
        label: session.title, description,
        searchText: joinDetails([session.title, description, session.runtimeAgent?.tool, session.cliTool, session.shell,
          session.environmentType ?? project?.environment_type, session.sshHostId]),
        sessionId: session.id, projectId: project?.id, worktreeId: worktree?.id,
        environment: session.environmentType ?? project?.environment_type,
        sshHostId: session.sshHostId ?? project?.ssh_host_id ?? undefined,
        active: session.id === snapshot.activeSessionId,
      });
    }

    if (snapshot.workspanEnabled) {
      for (const workspan of workspans) {
        const members = collectWorkspanSessionIds(workspan)
          .map(id => sessionsById.get(id)).filter((session): session is TerminalSession => Boolean(session));
        if (members.length === 0) continue;
        // An empty label asks the UI to use its localized default Workspan title.
        const label = workspan.customTitle ?? (members.length === 1 ? members[0].title : "");
        const description = joinDetails(members.map(session => session.title));
        const searchText = joinDetails(["Workspan", label, description, ...members.flatMap(session => {
          const workspace = index.bySession.get(session.id);
          return [session.cwd, session.remotePath, projectsById.get(workspace?.projectId ?? session.projectId ?? "")?.name,
            worktreesById.get(workspace?.worktreeId ?? session.worktreeId ?? "")?.name];
        })]);
        add({
          id: `navigate:workspan:${workspan.id}`, kind: "workspan", intent: "navigate", label, description, searchText,
          workspanId: workspan.id, sessionCount: members.length,
          terminalCount: members.filter(session => isLiveQuickJumpTerminal(session, sessionStatuses)).length,
          active: workspan.id === snapshot.activeWorkspanId,
        });
      }
    }
  }
  return targets;
}

function fuzzyScore(text: string, query: string): number | null {
  const exactIndex = text.indexOf(query);
  if (exactIndex >= 0) return exactIndex === 0 ? 0 : 20 + exactIndex;
  const maxSpan = query.length * 3;
  for (let start = text.indexOf(query[0]); start >= 0; start = text.indexOf(query[0], start + 1)) {
    let end = start;
    let queryIndex = 1;
    for (; queryIndex < query.length; queryIndex++) {
      end = text.indexOf(query[queryIndex], end + 1);
      if (end < 0 || end - start + 1 > maxSpan) break;
    }
    if (queryIndex === query.length) return 100 + end - start + 1 - query.length;
  }
  return null;
}

/** Token matching allows e.g. a project name plus a branch, path, host, or CLI. */
export function quickJumpMatchScore(label: string, searchText: string, query: string): number | null {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return 0;
  const normalizedLabel = label.toLocaleLowerCase();
  // Never assemble a fuzzy match across unrelated project/path/CLI/host fields.
  // Keep path punctuation intact so useful abbreviations still match one path.
  const metadataFields = searchText.toLocaleLowerCase().split(/[\s·]+/).filter(Boolean);
  if (normalizedLabel === normalizedQuery) return 0;
  let score = 1;
  for (const token of normalizedQuery.split(/\s+/)) {
    const labelScore = fuzzyScore(normalizedLabel, token);
    const fieldScores = metadataFields.map(field => fuzzyScore(field, token))
      .filter((value): value is number => value !== null);
    const textScore = fieldScores.length > 0 ? Math.min(...fieldScores) : null;
    if (labelScore === null && textScore === null) return null;
    score += Math.min(labelScore === null ? Infinity : labelScore,
      textScore === null ? Infinity : 50 + textScore);
  }
  return score;
}

export function matchesQuickJumpQuery(searchText: string, query: string): boolean {
  return quickJumpMatchScore("", searchText, query) !== null;
}

export function searchQuickJumpTargets<T extends Pick<QuickJumpTarget, "label" | "searchText">>(
  targets: readonly T[], query: string,
): T[] {
  return targets.map((target, index) => ({ target, index, score: quickJumpMatchScore(target.label, target.searchText, query) }))
    .filter((item): item is { target: T; index: number; score: number } => item.score !== null)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map(item => item.target);
}
