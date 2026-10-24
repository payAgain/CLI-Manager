import type { TerminalSession } from "./types";

export type WorkspaceDisplayStatus = "working" | "attention" | "failed" | "done" | "ready" | "connecting" | "stopped" | "unavailable";

/** A live PTY is ready; only Hook/shell task evidence can mark it as working. */
export function workspaceTerminalStatus(session: TerminalSession, status?: string, notification?: string): WorkspaceDisplayStatus {
  if (status === "error" || session.connectionState === "failed") return "failed";
  if (status !== "running" || session.connectionState === "disconnected") return "stopped";
  if (session.connectionState === "connecting" || session.connectionState === "authenticating") return "connecting";
  if (notification === "attention") return "attention";
  if (notification === "failed") return "failed";
  if (notification === "running") return "working";
  if (notification === "done") return "done";
  return "ready";
}

export function workspaceDisplayStatus(
  sessions: readonly TerminalSession[], statuses: Readonly<Record<string, string | undefined>>,
  notifications: Readonly<Record<string, string | undefined>>, invalid = false,
): WorkspaceDisplayStatus {
  if (invalid) return "unavailable";
  const states = sessions.filter(session => (session.kind ?? "pty") === "pty")
    .map(session => workspaceTerminalStatus(session, statuses[session.id], notifications[session.id]));
  return (["attention", "failed", "working", "connecting", "ready", "done"] as const).find(state => states.includes(state)) ?? "stopped";
}
