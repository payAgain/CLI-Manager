import { resolveDirectCliToolCommand } from "./cliTools";
import { stripPiResumeCliArgs } from "./historyResumeCommand";
import { resolveProjectStartupCommand } from "./projectStartupCommand";
import { stripResumeCliArgs, tokenizeCliArgs } from "./resumeCliArgs";
import type { Project } from "./types";

export type WorktreeLaunchMode = "agent" | "shell" | "none";

/** A workspace launch owns its directory and must not reuse a saved conversation selector. */
export function freshWorkspaceAgentArgs(args: string, tool: string): string {
  const tokens = tokenizeCliArgs(tool === "pi" ? stripPiResumeCliArgs(args) : stripResumeCliArgs(args));
  const kept: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i].raw;
    if ((tool === "codex" && /^-C.+/.test(raw)) || (tool === "claude" && /^-[rw].+/.test(raw))) continue;
    const name = raw.split("=", 1)[0];
    const valueOption = name === "--session-id"
      || (tool === "claude" && name === "-r")
      || (tool === "codex" && (name === "--cd" || name === "-C"));
    const optionalWorktreeName = tool === "claude" && (name === "--worktree" || name === "-w");
    if (valueOption || optionalWorktreeName) {
      if (!raw.includes("=") && tokens[i + 1] && !tokens[i + 1].raw.startsWith("-")) i++;
      continue;
    }
    if ((tool === "claude" && ["-c", "--fork-session"].includes(name))
      || (tool === "codex" && name === "--worktree")) continue;
    kept.push(raw);
  }
  return kept.join(" ");
}

export function defaultWorktreeLaunchMode(project: Project): WorktreeLaunchMode {
  return resolveProjectStartupCommand(project) ? "agent" : "shell";
}

/** null creates only the checkout; empty string explicitly starts a plain shell. */
export function worktreeStartupCommand(project: Project, mode: WorktreeLaunchMode): string | null {
  if (mode === "none") return null;
  if (mode === "shell") return "";
  const command = resolveProjectStartupCommand(project) ?? "";
  const tool = resolveDirectCliToolCommand(command);
  if (!tool || !["codex", "claude", "pi", "grok"].includes(tool)) return command;
  return freshWorkspaceAgentArgs(command, tool);
}
