import type { TerminalSession, WorktreeRecord } from "./types";
import { resolveTerminalRuntimeEnvironment } from "./terminalRuntimeEnvironment";

function pathKey(path?: string): string {
  const normalized = path?.replace(/^\\\\\?\\/, "").replace(/\\/g, "/").replace(/\/+$/, "") ?? "";
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

/** UI sessions supplement daemon preflight, including a tab still starting its PTY. */
export function worktreeRelatedSessions(
  worktree: WorktreeRecord, canonicalPath: string, sessions: readonly TerminalSession[],
  statuses: Readonly<Record<string, string | undefined>>,
): TerminalSession[] {
  const roots = [pathKey(worktree.path), pathKey(canonicalPath)].filter(Boolean);
  const inside = (path?: string) => {
    const key = pathKey(path);
    return Boolean(key) && roots.some(root => key === root || key.startsWith(`${root}/`));
  };
  return sessions.filter(session => (session.kind === undefined || session.kind === "pty" || session.kind === "synced-history") && statuses[session.id] === "running"
    && resolveTerminalRuntimeEnvironment(session) !== "ssh"
    && ((session.workspace?.worktreeId ?? session.worktreeId) === worktree.id
      || inside(session.workspace?.path) || inside(session.cwd)));
}
