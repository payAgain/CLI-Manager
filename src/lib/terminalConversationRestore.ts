import { resolveAgentTerminalMetadata } from "./agentTerminal";
import { resolveCliToolHistorySourceId } from "./cliTools";
import { buildHistoryResumeCommand } from "./historyResumeCommand";
import { applyConversationCwd } from "./terminalConversationCwd";
import { freshWorkspaceAgentArgs } from "./worktreeLaunch";
import type { Project, TerminalSession } from "./types";

/** Persist the current Agent, including manual starts, without retaining a dead process identity. */
export function persistTerminalSession(session: TerminalSession): TerminalSession {
  const { runtimeAgent, runtimeAgentObservedAtMs: _observedAt, pendingConversationResume, deferredStartupCmd: _deferredStartup, ...persisted } = session;
  if (pendingConversationResume && Date.now() <= pendingConversationResume.expiresAtMs) {
    return {
      ...persisted,
      isAgentSession: true,
      cliTool: pendingConversationResume.tool,
      cliSessionId: pendingConversationResume.sessionId,
    };
  }
  if (runtimeAgent === undefined) return persisted;
  return {
    ...persisted,
    ...resolveAgentTerminalMetadata(session, null),
    cliSessionId: runtimeAgent ? session.cliSessionId ?? runtimeAgent.cliSessionId ?? undefined : undefined,
  };
}

const AGENT_COMMAND = /(?:^|\s)(codex|claude|grok|pi)(?:\.(?:cmd|exe|ps1))?(?:\s|$)/i;

export interface TerminalConversationRestore {
  startupCmd?: string;
  cliSessionId?: string;
  isAgentSession: boolean;
  cliTool?: string;
  issue?: "missingId" | "unsupportedTool" | "unsupportedLaunch";
}

/** Recreate a conversation by exact identity; directory-scoped "last" can select another pane's chat. */
export function resolveTerminalConversationRestore(
  session: TerminalSession,
  project?: Project,
): TerminalConversationRestore {
  const saved = persistTerminalSession(session);
  const commandMatch = AGENT_COMMAND.exec(saved.startupCmd ?? "");
  const commandTool = commandMatch?.[1]?.toLowerCase();
  const tool = saved.isAgentSession === false
    ? undefined
    : saved.cliTool?.trim() || commandTool || project?.cli_tool.trim();
  if (!tool) {
    return {
      isAgentSession: false,
      // A confirmed Agent exit must not rerun its original launch command.
      startupCmd: commandTool ? undefined : saved.startupCmd?.trim() || undefined,
    };
  }
  const source = resolveCliToolHistorySourceId(tool);
  const id = saved.cliSessionId?.trim();
  if (!source || !["claude", "codex", "grok", "pi"].includes(source)) {
    return { isAgentSession: false, issue: "unsupportedTool" };
  }
  // IDs become shell arguments. Accept only a single inert token, never shell syntax or options.
  if (!id || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(id)) {
    return { isAgentSession: false, issue: "missingId" };
  }
  const target = saved.conversationResumeTarget?.tool === source && saved.conversationResumeTarget.sessionId === id
    ? saved.conversationResumeTarget : undefined;
  const resumeProject = target && project
    ? { ...project, cli_args: freshWorkspaceAgentArgs(project.cli_args, source) } : project;
  const command = buildHistoryResumeCommand({ source, session_id: id }, resumeProject);
  if (!command) return { isAgentSession: false, issue: "unsupportedTool" };
  let resumeCommand = source === "codex"
    ? command.replace(/^codex resume /, "codex resume --no-alt-screen ")
    : command;
  if (target) {
    const directedCommand = applyConversationCwd(resumeCommand, target, saved.shell || project?.shell);
    if (!directedCommand) return { isAgentSession: false, issue: "unsupportedLaunch" };
    resumeCommand = directedCommand;
  }
  // A Windows shell may enter WSL through the launch command instead of shell="wsl".
  const prefix = commandMatch ? saved.startupCmd!.slice(0, commandMatch.index).trim() : "";
  const wslPrefix = /^wsl(?:\.exe)?(?:\s|$)/i.test(prefix) ? prefix : "";
  return {
    isAgentSession: true,
    cliTool: source,
    cliSessionId: id,
    startupCmd: wslPrefix ? `${wslPrefix} ${resumeCommand}` : resumeCommand,
  };
}
