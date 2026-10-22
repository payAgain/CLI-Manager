import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createStore } from "zustand/vanilla";
import ts from "typescript";

const cache = new Map();
function load(path) {
  const url = new URL(path, import.meta.url);
  if (cache.has(url.href)) return cache.get(url.href);
  const exports = {};
  cache.set(url.href, exports);
  evaluate(url, name => {
    assert.ok(name.startsWith("."), `unexpected runtime import ${name}`);
    return load(new URL(name + ".ts", url));
  }, exports);
  return exports;
}
function evaluate(url, require, exports) {
  const code = ts.transpileModule(readFileSync(url, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("require", "exports", code)(require, exports);
}
const scopeHelpers = load("../src/lib/historyScope.ts");
const { resolveHistoryOpenScope } = scopeHelpers;
const project = (id, path, extras = {}) => ({
  id, path, name: id, environment_type: "local", remote_path: "", ssh_host_id: "", ...extras,
});
const main = project("main", "E:/Work/main");
const other = project("other", "E:/Work/other");
const tree = { id: "tree", project_id: main.id, path: "E:/trees/feature" };
const terminal = (id, extras = {}) => ({ id, title: id, ...extras });
const all = { projectPath: null, projectId: null, scopedProjectPath: null };
const mainScope = { projectPath: main.path, projectId: main.id, scopedProjectPath: null };
const context = (extras = {}) => ({
  terminalScope: { kind: "all" }, activeSessionId: "active",
  sessions: [terminal("active", { projectId: main.id, cwd: main.path })],
  projects: [main, other], groups: [], worktrees: [tree], ...extras,
});

test("default history follows the active pane and Workspan without changing any terminal state", () => {
  const input = context({ sessions: [
    terminal("background", { projectId: other.id, cwd: other.path }),
    terminal("active", { projectId: main.id, cwd: main.path }),
  ] });
  const before = structuredClone(input);
  assert.deepEqual(resolveHistoryOpenScope(undefined, input), mainScope);
  input.activeSessionId = "background";
  assert.deepEqual(resolveHistoryOpenScope(undefined, input), {
    projectPath: other.path, projectId: other.id, scopedProjectPath: null,
  });
  input.activeSessionId = "active";
  assert.deepEqual(input, before);
});

test("a selected project takes priority over a hidden terminal even with no terminal of its own", () => {
  for (const sessions of [[], [terminal("active", { projectId: other.id, cwd: other.path })]]) {
    assert.deepEqual(resolveHistoryOpenScope(undefined, context({
      terminalScope: { kind: "project", projectId: main.id }, sessions,
    })), mainScope);
  }
});

test("manual All Projects and explicit project/worktree selections override the default", () => {
  assert.deepEqual(resolveHistoryOpenScope({ projectPath: null }, context()), all);
  assert.deepEqual(resolveHistoryOpenScope({ projectId: null }, context()), all);
  assert.deepEqual(resolveHistoryOpenScope({ projectPath: other.path, projectId: other.id }, context()), {
    projectPath: other.path, projectId: other.id, scopedProjectPath: null,
  });
  const explicit = { ...mainScope, scopedProjectPath: tree.path };
  assert.deepEqual(resolveHistoryOpenScope(explicit, context()), explicit);
});

test("worktree context is retained for both selected empty worktrees and restored terminals", () => {
  for (const extras of [
    { terminalScope: { kind: "worktree", projectId: main.id, worktreeId: tree.id }, sessions: [] },
    { sessions: [terminal("active", { projectId: main.id, worktreeId: tree.id, cwd: other.path })] },
    { sessions: [terminal("active", { cwd: tree.path + "/src" })] },
  ]) {
    assert.deepEqual(resolveHistoryOpenScope(undefined, context(extras)), { ...mainScope, scopedProjectPath: tree.path });
  }
});

test("nested subagent and file-editor panes use their owning project and worktree", () => {
  const parent = terminal("parent", { projectId: main.id, worktreeId: tree.id, cwd: tree.path });
  const child = terminal("child", { kind: "subagent-transcript", subagent: { parentSessionId: parent.id } });
  const grandchild = terminal("active", { kind: "subagent-transcript", subagent: { parentSessionId: child.id } });
  const file = terminal("active", { kind: "file-editor", fileEditor: {
    projectId: main.id, projectPath: tree.path, project: main,
  } });
  for (const sessions of [[parent, child, grandchild], [file]]) {
    assert.deepEqual(resolveHistoryOpenScope(undefined, context({ sessions })), { ...mainScope, scopedProjectPath: tree.path });
  }
});

test("orphaned or cyclic subagent panes do not adopt a different project's terminal", () => {
  const child = terminal("active", { kind: "subagent-transcript", subagent: { parentSessionId: "missing" } });
  for (const sessions of [[child], [{ ...child, subagent: { parentSessionId: "active" } }]]) {
    assert.deepEqual(resolveHistoryOpenScope(undefined, context({ sessions })), all);
  }
});

test("local and WSL history use checkout paths while SSH stays on the matching host", () => {
  for (const environment_type of ["local", "wsl", "ssh"]) {
    const current = project("remote", "E:/local-placeholder", {
      environment_type, remote_path: "/srv/repo", ssh_host_id: "host-a",
    });
    const input = context({ projects: [current], sessions: [terminal("active", { projectId: current.id })] });
    assert.deepEqual(resolveHistoryOpenScope(undefined, input), {
      projectPath: environment_type === "ssh" ? current.remote_path : current.path,
      projectId: current.id, scopedProjectPath: null,
    });
  }
  const remote = project("remote", "E:/local-placeholder", { environment_type: "ssh", remote_path: "/srv/repo", ssh_host_id: "host-a" });
  const wrongHost = { ...remote, id: "wrong-host", ssh_host_id: "host-b" };
  assert.equal(resolveHistoryOpenScope(undefined, context({
    projects: [wrongHost, remote],
    sessions: [terminal("active", { environmentType: "ssh", sshHostId: "host-a", remotePath: "/srv/repo/src" })],
  })).projectId, remote.id);
});

test("group scope never borrows a hidden terminal outside the selected group", () => {
  const grouped = { ...main, group_id: "group" };
  const input = context({
    projects: [grouped, other], groups: [{ id: "group" }], terminalScope: { kind: "group", groupId: "group" },
  });
  assert.deepEqual(resolveHistoryOpenScope(undefined, input), mainScope);
  input.sessions = [terminal("active", { projectId: other.id })];
  assert.deepEqual(resolveHistoryOpenScope(undefined, input), all);
});

test("no current project keeps all history available; an unregistered shell uses its directory", () => {
  assert.deepEqual(resolveHistoryOpenScope(undefined, context({ activeSessionId: null })), all);
  assert.deepEqual(resolveHistoryOpenScope(undefined, context({
    sessions: [terminal("active", { cwd: "E:/unregistered" })],
  })), { ...all, projectPath: "E:/unregistered" });
});

function historyStoreHarness(input = context(), loaded = true, fetchProjects = async () => {}) {
  const calls = [];
  const projects = { projects: input.projects, groups: input.groups, loaded,
    fetchAll: async () => { calls.push(["fetchProjects"]); await fetchProjects(); projects.loaded = true; },
  };
  const exports = {};
  const modules = {
    "zustand": { create: createStore },
    "@tauri-apps/api/core": { invoke: async (...args) => { calls.push(args); return []; } },
    "@tauri-apps/api/event": { listen: async () => () => {} },
    "../lib/logger": { createPerfMarker: () => () => {} },
    "../lib/historyProjectPaths": load("../src/lib/historyProjectPaths.ts"),
    "../lib/historyScope": scopeHelpers,
    "../lib/sshAgentHistory": { buildSshAgentHistoryContext: async project => { calls.push(["remoteProject", project]); return null; } },
    "./projectStore": { useProjectStore: { getState: () => projects } },
    "./terminalStore": { useTerminalStore: { getState: () => input } },
    "./worktreeStore": { useWorktreeStore: { getState: () => ({ worktrees: input.worktrees }) } },
  };
  evaluate(new URL("../src/stores/historyStore.ts", import.meta.url), name => modules[name] ?? {}, exports);
  const store = exports.useHistoryStore;
  store.setState({
    loadIndexStatus: async () => {},
    loadSessions: async () => { calls.push(["load", store.getState().projectPathFilter, store.getState().scopedProjectPathFilter]); },
  });
  return { store, calls, input };
}

test("openHistory defaults to current project, allows All, and preserves All on repeated global opens", async () => {
  const { store, calls } = historyStoreHarness();
  await store.getState().openHistory();
  assert.equal(store.getState().projectPathFilter, main.path);
  assert.equal(store.getState().projectIdFilter, main.id);
  assert.equal(store.getState().sourceFilter, "all");
  assert.deepEqual(calls.at(-1), ["load", main.path, null]);
  await store.getState().openHistory({ projectPath: null, projectId: null });
  assert.equal(store.getState().projectPathFilter, null);
  const loadCount = calls.length;
  await store.getState().openHistory();
  assert.equal(store.getState().projectPathFilter, null);
  assert.equal(calls.length, loadCount);
  store.getState().closeHistory();
  await store.getState().openHistory();
  assert.equal(store.getState().projectPathFilter, main.path);
});

test("opening history after switching panes or an empty selected project uses the new project", async () => {
  const { store, input } = historyStoreHarness();
  await store.getState().openHistory();
  store.getState().closeHistory();
  input.sessions = [terminal("active", { projectId: other.id })];
  await store.getState().openHistory();
  assert.equal(store.getState().projectIdFilter, other.id);
  store.getState().closeHistory();
  input.terminalScope = { kind: "project", projectId: main.id };
  input.sessions = [];
  await store.getState().openHistory();
  assert.equal(store.getState().projectIdFilter, main.id);
});

test("default open loads project metadata before resolving scope and keeps explicit worktree filters", async () => {
  const { store, calls } = historyStoreHarness(context(), false);
  await store.getState().openHistory();
  assert.deepEqual(calls[0], ["fetchProjects"]);
  assert.equal(store.getState().projectIdFilter, main.id);
  await store.getState().openHistory({ ...mainScope, scopedProjectPath: tree.path });
  assert.deepEqual(calls.at(-1), ["load", main.path, tree.path]);
});

test("default SSH open creates history context from the remote project instead of a local path", async () => {
  const remote = project("ssh", "E:/placeholder", { environment_type: "ssh", remote_path: "/srv/repo", ssh_host_id: "host-a" });
  const { store, calls } = historyStoreHarness(context({
    projects: [remote], sessions: [], terminalScope: { kind: "project", projectId: remote.id },
  }));
  await store.getState().openHistory();
  assert.equal(store.getState().projectPathFilter, remote.remote_path);
  assert.deepEqual(calls.find(([kind]) => kind === "remoteProject"), ["remoteProject", remote]);
});

test("a delayed project load cannot overwrite a later explicit All Projects selection", async () => {
  let release;
  const loaded = new Promise(resolve => { release = resolve; });
  const { store } = historyStoreHarness(context(), false, () => loaded);
  const opening = store.getState().openHistory();
  await store.getState().openHistory({ projectPath: null });
  release();
  await opening;
  assert.equal(store.getState().projectPathFilter, null);
  assert.equal(store.getState().projectIdFilter, null);
});
