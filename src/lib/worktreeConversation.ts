import { resolveTerminalConversationRestore, persistTerminalSession } from "./terminalConversationRestore";
import { freshWorkspaceAgentArgs } from "./worktreeLaunch";
import { quoteShellPath } from "./terminalShellPath";
import { parseProjectEnvVars } from "./projectEnv";
import { normalizeShellKey } from "./shell";
import type { Project, TerminalSession, WorktreeRecord } from "./types";

export type WorktreeContinuationIssue = "notAgent" | "missingId" | "unsupportedTool" | "remoteUnsupported"
  | "unbound" | "sourceChanged" | "missingTarget" | "sameTarget" | "unsupportedLaunch" | "busy" | "invalidPath";

export class WorktreeContinuationError extends Error {
  constructor(public readonly issue: WorktreeContinuationIssue) { super(issue); }
}

export function worktreeConversationIdentity(session: TerminalSession, project?: Project) {
  const conversation = resolveTerminalConversationRestore(session, project);
  const issue: WorktreeContinuationIssue | undefined = (session.kind ?? "pty") !== "pty" ? "notAgent"
    : session.environmentType === "ssh" || project?.environment_type === "ssh" ? "remoteUnsupported"
    : conversation.issue ?? (!conversation.isAgentSession ? "notAgent" : undefined);
  if (issue) return { issue };
  if (!conversation.cliSessionId) return { issue: "missingId" as const };
  if (conversation.cliTool !== "codex" && conversation.cliTool !== "claude") return { issue: "unsupportedTool" as const };
  // A shell wrapper can carry its own distro/cwd/env. Do not silently replace it with a host CLI.
  if (/^wsl(?:\.exe)?\s/i.test(session.startupCmd?.trim() ?? "")) return { issue: "unsupportedLaunch" as const };
  return { sessionId: conversation.cliSessionId, tool: conversation.cliTool };
}

function pathForAgent(path: string, shell?: string | null): string {
  if (normalizeShellKey(shell) !== "wsl") return path;
  const plain = path.replace(/\\/g, "/");
  const unc = /^\/\/wsl(?:\.localhost|\$)\/[^/]+(\/.*)?$/i.exec(plain);
  if (unc) return unc[1] || "/";
  if (/^[a-z]:\//i.test(plain)) return `/mnt/${plain[0].toLowerCase()}${plain.slice(2)}`;
  return plain;
}

export interface WorktreeContinuationPlan {
  source: TerminalSession;
  project: Project;
  worktree: WorktreeRecord | null;
  cwd: string;
  tool: string;
  conversationId: string;
  startupCmd: string;
  envVars: Record<string, string>;
}

export function planWorktreeContinuation(
  source: TerminalSession, project: Project, worktree: WorktreeRecord | null, expectedConversationId: string,
): WorktreeContinuationPlan {
  const identity = worktreeConversationIdentity(source, project);
  if (identity.issue) throw new WorktreeContinuationError(identity.issue);
  if (identity.sessionId !== expectedConversationId) throw new WorktreeContinuationError("sourceChanged");
  if (source.workspace === null || (source.workspace?.projectId ?? source.projectId) !== project.id) throw new WorktreeContinuationError("unbound");
  if (worktree && (worktree.project_id !== project.id || worktree.status !== "active")) throw new WorktreeContinuationError("missingTarget");
  if ((source.workspace?.worktreeId ?? source.worktreeId) === worktree?.id) throw new WorktreeContinuationError("sameTarget");
  const cwd = worktree?.path ?? project.path;
  const shell = source.shell || project.shell;
  if (!cwd || /[\0\r\n]/.test(cwd) || (normalizeShellKey(shell) === "cmd" && /[%!"]/.test(cwd))) throw new WorktreeContinuationError("invalidPath");
  const cleanProject = { ...project, cli_args: freshWorkspaceAgentArgs(project.cli_args, identity.tool!) };
  const conversation = resolveTerminalConversationRestore(source, cleanProject);
  let startupCmd = conversation.startupCmd!;
  if (identity.tool === "codex") {
    // Explicit resume otherwise restores the recorded cwd; the target directory is authoritative.
    if (/(?:^|\s)--remote(?:=|\s|$)/.test(startupCmd)) throw new WorktreeContinuationError("unsupportedLaunch");
    startupCmd += ` --cd ${quoteShellPath(pathForAgent(cwd, shell), shell)}`;
  }
  return {
    source: persistTerminalSession(source), project, worktree, cwd, tool: identity.tool!,
    conversationId: identity.sessionId!, startupCmd,
    envVars: { ...parseProjectEnvVars(project), ...source.envVars },
  };
}

/** Stop must be acknowledged before launch; retain the original exact identity on launch failure. */
export async function executeWorktreeContinuation(ports: {
  preflight: () => Promise<void>;
  saveRecovery: () => Promise<void>;
  stopSource: () => Promise<void>;
  openTarget: () => Promise<string>;
  removeSource: () => Promise<void>;
  restoreSource: () => Promise<void>;
}): Promise<string> {
  await ports.preflight();
  await ports.saveRecovery();
  await ports.stopSource();
  let id: string;
  try { id = await ports.openTarget(); }
  catch (error) { await ports.restoreSource(); throw error; }
  await ports.removeSource();
  return id;
}
