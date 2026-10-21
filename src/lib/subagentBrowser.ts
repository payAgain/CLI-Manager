import { resolveCliToolHistorySourceId } from "./cliTools";
import { extractCodexResumeSessionId } from "./resumeCliArgs";
import type { Project, TerminalSession } from "./types";

export interface SubagentRecord {
  agentId: string;
  title: string;
  transcriptPath: string;
  parentTranscriptPath?: string | null;
}

export function resolveSubagentConfigDir(
  source: "codex" | "claude",
  session: TerminalSession,
  project: Project | null | undefined,
  defaults: { codexConfigDir?: string | null; claudeConfigDir?: string | null },
): string | null {
  return session.envVars?.[source === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"]?.trim()
    || project?.cli_config_root?.trim()
    || (source === "codex" ? defaults.codexConfigDir : defaults.claudeConfigDir)?.trim()
    || null;
}

export function resolveSubagentBrowserIdentity(session: TerminalSession | null, project?: Project | null) {
  if (!session || (session.kind && session.kind !== "pty")) return null;
  const pending = session.pendingConversationResume;
  const pendingActive = pending && pending.expiresAtMs > Date.now();
  const tool = session.runtimeAgent?.tool || (pendingActive ? pending.tool : undefined)
    || session.cliTool || project?.cli_tool || /(?:^|\s)(codex|claude)(?:\s|$)/i.exec(session.startupCmd ?? "")?.[1];
  const source = resolveCliToolHistorySourceId(tool ?? "");
  if (source !== "codex" && source !== "claude") return null;
  const resumeId = source === "codex" ? extractCodexResumeSessionId(session.startupCmd)
    : /(?:^|\s)(?:--resume|-r)\s+["']?([a-zA-Z0-9._-]+)/.exec(session.startupCmd ?? "")?.[1];
  const parentSessionId = session.runtimeAgent?.cliSessionId || (pendingActive ? pending.sessionId : undefined)
    || session.cliSessionId || resumeId;
  if (!parentSessionId || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(parentSessionId)) return null;
  return { source, parentSessionId };
}

export function inferWslDistroFromCwd(cwd: string | null | undefined): string | null {
  const value = cwd?.trim();
  if (!value) return null;
  const normalized = value.replace(/\//g, "\\");
  const match = normalized.match(/^(?:\\\\wsl(?:\.localhost|\$)\\|\\\\\?\\UNC\\wsl(?:\.localhost|\$)\\)([^\\]+)(?:\\|$)/i);
  return match?.[1]?.trim() || null;
}
