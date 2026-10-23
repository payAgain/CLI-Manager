import { invoke } from "@tauri-apps/api/core";
import type { Project, WorktreeRecord } from "./types";

export interface GitDiscoveredWorktree {
  path: string;
  branch: string;
  head: string;
  missing: boolean;
}

export function worktreePathKey(path: string): string {
  const plain = path.replace(/^\\\\\?\\/, "").replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(plain) ? plain.toLowerCase() : plain;
}

export function canDiscoverWorktrees(project: Project): boolean {
  // Worktree commands currently support local repositories only. Do not send
  // SSH or WSL paths to the host's Git, or start a remote connection on focus.
  const path = project.path.replace(/^\\\\\?\\/, "").replace(/^\/\/\?\//, "");
  return (!project.environment_type || project.environment_type === "local")
    && Boolean(path.trim()) && !/^(?:\\\\|\/\/|UNC[\\/])/i.test(path);
}

export function mergeDiscoveredWorktrees(
  project: Project, managed: WorktreeRecord[], entries: GitDiscoveredWorktree[],
): WorktreeRecord[] {
  const byPath = new Map(entries.map(entry => [worktreePathKey(entry.path), entry]));
  const records = managed.map(record => {
    const entry = byPath.get(worktreePathKey(record.path));
    byPath.delete(worktreePathKey(record.path));
    return { ...record, branch: entry?.branch || record.branch,
      status: entry ? (entry.missing ? "missing" : "active") as WorktreeRecord["status"] : record.status };
  });
  for (const [key, entry] of byPath) {
    if (key === worktreePathKey(project.path) || entry.missing) continue;
    const branch = entry.branch || entry.head.slice(0, 8);
    records.push({
      id: `git:${project.id}:${key}`, project_id: project.id, origin: "discovered",
      name: branch || entry.path.split(/[\\/]/).pop() || entry.path,
      path: entry.path, branch, base_branch: "", status: "active",
      deps_prompt_dismissed: 1, provider_overrides: "{}", created_at: "0", updated_at: "0",
    });
  }
  return records;
}

/** Short cache + shared in-flight reads bound focus/palette refresh costs. */
export function createWorktreeDiscovery(
  list: (path: string) => Promise<GitDiscoveredWorktree[]>, now = Date.now,
) {
  const cache = new Map<string, { at: number; entries?: GitDiscoveredWorktree[]; pending?: Promise<void> }>();
  return async (projects: Project[], managed: WorktreeRecord[], force = false): Promise<WorktreeRecord[]> => {
    const eligible = projects.filter(canDiscoverWorktrees);
    const keys = new Set(eligible.map(project => worktreePathKey(project.path)));
    for (const key of cache.keys()) if (!keys.has(key)) cache.delete(key);
    const queue = [...new Map(eligible.map(project => [worktreePathKey(project.path), project])).values()];
    await Promise.all(Array.from({ length: Math.min(2, queue.length) }, async () => {
      for (let project = queue.shift(); project; project = queue.shift()) {
        const key = worktreePathKey(project.path);
        let cached = cache.get(key);
        if (!cached) { cached = { at: -Infinity }; cache.set(key, cached); }
        if (force) { await cached.pending; cached.at = -Infinity; }
        if (!cached.pending && now() - cached.at >= 5000) {
          const current = cached;
          const path = project.path;
          current.pending = Promise.resolve().then(() => list(path))
            .then(entries => { current.entries = entries; })
            .catch(() => { /* Keep the last successful snapshot on transient Git errors. */ })
            .finally(() => { current.at = now(); current.pending = undefined; });
        }
        await cached.pending;
      }
    }));
    return projects.flatMap(project => {
      const records = managed.filter(record => record.project_id === project.id && record.origin !== "discovered");
      const entries = canDiscoverWorktrees(project) ? cache.get(worktreePathKey(project.path))?.entries : undefined;
      return entries ? mergeDiscoveredWorktrees(project, records, entries) : records;
    });
  };
}

export const discoverWorktrees = createWorktreeDiscovery(projectPath =>
  invoke<GitDiscoveredWorktree[]>("git_worktree_list", { projectPath }));
