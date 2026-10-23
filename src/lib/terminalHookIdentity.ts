import type { TerminalSession } from "./types";
import { persistTerminalSession } from "./terminalConversationRestore";

const hookObservations = new Map<string, { receivedAt: number; timestamp: number }>();
const pendingIdentities = new Map<string, { identity: string }>();

/** Keep the daemon ordering watermark off the globally subscribed sessions array. */
export function observeHookIdentity(sessionId: string, timestamp?: string | null): boolean {
  const receivedAt = Date.now();
  const parsed = timestamp ? Date.parse(timestamp) : NaN;
  const eventAt = Number.isFinite(parsed) ? parsed : receivedAt;
  const previous = hookObservations.get(sessionId);
  if (previous && eventAt < previous.timestamp) return false;
  hookObservations.set(sessionId, { receivedAt: Math.max(previous?.receivedAt ?? 0, receivedAt), timestamp: eventAt });
  return true;
}

export function isDetectionOlderThanHook(sessionId: string, updatedAtMs: number): boolean {
  return updatedAtMs < (hookObservations.get(sessionId)?.receivedAt ?? 0);
}

function identityKey(session: TerminalSession | undefined): string {
  if (!session) return "";
  const saved = persistTerminalSession(session);
  return JSON.stringify([saved.isAgentSession, saved.cliTool, saved.cliSessionId, saved.remoteTranscriptRef, saved.cliReasoningEffort]);
}

/** Unchanged Hooks neither serialize every terminal nor enqueue duplicate pending writes. */
export async function persistChangedHookIdentity(
  session: TerminalSession,
  saved: TerminalSession | undefined,
  write: () => Promise<void>,
): Promise<void> {
  const identity = identityKey(session);
  const pending = pendingIdentities.get(session.id);
  if (pending ? pending.identity === identity : identity === identityKey(saved)) return;
  const request = { identity };
  pendingIdentities.set(session.id, request);
  try { await write(); }
  finally { if (pendingIdentities.get(session.id) === request) pendingIdentities.delete(session.id); }
}

export function retainHookIdentities(sessions: readonly Pick<TerminalSession, "id">[]): void {
  const ids = new Set(sessions.map(session => session.id));
  for (const id of hookObservations.keys()) if (!ids.has(id)) hookObservations.delete(id);
  for (const id of pendingIdentities.keys()) if (!ids.has(id)) pendingIdentities.delete(id);
}
