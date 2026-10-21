import { runtimeAgentTool } from "./terminalAgent";
import { resolveCliToolHistorySourceId } from "./cliTools";
import type { Project, TerminalSession } from "./types";

export function resolveTerminalMarkdownSource(
  session: TerminalSession | null | undefined,
  project: Project | null | undefined,
): "claude" | "codex" | null {
  if (!session && !project) return null;
  if (session && runtimeAgentTool(session) !== undefined) {
    const source = resolveCliToolHistorySourceId(runtimeAgentTool(session));
    return source === "claude" || source === "codex" ? source : null;
  }
  const explicitSource = [session?.cliTool, project?.cli_tool]
    .map((value) => resolveCliToolHistorySourceId(value))
    .find((value): value is "claude" | "codex" => value === "claude" || value === "codex");
  if (explicitSource) return explicitSource;
  const text = `${session?.startupCmd ?? ""} ${session?.title ?? ""} ${project?.cli_tool ?? ""}`.toLowerCase();
  if (/\bclaude\b/u.test(text)) return "claude";
  if (/\bcodex\b/u.test(text)) return "codex";
  return null;
}

export function isTerminalMarkdownPreviewSupported(
  session: TerminalSession | null | undefined,
  project: Project | null | undefined,
): boolean {
  return resolveTerminalMarkdownSource(session, project) !== null;
}
