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

test("Claude shell tools use the command category while preserving exact arguments and results", () => {
  const parsed = parseSubagentTranscript(lines(
    { type: "assistant", message: { role: "assistant", content: [
      { type: "tool_use", id: "bash-1", name: "Bash", input: { command: "git status --short" } },
      { type: "tool_use", id: "ps-1", name: "PowerShell", input: { command: "Get-Location" } },
    ] } },
    { type: "user", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "bash-1", content: " M src/app.ts" },
    ] } },
  ));
  const merged = mergeSubagentMessages([], parsed.messages);
  const [activity] = buildSubagentTranscriptRows(merged, "summary");
  assert.deepEqual(activity.categories, ["command"]);
  assert.equal(activity.toolCount, 2);
  assert.equal(activity.pendingCount, 1);
  assert.equal(activity.messages[0].output, " M src/app.ts");
  assert.deepEqual(activity.messages, merged);
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
const moduleUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const { routeSubagentHook, isSubagentActivityHook, isSubagentCompletionHook } = await import(moduleUrl(ts.transpileModule(
  readFileSync(new URL("../src/lib/subagentHookRouting.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  },
).outputText));
const paneTreeUrl = moduleUrl(ts.transpileModule(readFileSync(new URL("../src/stores/terminalPaneTree.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText);
const paneTree = await import(paneTreeUrl);
const workspanCode = ts.transpileModule(readFileSync(new URL("../src/stores/terminalWorkspan.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText.replace('from "./terminalPaneTree"', `from "${paneTreeUrl}"`);
const workspan = await import(moduleUrl(workspanCode));
const storeSource = readFileSync(new URL("../src/stores/terminalStore.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("terminalStore.ts", storeSource, ts.ScriptTarget.Latest, true);
const actions = {};
let mirrorDeclaration;
const openHelpers = [];
const openHelperNames = ["rememberClosedSubagent", "resolveHookWslDistroName", "normalizePathForCompare", "isSameTranscriptPath", "hashString", "createSubagentPaneId", "buildSubagentTitle", "resolveSubagentTranscriptSource", "shouldUpgradeSubagentSource", "mergeSubagentSource", "shouldSubscribeSubagentSource", "shouldAttemptDerivedChildTranscript", "findSubagentSessionId"];
function visit(node) {
  if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)
    && ["openSubagentTranscript", "appendSubagentTranscript", "finishSubagentTranscript", "collapseSubagentTranscript", "setActive"].includes(node.name.text)) {
    actions[node.name.text] = node.initializer.getText(ast);
  }
  if (ts.isFunctionDeclaration(node) && node.name?.text === "buildWorkspanMirror") mirrorDeclaration = node.getText(ast);
  if (ts.isFunctionDeclaration(node) && openHelperNames.includes(node.name?.text)) openHelpers.push(node.getText(ast));
  ts.forEachChild(node, visit);
}
visit(ast);
function harness(autoClose = true, ipcHandler) {
  const timers = new Map();
  const settings = { hookPopupAutoCloseEnabled: autoClose, hookPopupAutoCloseSeconds: 10, hookSubagentSplitViewEnabled: false };
  const ipc = [];
  let paneSeq = 0;
  const owner = {
    id: "workspan", customTitle: null,
    paneTree: {
      type: "split", id: "root", direction: "horizontal", ratio: 0.5,
      first: { type: "leaf", id: "parent-pane", sessionIds: ["parent"], activeSessionId: "parent" },
      second: { type: "leaf", id: "child-pane", sessionIds: ["pane"], activeSessionId: "pane" },
    },
    activePaneId: "parent-pane", activeSessionId: "parent",
  };
  const state = {
    sessions: [
      { id: "parent", title: "Parent", kind: "pty" },
      { id: "pane", kind: "subagent-transcript", title: "default (Parent)", subagent: { parentSessionId: "parent", agentId: "child", generatedTitle: "default (Parent)" } },
    ],
    subagentTranscripts: { pane: { content: "", ended: false, status: "running", resetSeq: 0, source: { kind: "child-jsonl" } } },
    closed: [], closeSession(id) { state.closed.push(id); },
    workspans: [owner], activeWorkspanId: owner.id, paneTree: owner.paneTree,
    activePaneId: owner.activePaneId, activeSessionId: owner.activeSessionId,
  };
  let timerId = 0;
  const environment = {
    get: () => state,
    set: update => Object.assign(state, typeof update === "function" ? update(state) : update),
    readSubagentTranscriptLifecycle,
    parseSubagentTranscript,
    isSubagentActivityHook,
    isSubagentCompletionHook,
    trimOptional: value => typeof value === "string" ? value.trim() || null : null,
    subagentFoldTimers: new Map(), subagentDiscoveryTimers: new Map(), dismissedSubagentActivity: new Set(),
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id), clearInterval() {},
    inferWslDistroFromCwd: () => null,
    resolveSubagentConfigDir: () => null,
    translateCurrent: () => "Subagent",
    useProjectStore: { getState: () => ({ projects: [] }) },
    useSessionStore: { getState: () => ({ saveSessions: async () => {} }) },
    invoke: async (command, args) => {
      ipc.push({ command, args });
      if (ipcHandler) return ipcHandler(command, args);
      return { path: args.transcriptPath, initialContent: lines(...fork(), event("task_complete", { turn_id: "child-turn" })).replaceAll('"child"', JSON.stringify(args.agentId)) };
    },
    useSettingsStore: { getState: () => settings }, useTerminalStore: { getState: () => state },
    stopSubagentTranscriptRetry() {}, logInfo() {}, logWarn() {}, logError() {}, debugConsoleWarn() {},
    findWorkspanBySession: workspan.findWorkspanBySession,
    updateTerminalWorkspan: workspan.updateTerminalWorkspan,
    syncTerminalWorkspanLayout: workspan.syncTerminalWorkspanLayout,
    findPaneLeafBySession: paneTree.findPaneLeafBySession,
    addSessionToPaneTree: paneTree.addSessionToPaneTree,
    splitPaneLeaf: paneTree.splitPaneLeaf,
    createPaneId: () => `new-pane-${++paneSeq}`,
    moveSessionToPaneTree: paneTree.moveSessionToPane,
    setPaneActiveSession: paneTree.setPaneActiveSession,
    scheduleSaveActiveId() {}, persistWorkspanState() {},
    SUBAGENT_TRANSCRIPT_MAX_CHARS: 4 * 1024 * 1024,
  };
  const code = ts.transpileModule([mirrorDeclaration, ...openHelpers, ...Object.entries(actions).map(([name, value]) => `const ${name} = ${value};`)].join("\n"), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const resolved = new Function(...Object.keys(environment), `${code}\nreturn {openSubagentTranscript, appendSubagentTranscript, finishSubagentTranscript, collapseSubagentTranscript, setActive, rememberClosedSubagent};`)(...Object.values(environment));
  Object.assign(state, resolved);
  return { state, settings, timers, ipc, rememberClosedSubagent: resolved.rememberClosedSubagent };
}

const childActivity = (extra = {}) => ({
  tabId: "parent", source: "claude", event: "ToolStart", sessionId: "main",
  agentId: "internal-worker", toolUseId: "bash-call", toolName: "Bash",
  cwd: "E:/work/project", transcriptPath: "/claude/projects/project/main.jsonl", ...extra,
});
const readableChild = {
  path: "/claude/projects/project/main/subagents/agent-fallback.jsonl",
  initialContent: lines({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Actual child output" }] } }),
};

test("ordinary tool callbacks with an unknown agentId never create empty children or start a tail", async () => {
  for (const event of ["ToolStart", "ToolStop"]) {
    for (const probeResult of [null, { ...readableChild, initialContent: "" }, { ...readableChild, initialContent: lines(meta("metadata-only")) }]) {
      const { state, settings, ipc } = harness(false, async () => probeResult);
      settings.hookSubagentSplitViewEnabled = true;
      const before = structuredClone({ sessions: state.sessions, workspans: state.workspans, transcripts: state.subagentTranscripts });
      await state.openSubagentTranscript(childActivity({ event }));
      assert.deepEqual({ sessions: state.sessions, workspans: state.workspans, transcripts: state.subagentTranscripts }, before);
      assert.deepEqual(ipc.map(item => item.command), ["subagent_transcript_probe"]);
      assert.equal(state.activeSessionId, "parent");
    }
  }
});

test("WSL missing-start compatibility opens a verified child and retains parent focus", async () => {
  const { state, settings, ipc } = harness(false, async () => readableChild);
  settings.hookSubagentSplitViewEnabled = true;
  await state.openSubagentTranscript(childActivity({ agentId: "fallback", cwd: "//wsl.localhost/Ubuntu/home/me/project", wslDistroName: "Ubuntu" }));
  const child = state.sessions.find(item => item.subagent?.agentId === "fallback");
  assert.ok(child);
  assert.equal(child.subagent.parentSessionId, "parent");
  assert.equal(child.subagent.source.transcriptPath, readableChild.path);
  assert.equal(state.subagentTranscripts[child.id].content, readableChild.initialContent);
  assert.equal(state.activeSessionId, "parent");
  assert.deepEqual(ipc.map(item => item.command), ["subagent_transcript_probe", "subagent_transcript_subscribe"]);
  assert.equal(ipc[0].args.wslDistroName, "Ubuntu");
  assert.equal(ipc[0].args.transcriptPath, null, "never probe the parent transcript as the child's file");
  assert.equal(ipc[1].args.transcriptPath, readableChild.path);
});

test("known child tools update directly without a creation probe, even with auto-split disabled", async () => {
  const { state, ipc } = harness();
  await state.openSubagentTranscript(childActivity({ agentId: "child", agentTranscriptPath: "/claude/child.jsonl" }));
  assert.equal(state.sessions.length, 2);
  assert.equal(state.sessions[1].subagent.agentId, "child");
  assert.deepEqual(ipc.map(item => item.command), ["subagent_transcript_subscribe"]);
});

test("unavailable probes and a disabled auto-split setting leave layout and subscriptions untouched", async () => {
  const { state, settings, ipc } = harness(false, async () => { throw new Error("file unreadable"); });
  await state.openSubagentTranscript(childActivity());
  assert.equal(ipc.length, 0);
  settings.hookSubagentSplitViewEnabled = true;
  await state.openSubagentTranscript(childActivity());
  assert.equal(state.sessions.length, 2);
  assert.deepEqual(ipc.map(item => item.command), ["subagent_transcript_probe"]);
});

test("simultaneous tool callbacks verify once per request and reuse a single child in the latest layout", async () => {
  const pending = [];
  const { state, settings, ipc } = harness(false, async command => command === "subagent_transcript_probe"
    ? new Promise(resolve => pending.push(resolve)) : readableChild);
  settings.hookSubagentSplitViewEnabled = true;
  const first = state.openSubagentTranscript(childActivity({ agentId: "fallback" }));
  const second = state.openSubagentTranscript(childActivity({ agentId: "fallback", event: "ToolStop" }));
  pending[0](readableChild);
  pending[1](readableChild);
  await Promise.all([first, second]);
  const children = state.sessions.filter(item => item.subagent?.agentId === "fallback");
  assert.equal(children.length, 1);
  assert.equal(state.sessions.length, 3, "preserve the existing sibling");
  assert.equal(ipc.filter(item => item.command === "subagent_transcript_subscribe").length, 1);
  assert.ok(paneTree.findPaneLeafBySession(state.paneTree, children[0].id));
});

test("closing a parent, switching its Agent or finishing the child while probing discards the late result", async () => {
  for (const change of [state => { state.sessions = state.sessions.filter(item => item.id !== "parent"); },
    state => { state.sessions[0] = { ...state.sessions[0], cliSessionId: "new-conversation" }; },
    state => { state.finishSubagentTranscript(childActivity({ event: "SubagentStop" })); }]) {
    let resolve;
    const ready = new Promise(done => { resolve = done; });
    const { state, settings, ipc } = harness(false, async () => ready);
    settings.hookSubagentSplitViewEnabled = true;
    const opening = state.openSubagentTranscript(childActivity());
    change(state);
    resolve(readableChild);
    await opening;
    assert.equal(state.sessions.some(item => item.subagent?.agentId === "internal-worker"), false);
    assert.deepEqual(ipc.map(item => item.command), ["subagent_transcript_probe"]);
  }
});

test("a probe follows the latest parent Workspan without changing foreground focus", async () => {
  let resolve;
  const ready = new Promise(done => { resolve = done; });
  const { state, settings } = harness(false, async command => command === "subagent_transcript_probe" ? ready : readableChild);
  settings.hookSubagentSplitViewEnabled = true;
  const opening = state.openSubagentTranscript(childActivity({ agentId: "fallback" }));
  const moved = { ...state.workspans[0], id: "moved-parent" };
  state.sessions.push({ id: "other", title: "Foreground", kind: "pty" });
  const visibleTree = { type: "leaf", id: "visible-pane", sessionIds: ["other"], activeSessionId: "other" };
  state.workspans = [moved, { id: "foreground", paneTree: visibleTree, activePaneId: "visible-pane", activeSessionId: "other" }];
  state.activeWorkspanId = "foreground";
  state.activeSessionId = "other";
  state.paneTree = visibleTree;
  resolve(readableChild);
  await opening;
  const child = state.sessions.find(item => item.subagent?.agentId === "fallback");
  assert.equal(workspan.findWorkspanBySession(state.workspans, child.id).id, "moved-parent");
  assert.equal(state.activeSessionId, "other");
  assert.equal(state.activeWorkspanId, "foreground");
  assert.equal(state.paneTree, visibleTree);
});

test("verified content remains visible if the file disappears between probing and subscribing", async () => {
  const { state, settings } = harness(false, async command => command === "subagent_transcript_probe"
    ? readableChild : { path: readableChild.path, initialContent: "" });
  settings.hookSubagentSplitViewEnabled = true;
  await state.openSubagentTranscript(childActivity({ agentId: "fallback" }));
  const child = state.sessions.find(item => item.subagent?.agentId === "fallback");
  assert.equal(state.subagentTranscripts[child.id].content, readableChild.initialContent);
});

test("a user-dismissed child stays closed on later tools and can be explicitly restarted", async () => {
  const { state, settings, ipc, rememberClosedSubagent } = harness(false, async () => readableChild);
  settings.hookSubagentSplitViewEnabled = true;
  rememberClosedSubagent({ id: "removed", kind: "subagent-transcript", subagent: { parentSessionId: "parent", agentId: "fallback" } });
  await state.openSubagentTranscript(childActivity({ agentId: "fallback" }));
  assert.equal(state.sessions.length, 2);
  assert.equal(ipc.length, 0);
  await state.openSubagentTranscript(childActivity({ event: "SubagentStart", agentId: "fallback", agentTranscriptPath: readableChild.path }));
  assert.equal(state.sessions.filter(item => item.subagent?.agentId === "fallback").length, 1);
});

async function deliverHook(state, payload) {
  const handled = routeSubagentHook(payload, {
    bind: input => state.sessions.some(item => item.id === input.tabId && item.kind === "pty") ? input.tabId : null,
    open: state.openSubagentTranscript,
    finish: state.finishSubagentTranscript,
  });
  await new Promise(resolve => setImmediate(resolve));
  return handled;
}

test("completion-only hooks never create a pane or finish an unrelated running child", async () => {
  for (const variant of [
    { source: "claude", event: "SubagentStop", agentId: "internal-agent", agentTranscriptPath: "/missing/internal-agent.jsonl" },
    { source: "claude", event: "SubagentStop", agentId: "internal-agent" },
    { source: "claude", event: "SubagentStop", agentId: " " },
    { source: "claude", event: "SubagentStop", agentId: "internal-agent", wslDistroName: "Ubuntu" },
    { source: "codex", event: "SubagentStop", agentId: "unseen-child" },
    { source: "codex", event: "Stop", agentId: "unseen-child" },
    { source: "codex", event: "StopFailure", agentId: "unseen-child" },
    { source: "grok", event: "SubagentStop", agentId: "unseen-child", agentTranscriptPath: "/missing/grok-child.jsonl" },
    { source: "grok", event: "SubagentStop", agentId: null },
    { event: "SubagentStop", agentId: "legacy-internal-agent", agentTranscriptPath: "/missing/legacy-child.jsonl" },
  ]) {
    const { state, settings, ipc, timers } = harness();
    settings.hookSubagentSplitViewEnabled = true;
    const layout = state.paneTree;
    assert.equal(await deliverHook(state, { tabId: "parent", sessionId: "main", ...variant }), true);
    assert.equal(state.sessions.length, 2, JSON.stringify(variant));
    assert.equal(state.subagentTranscripts.pane.status, "running");
    assert.equal(state.subagentTranscripts.pane.ended, false);
    assert.equal(state.paneTree, layout);
    assert.equal(state.activeSessionId, "parent");
    assert.equal(ipc.length, 0, "unseen completions must not subscribe to a fabricated transcript path");
    assert.equal(timers.size, 0);
  }
});

test("known Claude, Codex and Grok children receive final transcripts in the same result pane", async () => {
  for (const source of ["claude", "codex", "grok"]) {
    const { state, settings, ipc } = harness();
    settings.hookSubagentSplitViewEnabled = true;
    state.subagentTranscripts.pane.source = { kind: "pending" };
    await deliverHook(state, {
      tabId: "parent", sessionId: "main", source, event: "SubagentStop", agentId: "child",
      agentTranscriptPath: `/${source}/subagents/agent-child.jsonl`,
    });
    assert.equal(state.sessions.length, 2);
    assert.equal(state.subagentTranscripts.pane.source.kind, "child-jsonl");
    assert.equal(state.subagentTranscripts.pane.ended, true);
    assert.equal(ipc.length, 1);
    assert.equal(ipc[0].args.key, "pane");
    assert.equal(state.activeSessionId, "parent");
  }
});

test("real start hooks still create child panes with local and WSL transcript context", async () => {
  for (const wslDistroName of [null, "Ubuntu"]) {
    const { state, settings, ipc } = harness();
    settings.hookSubagentSplitViewEnabled = true;
    await deliverHook(state, {
      tabId: "parent", sessionId: "main", source: "claude", event: "SubagentStart", agentId: "new-child",
      agentType: "research", agentTranscriptPath: "/claude/subagents/agent-new-child.jsonl", wslDistroName,
    });
    assert.equal(state.sessions.length, 3);
    const child = state.sessions.find(item => item.subagent?.agentId === "new-child");
    assert.ok(child);
    assert.equal(ipc[0].args.key, child.id);
    assert.equal(ipc[0].args.wslDistroName, wslDistroName);
    assert.equal(state.activeSessionId, "parent");
  }
});

test("late completion after a user closes a child cannot reopen it in a background Workspan", async () => {
  const { state, settings, ipc } = harness();
  settings.hookSubagentSplitViewEnabled = true;
  state.sessions = state.sessions.filter(item => item.id !== "pane");
  delete state.subagentTranscripts.pane;
  const ownerTree = state.workspans[0].paneTree.first;
  state.workspans[0].paneTree = ownerTree;
  const activeTree = { type: "leaf", id: "other-pane", sessionIds: ["other"], activeSessionId: "other" };
  state.sessions.push({ id: "other", kind: "pty" });
  state.workspans.push({ id: "other-workspan", paneTree: activeTree, activePaneId: "other-pane", activeSessionId: "other" });
  Object.assign(state, { activeWorkspanId: "other-workspan", activePaneId: "other-pane", activeSessionId: "other", paneTree: activeTree });
  await deliverHook(state, {
    tabId: "parent", sessionId: "main", source: "claude", event: "SubagentStop", agentId: "child",
    agentTranscriptPath: "/claude/subagents/agent-child.jsonl",
  });
  assert.equal(state.sessions.length, 2);
  assert.equal(state.workspans[0].paneTree, ownerTree);
  assert.equal(state.paneTree, activeTree);
  assert.equal(state.activeSessionId, "other");
  assert.equal(ipc.length, 0);
});

test("manual browsing opens a completed child with auto-split disabled and keeps the result focused", async () => {
  const { state, ipc, timers } = harness();
  const payload = { tabId: "parent", source: "codex", event: "SubagentStop", sessionId: "main", agentId: "restored-child", agentTranscriptPath: "/custom/sessions/rollout-restored-child.jsonl" };
  await state.openSubagentTranscript(payload);
  assert.equal(state.sessions.length, 2, "Hook auto-open remains disabled");
  await state.openSubagentTranscript(payload, { manual: true, configDir: "/custom" });
  const child = state.sessions.find(item => item.subagent?.agentId === "restored-child");
  assert.ok(child);
  assert.equal(state.activeSessionId, child.id);
  assert.equal(state.subagentTranscripts[child.id].status, "completed");
  assert.equal(state.subagentTranscripts[child.id].ended, true);
  assert.equal(ipc[0].args.configDir, "/custom");
  for (const callback of timers.values()) callback();
  assert.equal(state.activeSessionId, child.id);
  assert.equal(parseSubagentTranscript(state.subagentTranscripts[child.id].content, 1, undefined, "restored-child").messages.at(-1).text, "Own answer");
  await state.openSubagentTranscript(payload, { manual: true, configDir: "/custom" });
  assert.equal(state.sessions.length, 3, "opening again reuses this parent's child");
  assert.equal(ipc.length, 2, "manual refresh retries an existing subscription");
});

test("the same child ID restored under different parents does not adopt another parent's pane", async () => {
  const { state } = harness();
  state.sessions.push({ id: "other-parent", title: "Other", kind: "pty" });
  state.workspans[0].paneTree = paneTree.addSessionToPaneTree(state.workspans[0].paneTree, "parent-pane", "other-parent", () => "unused").tree;
  await state.openSubagentTranscript({ tabId: "other-parent", source: "codex", event: "SubagentStop", sessionId: "other-main", agentId: "child", agentTranscriptPath: "/custom/sessions/rollout-child.jsonl" }, { manual: true, configDir: "/custom" });
  assert.equal(state.sessions.filter(item => item.subagent?.agentId === "child").length, 2);
  assert.equal(state.sessions.find(item => item.id === state.activeSessionId).subagent.parentSessionId, "other-parent");
});

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

test("a new child turn cancels its previous auto-fold and keeps user titles", () => {
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

test("disabling auto-fold after completion preserves the result and split", () => {
  const { state, timers, settings } = harness();
  state.appendSubagentTranscript("pane", lines(...fork(), event("task_complete", { turn_id: "child-turn" })), true);
  assert.equal(timers.size, 1);
  settings.hookPopupAutoCloseEnabled = false;
  for (const callback of timers.values()) callback();
  assert.deepEqual(state.closed, []);
  assert.equal(paneTree.collectPaneLeaves(state.paneTree).length, 2);
});

test("completion folds the split into a result tab without deleting its transcript, title or identity", () => {
  const { state, timers } = harness();
  state.appendSubagentTranscript("pane", lines(...fork(), event("task_complete", { turn_id: "child-turn" })), true);
  const transcript = state.subagentTranscripts.pane;
  const child = state.sessions[1];
  for (const callback of timers.values()) callback();
  assert.equal(paneTree.collectPaneLeaves(state.paneTree).length, 1);
  assert.deepEqual(state.paneTree.sessionIds, ["parent", "pane"]);
  assert.equal(state.paneTree.activeSessionId, "parent");
  assert.equal(state.activeSessionId, "parent");
  assert.equal(state.subagentTranscripts.pane, transcript);
  assert.equal(state.sessions[1], child);
  assert.deepEqual(state.closed, []);
  state.setActive("pane");
  assert.equal(state.activeSessionId, "pane");
  assert.equal(state.paneTree.activeSessionId, "pane");
  assert.equal(parseSubagentTranscript(state.subagentTranscripts.pane.content, 1, undefined, "child").messages.at(-1).text, "Own answer");
});

test("a result being read stays in place, while manual folding activates its parent", () => {
  const { state, timers } = harness();
  state.setActive("pane");
  state.appendSubagentTranscript("pane", lines(...fork(), event("turn_aborted", { turn_id: "child-turn" })), true);
  for (const callback of timers.values()) callback();
  assert.equal(paneTree.collectPaneLeaves(state.paneTree).length, 2);
  assert.equal(state.activeSessionId, "pane");
  state.collapseSubagentTranscript("pane", true);
  assert.equal(paneTree.collectPaneLeaves(state.paneTree).length, 1);
  assert.equal(state.activeSessionId, "parent");
  assert.equal(state.subagentTranscripts.pane.status, "interrupted");
  assert.deepEqual(state.closed, []);
});

test("folding a hidden Workspan keeps the visible Workspan and its terminal focused", () => {
  const { state, timers } = harness();
  const visible = workspan.createTerminalWorkspan("visible", "visible-pane", "visible-terminal");
  state.workspans.push(visible);
  state.activeWorkspanId = visible.id;
  state.paneTree = visible.paneTree;
  state.activeSessionId = visible.activeSessionId;
  state.activePaneId = visible.activePaneId;
  state.appendSubagentTranscript("pane", lines(...fork(), event("task_failed", { turn_id: "child-turn" })), true);
  for (const callback of timers.values()) callback();
  assert.equal(state.activeWorkspanId, "visible");
  assert.equal(state.activeSessionId, "visible-terminal");
  assert.equal(state.paneTree, visible.paneTree);
  assert.deepEqual(state.workspans[0].paneTree.sessionIds, ["parent", "pane"]);
  assert.equal(state.subagentTranscripts.pane.status, "failed");
  assert.deepEqual(state.closed, []);
});

test("missing or detached parents keep results in their original pane, and running tasks never fold", () => {
  for (const scenario of ["running", "missing", "detached"]) {
    const { state } = harness();
    if (scenario !== "running") state.subagentTranscripts.pane.ended = true;
    if (scenario === "missing") state.sessions[1].subagent.parentSessionId = "closed-parent";
    if (scenario === "detached") {
      state.workspans = [
        workspan.createTerminalWorkspan("parent", "parent-pane", "parent"),
        workspan.createTerminalWorkspan("child", "child-pane", "pane"),
      ];
    }
    const before = state.workspans;
    state.collapseSubagentTranscript("pane");
    assert.equal(state.workspans, before, scenario);
    assert.ok(state.subagentTranscripts.pane, scenario);
    assert.deepEqual(state.closed, [], scenario);
  }
});
