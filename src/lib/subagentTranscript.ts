export type SubagentTranscriptStatus = "running" | "completed" | "interrupted" | "failed";
export type SubagentTranscriptMode = "summary" | "full";

/** Small streaming cursor, retained even when the transcript buffer is trimmed. */
export interface SubagentTranscriptCursor {
  threadId?: string;
  currentThreadId?: string;
  turnId?: string;
  nickname?: string;
  status?: SubagentTranscriptStatus;
  pendingLine: string;
  lastReasoning?: { text: string; source: "event" | "item" };
}

export interface SubagentTranscriptMessage {
  id: number;
  kind: "message" | "reasoning" | "tool" | "tool-result";
  role: "user" | "assistant" | "tool";
  text: string;
  callId?: string;
  toolName?: string;
  arguments?: string;
  output?: string;
  failed?: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => {
    const block = record(item);
    return block && ["text", "input_text", "output_text", "summary_text"].includes(String(block.type))
      ? string(block.text) ?? ""
      : "";
  }).filter(Boolean).join("\n");
}

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  return contentText(output) || (output === undefined ? "" : JSON.stringify(output, null, 2));
}

function formatArguments(input: unknown): string {
  if (typeof input !== "string") return input === undefined ? "" : JSON.stringify(input, null, 2);
  try { return JSON.stringify(JSON.parse(input), null, 2); } catch { return input; }
}

/** CLI envelopes remain plain text; Markdown would interpret flags as emphasis. */
export function subagentToolSummary(message: SubagentTranscriptMessage): string {
  if (!message.arguments) return "";
  try {
    const input = record(JSON.parse(message.arguments));
    if (!input) return "";
    for (const key of ["cmd", "command", "file_path", "path", "pattern", "query", "q", "url"]) {
      const value = string(input[key]);
      if (value) return value.replace(/\s+/g, " ").slice(0, 180);
    }
    if (Array.isArray(input.search_query)) {
      return input.search_query.map((item) => string(record(item)?.q)).filter(Boolean).join(" · ").slice(0, 180);
    }
  } catch { /* Raw custom-tool input is still available in the disclosure. */ }
  return message.arguments.replace(/\s+/g, " ").slice(0, 180);
}

function consumeLifecycle(state: SubagentTranscriptCursor, row: Record<string, unknown>): boolean {
  const payload = record(row.payload);
  if (row.type === "session_meta" && payload) {
    const id = string(payload.id);
    state.threadId ??= id;
    state.currentThreadId = id;
    if (id === state.threadId) state.nickname = string(payload.agent_nickname) ?? state.nickname;
    return false;
  }
  if (row.type === "event_msg" && payload?.type === "thread_settings_applied") {
    state.currentThreadId = string(payload.thread_id) ?? state.currentThreadId;
    return false;
  }
  // Nested parents also have parent_turn_id; only a matching thread identity
  // can establish the child's scope after inherited context.
  const explicitThread = row.type === "event_msg" ? string(payload?.thread_id) : undefined;
  if (explicitThread && explicitThread === state.threadId) state.currentThreadId = explicitThread;
  if (state.threadId && ((explicitThread && explicitThread !== state.threadId)
    || (state.currentThreadId && state.currentThreadId !== state.threadId))) return false;
  if (row.type !== "event_msg" || !payload) return true;
  const turnId = string(payload.turn_id);
  if (payload.type === "task_started" || payload.type === "turn_started") {
    state.turnId = turnId;
    state.status = "running";
    state.lastReasoning = undefined;
  } else if (!turnId || !state.turnId || turnId === state.turnId) {
    if (payload.type === "turn_aborted") state.status = "interrupted";
    if (payload.type === "task_complete" || payload.type === "turn_completed") state.status = "completed";
    if (payload.type === "task_failed" || payload.type === "turn_failed") state.status = "failed";
  }
  return true;
}

function walkTranscript(
  chunk: string,
  previous: SubagentTranscriptCursor | undefined,
  expectedThreadId: string | undefined,
  consume?: (row: Record<string, unknown>, state: SubagentTranscriptCursor) => void,
): SubagentTranscriptCursor {
  const state: SubagentTranscriptCursor = { ...previous, threadId: previous?.threadId ?? expectedThreadId, pendingLine: "" };
  const lines = ((previous?.pendingLine ?? "") + chunk).split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    let row: Record<string, unknown> | undefined;
    try { row = record(JSON.parse(line)); } catch {
      if (index === lines.length - 1) state.pendingLine = line.slice(-2 * 1024 * 1024);
      continue;
    }
    if (row && consumeLifecycle(state, row)) consume?.(row, state);
  }
  return state;
}

export function readSubagentTranscriptLifecycle(
  chunk: string,
  previous?: SubagentTranscriptCursor,
  expectedThreadId?: string,
): SubagentTranscriptCursor {
  return walkTranscript(chunk, previous, expectedThreadId);
}

export function parseSubagentTranscript(
  chunk: string,
  firstId = 1,
  previous?: SubagentTranscriptCursor,
  expectedThreadId?: string,
): { messages: SubagentTranscriptMessage[]; nextId: number; cursor: SubagentTranscriptCursor } {
  const messages: SubagentTranscriptMessage[] = [];
  let nextId = firstId;
  const push = (message: Omit<SubagentTranscriptMessage, "id">) => messages.push({ id: nextId++, ...message });
  const call = (item: Record<string, unknown>) => push({
    kind: "tool", role: "tool", text: "", toolName: string(item.name),
    callId: string(item.call_id) ?? string(item.id), arguments: formatArguments(item.arguments ?? item.input),
  });
  const result = (item: Record<string, unknown>) => {
    const output = outputText(item.output ?? item.content);
    push({
      kind: "tool-result", role: "tool", text: "", callId: string(item.call_id) ?? string(item.tool_use_id), output,
      failed: item.is_error === true || /(?:Process exited with code|Exit code:)\s*[1-9]\d*/i.test(output),
    });
  };
  const cursor = walkTranscript(chunk, previous, expectedThreadId, (row, state) => {
    const payload = row.type === "response_item" ? record(row.payload) : undefined;
    const claude = row.type === "user" || row.type === "assistant" ? record(row.message) : undefined;
    const event = row.type === "event_msg" ? record(row.payload) : undefined;
    // Only readable summaries are public output. encrypted_content is an opaque
    // continuation token and must never be displayed or treated as text.
    if (payload?.type === "reasoning" || event?.type === "agent_reasoning") {
      const text = (payload ? contentText(payload.summary) : string(event?.text) ?? "").trim();
      if (text) {
        const source = payload ? "item" : "event";
        // Older rollouts can log both event and response-item representations.
        // Retain this pairing cursor across append boundaries, without removing
        // legitimate repeated reasoning within the same representation.
        if (state.lastReasoning?.source !== source && state.lastReasoning?.text === text) {
          state.lastReasoning = undefined;
        } else {
          state.lastReasoning = { text, source };
          push({ kind: "reasoning", role: "assistant", text });
        }
      }
      return;
    }
    if (payload || claude) state.lastReasoning = undefined;
    if (payload?.type === "function_call" || payload?.type === "custom_tool_call") { call(payload); return; }
    if (payload?.type === "function_call_output" || payload?.type === "custom_tool_call_output") { result(payload); return; }
    if (payload?.type === "web_search_call") {
      push({ kind: "tool", role: "tool", text: "", toolName: "web_search", arguments: formatArguments(payload.action),
        output: payload.status === "completed" ? "" : undefined });
      return;
    }
    const message = claude ?? (payload?.type === "message" ? record(payload.message) ?? payload : undefined);
    if (!message) return;
    const role = message.role ?? (claude ? row.type : undefined);
    if (role !== "user" && role !== "assistant") return;
    if (typeof message.content === "string") {
      if (message.content.trim()) push({ kind: "message", role, text: message.content });
      return;
    }
    if (!Array.isArray(message.content)) return;
    let text: string[] = [];
    const flushText = () => {
      if (text.length) push({ kind: "message", role, text: text.join("\n") });
      text = [];
    };
    for (const value of message.content) {
      const block = record(value);
      if (!block) continue;
      if (["text", "input_text", "output_text"].includes(String(block.type)) && string(block.text)) {
        text.push(String(block.text));
      } else if (block.type === "tool_use" || block.type === "function_call") {
        flushText(); call(block);
      } else if (block.type === "tool_result" || block.type === "function_call_output") {
        flushText(); result(block);
      } else if (block.type === "thinking" && string(block.thinking)) {
        flushText(); push({ kind: "reasoning", role: "assistant", text: String(block.thinking) });
      }
    }
    flushText();
  });
  return { messages, nextId, cursor };
}

/** Pair by call ID across chunks, retaining references for unchanged message rows. */
export function mergeSubagentMessages(
  existing: SubagentTranscriptMessage[],
  incoming: SubagentTranscriptMessage[],
): SubagentTranscriptMessage[] {
  if (!incoming.length) return existing;
  const messages = [...existing];
  const calls = new Map(messages.flatMap((message, index) => message.callId ? [[message.callId, index] as const] : []));
  for (const message of incoming) {
    const index = message.callId ? calls.get(message.callId) : undefined;
    if (message.kind === "tool-result" && index !== undefined && messages[index].kind === "tool") {
      messages[index] = { ...messages[index], output: message.output, failed: message.failed };
    } else {
      if (message.callId) calls.set(message.callId, messages.length);
      messages.push(message);
    }
  }
  return messages;
}

export type SubagentToolCategory = "search" | "read" | "edit" | "command" | "other";

export interface SubagentTranscriptActivity {
  kind: "activity";
  id: number;
  messages: SubagentTranscriptMessage[];
  toolCount: number;
  reasoningCount: number;
  failedCount: number;
  pendingCount: number;
  categories: SubagentToolCategory[];
  latestReasoning?: string;
}

export type SubagentTranscriptRow = SubagentTranscriptActivity
  | { kind: "item"; id: number; message: SubagentTranscriptMessage };

function toolCategory(name: string): SubagentToolCategory {
  if (/search|browse|web/i.test(name)) return "search";
  if (/write|edit|patch/i.test(name)) return "edit";
  if (/read|grep|find|glob|file/i.test(name)) return "read";
  if (/exec|shell|command|terminal|run/i.test(name)) return "command";
  return "other";
}

/** Group operations between messages; summary text never includes raw commands. */
export function buildSubagentTranscriptRows(
  messages: SubagentTranscriptMessage[],
  mode: SubagentTranscriptMode,
): SubagentTranscriptRow[] {
  if (mode === "full") return messages.map(message => ({ kind: "item", id: message.id, message }));
  const rows: SubagentTranscriptRow[] = [];
  let activity: SubagentTranscriptActivity | undefined;
  for (const message of messages) {
    if (message.kind === "message") {
      activity = undefined;
      rows.push({ kind: "item", id: message.id, message });
      continue;
    }
    if (!activity) {
      activity = { kind: "activity", id: message.id, messages: [], toolCount: 0, reasoningCount: 0,
        failedCount: 0, pendingCount: 0, categories: [] };
      rows.push(activity);
    }
    activity.messages.push(message);
    if (message.kind === "reasoning") {
      activity.reasoningCount += 1;
      activity.latestReasoning = message.text;
    } else {
      activity.toolCount += 1;
      activity.failedCount += Number(Boolean(message.failed));
      activity.pendingCount += Number(message.output === undefined);
      const category = toolCategory(message.toolName ?? "");
      if (!activity.categories.includes(category)) activity.categories.push(category);
    }
  }
  return rows;
}
