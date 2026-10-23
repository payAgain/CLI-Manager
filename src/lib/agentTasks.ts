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
