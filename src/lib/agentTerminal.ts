import type { Project, TerminalSession } from "./types";

type AgentTerminalProject = Pick<Project, "cli_tool">;
type AgentTerminalSession = Pick<TerminalSession, "isAgentSession" | "cliTool" | "runtimeAgent">;

export interface AgentTerminalMetadata {
  isAgentSession: boolean;
  cliTool?: string;
}

function normalizedCliTool(project: AgentTerminalProject | null | undefined): string {
  return project?.cli_tool.trim() ?? "";
}

export function createAgentTerminalMetadata(
  project: AgentTerminalProject | null | undefined,
  hasStartupCommand = true,
): AgentTerminalMetadata {
  const cliTool = hasStartupCommand ? normalizedCliTool(project) : "";
  return {
    isAgentSession: Boolean(cliTool),
    cliTool: cliTool || undefined,
  };
}

export function resolveAgentTerminalMetadata(
  session: AgentTerminalSession | null | undefined,
  fallbackProject: AgentTerminalProject | null | undefined
): AgentTerminalMetadata {
  if (session?.runtimeAgent !== undefined) {
    return { isAgentSession: Boolean(session.runtimeAgent), cliTool: session.runtimeAgent?.tool };
  }
  if (typeof session?.isAgentSession !== "boolean") {
    return createAgentTerminalMetadata(fallbackProject);
  }
  const cliTool = session.cliTool?.trim() || normalizedCliTool(fallbackProject);
  return {
    isAgentSession: session.isAgentSession,
    cliTool: session.isAgentSession && cliTool ? cliTool : undefined,
  };
}

export function shouldIncludeAgentTerminal(
  session: AgentTerminalSession | null | undefined,
  fallbackProject: AgentTerminalProject | null | undefined,
  agentSessionsOnly: boolean
): boolean {
  return !agentSessionsOnly || resolveAgentTerminalMetadata(session, fallbackProject).isAgentSession;
}
