import type { WorktreeRecord } from "./types";

type WorktreeManagementTarget =
  | { worktree: WorktreeRecord; error: null }
  | { worktree: null; error: "external_worktree_read_only" | "worktree_target_changed" };

/** Recheck an open menu/dialog against the current ownership snapshot. */
export function resolveWorktreeManagementTarget(
  target: WorktreeRecord,
  worktrees: WorktreeRecord[],
): WorktreeManagementTarget {
  const current = worktrees.find((worktree) => worktree.id === target.id);
  if (target.origin === "discovered" || current?.origin === "discovered") {
    return { worktree: null, error: "external_worktree_read_only" };
  }
  if (!current || current.project_id !== target.project_id || current.path !== target.path || current.branch !== target.branch) {
    return { worktree: null, error: "worktree_target_changed" };
  }
  return { worktree: current, error: null };
}

/** Removal is available for both app-created and discovered Git registrations. */
export function resolveWorktreeRemovalTarget(target: WorktreeRecord, worktrees: WorktreeRecord[]): WorktreeManagementTarget {
  const current = worktrees.find(worktree => worktree.id === target.id);
  if (!current || current.project_id !== target.project_id || current.path !== target.path || current.branch !== target.branch) {
    return { worktree: null, error: "worktree_target_changed" };
  }
  return { worktree: current, error: null };
}
