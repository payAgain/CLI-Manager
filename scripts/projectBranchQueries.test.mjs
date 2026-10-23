import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
const exports = {};
runInNewContext(ts.transpileModule(readFileSync(new URL("../src/lib/projectBranchQueries.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports, Date });
const { createProjectBranchQueries, projectBranchTarget: target } = exports;
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test("sidebar, statusbar and split/Workspan panels share one checkout read and unchanged values never publish", async () => {
  const reads = [], pending = deferred();
  let now = 0, changes = 0;
  const registry = createProjectBranchQueries({ read: path => { reads.push(path); return pending.promise; }, now: () => now });
  const stops = Array.from({ length: 100 }, (_, index) => registry.subscribe(target(index % 2 ? "/repo/" : "/repo"), () => changes++));
  registry.refresh(true);
  assert.equal(reads.length, 1);
  pending.resolve("main"); await tick();
  assert.equal(changes, 100);
  registry.refresh(); await tick();
  assert.equal(reads.length, 1);
  now = 15_000;
  registry.refresh(); await tick();
  assert.equal(reads.length, 2);
  assert.equal(changes, 100);
  assert.equal(registry.getSnapshot(target("/repo")), "main");
  stops.forEach(stop => stop());
  registry.refresh(true); await tick();
  assert.equal(reads.length, 2);
});

test("large project lists limit process concurrency and skip unsubscribed queued projects", async () => {
  const reads = [], requests = [];
  const registry = createProjectBranchQueries({ read: path => { reads.push(path); const d = deferred(); requests.push(d); return d.promise; } });
  const stops = Array.from({ length: 30 }, (_, i) => registry.subscribe(target(`/repo/${i}`), () => {}));
  assert.equal(reads.length, 4);
  stops[4]();
  registry.setEnabled(false);
  requests.slice().forEach(request => request.resolve("main")); await tick();
  assert.equal(reads.length, 4);
  registry.setEnabled(true);
  assert.equal(reads.length, 8);
  assert.equal(reads.includes("/repo/4"), false);
  while (requests.some(request => !request.done)) {
    for (const request of requests.slice()) { request.done = true; request.resolve("main"); }
    await tick();
  }
  assert.equal(reads.length, 29);
});

test("path keys isolate Worktrees and environments while normalizing Windows and WSL aliases", () => {
  assert.equal(target("C:\\Repo\\").key, target("c:/repo").key);
  assert.equal(target("\\\\wsl$\\Ubuntu\\home\\Repo", "wsl").key, target("//wsl.localhost/ubuntu/home/Repo/", "local").key);
  assert.notEqual(target("//wsl.localhost/ubuntu/home/Repo").key, target("//wsl.localhost/ubuntu/home/repo").key);
  assert.notEqual(target("/repo", "local").key, target("/repo", "wsl").key);
  assert.notEqual(target("/repo").key, target("/repo.worktrees/feature").key);
  assert.equal(target("/repo", "ssh"), null);
});

test("late results cannot leak into a different checkout and failed refreshes retain valid data", async () => {
  const a = deferred(), b = deferred();
  let first = true, calls = 0, changes = 0;
  const registry = createProjectBranchQueries({ read: path => { calls++; return path === "/a" ? a.promise : first ? b.promise : Promise.reject(Error("busy")); } });
  const stop = registry.subscribe(target("/a"), () => changes++);
  stop();
  registry.subscribe(target("/b"), () => changes++);
  b.resolve("branch-b"); a.resolve("branch-a"); await tick();
  assert.equal(changes, 1);
  assert.equal(registry.getSnapshot(target("/b")), "branch-b");
  first = false; registry.refresh(true); await tick();
  assert.equal(calls, 3);
  assert.equal(changes, 1);
  assert.equal(registry.getSnapshot(target("/b")), "branch-b");
});

function watcherFixture() {
  const hooks = [], timers = new Map(), events = new Map(), nativeEvents = new Set(), requests = [];
  const state = { visible: true, minimized: false, documentVisible: true, focused: true };
  const context = {
    exports: {}, Date, ...exports,
    isTauri: () => true,
    getCurrentWindow: () => ({
      isVisible: async () => state.visible, isMinimized: async () => state.minimized,
      onFocusChanged: async cb => { nativeEvents.add(cb); return () => nativeEvents.delete(cb); },
      onResized: async cb => { nativeEvents.add(cb); return () => nativeEvents.delete(cb); },
    }),
    document: {
      get visibilityState() { return state.documentVisible ? "visible" : "hidden"; }, hasFocus: () => state.focused,
      addEventListener: (key, cb) => events.set(key, cb), removeEventListener: key => events.delete(key),
    },
    window: {
      setInterval: (cb, ms) => { const key = Symbol(); timers.set(key, { cb, ms }); return key; }, clearInterval: key => timers.delete(key),
      addEventListener: (key, cb) => events.set(key, cb), removeEventListener: key => events.delete(key),
    },
    invoke: async (command, { path }) => {
      assert.equal(command, "get_current_git_branch"); const d = deferred(); requests.push({ path, ...d }); return d.promise;
    },
    useMemo: fn => fn(), useCallback: fn => fn,
    useSyncExternalStore: (subscribe, getSnapshot) => { hooks.push(subscribe(() => {})); return getSnapshot(); },
  };
  const execute = file => {
    const raw = readFileSync(new URL(file, import.meta.url), "utf8");
    const ast = ts.createSourceFile("file.ts", raw, ts.ScriptTarget.Latest, true);
    const body = ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join("\n");
    runInNewContext(ts.transpileModule(body, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
    Object.assign(context, context.exports);
  };
  execute("../src/lib/appWindowVisibility.ts"); execute("../src/hooks/useProjectBranch.ts");
  return { state, requests, timers, events, nativeEvents, subscribe: path => context.useCheckoutBranch(path), stop: () => hooks.splice(0).forEach(fn => fn()) };
}

test("the production branch watcher shares one timer, stops queued reads in tray, and resumes while visible but unfocused", async () => {
  const f = watcherFixture();
  for (let i = 0; i < 30; i++) f.subscribe(`/repo/${i}`);
  await tick(); assert.equal(f.requests.length, 4); assert.equal(f.timers.size, 1);
  f.state.visible = false; f.state.focused = false;
  for (const cb of f.nativeEvents) cb(); await tick();
  f.requests.slice().forEach(r => r.resolve("main")); await tick();
  assert.equal(f.requests.length, 4);
  for (const timer of f.timers.values()) timer.cb(); await tick(); assert.equal(f.requests.length, 4);
  f.state.visible = true;
  for (const cb of f.nativeEvents) cb(); await tick();
  assert.equal(f.requests.length, 8);
  f.state.documentVisible = false; f.events.get("visibilitychange")();
  f.requests.slice(4).forEach(r => r.resolve("main")); await tick(); assert.equal(f.requests.length, 8);
  f.stop(); await tick(); assert.equal(f.timers.size, 0); assert.equal(f.nativeEvents.size, 0);
});
