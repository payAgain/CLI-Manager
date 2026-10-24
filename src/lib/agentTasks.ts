import type { TranslationKey } from "./i18n";

export type AgentTaskStatus = "pending" | "running" | "done" | "failed" | "unknown";

export interface AgentTaskRecord {
  id: string;
  title: string;
  description: string;
  status: AgentTaskStatus;
  detail?: string | null;
}

export interface AgentPlanRecord {
  id: string;
  title: string;
  content: string;
  status: AgentTaskStatus;
}

export interface AgentBackgroundTaskRecord extends AgentTaskRecord {
  output?: string | null;
}

export interface AgentTasksSnapshot {
  tasks: AgentTaskRecord[];
  plans: AgentPlanRecord[];
  backgroundTasks: AgentBackgroundTaskRecord[];
  warnings: string[];
  supported: boolean;
}

/** A failed refresh preserves readable content, never stale confirmed state. */
export function unconfirmAgentTasksSnapshot(snapshot: AgentTasksSnapshot): AgentTasksSnapshot {
  return {
    ...snapshot,
    tasks: snapshot.tasks.map(task => ({ ...task, status: "unknown" })),
    plans: snapshot.plans.map(plan => ({ ...plan, status: "unknown" })),
    backgroundTasks: snapshot.backgroundTasks.map(task => ({ ...task, status: "unknown" })),
  };
}

const warningKeys: Record<string, TranslationKey> = {
  transcript_line_limit_reached: "terminal.agentTasks.warning.recordLimit",
  transcript_projection_limit_reached: "terminal.agentTasks.warning.recordLimit",
  transcript_invalid_json: "terminal.agentTasks.warning.invalidRecord",
  transcript_incomplete: "terminal.agentTasks.warning.reading",
  transcript_changed_during_read: "terminal.agentTasks.warning.updating",
  transcript_session_mismatch: "terminal.agentTasks.warning.sessionMismatch",
  task_limit_reached: "terminal.agentTasks.warning.taskLimit",
  task_file_limit_reached: "terminal.agentTasks.warning.taskLimit",
  plan_limit_reached: "terminal.agentTasks.warning.planLimit",
  background_limit_reached: "terminal.agentTasks.warning.backgroundLimit",
  pending_tool_limit_reached: "terminal.agentTasks.warning.pendingLimit",
  tool_input_limit_reached: "terminal.agentTasks.warning.inputLimit",
  tool_arguments_invalid: "terminal.agentTasks.warning.invalidArguments",
  task_create_id_unconfirmed: "terminal.agentTasks.warning.taskIdentity",
  background_task_id_unconfirmed: "terminal.agentTasks.warning.taskIdentity",
  plan_update_unconfirmed: "terminal.agentTasks.warning.planUnconfirmed",
  plan_content_unavailable: "terminal.agentTasks.warning.planUnavailable",
  tool_results_pending: "terminal.agentTasks.warning.pendingResults",
  background_status_unconfirmed: "terminal.agentTasks.warning.backgroundUnconfirmed",
  task_files_unavailable: "terminal.agentTasks.warning.taskUnavailable",
  task_file_unavailable: "terminal.agentTasks.warning.taskUnavailable",
  task_path_outside_root: "terminal.agentTasks.warning.taskPath",
  task_file_invalid_or_limited: "terminal.agentTasks.warning.taskInvalid",
  task_file_identity_mismatch: "terminal.agentTasks.warning.taskFileIdentity",
  ssh_agent_tasks_unsupported: "terminal.agentTasks.remoteUnsupported",
  agent_tasks_source_unsupported: "terminal.agentTasks.unsupported",
};

/** Explain known read conditions without exposing internal codes as product copy. */
export function agentTaskWarningKey(code: string): TranslationKey {
  return Object.prototype.hasOwnProperty.call(warningKeys, code)
    ? warningKeys[code]
    : "terminal.agentTasks.warning.unknown";
}
