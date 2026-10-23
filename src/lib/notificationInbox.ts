import type { TerminalSession } from "./types";
import { resolveTerminalRuntimeEnvironment, terminalRuntimeWslDistro } from "./terminalRuntimeEnvironment";

export interface InboxTarget {
  source: string;
  tabId: string;
  cliSessionId: string | null;
  agentRunId: string | null;
  environment: "local" | "wsl" | "ssh";
  hostId: string | null;
  wslDistro: string | null;
}

export interface InboxEntry extends InboxTarget {
  sequence: number;
  eventId: string;
  event: "Notification" | "PermissionRequest" | "Stop" | "StopFailure";
  source: string;
  projectId: string | null;
  cwd: string | null;
  title: string | null;
  message: string | null;
  toolName: string | null;
  occurredAt: string | null;
  receivedAt: number;
  readAt: number | null;
}

export interface InboxUnreadTarget extends InboxTarget { count: number; latestSequence: number }
export interface InboxPage {
  entries: InboxEntry[];
  unreadCount: number;
  latestSequence: number;
  nextBefore: number | null;
  trimmedCount: number;
  unreadTargets: InboxUnreadTarget[];
}

export function inboxTargetKey(target: InboxTarget): string {
  return JSON.stringify([target.source, target.environment, target.hostId, target.wslDistro, target.tabId, target.cliSessionId, target.agentRunId]);
}

function sameEnvironment(target: InboxTarget, session: TerminalSession): boolean {
  const distro = terminalRuntimeWslDistro(session);
  const environment = resolveTerminalRuntimeEnvironment(session);
  if (environment !== target.environment) return false;
  if (environment === "ssh") return Boolean(target.hostId) && session.sshHostId === target.hostId;
  // An exact terminal/CLI identity can safely resolve a distro-less restored
  // shell; a known different distro must never match.
  return environment !== "wsl" || !target.wslDistro || !distro || target.wslDistro.toLowerCase() === distro.toLowerCase();
}

/** Never resolve by path alone: same-path projects on two hosts are distinct. */
export function resolveNotificationTarget(target: InboxTarget, sessions: TerminalSession[]): TerminalSession | null {
  const candidates = sessions.filter(session => (session.kind ?? "pty") === "pty" && sameEnvironment(target, session)
    && (!session.runtimeAgent?.tool || session.runtimeAgent.tool === target.source));
  const sameConversation = (session: TerminalSession) => Boolean(target.cliSessionId && session.cliSessionId === target.cliSessionId);
  const exact = candidates.find(session => session.id === target.tabId && (
    target.cliSessionId ? sameConversation(session)
      : target.agentRunId ? session.runtimeAgent?.runId === target.agentRunId : true
  ));
  if (exact) return exact;
  const resumed = candidates.filter(sameConversation);
  return resumed.length === 1 ? resumed[0] : null;
}

export function getUnreadCountForSession(targets: InboxUnreadTarget[], session: TerminalSession, sessions: TerminalSession[]): number {
  return targets.reduce((count, target) => count + (resolveNotificationTarget(target, sessions)?.id === session.id ? target.count : 0), 0);
}

/** Build once per changed summary/session snapshot, then use O(1) tab lookups. */
export function getUnreadCountsBySession(targets: InboxUnreadTarget[], sessions: TerminalSession[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const target of targets) {
    const session = resolveNotificationTarget(target, sessions);
    if (session) counts.set(session.id, (counts.get(session.id) ?? 0) + target.count);
  }
  return counts;
}

export function shouldAutoReadInbox(input: {
  visible: boolean; focused: boolean; windowFocused: boolean; windowVisible: boolean;
  minimized: boolean; documentVisible: boolean; terminalFocused: boolean;
}): boolean {
  return input.visible && input.focused && input.windowFocused && input.windowVisible
    && !input.minimized && input.documentVisible && input.terminalFocused;
}

export function mergeInboxPages(previous: InboxEntry[], incoming: InboxEntry[], limit = 200): InboxEntry[] {
  const byId = new Map(previous.map(entry => [entry.eventId, entry]));
  for (const entry of incoming) byId.set(entry.eventId, entry);
  return [...byId.values()].sort((a, b) => b.sequence - a.sequence).slice(0, limit);
}
