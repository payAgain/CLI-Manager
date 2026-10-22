import type { TerminalSession } from "./types";

interface SubagentPresentationInput {
  agentId?: string | null;
  session?: TerminalSession | null;
  nickname?: string | null;
  taskSummary?: string | null;
  recordTitle?: string | null;
  fallbackTitle: string;
}

function readableLabel(value: string | null | undefined, agentId: string | null | undefined) {
  const label = value?.replace(/\s+/g, " ").trim();
  if (!label) return undefined;
  const lower = label.toLowerCase();
  const id = agentId?.trim().toLowerCase();
  if (id && (lower === id || lower === `agent-${id}` || lower.startsWith(`${id} (`))) return undefined;
  if (/^(?:agent-)?[a-f\d]{8,}(?:-[a-f\d]+)*$/i.test(label)) return undefined;
  if (/^(?:subagent|子代理|子代理转录|agent)(?:\s*#\d+)?$/i.test(label)) return undefined;
  if (isSubagentEnvironmentLine(label)) return undefined;
  return label;
}

/** Keep task identity separate from transport IDs and generated parent context. */
export function resolveSubagentPresentation({ agentId, session, nickname, taskSummary, recordTitle, fallbackTitle }: SubagentPresentationInput) {
  const id = agentId?.trim() || session?.subagent?.agentId?.trim() || "";
  const customTitle = session?.title !== session?.subagent?.generatedTitle
    ? readableLabel(session?.title, id) : undefined;
  const title = customTitle
    || readableLabel(nickname, id)
    || readableLabel(recordTitle, id)
    || readableLabel(taskSummary, id)
    || readableLabel(session?.subagent?.agentType, id)
    || fallbackTitle;
  return { title, shortId: id.length > 8 ? `${id.slice(0, 8)}…` : id };
}

/** A task preview is derived only from the child's user message, never its output. */
export function subagentTaskSummary(text: string | null | undefined): string | undefined {
  const lines = text?.split(/\r?\n/).map(value => value.trim()).filter(Boolean) ?? [];
  let environmentPrefix = false;
  const line = lines.find(value => {
    if (isSubagentEnvironmentLine(value) || (environmentPrefix && /^(?:git )?branch\s*:/i.test(value))) {
      environmentPrefix = true;
      return false;
    }
    return true;
  });
  if (!line || /^<|^#\s*AGENTS\.md|^You are (?:an? |Codex)/i.test(line)) return undefined;
  return line.replace(/^#{1,6}\s+/, "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");
}

function isSubagentEnvironmentLine(line: string) {
  return /^(?:repo(?:sitory)?(?: root)?|project root|cwd|(?:current )?working directory)\s*:\s*(?:[a-z]:[\\/]|[\\/]|~\/)/i.test(line);
}
