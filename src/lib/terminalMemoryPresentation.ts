import type { TerminalMemorySnapshot } from "../hooks/useTerminalMemory";
import type { Project, TerminalSession, WorktreeRecord } from "./types";
import { resolveTerminalWorkspace } from "./workspaceTerminals";

export type TerminalMemoryEntry = TerminalMemorySnapshot["terminals"][number];
export interface MemoryTerminalRow {
  id: string;
  session?: TerminalSession;
  memory?: TerminalMemoryEntry;
}
export interface MemoryWorkspaceGroup {
  id: string;
  kind: "workspace" | "ungrouped" | "retained";
  project?: Project;
  worktree?: WorktreeRecord;
  terminals: MemoryTerminalRow[];
  totalBytes: number | null;
}

/** Unknown samples must not turn a partially measured workspace into a measured total. */
export function sumMemorySamples(values: Array<number | null | undefined>): number | null {
  if (values.some(value => value == null || !Number.isFinite(value) || value < 0)) return null;
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

/** Use the same explicit workspace ownership as the sidebar; count each PTY exactly once. */
export function groupTerminalMemory(
  sessions: TerminalSession[], projects: Project[], worktrees: WorktreeRecord[],
  snapshot: TerminalMemorySnapshot | null,
): MemoryWorkspaceGroup[] {
  const groups = new Map<string, MemoryWorkspaceGroup>();
  const samples = new Map(snapshot?.terminals.map(terminal => [terminal.sessionId, terminal]));
  const projectById = new Map(projects.map(project => [project.id, project]));
  const worktreeById = new Map(worktrees.map(worktree => [worktree.id, worktree]));
  const append = (group: Omit<MemoryWorkspaceGroup, "terminals" | "totalBytes">, row: MemoryTerminalRow) => {
    const entry = groups.get(group.id) ?? { ...group, terminals: [], totalBytes: null };
    entry.terminals.push(row);
    groups.set(group.id, entry);
  };
  const seen = new Set<string>();
  for (const session of sessions) {
    if ((session.kind ?? "pty") !== "pty" || seen.has(session.id)) continue;
    seen.add(session.id);
    const scope = resolveTerminalWorkspace(session, projects, worktrees, projectById, worktreeById);
    const project = scope ? projectById.get(scope.projectId) : undefined;
    const worktree = scope?.worktreeId ? worktreeById.get(scope.worktreeId) : undefined;
    // A removed Worktree cannot be relabelled as the project's main checkout.
    const resolved = project && (!scope?.worktreeId || worktree?.project_id === project.id);
    append(resolved ? {
      id: JSON.stringify([project.id, scope?.worktreeId ?? null]), kind: "workspace", project, worktree,
    } : { id: "ungrouped", kind: "ungrouped" }, {
      id: session.id, session, memory: samples.get(session.id),
    });
  }
  for (const memory of samples.values()) {
    if (seen.has(memory.sessionId)) continue;
    append({ id: "retained", kind: "retained" }, { id: memory.sessionId, memory });
  }
  for (const group of groups.values()) {
    group.totalBytes = sumMemorySamples(group.terminals.map(row => row.memory?.totalBytes));
  }
  return [...groups.values()];
}
