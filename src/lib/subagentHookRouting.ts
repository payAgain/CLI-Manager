import type { CliHookPayload } from "../stores/terminalStore";

interface SubagentHookHandlers {
  bind: (payload: CliHookPayload) => string | null;
  open: (payload: CliHookPayload) => Promise<void>;
  finish: (payload: CliHookPayload) => void;
}

/** Bind to the current parent terminal before routing a local child event. */
export function routeSubagentHook(payload: CliHookPayload, handlers: SubagentHookHandlers): boolean {
  if (payload.environmentType === "ssh") return false;
  const claudeTool = payload.source === "claude"
    && (payload.event === "ToolStart" || payload.event === "ToolStop")
    && Boolean(payload.agentId?.trim());
  // Codex also emits turn hooks for a child, carrying the parent's session_id.
  const codexChildTurn = payload.source === "codex" && Boolean(payload.agentId?.trim())
    && (payload.event === "SessionStart" || payload.event === "UserPromptSubmit" || payload.event === "Stop");
  if (!claudeTool && !codexChildTurn && ![
    "SubagentStart", "SubagentStop", "AgentToolStart", "AgentToolStop",
  ].includes(payload.event)) return false;

  const tabId = handlers.bind(payload);
  if (!tabId) return true;
  const bound = { ...payload, tabId };
  const ended = payload.event === "SubagentStop" || (codexChildTurn && payload.event === "Stop");
  if (ended && !payload.agentTranscriptPath?.trim() && payload.source !== "codex") {
    handlers.finish(bound);
  } else if (ended) {
    void handlers.open(bound).then(() => handlers.finish(bound), () => handlers.finish(bound));
  } else {
    void handlers.open(bound);
  }
  return true;
}
