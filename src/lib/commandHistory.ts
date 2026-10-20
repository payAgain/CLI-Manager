import type { CommandHistoryEntry } from "./types";

const MAX_COMMAND_LENGTH = 4096;
const SENSITIVE_ARGUMENT = /(?:--?(?:password|passwd|token|secret|api[-_]?key|access[-_]?key|authorization|client[-_]?secret)(?:[=\s]|$)|\b[\w]*(?:password|passwd|token|secret|api_?key|access_?key)[\w]*\s*=|\b(?:authorization|proxy-authorization)\s*:|[a-z][a-z\d+.-]*:\/\/[^\s/@:]+:[^\s/@]+@)/iu;
const CREDENTIAL_VALUE = /\b(?:sk-[a-z\d_-]{16,}|gh[pousr]_[a-z\d]{20,}|github_pat_[a-z\d_]{20,}|AKIA[A-Z\d]{16}|eyJ[a-z\d_-]{8,}\.[a-z\d_-]+\.[a-z\d_-]+)/iu;

/** Accept confirmed single-line shell commands; never guess commands from keystrokes. */
export function normalizeHistoryCommand(command: string): string | null {
  // A leading space is the conventional opt-out from shell history.
  if (!command || /^\s/u.test(command) || command.length > MAX_COMMAND_LENGTH) return null;
  if (/[\x00-\x1f\x7f-\x9f]/u.test(command)) return null;
  const value = command.trimEnd();
  if (!value || SENSITIVE_ARGUMENT.test(value) || CREDENTIAL_VALUE.test(value)) return null;
  return value;
}

export function recentTemplateCommands(entries: CommandHistoryEntry[], query = "", limit = 50): CommandHistoryEntry[] {
  const seen = new Set<string>();
  const keyword = query.trim().toLocaleLowerCase();
  return [...entries].sort((a, b) => Number(b.executed_at) - Number(a.executed_at)).filter((entry) => {
    const command = normalizeHistoryCommand(entry.command);
    if (!command || seen.has(command) || (keyword && !command.toLocaleLowerCase().includes(keyword))) return false;
    seen.add(command);
    return true;
  }).slice(0, limit);
}
