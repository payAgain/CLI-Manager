import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { getDb } from "../lib/db";
import { hasConfiguredCliTool } from "../lib/projectCli";
import { projectSupportsCapability } from "../lib/projectCapabilities";
import { resolveWorktreeManagementTarget, resolveWorktreeRemovalTarget } from "../lib/worktreeManagement";
import type { Project, TerminalSession, WorktreeIsolationStrategy, WorktreeRecord } from "../lib/types";
import { useProjectStore } from "./projectStore";
import { useTerminalStore } from "./terminalStore";
import { useSettingsStore } from "./settingsStore";
import { toast } from "sonner";
import { translateCurrent } from "../lib/i18n";
import { worktreeRelatedSessions } from "../lib/worktreeRemoval";
import { resolveTerminalRuntimeEnvironment } from "../lib/terminalRuntimeEnvironment";

export interface GitWorktreeCreateResult {
  name: string;
  branch: string;
  path: string;
  baseBranch: string;
}

export interface GitWorktreeDepsCheckResult {
  needsInstall: boolean;
  command: string | null;
  reason: string | null;
}

export interface GitWorktreeMergeResult {
  merged: boolean;
  output: string;
  conflictFiles: string[];
  skipped: boolean;
  skipReason: string | null;
}

export interface WorktreeRemovalSession {
  sessionId: string;
  title?: string;
  workspacePath?: string;
  cwd?: string;
}
export interface WorktreeRemovalPreflight {
  confirmationToken: string;
  worktreePath: string;
  branch: string | null;
  detached: boolean;
  head: string;
  locked: boolean;
  dirty: boolean;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  changedPaths: string[];
  changedCount?: number;
  runningSessions: WorktreeRemovalSession[];
  externalProcesses: { pid: number; name: string }[];
  /** App-side identity checked again before any terminal is closed. */
  worktreeId: string;
  projectPath: string;
}
export interface WorktreeRemovalOptions {
  preflight: WorktreeRemovalPreflight;
  discardChanges: boolean;
  closeSessions: boolean;
}
const inFlightWorktreeRemovals = new Set<string>();

export type WorktreeIsolationDecision = "prompt" | "auto" | "none";

export const WORKTREE_CREATE_IN_PROGRESS = "worktree_create_in_progress";

const inFlightWorktreeCreates = new Set<string>();
let followingProjectWorktrees = false;

const RESERVED_WINDOWS_WORKTREE_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
  "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);
const WORKTREE_SESSION_RELEASE_DELAY_MS = 350;

function waitForSessionRelease(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, WORKTREE_SESSION_RELEASE_DELAY_MS));
}

interface ProjectGitValidationCacheEntry {
  key: string;
  valid: boolean;
}

interface WorktreeStore {
  worktrees: WorktreeRecord[];
  loaded: boolean;
  validatingProjects: Record<string, ProjectGitValidationCacheEntry>;
  loadWorktrees: () => Promise<void>;
  createWorktreeForProject: (project: Project, name?: string) => Promise<WorktreeRecord>;
  shouldIsolateNewSession: (
    project: Project,
    sessions: TerminalSession[]
  ) => WorktreeIsolationDecision;
  validateProjectGit: (project: Project) => Promise<boolean>;
  checkDeps: (worktree: WorktreeRecord) => Promise<GitWorktreeDepsCheckResult>;
  dismissDepsPrompt: (worktreeId: string) => Promise<void>;
  mergeWorktree: (worktree: WorktreeRecord) => Promise<GitWorktreeMergeResult>;
  preflightRemoval: (worktree: WorktreeRecord) => Promise<WorktreeRemovalPreflight>;
  removeWorktree: (worktree: WorktreeRecord, deleteBranch: boolean, options?: WorktreeRemovalOptions) => Promise<void>;
  markMissingWorktrees: () => Promise<void>;
}

function normalizeStrategy(value: string | null | undefined): WorktreeIsolationStrategy {
  return value === "prompt" || value === "autoParallel" || value === "always" ? value : "disabled";
}

function hasSameProjectTerminalSession(projectId: string, sessions: TerminalSession[]): boolean {
  return sessions.some((session) => session.projectId === projectId && (session.kind ?? "pty") === "pty");
}

function createDefaultTaskName(existingNames: Set<string>): string {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  const base = `task-${mm}${dd}-${hh}${min}`;
  if (!existingNames.has(base)) return base;
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${base}-${i}`;
    if (!existingNames.has(candidate)) return candidate;
  }
  return `${base}-${crypto.randomUUID().slice(0, 6)}`;
}

export function createDefaultWorktreeTaskName(projectId: string): string {
  const existingNames = new Set(
    useWorktreeStore
      .getState()
      .worktrees.filter((worktree) => worktree.project_id === projectId)
      .map((worktree) => worktree.name)
  );
  return createDefaultTaskName(existingNames);
}

export function sanitizeWorktreeTaskName(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+/, "").slice(0, 64);
}

export function validateWorktreeTaskName(value: string): boolean {
  const trimmed = value.trim();
  return /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/.test(trimmed) && !RESERVED_WINDOWS_WORKTREE_NAMES.has(trimmed.toUpperCase());
}

export function isWorktreeCreateInProgressError(error: unknown): boolean {
  return String(error).includes(WORKTREE_CREATE_IN_PROGRESS);
}

function mapCreateResultToRecord(projectId: string, result: GitWorktreeCreateResult): WorktreeRecord {
  const ts = Date.now().toString();
  return {
    id: crypto.randomUUID(),
    project_id: projectId,
    name: result.name,
    branch: result.branch,
    path: result.path,
    base_branch: result.baseBranch,
    deps_prompt_dismissed: 0,
    provider_overrides: "{}",
    status: "active",
    created_at: ts,
    updated_at: ts,
  };
}

async function saveWorktreeRecord(record: WorktreeRecord): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO worktrees (id, project_id, name, branch, path, base_branch, deps_prompt_dismissed, provider_overrides, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      record.id,
      record.project_id,
      record.name,
      record.branch,
      record.path,
      record.base_branch,
      record.deps_prompt_dismissed,
      record.provider_overrides,
      record.status,
      record.created_at,
      record.updated_at,
    ]
  );
}

export const useWorktreeStore = create<WorktreeStore>((set, get) => ({
  worktrees: [],
  loaded: false,
  validatingProjects: {},

  loadWorktrees: async () => {
    // Subscribe after initialization, avoiding the existing project/settings/
    // terminal store import cycle. Both stores then share one Git snapshot.
    if (!followingProjectWorktrees) {
      followingProjectWorktrees = true;
      useProjectStore.subscribe((state, previous) => {
        if (state.worktrees !== previous.worktrees) {
          set({ worktrees: state.worktrees, loaded: state.loaded });
        }
      });
    }
    if (!useProjectStore.getState().loaded) await useProjectStore.getState().fetchAll("startup");
    else await useProjectStore.getState().refreshWorktrees();
    set({ worktrees: useProjectStore.getState().worktrees, loaded: true });
  },

  markMissingWorktrees: async () => {
    const active = get().worktrees.filter((worktree) => worktree.status === "active" && worktree.origin !== "discovered");
    if (active.length === 0) return;
    let exists: boolean[];
    try {
      exists = await invoke<boolean[]>("check_paths_exist", { paths: active.map((worktree) => worktree.path) });
    } catch {
      return;
    }
    const missingIds = active.filter((_, index) => !exists[index]).map((worktree) => worktree.id);
    if (missingIds.length === 0) return;
    const db = await getDb();
    const ts = Date.now().toString();
    for (const id of missingIds) {
      await db.execute("UPDATE worktrees SET status = $1, updated_at = $2 WHERE id = $3", ["missing", ts, id]);
    }
    await get().loadWorktrees();
    await useProjectStore.getState().fetchAll("startup");
  },

  createWorktreeForProject: async (project, name) => {
    if (!projectSupportsCapability(project, "worktree")) {
      throw new Error("remote_project_capability_unsupported:worktree");
    }
    const existingNames = new Set(
      get().worktrees
        .filter((worktree) => worktree.project_id === project.id)
        .map((worktree) => worktree.name)
    );
    const taskName = sanitizeWorktreeTaskName(name ?? createDefaultTaskName(existingNames));
    if (!validateWorktreeTaskName(taskName)) {
      throw new Error("task_name_invalid");
    }
    const creationKey = `${project.path}\u0000${project.worktree_root.trim()}\u0000${taskName}`;
    if (inFlightWorktreeCreates.has(creationKey)) {
      throw new Error(WORKTREE_CREATE_IN_PROGRESS);
    }
    inFlightWorktreeCreates.add(creationKey);
    try {
      const result = await invoke<GitWorktreeCreateResult>("git_worktree_create", {
        req: {
          projectPath: project.path,
          taskName,
          worktreeRoot: project.worktree_root.trim() || null,
        },
      });
      const record = mapCreateResultToRecord(project.id, result);
      await saveWorktreeRecord(record);
      set((state) => ({ worktrees: [record, ...state.worktrees] }));
      await useProjectStore.getState().fetchAll("interactive");
      return record;
    } finally {
      inFlightWorktreeCreates.delete(creationKey);
    }
  },

  shouldIsolateNewSession: (project, sessions) => {
    if (!useSettingsStore.getState().projectWorktreeConfigEnabled) return "none";
    if (!projectSupportsCapability(project, "worktree")) return "none";
    const strategy = normalizeStrategy(project.worktree_strategy);
    if (strategy === "disabled") return "none";
    if (strategy === "always") return "auto";
    if (!hasConfiguredCliTool(project)) return "none";
    if (!hasSameProjectTerminalSession(project.id, sessions)) return "none";
    return strategy === "autoParallel" ? "auto" : "prompt";
  },

  validateProjectGit: async (project) => {
    if (!projectSupportsCapability(project, "worktree")) return false;
    const key = `${project.id}:${project.path}`;
    const cached = get().validatingProjects[project.id];
    if (cached?.key === key) return cached.valid;
    let valid = false;
    try {
      valid = await invoke<boolean>("git_worktree_validate", { projectPath: project.path });
    } catch {
      valid = false;
    }
    set((state) => ({
      validatingProjects: {
        ...state.validatingProjects,
        [project.id]: { key, valid },
      },
    }));
    return valid;
  },

  checkDeps: async (worktree) => {
    return invoke<GitWorktreeDepsCheckResult>("git_worktree_check_deps", { worktreePath: worktree.path });
  },

  dismissDepsPrompt: async (worktreeId) => {
    const ts = Date.now().toString();
    const db = await getDb();
    await db.execute("UPDATE worktrees SET deps_prompt_dismissed = 1, updated_at = $1 WHERE id = $2", [ts, worktreeId]);
    set((state) => ({
      worktrees: state.worktrees.map((worktree) =>
        worktree.id === worktreeId
          ? { ...worktree, deps_prompt_dismissed: 1, updated_at: ts }
          : worktree
      ),
    }));
    await useProjectStore.getState().fetchAll("interactive");
  },

  mergeWorktree: async (worktree) => {
    const target = resolveWorktreeManagementTarget(worktree, get().worktrees);
    if (!target.worktree) throw new Error(target.error);
    const current = target.worktree;
    const project = useProjectStore.getState().projects.find((item) => item.id === current.project_id);
    if (!project) throw new Error("project_not_found");
    return invoke<GitWorktreeMergeResult>("git_worktree_merge", {
      projectPath: project.path,
      worktreeBranch: current.branch,
      baseBranch: current.base_branch,
    });
  },

  preflightRemoval: async (worktree) => {
    const target = resolveWorktreeRemovalTarget(worktree, get().worktrees);
    if (!target.worktree) throw new Error(target.error);
    const project = useProjectStore.getState().projects.find(item => item.id === worktree.project_id);
    if (!project) throw new Error("project_not_found");
    if (project.environment_type !== "local") throw new Error("worktree_remove_unsupported_environment");
    const result = await invoke<Omit<WorktreeRemovalPreflight, "worktreeId" | "projectPath">>("git_worktree_remove_preflight", {
      projectPath: project.path, worktreePath: target.worktree.path, branch: target.worktree.branch,
    });
    const state = useTerminalStore.getState();
    const running = new Map(result.runningSessions.map(session => [session.sessionId, { ...session,
      title: state.sessions.find(item => item.id === session.sessionId)?.title || session.title }]));
    const related = worktreeRelatedSessions(target.worktree, result.worktreePath, state.sessions, state.sessionStatuses);
    if (related.some(session => resolveTerminalRuntimeEnvironment(session) === "wsl")) throw new Error("worktree_remove_wsl_sessions");
    for (const session of related) {
      running.set(session.id, { sessionId: session.id, title: session.title, cwd: session.cwd });
    }
    return { ...result, runningSessions: [...running.values()], worktreeId: worktree.id, projectPath: project.path };
  },

  removeWorktree: async (worktree, deleteBranch, options) => {
    const preflight = options?.preflight;
    if (!options || !preflight?.confirmationToken || preflight.worktreeId !== worktree.id) throw new Error("worktree_remove_confirmation_required");
    if (preflight.dirty && !options.discardChanges) throw new Error("worktree_remove_changes_confirmation_required");
    if (preflight.externalProcesses.length) throw new Error("worktree_remove_processes_running");
    if (preflight.runningSessions.length && !options.closeSessions) throw new Error("worktree_remove_sessions_running");
    if (deleteBranch && (preflight.detached || !preflight.branch)) throw new Error("worktree_remove_detached_branch");
    const key = `${worktree.project_id}:${preflight.worktreePath}`;
    if (inFlightWorktreeRemovals.has(key)) throw new Error("worktree_remove_busy");
    inFlightWorktreeRemovals.add(key);
    const currentTarget = () => {
      const target = resolveWorktreeRemovalTarget(worktree, get().worktrees);
      if (!target.worktree) throw new Error(target.error);
      const project = useProjectStore.getState().projects.find(item => item.id === worktree.project_id);
      if (!project || project.path !== preflight.projectPath) throw new Error("worktree_target_changed");
      if (project.environment_type !== "local") throw new Error("worktree_remove_unsupported_environment");
      return { worktree: target.worktree, project };
    };
    try {
      currentTarget();
      const permitted = new Set(preflight.runningSessions.map(session => session.sessionId));
      // A hidden tab may have stale cwd/status. Refresh daemon association before closing,
      // while retaining the original content token for the final destructive operation.
      const daemonRelated = new Set<string>();
      if (options.closeSessions && permitted.size) {
        const target = currentTarget();
        const current = await invoke<WorktreeRemovalPreflight>("git_worktree_remove_preflight", {
          projectPath: target.project.path, worktreePath: target.worktree.path, branch: target.worktree.branch,
        });
        if (current.externalProcesses.length) throw new Error("worktree_remove_processes_running");
        for (const session of current.runningSessions) {
          if (!permitted.has(session.sessionId)) throw new Error("worktree_remove_changed");
          daemonRelated.add(session.sessionId);
        }
      }
      const terminalState = useTerminalStore.getState();
      const related = worktreeRelatedSessions(worktree, preflight.worktreePath, terminalState.sessions, terminalState.sessionStatuses);
      if (related.some(session => resolveTerminalRuntimeEnvironment(session) === "wsl")) throw new Error("worktree_remove_wsl_sessions");
      if (related.some(session => !permitted.has(session.id))) throw new Error("worktree_remove_changed");
      if (options.closeSessions) {
        for (const sessionId of permitted) {
          currentTarget();
          const state = useTerminalStore.getState();
          const session = state.sessions.find(item => item.id === sessionId);
          if (!daemonRelated.has(sessionId) && (!session || !worktreeRelatedSessions(worktree, preflight.worktreePath, [session], state.sessionStatuses).length)) continue;
          if (session && resolveTerminalRuntimeEnvironment(session) === "wsl") throw new Error("worktree_remove_wsl_sessions");
          await state.discardDaemonSession(sessionId);
        }
        if (permitted.size) await waitForSessionRelease();
      }
      const latest = currentTarget();
      const output = await invoke<string>("git_worktree_remove", {
        projectPath: latest.project.path, worktreePath: latest.worktree.path, branch: latest.worktree.branch,
        deleteBranch, confirmationToken: preflight.confirmationToken, discardChanges: options.discardChanges,
      });
      // Git removal is authoritative even if saving the sidebar record later fails.
      if (latest.worktree.origin !== "discovered") {
        try {
          const db = await getDb();
          await db.execute("DELETE FROM worktrees WHERE id = $1", [worktree.id]);
        } catch {
          toast.warning(translateCurrent("worktree.remove.metadataFailed"));
        }
      }
      set(state => ({ worktrees: state.worktrees.filter(item => item.id !== worktree.id) }));
      if (output.includes("branch_delete_failed:")) toast.warning(translateCurrent("worktree.remove.branchKept"));
      try { await useProjectStore.getState().fetchAll("interactive"); }
      catch { toast.warning(translateCurrent("worktree.remove.refreshFailed")); }
    } finally {
      inFlightWorktreeRemovals.delete(key);
    }
  },
}));
