import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const project = (id, extras = {}) => ({
  id, name: id, path: `/repo/${id}`, remote_path: "", environment_type: "local", ssh_host_id: null, ...extras,
});
const session = (id, projectId, extras = {}) => ({ id, title: id, projectId, ...extras });
const worktree = (id, projectId, extras = {}) => ({ id, project_id: projectId, name: id, path: `/trees/${id}`, status: "active", ...extras });
const workspan = (id, sessionIds) => ({
  id, customTitle: null, activeSessionId: sessionIds[0] ?? null, activePaneId: `pane:${id}`,
  paneTree: { id: `pane:${id}`, type: "leaf", sessionIds, activeSessionId: sessionIds[0] ?? null },
});
const target = (kind, id, extras = {}) => ({
  kind, intent: "navigate", id: `navigate:${kind}:${id}`, label: id, description: "", searchText: id, active: false,
  [`${kind === "terminal" ? "session" : kind}Id`]: id, ...extras,
});

function fixture({ projects = [project("repo")], worktrees = [], sessions = [], sessionStatuses, workspans, activeSessionId = null } = {}) {
  const events = [];
  const projectState = { projects, worktrees };
  const terminalState = {
    sessions,
    sessionStatuses: sessionStatuses ?? Object.fromEntries(sessions.map(item => [item.id, "running"])),
    workspans: workspans ?? sessions.map(item => workspan(`span:${item.id}`, [item.id])),
    activeSessionId,
    setTerminalScope: scope => events.push(["scope", scope]),
    setActive: id => events.push(["active", id]),
    setActiveWorkspan: id => events.push(["workspan", id]),
    createSession: () => { throw new Error("navigation must never create a PTY"); },
  };
  const mocks = {
    "../stores/projectStore": { useProjectStore: { getState: () => projectState } },
    "../stores/terminalStore": { useTerminalStore: { getState: () => terminalState } },
    "../stores/historyStore": { useHistoryStore: { getState: () => ({ closeHistory: () => events.push(["history", "close"]) }) } },
  };
  const cache = new Map();
  function load(path) {
    const url = new URL(path, import.meta.url);
    if (cache.has(url.href)) return cache.get(url.href);
    const exports = {};
    cache.set(url.href, exports);
    const code = ts.transpileModule(readFileSync(url, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    new Function("require", "exports", code)(name => {
      if (mocks[name]) return mocks[name];
      assert.ok(name.startsWith("."), `unexpected runtime import ${name}`);
      return load(new URL(`${name}.ts`, url));
    }, exports);
    return exports;
  }
  return { api: load("../src/lib/quickJumpNavigation.ts"), events, terminalState, projectState };
}

test("an empty project or worktree selects its workspace without a launch or active-session fallback", () => {
  const { api, events } = fixture({ worktrees: [worktree("feature", "repo")], sessions: [session("unrelated", "other")] });
  assert.equal(api.activateQuickJumpTarget(target("project", "repo")), true);
  assert.deepEqual(events, [["scope", { kind: "project", projectId: "repo" }], ["history", "close"]]);
  events.length = 0;
  assert.equal(api.activateQuickJumpTarget(target("worktree", "feature", { projectId: "repo" })), true);
  assert.deepEqual(events, [["scope", { kind: "worktree", projectId: "repo", worktreeId: "feature" }], ["history", "close"]]);
});

test("project navigation preserves an active matching session, then prefers a live primary terminal", () => {
  const { api, events, terminalState } = fixture({
    worktrees: [worktree("feature", "repo")],
    sessions: [session("feature-session", "repo", { worktreeId: "feature" }), session("main-session", "repo"), session("exited", "repo")],
    sessionStatuses: { "feature-session": "running", "main-session": "running", exited: "exited" }, activeSessionId: "feature-session",
  });
  assert.equal(api.activateQuickJumpTarget(target("project", "repo")), true);
  assert.deepEqual(events.at(-1), ["active", "feature-session"]);
  terminalState.activeSessionId = "exited";
  assert.equal(api.activateQuickJumpTarget(target("project", "repo")), true);
  assert.deepEqual(events.at(-1), ["active", "main-session"]);
  assert.equal(api.activateQuickJumpTarget(target("worktree", "feature", { projectId: "repo" })), true);
  assert.deepEqual(events.at(-1), ["active", "feature-session"]);
});

test("live terminal jumps clear project filtering and use setActive to retain the owning split/Workspan", () => {
  const mixed = workspan("mixed", ["local", "remote", "reader"]);
  const { api, events } = fixture({
    sessions: [session("local", "repo"), session("remote", "remote", { environmentType: "ssh" }), session("reader", "repo", { kind: "subagent-transcript" })],
    workspans: [mixed],
  });
  assert.equal(api.activateQuickJumpTarget(target("terminal", "remote")), true);
  assert.deepEqual(events, [["scope", { kind: "all" }], ["history", "close"], ["active", "remote"]]);
  events.length = 0;
  assert.equal(api.activateQuickJumpTarget(target("workspan", "mixed")), true);
  assert.deepEqual(events, [["scope", { kind: "all" }], ["history", "close"], ["workspan", "mixed"]]);
});

test("stale, exited, unrestored and read-only terminal results fail without changing the workspace", () => {
  const { api, events } = fixture({
    sessions: [session("done", "repo"), session("unrestored", "repo"), session("reader", "repo", { kind: "subagent-transcript" }), session("orphan", "repo")],
    sessionStatuses: { done: "exited", reader: "running", orphan: "running" },
    workspans: [workspan("span", ["done", "unrestored", "reader"])],
  });
  for (const id of ["done", "unrestored", "reader", "orphan", "removed"]) {
    assert.equal(api.activateQuickJumpTarget(target("terminal", id)), false, id);
  }
  assert.equal(api.activateQuickJumpTarget(target("project", "deleted")), false);
  assert.equal(api.activateQuickJumpTarget(target("worktree", "deleted", { projectId: "repo" })), false);
  assert.equal(api.activateQuickJumpTarget(target("workspan", "deleted")), false);
  assert.deepEqual(events, []);
});

test("navigation and create intent cannot be confused, and missing launch handlers do not fall back", async () => {
  const { api, events } = fixture();
  assert.equal(api.activateQuickJumpTarget(target("project", "repo", { intent: "create" })), false);
  assert.equal(await api.requestQuickJumpCreate(target("project", "repo")), false);
  assert.equal(await api.requestQuickJumpCreate(target("project", "repo", { intent: "create" })), false);
  assert.deepEqual(events, []);
});

test("new sessions delegate current objects to Sidebar's existing launch flow", async () => {
  const repo = project("repo", { cli_args: "--profile personal", environment_type: "wsl" });
  const feature = worktree("feature", "repo");
  const { api, events, projectState } = fixture({ projects: [repo], worktrees: [feature] });
  const launches = [];
  const unregister = api.registerQuickJumpWorkspaceActions({
    selectWorkspace: scope => events.push(["sidebar", scope]),
    createSession: async (...args) => launches.push(args),
  });
  assert.equal(await api.requestQuickJumpCreate(target("project", "repo", { intent: "create" })), true);
  assert.deepEqual(launches[0], [repo, undefined]);
  assert.equal(await api.requestQuickJumpCreate(target("worktree", "feature", { projectId: "repo", intent: "create" })), true);
  assert.deepEqual(launches[1], [repo, feature]);
  projectState.worktrees = [{ ...feature, status: "missing" }];
  assert.equal(await api.requestQuickJumpCreate(target("worktree", "feature", { projectId: "repo", intent: "create" })), false);
  projectState.worktrees = [feature];
  projectState.projects = [{ ...repo, environment_type: "ssh", ssh_host_id: "remote" }];
  assert.equal(await api.requestQuickJumpCreate(target("worktree", "feature", { projectId: "repo", intent: "create" })), false);
  assert.equal(launches.length, 2);
  unregister();
  assert.equal(await api.requestQuickJumpCreate(target("project", "repo", { intent: "create" })), false);
});

test("re-registering after a React commit cannot be undone by an older cleanup", async () => {
  const { api } = fixture();
  const launches = [];
  const oldCleanup = api.registerQuickJumpWorkspaceActions({ selectWorkspace() {}, createSession: async () => launches.push("old") });
  api.registerQuickJumpWorkspaceActions({ selectWorkspace() {}, createSession: async () => launches.push("current") });
  oldCleanup();
  assert.equal(await api.requestQuickJumpCreate(target("project", "repo", { intent: "create" })), true);
  assert.deepEqual(launches, ["current"]);
});

test("leaving fullscreen allows two frames for Sidebar registration and never queues indefinitely", async () => {
  const { api } = fixture();
  let frames = 0;
  let launches = 0;
  const originalWindow = globalThis.window;
  try {
    globalThis.window = { requestAnimationFrame: callback => {
      frames++;
      if (frames === 2) api.registerQuickJumpWorkspaceActions({ selectWorkspace() {}, createSession: async () => { launches++; } });
      callback();
    } };
    assert.equal(await api.requestQuickJumpCreate(target("project", "repo", { intent: "create" })), true);
    assert.equal(frames, 2);
    assert.equal(launches, 1);
    const unavailable = fixture();
    frames = 0;
    globalThis.window = { requestAnimationFrame: callback => { frames++; callback(); } };
    assert.equal(await unavailable.api.requestQuickJumpCreate(target("project", "repo", { intent: "create" })), false);
    assert.equal(frames, 2);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test("suspended animation frames in a hidden window cannot leave a launch request pending", async () => {
  const { api } = fixture();
  const originalWindow = globalThis.window;
  let frames = 0;
  const cancelled = [];
  try {
    globalThis.window = {
      requestAnimationFrame: () => ++frames,
      cancelAnimationFrame: id => cancelled.push(id),
    };
    assert.equal(await api.requestQuickJumpCreate(target("project", "repo", { intent: "create" })), false);
    assert.equal(frames, 2);
    assert.deepEqual(cancelled, [1, 2]);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});
