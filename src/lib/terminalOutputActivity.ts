import type { TerminalSession } from "./types";

const OUTPUT_ACTIVITY_UPDATE_INTERVAL_MS = 1000;
// Only Hook routing consumes these timestamps. PTY output must not publish
// global UI updates just to keep same-directory candidate selection current.
const outputActivity = new Map<string, number>();

export function recordTerminalOutputActivity(sessionId: string): void {
  const now = Date.now();
  const previous = outputActivity.get(sessionId) ?? 0;
  if (now - previous < OUTPUT_ACTIVITY_UPDATE_INTERVAL_MS) return;
  outputActivity.set(sessionId, now);
}

export function getTerminalOutputActivity(sessionId: string): number | undefined {
  return outputActivity.get(sessionId);
}

export function clearTerminalOutputActivity(sessionId: string): void {
  outputActivity.delete(sessionId);
}

export function retainTerminalOutputActivity(sessions: readonly TerminalSession[]): void {
  const liveIds = new Set(sessions.map((session) => session.id));
  for (const sessionId of outputActivity.keys()) {
    if (!liveIds.has(sessionId)) outputActivity.delete(sessionId);
  }
}
