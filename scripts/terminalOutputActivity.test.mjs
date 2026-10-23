import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { createStore } from "zustand/vanilla";
import ts from "typescript";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const terminalSource = read("../src/stores/terminalStore.ts");
const ast = ts.createSourceFile("terminalStore.ts", terminalSource, ts.ScriptTarget.Latest, true);
function findNode(predicate) {
  let found;
  const visit = node => {
    if (predicate(node)) found = node;
    else ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(found, "production entry point exists");
  return found;
}
const action = name => findNode(node => ts.isPropertyAssignment(node)
  && node.name.getText(ast) === name).initializer.getText(ast);
const helperNames = new Set([
  "resolvePrimaryTabId", "mapCliHookEvent", "getTabStatusEntry", "getTabStatusDetails", "buildTabStatusUpdate",
]);
const helpers = ast.statements.filter(node => ts.isFunctionDeclaration(node)
  && helperNames.has(node.name?.text)).map(node => node.getText(ast)).join("\n");
const priorities = findNode(node => ts.isVariableDeclaration(node)
  && node.name.getText(ast) === "TAB_STATUS_PRIORITY").initializer.getText(ast);
const subscription = findNode(node => ts.isCallExpression(node)
  && node.expression.getText(ast) === "useTerminalStore.subscribe").arguments[0].getText(ast);
const production = compile(`const TAB_STATUS_PRIORITY = ${priorities};
${helpers}
exports.record = ${action("recordPtyOutputActivity")};
exports.hook = ${action("handleCliHookEvent")};
exports.reconcile = ${subscription};`);
const session = (id, environmentType = "local", extra = {}) => ({
  id, title: id, cliTool: "codex", cwd: "/repo", environmentType, ...extra,
});

function harness(sessions = [session("a"), session("b")]) {
  let now = 10_000;
  class Clock extends Date { static now() { return now; } }
  const activity = {}, routing = {}, exports = {}, modules = new Map();
  function load(path) {
    if (!isAbsolute(path)) return require(path);
    if (modules.has(path)) return modules.get(path);
    const exports = {};
    modules.set(path, exports);
    runInNewContext(compile(readFileSync(path, "utf8")), { exports, Date: Clock, Set, Map,
      require: name => load(name.startsWith(".") ? resolve(dirname(path), `${name}.ts`) : name) });
    return exports;
  }
  const identity = load(resolve(root, "src/lib/terminalHookIdentity.ts"));
  const { persistTerminalSession } = load(resolve(root, "src/lib/terminalConversationRestore.ts"));
  const persisted = { sessions: sessions.map(persistTerminalSession) };
  runInNewContext(compile(read("../src/lib/terminalOutputActivity.ts")), { exports: activity, Date: Clock });
  runInNewContext(compile(read("../src/stores/terminalHookBinding.ts")), { exports: routing });
  const state = createStore(() => ({
    sessions, sessionStatuses: Object.fromEntries(sessions.map(session => [session.id, "running"])),
    splits: {}, tabStatuses: {}, tabNotifications: {}, tabStatusDetails: {}, statsPanelRefreshSeq: {},
  }));
  runInNewContext(production, {
    exports, Date: Clock, ...activity, ...routing, ...identity,
    ...load(resolve(root, "src/stores/terminalCliSession.ts")),
    get: state.getState, set: state.setState, useTerminalStore: state,
    useProjectStore: { getState: () => ({ projects: [], worktrees: [] }) },
    useSessionStore: { getState: () => persisted },
    queueSshSessionPersistence: async sessions => { persisted.sessions = sessions.map(persistTerminalSession); },
    findProjectByPath: () => null, findWorktreeByPath: () => null,
    resolveHookWslDistroName: payload => payload.wslDistroName ?? null,
    acceptsAgentHook: () => true, applyHookAgentIdentity: value => value,
    clearHookRunningTimeout: () => {}, scheduleHookRunningTimeout: () => {},
    terminalProcessManager: { getAgentDetection: () => null },
    receiveAgentDetection: () => { throw new Error("unexpected detection"); },
    retainTerminalSnapshots: () => {}, logInfo: () => {}, logWarn: () => {},
  });
  state.subscribe(exports.reconcile);
  return {
    ...exports, ...activity, state,
    setNow: value => { now = value; },
    legacy: extra => exports.hook({
      tabId: "legacy-codex-tab", source: "codex", event: "SessionStart", cwd: "/repo", ...extra,
    }),
    external: extra => exports.hook({
      tabId: "external:codex", source: "codex", event: "SessionStart", cwd: "/repo", ...extra,
    }),
  };
}

test("100 streaming terminals do not publish global state while routing sees fresh activity immediately", () => {
  const sessions = Array.from({ length: 100 }, (_, index) => session(`pane-${index}`));
  const h = harness(sessions);
  let notifications = 0;
  h.state.subscribe(() => { notifications++; });
  for (let round = 0; round < 10; round++) {
    h.setNow(10_000 + round * 1000);
    for (const item of sessions) h.record(item.id);
  }
  assert.equal(notifications, 0);
  assert.equal(h.state.getState().sessions, sessions);
  assert.equal(h.getTerminalOutputActivity("pane-99"), 19_000);
  // All recently active panes are intentionally ambiguous, even across Workspans.
  assert.equal(h.legacy(), null);
  assert.equal(h.external(), null);
});

test("activity retains the existing per-terminal one-second throttle", () => {
  const h = harness();
  h.record("a");
  h.setNow(10_999);
  h.record("a");
  assert.equal(h.getTerminalOutputActivity("a"), 10_000);
  h.record("b");
  assert.equal(h.getTerminalOutputActivity("b"), 10_999);
  h.setNow(11_000);
  h.record("a");
  assert.equal(h.getTerminalOutputActivity("a"), 11_000);
});

test("legacy same-directory local, WSL and SSH hooks use the uniquely active pane without a timer", () => {
  for (const environmentType of ["local", "wsl", "ssh"]) {
    const h = harness([session("a", environmentType), session("b", environmentType)]);
    h.record("b");
    assert.equal(h.legacy({ environmentType }), "b");
    h.record("a");
    assert.equal(h.legacy({ environmentType }), null);
    h.setNow(16_000);
    assert.equal(h.legacy({ environmentType }), null);
    h.record("a");
    assert.equal(h.legacy({ environmentType }), "a");
  }
});

test("activity does not cross local/SSH boundaries and exact IDs still override activity", () => {
  const h = harness([session("a"), session("b"), session("ssh-a", "ssh"), session("ssh-b", "ssh")]);
  h.record("ssh-b");
  assert.equal(h.legacy(), null);
  assert.equal(h.legacy({ environmentType: "ssh" }), "ssh-b");
  assert.equal(h.legacy({ tabId: "a" }), "a");
  assert.equal(h.legacy({ tabId: "a", environmentType: "ssh" }), "ssh-b");
});

test("external same-directory hooks cannot claim recent output without an exact conversation identity", () => {
  for (const environmentType of ["local", "wsl", "ssh"]) {
    const h = harness([session("a", environmentType, { cliSessionId: "conversation-a" }), session("b", environmentType)]);
    h.record("b");
    assert.equal(h.external({ environmentType }), null);
    assert.equal(h.external({ environmentType, sessionId: "unknown" }), null);
    assert.equal(h.external({ environmentType, sessionId: "conversation-a" }), "a");
    assert.equal(h.state.getState().sessions[0].cliSessionId, "conversation-a");
    assert.equal(h.getTerminalOutputActivity("b"), 10_000);
  }
});

test("Stop and StopFailure clear activity and shell status before subsequent routing", () => {
  for (const event of ["Stop", "StopFailure"]) {
    const h = harness();
    h.state.setState({ tabStatuses: { a: { shell: "running" } } });
    h.record("a");
    assert.equal(h.legacy(), "a");
    assert.equal(h.hook({ tabId: "a", source: "codex", event, timestamp: new Date(10_000).toISOString() }), "a");
    assert.equal(h.getTerminalOutputActivity("a"), undefined);
    assert.equal(h.state.getState().tabStatuses.a.shell, undefined);
    assert.equal(h.state.getState().tabStatuses.a.hook, event === "Stop" ? "done" : "failed");
    assert.equal(h.legacy(), null);
    h.setNow(10_001);
    h.record("a");
    assert.equal(h.legacy(), "a");
  }
});

test("stale and subagent completion events cannot erase current parent activity", () => {
  const h = harness();
  h.state.setState({ tabStatuses: { a: { hook: "running", hookUpdatedAt: new Date(10_000).toISOString() } } });
  h.record("a");
  h.hook({ tabId: "a", source: "codex", event: "Stop", timestamp: new Date(9000).toISOString() });
  assert.equal(h.getTerminalOutputActivity("a"), 10_000);
  h.hook({ tabId: "a", source: "codex", event: "Stop" }, { subagent: true });
  assert.equal(h.getTerminalOutputActivity("a"), 10_000);
});

test("late hooks for stopped recovery tabs cannot change identity or clear retained activity", () => {
  for (const status of ["exited", "error"]) {
    const original = session("a", "local", { cliSessionId: "recovery-conversation" });
    const h = harness([original]);
    h.state.setState({ sessionStatuses: { a: status } });
    h.record("a");
    assert.equal(h.hook({ tabId: "a", source: "codex", event: "Stop", sessionId: "late-conversation" }), null);
    assert.equal(h.state.getState().sessions[0], original);
    assert.equal(h.getTerminalOutputActivity("a"), 10_000);
  }
});

test("session removal clears activity while metadata updates and other panes retain it", () => {
  const h = harness();
  h.record("a");
  h.record("b");
  h.state.setState({ sessions: [session("a", "local", { title: "renamed" }), session("b")] });
  assert.equal(h.getTerminalOutputActivity("a"), 10_000);
  h.state.setState({ sessions: [session("b")] });
  assert.equal(h.getTerminalOutputActivity("a"), undefined);
  assert.equal(h.getTerminalOutputActivity("b"), 10_000);
  h.state.setState({ sessions: [session("a"), session("b")] });
  assert.equal(h.legacy(), "b");
  h.state.setState({ sessions: [] });
  assert.equal(h.getTerminalOutputActivity("b"), undefined);
});
