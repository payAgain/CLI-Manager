export type TaskDisplayStatus = "running" | "attention" | "done" | "failed" | "pending" | "interrupted" | "unknown";

const TASK_PRIORITY: Record<TaskDisplayStatus, number> = {
  attention: 0, failed: 0, interrupted: 0, running: 1, pending: 2, unknown: 3, done: 4,
};

/** Tasks that need action stay above ongoing work and completed records. */
export function compareTaskActivity(
  left: { status: TaskDisplayStatus; updatedAt: number },
  right: { status: TaskDisplayStatus; updatedAt: number },
) {
  return TASK_PRIORITY[left.status] - TASK_PRIORITY[right.status] || right.updatedAt - left.updatedAt;
}

/** Missing progress is indeterminate; it must never be displayed as a guessed percentage. */
export function taskProgress(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
}

export function backgroundTaskStatus(task: { taskStatus?: string | null; alive: boolean }): TaskDisplayStatus {
  const status = task.taskStatus;
  if (status === "running" || status === "attention" || status === "done" || status === "failed") return status;
  return task.alive ? "running" : "done";
}
