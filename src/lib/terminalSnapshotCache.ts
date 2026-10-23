import type { TerminalSession } from "./types";

// Checkpoints are persistence data, not UI metadata. Keeping them outside the
// terminal store avoids notifying every mounted terminal for every snapshot.
const snapshots = new Map<string, string>();

export function setTerminalSnapshot(sessionId: string, text: string): void {
  snapshots.set(sessionId, text);
}

export function getTerminalSnapshot(session: TerminalSession | null | undefined): string | undefined {
  if (!session) return undefined;
  return snapshots.get(session.id) ?? session.initialTerminalOutput;
}

/** Capture a DTO now, before an asynchronous persistence write is queued. */
export function withTerminalSnapshot(session: TerminalSession): TerminalSession {
  const initialTerminalOutput = getTerminalSnapshot(session);
  return initialTerminalOutput === session.initialTerminalOutput
    ? session
    : { ...session, initialTerminalOutput };
}

// Component unmounts can be temporary (theme, layout or renderer changes).
// Only the session lifecycle may discard a cached snapshot.
export function retainTerminalSnapshots(sessions: readonly TerminalSession[]): void {
  const liveIds = new Set(sessions.map((session) => session.id));
  for (const sessionId of snapshots.keys()) {
    if (!liveIds.has(sessionId)) snapshots.delete(sessionId);
  }
}
