import type { TerminalSession } from "./types";

export interface RuntimeAgent {
  tool: string;
  runId: string;
  source: "process" | "hook";
  detectedAtMs: number;
  pid?: number;
  startedAt?: number;
  /** Latest exact ID supplied by a Hook, also carried in daemon reconnect snapshots. */
  cliSessionId?: string | null;
}

export interface AgentDetection {
  agent: Omit<RuntimeAgent, "source"> | null;
  updatedAtMs: number;
}

export function applyAgentDetection(session: TerminalSession, detection: AgentDetection): TerminalSession {
  if (session.runtimeAgentObservedAtMs != null && detection.updatedAtMs < session.runtimeAgentObservedAtMs) return session;
  const next = detection.agent ? { ...detection.agent, source: "process" as const } : null;
  const pending = session.pendingConversationResume;
  const pendingValid = pending && detection.updatedAtMs <= pending.expiresAtMs;
  const waitingForResume = pendingValid && !next;
  const matchingResume = pendingValid && next?.tool === pending.tool;
  if (!pending && session.runtimeAgent !== undefined && session.runtimeAgent?.runId === next?.runId
    && session.runtimeAgent?.source !== "hook") {
    const id = detection.agent?.cliSessionId;
    return id && id !== session.cliSessionId
      ? { ...session, runtimeAgent: next, runtimeAgentObservedAtMs: detection.updatedAtMs, cliSessionId: id }
      : session;
  }
  // A Hook can beat the first poll; promoting its matching run must retain the session ID.
  const preserveBinding = session.runtimeAgent?.source === "hook"
    && session.runtimeAgent.tool === next?.tool
    && (!session.runtimeAgent.runId.startsWith("hook:") ? session.runtimeAgent.runId === next.runId : true);
  return {
    ...session,
    runtimeAgent: next,
    runtimeAgentObservedAtMs: detection.updatedAtMs,
    pendingConversationResume: waitingForResume ? pending : undefined,
    ...(preserveBinding ? {} : {
      cliSessionId: detection.agent?.cliSessionId ?? (waitingForResume || matchingResume ? pending?.sessionId : undefined),
      cliReasoningEffort: undefined,
      remoteTranscriptRef: undefined,
    }),
  };
}

export function acceptsAgentHook(
  session: TerminalSession,
  payload: { source?: string | null; agentRunId?: string | null; timestamp?: string | null },
): boolean {
  const agent = session.runtimeAgent;
  if (agent === null) return false;
  if (!agent) return true; // Older daemon / guest-side Hook evidence.
  if (agent.source === "process" && payload.source && payload.source !== agent.tool) return false;
  if (payload.agentRunId && payload.agentRunId !== agent.runId) return false;
  const timestamp = payload.timestamp ? Date.parse(payload.timestamp) : NaN;
  const lowerBound = agent.source === "process" ? (agent.startedAt ?? 0) * 1000 : agent.detectedAtMs;
  return !Number.isFinite(timestamp) || timestamp >= lowerBound;
}

export function applyHookAgentIdentity(
  session: TerminalSession,
  payload: { source?: string | null; agentRunId?: string | null; sessionId?: string | null; timestamp?: string | null },
): TerminalSession {
  if (!payload.source || session.runtimeAgent?.source === "process") return session;
  const runId = payload.agentRunId ?? (payload.sessionId
    ? `hook:${payload.source}:${payload.sessionId}`
    : session.runtimeAgent?.runId ?? `hook:${payload.source}:${session.id}`);
  if (session.runtimeAgent?.runId === runId && session.runtimeAgent.tool === payload.source) return session;
  const timestamp = payload.timestamp ? Date.parse(payload.timestamp) : NaN;
  return {
    ...session,
    runtimeAgent: { tool: payload.source, runId, source: "hook", detectedAtMs: Number.isFinite(timestamp) ? timestamp : Date.now() },
    pendingConversationResume: undefined,
    cliSessionId: undefined,
    cliReasoningEffort: undefined,
    remoteTranscriptRef: undefined,
  };
}

/** Undefined = discovery has not answered; null = confirmed ordinary shell. */
export function runtimeAgentTool(session: Pick<TerminalSession, "runtimeAgent">): string | null | undefined {
  return session.runtimeAgent === undefined ? undefined : session.runtimeAgent?.tool ?? null;
}
