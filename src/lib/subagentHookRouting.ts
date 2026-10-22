import type { CliHookPayload } from "../stores/terminalStore";

interface SubagentHookHandlers {
  bind: (payload: CliHookPayload) => string | null;
  open: (payload: CliHookPayload) => Promise<void>;
  finish: (payload: CliHookPayload) => void;
}

/** Tool hooks describe activity inside an agent, not a new child lifecycle. */
export function isSubagentActivityHook(payload: CliHookPayload): boolean {
  return payload.source === "claude"
    && (payload.event === "ToolStart" || payload.event === "ToolStop")
    && Boolean(payload.agentId?.trim());
}

export function isSubagentCompletionHook(payload: CliHookPayload): boolean {
  return payload.event === "SubagentStop"
    || (payload.source === "codex" && Boolean(payload.agentId?.trim())
      && (payload.event === "Stop" || payload.event === "StopFailure"));
}

/** Bind to the current parent terminal before routing a local child event. */
export function routeSubagentHook(payload: CliHookPayload, handlers: SubagentHookHandlers): boolean {
  if (payload.environmentType === "ssh") return false;
  const claudeTool = isSubagentActivityHook(payload);
  // Codex also emits turn hooks for a child, carrying the parent's session_id.
  const codexChildTurn = payload.source === "codex" && Boolean(payload.agentId?.trim())
    && (payload.event === "SessionStart" || payload.event === "UserPromptSubmit" || payload.event === "Stop" || payload.event === "StopFailure");
  if (!claudeTool && !codexChildTurn && ![
    "SubagentStart", "SubagentStop", "AgentToolStart", "AgentToolStop",
  ].includes(payload.event)) return false;

  const tabId = handlers.bind(payload);
  if (!tabId) return true;
  const bound = { ...payload, tabId };
  const ended = isSubagentCompletionHook(payload);
  if (ended && !payload.agentTranscriptPath?.trim() && payload.source !== "codex") {
    handlers.finish(bound);
  } else if (ended) {
    void handlers.open(bound).then(() => handlers.finish(bound), () => handlers.finish(bound));
  } else {
    void handlers.open(bound);
  }
  return true;
}
