import type { Project, TerminalSession, TerminalWorkspaceBinding, WorktreeRecord } from "./types";
import { resolveTerminalWorkspace } from "./workspaceTerminals";

type BindingInput = Pick<TerminalSession, "projectId" | "worktreeId" | "workspace" | "cwd" | "environmentType" | "sshHostId" | "remotePath">;

/** Resolve at creation/legacy hydration, never on OSC cwd changes or sidebar renders. */
export function bindTerminalWorkspace(
  input: BindingInput, projects: Project[], worktrees: WorktreeRecord[],
): Pick<TerminalSession, "projectId" | "worktreeId" | "workspace"> {
  if (input.workspace !== undefined) {
    return { workspace: input.workspace, projectId: input.workspace?.projectId ?? input.projectId, worktreeId: input.workspace ? input.workspace.worktreeId : input.worktreeId };
  }
  const scope = resolveTerminalWorkspace({ ...input, id: "", title: "" }, projects, worktrees);
  const project = projects.find(item => item.id === scope?.projectId);
  if (!project) return { workspace: null, projectId: input.projectId, worktreeId: input.worktreeId };
  const worktreeId = input.worktreeId ?? scope?.worktreeId;
  const worktree = worktrees.find(item => item.id === worktreeId && item.project_id === project.id);
  const workspace: TerminalWorkspaceBinding = {
    id: worktreeId ?? `main:${project.id}`,
    projectId: project.id,
    ...(worktreeId ? { worktreeId } : {}),
    // Keep an absent legacy Worktree's identity; never silently attach it to main.
    path: worktree?.path ?? (worktreeId ? input.cwd ?? "" : project.environment_type === "ssh" ? project.remote_path : project.path),
    environmentType: project.environment_type ?? "local",
    ...(project.environment_type === "ssh" ? { sshHostId: project.ssh_host_id ?? undefined } : {}),
  };
  return { projectId: project.id, worktreeId, workspace };
}

export function terminalWorkspaceEnvironment(
  workspace: TerminalWorkspaceBinding | null, env?: Record<string, string> | null,
): Record<string, string> {
  const result = { ...env };
  // Explicitly replace inherited ownership, including on ordinary shells without Hooks.
  result.CLI_MANAGER_WORKSPACE = JSON.stringify(workspace);
  result.CLI_MANAGER_WORKTREE_ID = workspace?.id ?? "";
  result.CLI_MANAGER_PROJECT_ID = workspace?.projectId ?? "";
  return result;
}
