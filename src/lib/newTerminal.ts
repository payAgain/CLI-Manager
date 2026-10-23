import type { Project, TerminalSession, WorktreeRecord, TerminalWorkspaceBinding } from "./types";
import { parseProjectEnvVars } from "./projectEnv";

export interface NewTerminalContext {
  project: Project | null;
  projectId?: string;
  cwd?: string;
  title: string;
  shell?: string;
  envVars?: Record<string, string>;
  worktreeId?: string;
  workspace?: TerminalWorkspaceBinding | null;
  sshHostId?: string;
  remote: boolean;
}

/** Resolve both discovery and launch from the same workspace, including blank shells. */
export function resolveNewTerminalContext(
  session: TerminalSession | null,
  project: Project | null,
  worktree: WorktreeRecord | null,
  defaultShell: string,
): NewTerminalContext {
  const remote = session?.environmentType === "ssh" || project?.environment_type === "ssh";
  const envVars = { ...parseProjectEnvVars(project ?? { env_vars: "" }), ...session?.envVars };
  return {
    project,
    projectId: session?.projectId ?? project?.id,
    cwd: remote
      ? session?.remotePath || project?.remote_path || session?.cwd || undefined
      : session?.fileEditor?.projectPath || session?.cwd || worktree?.path || project?.path || undefined,
    title: project?.name || session?.title || "Terminal",
    shell: remote ? undefined : session?.shell || project?.shell || defaultShell,
    envVars: Object.keys(envVars).length ? envVars : undefined,
    worktreeId: worktree?.id ?? session?.worktreeId,
    workspace: session?.workspace,
    sshHostId: remote ? session?.sshHostId || project?.ssh_host_id || undefined : undefined,
    remote,
  };
}

export function resolveNewTerminalCommand(context: NewTerminalContext, tool: string): string {
  const project = context.project;
  // Project arguments only belong to that Agent; never clone a live conversation's resume command.
  return project?.cli_tool.trim().toLowerCase() === tool && !project.startup_cmd.trim()
    ? [tool, project.cli_args.trim()].filter(Boolean).join(" ")
    : tool;
}
