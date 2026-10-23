import { normalizeShellKey } from "./shell";
import { quoteShellPath } from "./terminalShellPath";
import { tokenizeCliArgs } from "./resumeCliArgs";
import type { TerminalSession } from "./types";

export function isConversationTargetPathSafe(path: string, shell?: string | null): boolean {
  return !!path && !/[\0\r\n]/.test(path)
    && !(normalizeShellKey(shell) === "cmd" && /[%!"]/.test(path));
}

function pathForAgent(path: string, shell?: string | null): string {
  if (normalizeShellKey(shell) !== "wsl") return path;
  const plain = path.replace(/\\/g, "/");
  const unc = /^\/\/wsl(?:\.localhost|\$)\/[^/]+(\/.*)?$/i.exec(plain);
  if (unc) return unc[1] || "/";
  if (/^[a-z]:\//i.test(plain)) return `/mnt/${plain[0].toLowerCase()}${plain.slice(2)}`;
  return plain;
}

/** Replay a user's explicit directory choice whenever the same conversation is resumed. */
export function applyConversationCwd(
  command: string, target: NonNullable<TerminalSession["conversationResumeTarget"]>, shell?: string | null,
): string | undefined {
  if (!isConversationTargetPathSafe(target.cwd, shell)) return undefined;
  const options = tokenizeCliArgs(command).map(token => token.raw.split("=", 1)[0]);
  if (options.includes("--")) return undefined;
  const path = pathForAgent(target.cwd, shell);
  if (target.tool === "codex") {
    if (options.includes("--remote")) return undefined;
    return `${command} --cd ${quoteShellPath(path, shell)}`;
  }
  if (target.tool === "claude") {
    // /cd is an interactive local command, not a model prompt or a background launch.
    if (options.some(option => ["--print", "-p", "--bg", "--background", "--cloud", "--desktop",
      "--environment", "--teleport", "--from-pr", "--tmux", "--disable-slash-commands"].includes(option)
      || /^-p.+/.test(option))) return undefined;
    // Native Claude Worktree metadata can override the process's launch cwd on resume.
    // End options explicitly so variadic flags such as --allowedTools cannot consume /cd.
    return `${command} -- ${quoteShellPath(`/cd ${path}`, shell)}`;
  }
  return undefined;
}
