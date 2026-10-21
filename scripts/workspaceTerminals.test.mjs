import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

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
    assert.ok(name.startsWith("."), `unexpected runtime import ${name}`);
    return load(new URL(name + ".ts", url));
  }, exports);
  return exports;
}
const { indexWorkspaceTerminals } = load("../src/lib/workspaceTerminals.ts");
const { sessionMatchesTerminalScope } = load("../src/lib/terminalScope.ts");
const project = (id, path, extras = {}) => ({ id, path, environment_type: "local", remote_path: "", ssh_host_id: "", ...extras });
const terminal = (id, extras = {}) => ({ id, title: id, ...extras });
const ids = (values = []) => values.map(value => value.id);
const main = project("claude", "E:/Work/claude");

test("both restored and project-bound terminals appear in the same main workspace", () => {
  const sessions = [
    terminal("history", { title: "你好", cwd: "E:\\Work\\claude", cliTool: "pi" }),
    terminal("bound", { title: "claude", projectId: main.id, cwd: main.path, cliTool: "pi" }),
  ];
  const before = structuredClone(sessions);
  const index = indexWorkspaceTerminals(sessions, [main], []);
  assert.deepEqual(ids(index.primaryByProject.get(main.id)), ["history", "bound"]);
  assert.equal(index.byProject.get(main.id).length, 2);
  assert.equal(index.bySession.get("history").projectId, main.id);
  assert.deepEqual(sessions, before, "display membership must not rewrite launch metadata");
});

test("workspace lists and project/worktree/group terminal scopes use the same membership", () => {
  const worktree = { id: "feature", project_id: main.id, path: "E:/trees/feature" };
  const sessions = [terminal("main", { cwd: main.path }), terminal("tree", { cwd: worktree.path + "/src" })];
  const index = indexWorkspaceTerminals(sessions, [main], [worktree]);
  const map = new Map([[main.id, main]]);
  for (const [scope, expected] of [
    [{ kind: "project", projectId: main.id }, ids(index.byProject.get(main.id))],
    [{ kind: "worktree", projectId: main.id, worktreeId: worktree.id }, ids(index.byWorktree.get(worktree.id))],
    [{ kind: "group", groupId: "group" }, ids(index.byProject.get(main.id))],
  ]) {
    assert.deepEqual(ids(sessions.filter(session => sessionMatchesTerminalScope(
      session, scope, sessions, [main], map, [worktree], new Set([main.id]),
    ))), expected);
  }
  assert.deepEqual(ids(index.primaryByProject.get(main.id)), ["main"]);
  assert.deepEqual(ids(index.byWorktree.get(worktree.id)), ["tree"]);
});

test("explicit project and worktree bindings survive changing directory", () => {
  const other = project("other", "E:/other");
  const worktree = { id: "feature", project_id: main.id, path: "E:/trees/feature" };
  const index = indexWorkspaceTerminals([
    terminal("bound", { projectId: main.id, cwd: other.path }),
    terminal("worktree", { projectId: main.id, worktreeId: worktree.id, cwd: other.path }),
  ], [main, other], [worktree]);
  assert.deepEqual(ids(index.byProject.get(main.id)), ["bound", "worktree"]);
  assert.equal(index.byProject.has(other.id), false);
  assert.deepEqual(ids(index.byWorktree.get(worktree.id)), ["worktree"]);
});

test("directory inference respects path boundaries, case normalization and the closest project", () => {
  const nested = project("nested", main.path + "/nested");
  const index = indexWorkspaceTerminals([
    terminal("case", { cwd: "e:\\WORK\\CLAUDE\\" }),
    terminal("nested", { cwd: nested.path + "/src" }),
    terminal("outside", { cwd: main.path + "-other" }),
  ], [main, nested], []);
  assert.deepEqual(ids(index.byProject.get(main.id)), ["case"]);
  assert.deepEqual(ids(index.byProject.get(nested.id)), ["nested"]);
  assert.equal(index.bySession.has("outside"), false);
});

test("nested worktree paths are listed once and do not inflate the main-workspace count", () => {
  const worktree = { id: "feature", project_id: main.id, path: main.path + "/.worktrees/feature" };
  const index = indexWorkspaceTerminals([
    terminal("main", { cwd: main.path }),
    terminal("feature", { cwd: worktree.path }),
  ], [main], [worktree]);
  assert.equal(index.byProject.get(main.id).length, 2);
  assert.equal(index.primaryByProject.get(main.id).length, 1);
  assert.equal(index.byWorktree.get(worktree.id).length, 1);
});

test("SSH inference uses its host and case-sensitive remote path without claiming local directories", () => {
  const local = project("local", "/repo");
  const a = project("a", "ssh:a", { environment_type: "ssh", ssh_host_id: "host-a", remote_path: "/repo" });
  const b = project("b", "ssh:b", { environment_type: "ssh", ssh_host_id: "host-b", remote_path: "/repo" });
  const sessions = [
    terminal("remote", { environmentType: "ssh", sshHostId: "host-b", remotePath: "/repo/src", cwd: "/repo" }),
    terminal("wrong-case", { environmentType: "ssh", sshHostId: "host-a", remotePath: "/Repo" }),
    terminal("unknown-host", { environmentType: "ssh", cwd: "/repo" }),
    terminal("local", { cwd: "/repo" }),
  ];
  const index = indexWorkspaceTerminals(sessions, [local, a, b], []);
  assert.deepEqual(ids(index.byProject.get(b.id)), ["remote"]);
  assert.deepEqual(ids(index.byProject.get(local.id)), ["local"]);
  assert.equal(index.byProject.has(a.id), false);
  assert.equal(index.bySession.has("unknown-host"), false);
  assert.equal(index.bySession.has("wrong-case"), false);
  assert.equal(sessionMatchesTerminalScope(sessions[0], { kind: "project", projectId: b.id }, sessions,
    [local, a, b], new Map([local, a, b].map(value => [value.id, value])), []), true);
});

test("WSL and local sessions sharing a directory remain separate", () => {
  const wsl = project("wsl", main.path, { environment_type: "wsl" });
  const index = indexWorkspaceTerminals([
    terminal("local", { cwd: main.path, environmentType: "local" }),
    terminal("wsl", { cwd: main.path, environmentType: "wsl" }),
  ], [main, wsl], []);
  assert.deepEqual(ids(index.byProject.get(main.id)), ["local"]);
  assert.deepEqual(ids(index.byProject.get(wsl.id)), ["wsl"]);
});

test("open shell tabs count independently of Agent type and exclude non-PTY panes", () => {
  const index = indexWorkspaceTerminals([
    terminal("pi-one", { projectId: main.id, runtimeAgent: { tool: "pi" } }),
    terminal("pi-two", { projectId: main.id, runtimeAgent: { tool: "pi" } }),
    terminal("shell", { projectId: main.id, runtimeAgent: null }),
    ...["file-editor", "synced-history", "subagent-transcript"].map(kind => terminal(kind, { projectId: main.id, kind })),
  ], [main], []);
  assert.deepEqual(ids(index.primaryByProject.get(main.id)), ["pi-one", "pi-two", "shell"]);
});
