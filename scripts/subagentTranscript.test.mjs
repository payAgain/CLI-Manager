import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/subagentTranscript.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } });
const { parseSubagentTranscript, readSubagentTranscriptLifecycle, mergeSubagentMessages, subagentToolSummary, buildSubagentTranscriptRows } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`,
);
const lines = (...items) => items.map(item => JSON.stringify(item)).join("\n") + "\n";
const meta = (id, extra = {}) => ({ type: "session_meta", payload: { id, ...extra } });
const event = (type, extra = {}) => ({ type: "event_msg", payload: { type, ...extra } });
const response = payload => ({ type: "response_item", payload });
const text = (role, value) => response({ type: "message", role, content: [{ type: "input_text", text: value }] });
const fork = () => [
  meta("child", { parent_thread_id: "parent", agent_nickname: "Feynman" }),
  meta("parent"), event("task_started", { turn_id: "parent-turn" }),
  text("user", "Inherited parent prompt"), text("assistant", "Inherited parent answer"),
  event("task_complete", { turn_id: "parent-turn" }),
  event("thread_settings_applied", { thread_id: "child" }),
  event("task_started", { turn_id: "child-turn", turn_attribution: { parent_turn_id: "parent-turn" } }),
  text("developer", "Internal instructions"), text("user", "Own task"), text("assistant", "Own answer"),
];

test("forked Codex rollouts show only the child's messages and lifecycle", () => {
  const parsed = parseSubagentTranscript(lines(...fork()), 1, undefined, "child");
  assert.deepEqual(parsed.messages.map(item => item.text), ["Own task", "Own answer"]);
  assert.equal(parsed.cursor.nickname, "Feynman");
  assert.equal(parsed.cursor.status, "running");
  assert.equal(parsed.cursor.turnId, "child-turn");
});

test("nested subagents cannot adopt their parent's inherited turn", () => {
  const records = fork();
  records[2].payload.turn_attribution = { parent_turn_id: "grandparent-turn" };
  const parsed = parseSubagentTranscript(lines(...records), 1, undefined, "child");
  assert.deepEqual(parsed.messages.map(item => item.text), ["Own task", "Own answer"]);
  assert.equal(parsed.cursor.status, "running");
});

test("parent interruption cannot impersonate child interruption, including when hidden", () => {
  const cursor = readSubagentTranscriptLifecycle(lines(...fork()), undefined, "child");
  const parentStop = readSubagentTranscriptLifecycle(lines(event("turn_aborted", { thread_id: "parent", turn_id: "parent-turn" })), cursor, "child");
  assert.equal(parentStop.status, "running");
  for (const [kind, status] of [["task_complete", "completed"], ["turn_aborted", "interrupted"], ["task_failed", "failed"]]) {
    assert.equal(readSubagentTranscriptLifecycle(lines(event(kind, { turn_id: "child-turn" })), parentStop, "child").status, status);
  }
});

test("a resumed child uses its latest turn and rejects a late completion from the previous turn", () => {
  const first = readSubagentTranscriptLifecycle(lines(...fork(), event("task_complete", { turn_id: "child-turn" })), undefined, "child");
  const resumed = readSubagentTranscriptLifecycle(lines(
    event("task_started", { turn_id: "second-turn" }), event("task_complete", { turn_id: "child-turn" }),
  ), first, "child");
  assert.equal(resumed.status, "running");
  assert.equal(resumed.turnId, "second-turn");
});

test("partial JSONL records survive arbitrary append boundaries", () => {
  const input = lines(...fork(), event("turn_aborted", { turn_id: "child-turn" }));
  const whole = parseSubagentTranscript(input, 1, undefined, "child");
  let cursor;
  let nextId = 1;
  const messages = [];
  for (let index = 0; index < input.length; index += 7) {
    const parsed = parseSubagentTranscript(input.slice(index, index + 7), nextId, cursor, "child");
    cursor = parsed.cursor; nextId = parsed.nextId; messages.push(...parsed.messages);
  }
  assert.deepEqual(messages, whole.messages);
  assert.equal(cursor.status, "interrupted");
});

test("tool calls and results pair across chunks without reinterpreting command output as Markdown", () => {
  const call = parseSubagentTranscript(lines(response({ type: "function_call", name: "exec_command", call_id: "call-1", arguments: '{"cmd":"git status --short","workdir":"/repo"}' })));
  const answer = parseSubagentTranscript(lines(response({ type: "function_call_output", call_id: "call-1", output: "Process exited with code 128\n--flag value `literal`" })), call.nextId);
  const merged = mergeSubagentMessages(call.messages, answer.messages);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].toolName, "exec_command");
  assert.equal(merged[0].failed, true);
  assert.equal(merged[0].output, "Process exited with code 128\n--flag value `literal`");
  assert.equal(subagentToolSummary(merged[0]), "git status --short");
  assert.equal(mergeSubagentMessages(merged, []), merged);
});

test("Claude tool-result blocks retain tool identity instead of becoming user messages", () => {
  const parsed = parseSubagentTranscript(lines(
    { type: "assistant", message: { content: [{ type: "text", text: "Checking" }, { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "/repo/file.ts" } }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "read-1", content: "file contents" }] } },
  ));
  const messages = mergeSubagentMessages([], parsed.messages);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].text, "Checking");
  assert.equal(messages[1].role, "tool");
  assert.equal(messages[1].output, "file contents");
});

test("Codex readable summaries are rendered while encrypted and raw continuation fields stay opaque", () => {
  const parsed = parseSubagentTranscript(lines(
    response({ type: "reasoning", summary: [{ type: "summary_text", text: "Checking the source" }, { type: "summary_text", text: "Then comparing results" }], encrypted_content: "opaque-token", content: [{ type: "reasoning_text", text: "private-token-content" }] }),
    response({ type: "reasoning", summary: [], encrypted_content: "another-opaque-token" }),
  ));
  assert.deepEqual(parsed.messages.map(message => [message.kind, message.text]), [["reasoning", "Checking the source\nThen comparing results"]]);
});

test("legacy reasoning events and canonical summaries are paired across append boundaries", () => {
  const a = parseSubagentTranscript(lines(event("agent_reasoning", { text: "Check the repository" })));
  const b = parseSubagentTranscript(lines(response({ type: "reasoning", summary: [{ type: "summary_text", text: "Check the repository" }] })), a.nextId, a.cursor);
  const c = parseSubagentTranscript(lines(
    event("agent_reasoning", { text: "Check the repository" }),
    event("agent_reasoning", { text: "Check the repository" }),
  ), b.nextId, b.cursor);
  assert.equal(a.messages.length, 1);
  assert.equal(b.messages.length, 0);
  assert.equal(c.messages.length, 2, "same-format repetitions are real records");
});

test("fork inheritance also filters the parent's reasoning summaries", () => {
  const records = fork();
  records.splice(4, 0, response({ type: "reasoning", summary: [{ type: "summary_text", text: "Parent reasoning" }] }));
  records.push(response({ type: "reasoning", summary: [{ type: "summary_text", text: "Child reasoning" }] }));
  const parsed = parseSubagentTranscript(lines(...records), 1, undefined, "child");
  assert.deepEqual(parsed.messages.filter(message => message.kind === "reasoning").map(message => message.text), ["Child reasoning"]);
});

test("Claude readable thinking remains separate from tool calls and redacted blocks", () => {
  const parsed = parseSubagentTranscript(lines({ type: "assistant", message: { role: "assistant", content: [
    { type: "thinking", thinking: "Compare both files", signature: "opaque-signature" },
    { type: "redacted_thinking", data: "opaque-data" },
    { type: "tool_use", id: "c1", name: "Read", input: { file_path: "file.ts" } },
  ] } }));
  assert.deepEqual(parsed.messages.map(message => message.kind), ["reasoning", "tool"]);
  assert.equal(parsed.messages[0].text, "Compare both files");
});

test("summary groups preserve messages, thinking, failures and pending calls without losing full detail", () => {
  const { messages } = parseSubagentTranscript(lines(
    text("user", "Inspect the project"),
    response({ type: "reasoning", summary: [{ type: "summary_text", text: "Inspect sources first" }] }),
    response({ type: "function_call", call_id: "c1", name: "exec_command", arguments: '{"cmd":"git status"}' }),
    response({ type: "function_call_output", call_id: "c1", output: "Exit code: 128" }),
    response({ type: "function_call", call_id: "c2", name: "web_search", arguments: '{"query":"project docs"}' }),
    text("assistant", "Found the cause"),
    response({ type: "reasoning", summary: [{ type: "summary_text", text: "Check the fix" }] }),
  ));
  const merged = mergeSubagentMessages([], messages);
  const rows = buildSubagentTranscriptRows(merged, "summary");
  assert.deepEqual(rows.map(row => row.kind), ["item", "activity", "item", "activity"]);
  const activity = rows[1];
  assert.equal(activity.toolCount, 2);
  assert.equal(activity.reasoningCount, 1);
  assert.equal(activity.failedCount, 1);
  assert.equal(activity.pendingCount, 1);
  assert.deepEqual(activity.categories, ["command", "search"]);
  assert.equal(activity.latestReasoning, "Inspect sources first");
  assert.equal(rows[3].toolCount, 0, "reasoning without tools still appears");
  assert.deepEqual(rows.flatMap(row => row.kind === "activity" ? row.messages : [row.message]), merged);
  assert.deepEqual(buildSubagentTranscriptRows(merged, "full").map(row => row.message), merged);
  const completed = mergeSubagentMessages(merged, parseSubagentTranscript(lines(response({ type: "function_call_output", call_id: "c2", output: "Found documentation" }))).messages);
  const updated = buildSubagentTranscriptRows(completed, "summary")[1];
  assert.equal(updated.id, activity.id, "the disclosure keeps its identity when results arrive");
  assert.equal(updated.pendingCount, 0);
  assert.equal(updated.messages[2].output, "Found documentation");
});

// Execute the real store actions with isolated state, IPC-free timers and settings.
const storeSource = readFileSync(new URL("../src/stores/terminalStore.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("terminalStore.ts", storeSource, ts.ScriptTarget.Latest, true);
const actions = {};
function visit(node) {
  if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)
    && ["appendSubagentTranscript", "finishSubagentTranscript"].includes(node.name.text)) {
    actions[node.name.text] = node.initializer.getText(ast);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
function harness(autoClose = true) {
  const timers = new Map();
  const settings = { hookPopupAutoCloseEnabled: autoClose, hookPopupAutoCloseSeconds: 10 };
  const state = {
    sessions: [
      { id: "parent", title: "Parent", kind: "pty" },
      { id: "pane", kind: "subagent-transcript", title: "default (Parent)", subagent: { parentSessionId: "parent", agentId: "child", generatedTitle: "default (Parent)" } },
    ],
    subagentTranscripts: { pane: { content: "", ended: false, status: "running", resetSeq: 0, source: { kind: "child-jsonl" } } },
    closed: [], closeSession(id) { state.closed.push(id); },
  };
  let timerId = 0;
  const environment = {
    get: () => state,
    set: update => Object.assign(state, typeof update === "function" ? update(state) : update),
    readSubagentTranscriptLifecycle,
    trimOptional: value => typeof value === "string" ? value.trim() || null : null,
    subagentCloseTimers: new Map(), subagentDiscoveryTimers: new Map(),
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id), clearInterval() {},
    findSubagentSessionId: (sessions, payload) => sessions.find(item => item.subagent?.parentSessionId === payload.tabId && item.subagent?.agentId === payload.agentId)?.id,
    useSettingsStore: { getState: () => settings }, useTerminalStore: { getState: () => state },
    stopSubagentTranscriptRetry() {}, logInfo() {}, logWarn() {}, debugConsoleWarn() {},
    SUBAGENT_TRANSCRIPT_MAX_CHARS: 4 * 1024 * 1024,
  };
  const code = ts.transpileModule(Object.entries(actions).map(([name, value]) => `const ${name} = ${value};`).join("\n"), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const resolved = new Function(...Object.keys(environment), `${code}\nreturn {appendSubagentTranscript, finishSubagentTranscript};`)(...Object.values(environment));
  Object.assign(state, resolved);
  return { state, settings, timers };
}

test("store updates run independently of visibility and preserves an interrupted child status", () => {
  const { state, timers } = harness(false);
  state.appendSubagentTranscript("pane", lines(...fork()), true);
  assert.equal(state.subagentTranscripts.pane.ended, false);
  assert.equal(state.sessions[1].title, "Feynman");
  state.appendSubagentTranscript("pane", lines(event("turn_aborted", { turn_id: "child-turn" })), false);
  assert.equal(state.subagentTranscripts.pane.ended, true);
  assert.equal(state.subagentTranscripts.pane.status, "interrupted");
  assert.equal(timers.size, 0);
  assert.equal(state.sessions[0].title, "Parent");
});

test("a new child turn cancels its previous auto-close and keeps user titles", () => {
  const { state, timers } = harness();
  state.sessions[1].title = "My label";
  state.appendSubagentTranscript("pane", lines(...fork(), event("task_complete", { turn_id: "child-turn" })), true);
  assert.equal(timers.size, 1);
  const oldClose = [...timers.values()][0];
  state.appendSubagentTranscript("pane", lines(event("task_started", { turn_id: "next-turn" })), false);
  assert.equal(timers.size, 0);
  assert.equal(state.subagentTranscripts.pane.status, "running");
  assert.equal(state.subagentTranscripts.pane.ended, false);
  assert.equal(state.sessions[1].title, "My label");
  oldClose();
  assert.deepEqual(state.closed, []);
});

test("foreign-window append keys never create transcripts", () => {
  const { state } = harness();
  state.appendSubagentTranscript("unowned-pane", lines(...fork()), false);
  assert.deepEqual(Object.keys(state.subagentTranscripts), ["pane"]);
});

test("disabling auto-close after completion preserves the result", () => {
  const { state, timers, settings } = harness();
  state.appendSubagentTranscript("pane", lines(...fork(), event("task_complete", { turn_id: "child-turn" })), true);
  assert.equal(timers.size, 1);
  settings.hookPopupAutoCloseEnabled = false;
  for (const callback of timers.values()) callback();
  assert.deepEqual(state.closed, []);
});
