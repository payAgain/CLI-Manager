import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { createStore } from "zustand/vanilla";
import ts from "typescript";
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const compile = text => ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const source = readFileSync(resolve(root, "src/stores/terminalStore.ts"), "utf8");
const ast = ts.createSourceFile("terminalStore.ts", source, ts.ScriptTarget.Latest, true);
function find(predicate) { let result; function visit(node) { if (predicate(node)) result = node; else ts.forEachChild(node, visit); } visit(ast); assert.ok(result); return result; }
const action = name => find(node => ts.isPropertyAssignment(node) && node.name.getText(ast) === name).initializer.getText(ast);
const helperNames = new Set(["resolvePrimaryTabId", "mapCliHookEvent", "getTabStatusEntry", "getTabStatusDetails", "buildTabStatusUpdate", "receiveAgentDetection"]);
const helperCode = ast.statements.filter(node => ts.isFunctionDeclaration(node) && helperNames.has(node.name?.text)).map(node => node.getText(ast)).join("\n");
const priority = find(node => ts.isVariableDeclaration(node) && node.name.getText(ast) === "TAB_STATUS_PRIORITY").initializer.getText(ast);
const subscription = find(node => ts.isCallExpression(node) && node.expression.getText(ast) === "useTerminalStore.subscribe").arguments[0].getText(ast);
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const session = (id, environmentType = "local", extra = {}) => ({
  id, cwd: "/repo", title: "Terminal", environmentType, cliTool: "codex", cliSessionId: `cli-${id}`,
  runtimeAgent: { tool: "codex", runId: `run-${id}`, source: "process", detectedAtMs: 1000, startedAt: 1 }, ...extra,
});
function harness(sessions = [session("a"), session("b")]) {
  let now = 10_000;
  class Clock extends Date { static now() { return now; } }
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const exports = {}; cache.set(file, exports);
    runInNewContext(compile(readFileSync(file, "utf8")), {
      exports, Date: Clock,
      require: name => name.startsWith(".") ? load(resolve(dirname(file), `${name}.ts`)) : require(name),
    });
    return exports;
  }
  const lib = name => load(resolve(root, `src/lib/${name}.ts`));
  const saved = sessions.map(lib("terminalConversationRestore").persistTerminalSession);
  const state = createStore(() => ({ sessions, splits: {}, workspans: [], activeWorkspanId: "ws-a", tabStatuses: {}, tabNotifications: {}, tabStatusDetails: {}, statsPanelRefreshSeq: {} }));
  const writes = [], exports = {};
  let barrier = null;
  const queueSshSessionPersistence = async value => {
    const snapshot = value.map(lib("terminalConversationRestore").persistTerminalSession);
    writes.push(snapshot);
    if (barrier) await barrier;
    saved.splice(0, saved.length, ...snapshot);
  };
  runInNewContext(compile(`const TAB_STATUS_PRIORITY = ${priority};\n${helperCode}\nexports.hook = ${action("handleCliHookEvent")}; exports.detect = receiveAgentDetection; exports.reconcile = ${subscription};`), {
    exports, Date: Clock, ...lib("terminalAgent"), ...lib("terminalHookIdentity"), ...lib("terminalOutputActivity"),
    ...load(resolve(root, "src/stores/terminalHookBinding.ts")), ...load(resolve(root, "src/stores/terminalCliSession.ts")),
    get: state.getState, set: state.setState, useTerminalStore: state,
    useProjectStore: { getState: () => ({ projects: [], worktrees: [] }) },
    useSessionStore: { getState: () => ({ sessions: saved }) }, queueSshSessionPersistence,
    findProjectByPath: () => null, findWorktreeByPath: () => null, resolveHookWslDistroName: value => value.wslDistroName,
    clearHookRunningTimeout: () => {}, scheduleHookRunningTimeout: () => {},
    retainTerminalSnapshots: () => {}, terminalProcessManager: { getAgentDetection: () => null }, logInfo: () => {}, logWarn: () => {},
  });
  state.subscribe(exports.reconcile);
  return {
    ...exports, ...lib("terminalHookIdentity"), state, saved, writes,
    setNow: value => { now = value; }, block: value => { barrier = value; },
    event: (id, extra = {}, options) => exports.hook({ tabId: id, source: "codex", event: "PreToolUse", sessionId: `cli-${id}`, timestamp: new Date(now).toISOString(), ...extra }, options),
  };
}

test("100 repeated local/WSL/SSH Hooks preserve session references and enqueue no persistence", async () => {
  for (const environment of ["local", "wsl", "ssh"]) {
    const sessions = [session("a", environment), session("b", environment)];
    const h = harness(sessions);
    let sessionUpdates = 0;
    h.state.subscribe((state, prev) => { if (state.sessions !== prev.sessions) sessionUpdates++; });
    for (let i = 0; i < 100; i++) { h.setNow(10_000 + i); h.event("b", { environmentType: environment }); }
    await tick();
    assert.equal(sessionUpdates, 0); assert.equal(h.writes.length, 0);
    assert.equal(h.state.getState().sessions, sessions);
    assert.equal(h.isDetectionOlderThanHook("b", 10_050), true);
  }
});

test("Hook refreshes stay with their split/Workspan session instead of the visible session", async () => {
  const h = harness();
  h.state.setState({ activeSessionId: "a", activeWorkspanId: "ws-a", workspans: [{ id: "ws-a", sessions: ["a"] }, { id: "ws-b", sessions: ["b"] }] });
  h.event("b", { event: "Stop" });
  assert.equal(h.state.getState().statsPanelRefreshSeq.a, undefined);
  assert.equal(h.state.getState().statsPanelRefreshSeq.b, 1);
  h.event("b", { event: "UserPromptSubmit" });
  assert.equal(h.state.getState().statsPanelRefreshSeq.b, 2);
  h.event("a", { event: "StopFailure" });
  assert.equal(h.state.getState().statsPanelRefreshSeq.a, 1);
  await tick(); assert.equal(h.writes.length, 0);
});

test("identity changes persist once while pending; SSH metadata self-heals and failures can retry", async () => {
  const h = harness([session("a", "ssh", { remoteTranscriptRef: "old" })]);
  const pending = deferred(); h.block(pending.promise);
  for (let i = 0; i < 20; i++) h.event("a", { environmentType: "ssh", remoteTranscriptRef: "new", reasoningEffort: "high" });
  assert.equal(h.writes.length, 1);
  pending.resolve(); await tick(); h.block(null);
  assert.equal(h.saved[0].remoteTranscriptRef, "new");
  h.saved[0].remoteTranscriptRef = "missing";
  h.event("a", { environmentType: "ssh", remoteTranscriptRef: "new", reasoningEffort: "high" });
  await tick(); assert.equal(h.writes.length, 2); assert.equal(h.saved[0].remoteTranscriptRef, "new");
  const failed = deferred(); h.block(failed.promise);
  h.event("a", { environmentType: "ssh", remoteTranscriptRef: "after-failure" });
  failed.reject(Error("disk busy")); await tick(); h.block(null);
  h.event("a", { environmentType: "ssh", remoteTranscriptRef: "after-failure" });
  await tick(); assert.equal(h.writes.length, 4); assert.equal(h.saved[0].remoteTranscriptRef, "after-failure");
});

test("late Hook identity and daemon detections cannot roll back newer bindings", async () => {
  const h = harness();
  h.event("a", { event: "Stop", sessionId: "new-cli" }); await tick();
  h.event("a", { event: "UserPromptSubmit", sessionId: "old-cli", timestamp: new Date(9000).toISOString() });
  assert.equal(h.state.getState().sessions[0].cliSessionId, "new-cli");
  assert.equal(h.state.getState().tabStatuses.a.hook, "done");
  assert.equal(h.state.getState().statsPanelRefreshSeq.a, 1);
  h.detect("a", { agent: null, updatedAtMs: 9999 });
  assert.equal(h.state.getState().sessions[0].cliSessionId, "new-cli");
  h.detect("a", { agent: null, updatedAtMs: 10_001 }); await tick();
  assert.equal(h.state.getState().sessions[0].runtimeAgent, null);
  assert.equal(h.state.getState().sessions[0].cliSessionId, undefined);
});

test("guest dynamic binding works without process detection or an installed launcher Hook", async () => {
  for (const environment of ["local", "wsl", "ssh"]) {
    const h = harness([session("a", environment, { runtimeAgent: undefined, cliSessionId: undefined })]);
    h.event("a", { source: "claude", sessionId: "manual-cli", environmentType: environment }); await tick();
    assert.equal(h.state.getState().sessions[0].runtimeAgent.tool, "claude");
    assert.equal(h.state.getState().sessions[0].cliSessionId, "manual-cli");
    assert.equal(h.saved[0].cliTool, "claude"); assert.equal(h.writes.length, 1);
    h.state.setState({ sessions: [] });
    assert.equal(h.isDetectionOlderThanHook("a", 1), false);
  }
});


test("an identity returning to its saved value still supersedes an outstanding different write", async () => {
  const h = harness([session("a", "ssh", { remoteTranscriptRef: "original" })]);
  const pending = deferred(); h.block(pending.promise);
  h.event("a", { environmentType: "ssh", remoteTranscriptRef: "intermediate" });
  h.setNow(10_001);
  h.event("a", { environmentType: "ssh", remoteTranscriptRef: "original" });
  assert.equal(h.writes.length, 2);
  pending.resolve(); await tick();
  assert.equal(h.saved[0].remoteTranscriptRef, "original");
});
