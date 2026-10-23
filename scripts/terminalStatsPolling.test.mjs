import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
const stripImports = source => {
  const ast = ts.createSourceFile("source.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join("\n");
};
const panelSource = read("../src/components/terminal/TerminalStatsPanel.tsx");
const panelAst = ts.createSourceFile("panel.tsx", panelSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = panelAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "TerminalStatsPanel");
// Execute the component's real hooks/effects, stopping before presentation-only JSX.
const body = [];
for (const statement of component.body.statements) {
  if (statement.getText(panelAst).startsWith("const stats = useMemo")) break;
  body.push(statement.getText(panelAst));
}
const prelude = panelAst.statements.filter(node => node !== component && !ts.isImportDeclaration(node)).map(node => node.getText(panelAst)).join("\n");
const panelCode = compile(`${prelude}\nexports.panel = (${component.parameters.map(p => p.getText(panelAst)).join(",")}) => { ${body.join("\n")} return { latestSession, panelActive, updatedAt, statsPanelRefreshSeq }; };`);
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

function fixture({ environment = "local", worktree = false, native = true } = {}) {
  const slots = [], effects = [], timers = new Map(), events = new Map(), requests = [];
  const visibility = { native, visible: true, minimized: false, documentVisible: true, focused: true };
  const sessions = ["a", "b"].map(id => ({ id, projectId: id, cliSessionId: `cli-${id}`, cliTool: "codex", title: "codex", cwd: `/repo/${id}`, environmentType: environment, ...(worktree ? { worktreeId: `wt-${id}` } : {}) }));
  const store = { sessions, statsPanelRefreshSeq: {} };
  const projects = sessions.map(s => ({ id: s.id, environment_type: environment, path: s.cwd, remote_path: `/remote/${s.id}`, ssh_host_id: `host-${s.id}`, cli_tool: "codex" }));
  const worktrees = sessions.map(s => ({ id: `wt-${s.id}`, path: `/worktrees/${s.id}` }));
  let index = 0, dirty = false, timerId = 0, props = { activeSessionId: "a", open: true }, output;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const memo = (factory, deps) => { const i = index++; if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { value: factory(), deps }; return slots[i].value; };
  const hooks = {
    useState: initial => {
      const i = index++; slots[i] ??= { value: typeof initial === "function" ? initial() : initial };
      const slot = slots[i]; slot.set ??= value => { const next = typeof value === "function" ? value(slot.value) : value; if (!Object.is(next, slot.value)) { slot.value = next; dirty = true; } };
      return [slot.value, slot.set];
    },
    useRef: initial => { const i = index++; slots[i] ??= { current: initial }; return slots[i]; },
    useMemo: memo, useCallback: (fn, deps) => memo(() => fn, deps),
    useEffect: (fn, deps) => {
      const i = index++, previous = slots[i]; if (previous && same(previous.deps, deps)) return;
      slots[i] = { deps, cleanup: previous?.cleanup };
      effects.push(() => { slots[i].cleanup?.(); slots[i].cleanup = fn(); });
    },
  };
  const eventTarget = {
    addEventListener: (key, cb) => { if (!events.has(key)) events.set(key, new Set()); events.get(key).add(cb); },
    removeEventListener: (key, cb) => events.get(key)?.delete(cb),
  };
  const nativeEvents = { focus: new Set(), resize: new Set() };
  const appWindow = {
    isVisible: async () => visibility.readVisible ? visibility.readVisible() : visibility.visible, isMinimized: async () => visibility.minimized,
    onFocusChanged: async cb => { nativeEvents.focus.add(cb); return () => nativeEvents.focus.delete(cb); },
    onResized: async cb => { nativeEvents.resize.add(cb); return () => nativeEvents.resize.delete(cb); },
  };
  const context = {
    ...hooks, exports: {}, Date, Map, Set, console,
    isTauri: () => visibility.native, getCurrentWindow: () => appWindow,
    window: { ...eventTarget, setInterval: (cb, ms) => { const id = ++timerId; timers.set(id, { cb, ms }); return id; }, clearInterval: id => timers.delete(id) },
    document: { ...eventTarget, get visibilityState() { return visibility.documentVisible ? "visible" : "hidden"; }, hasFocus: () => visibility.focused },
  };
  runInNewContext(compile(stripImports(read("../src/lib/appWindowVisibility.ts"))), context);
  Object.assign(context, context.exports);
  runInNewContext(compile(stripImports(read("../src/hooks/useAppWindowVisible.ts"))), context);
  Object.assign(context, context.exports);
  const query = (kind, args) => { const d = deferred(); requests.push({ kind, args, ...d }); return d.promise; };
  Object.assign(context, {
    useI18n: () => ({ t: key => key }), useSaveSessionToSidebar: () => ({}),
    useTerminalStore: selector => selector(store),
    useSettingsStore: selector => selector({ terminalStatsCardVisibility: {}, terminalStatsCardOrder: [] }),
    useProjectStore: selector => selector({ projects }), useWorktreeStore: selector => selector({ worktrees }),
    runtimeAgentTool: () => undefined, calculateTokenStats: () => ({}), TERM: {},
    resolveTerminalProjectPath: cwd => cwd,
    fetchLatestProjectSessionDetail: (...args) => query("local", args),
    buildSshAgentHistoryContext: async project => ({ launch: { projectId: project.id } }),
    fetchRemoteLatestProjectSessionDetail: (...args) => query("ssh", args),
  });
  runInNewContext(panelCode, context);
  const render = (next = props) => {
    props = next;
    for (let pass = 0; pass < 30; pass++) {
      index = 0; dirty = false; output = context.exports.panel(props);
      while (effects.length) effects.shift()();
      if (!dirty) return output;
    }
    throw Error("render loop");
  };
  const flush = async () => { for (let i = 0; i < 4; i++) { await tick(); render(); } };
  const emit = name => { for (const cb of events.get(name) ?? []) cb(); };
  const resolveRequest = (i, title = `result-${i}`) => {
    const request = requests[i];
    const cli = request.kind === "ssh" ? request.args[2] : request.args[3];
    const result = { session_id: cli, file_path: title, updated_at: 100, usage: { input_tokens: 10 }, title };
    request.resolve(request.kind === "ssh" ? { result, context: request.args[0] } : result);
  };
  render();
  return { requests, store, projects, visibility, timers, render, flush, emit, resolveRequest, get output() { return output; }, unmount: () => slots.forEach(slot => slot.cleanup?.()) };
}

test("stats polling pauses for hidden/minimized/tray windows, refreshes on restore, and continues when visible but unfocused", async () => {
  for (const hidden of ["documentVisible", "visible", "minimized"]) {
    const f = fixture(); await f.flush(); assert.equal(f.requests.length, 1);
    f.resolveRequest(0); await f.flush();
    f.visibility.focused = false; f.emit("blur"); await f.flush();
    assert.equal(f.output.panelActive, true);
    for (const timer of f.timers.values()) timer.cb(); await f.flush();
    assert.equal(f.requests.length, 2); f.resolveRequest(1); await f.flush();
    f.visibility[hidden] = hidden === "minimized"; f.emit(hidden === "documentVisible" ? "visibilitychange" : "blur"); await f.flush();
    assert.equal(f.output.panelActive, false); assert.equal(f.timers.size, 0);
    f.visibility[hidden] = hidden !== "minimized"; f.emit("focus"); await f.flush();
    assert.equal(f.output.panelActive, true); assert.equal(f.requests.length, 3);
    f.unmount();
  }
});

test("another pane/Workspan Hook does not query the current stats panel; repeated invalidation coalesces in flight", async () => {
  const f = fixture(); await f.flush(); f.resolveRequest(0); await f.flush();
  f.store.statsPanelRefreshSeq.b = 1; f.render(); await f.flush(); assert.equal(f.requests.length, 1);
  f.store.statsPanelRefreshSeq.a = 1; f.render(); await f.flush(); assert.equal(f.requests.length, 2);
  for (let i = 2; i < 10; i++) { f.store.statsPanelRefreshSeq.a = i; f.render(); }
  await f.flush(); assert.equal(f.requests.length, 2);
  f.resolveRequest(1); await f.flush(); assert.equal(f.requests.length, 3);
  f.resolveRequest(2); await f.flush(); assert.equal(f.requests.length, 3);
  f.unmount();
});

test("late local/WSL/SSH results do not contaminate a different pane, Worktree or remote context", async () => {
  for (const environment of ["local", "wsl", "ssh"]) {
    const f = fixture({ environment, worktree: environment !== "ssh" }); await f.flush();
    if (environment !== "ssh") assert.equal(f.requests[0].args[0], "/worktrees/a");
    f.render({ activeSessionId: "b", open: true }); await f.flush(); assert.equal(f.requests.length, 2);
    f.resolveRequest(1, "current-b"); await f.flush();
    f.resolveRequest(0, "old-a"); await f.flush();
    assert.equal(f.output.latestSession.title, "current-b");
    f.store.statsPanelRefreshSeq.b = 1; f.render(); await f.flush();
    const last = f.requests.at(-1);
    if (environment === "ssh") assert.equal(last.args[0].launch.projectId, "b");
    else assert.equal(last.args[0], "/worktrees/b");
    f.unmount();
  }
});

test("closing and reopening the same scope joins its pending request and hidden panels never start reads", async () => {
  const f = fixture(); await f.flush();
  f.render({ activeSessionId: "a", open: false }); await f.flush(); assert.equal(f.timers.size, 0);
  f.render({ activeSessionId: "a", open: true }); await f.flush(); assert.equal(f.requests.length, 1);
  f.resolveRequest(0, "reopened"); await f.flush(); assert.equal(f.output.latestSession.title, "reopened");
  f.render({ activeSessionId: "b", open: true, visible: false }); await f.flush();
  assert.equal(f.requests.length, 1); assert.equal(f.timers.size, 0); f.unmount();
});


test("a delayed native visibility result cannot reopen polling after a newer tray event", async () => {
  const f = fixture(); await f.flush(); f.resolveRequest(0); await f.flush();
  const old = deferred(); f.visibility.readVisible = () => old.promise;
  f.emit("blur");
  f.visibility.visible = false; delete f.visibility.readVisible; f.emit("blur");
  await f.flush(); assert.equal(f.output.panelActive, false);
  old.resolve(true); await f.flush();
  assert.equal(f.output.panelActive, false); assert.equal(f.timers.size, 0); assert.equal(f.requests.length, 1);
  f.unmount();
});
