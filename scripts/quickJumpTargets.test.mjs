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
    return load(new URL(`${name}.ts`, url));
  }, exports);
  return exports;
}

const { buildQuickJumpTargets, searchQuickJumpTargets, matchesQuickJumpQuery, quickJumpMatchScore } = load("../src/lib/quickJumpTargets.ts");
const project = (id, extras = {}) => ({
  id, name: id, path: "/repo", remote_path: "", environment_type: "local", ssh_host_id: null,
  group_name: "Engineering", cli_tool: "codex", shell: "zsh", ...extras,
});
const terminal = (id, extras = {}) => ({ id, title: id, ...extras });
const worktree = (id, extras = {}) => ({
  id, project_id: "repo", name: id, path: `/trees/${id}`, branch: `feature/${id}`, status: "active", ...extras,
});
const workspan = (id, sessionIds, extras = {}) => ({
  id, customTitle: null, activeSessionId: sessionIds[0] ?? null, activePaneId: `pane:${id}`,
  paneTree: { id: `pane:${id}`, type: "leaf", sessionIds, activeSessionId: sessionIds[0] ?? null }, ...extras,
});
const snapshot = (extras = {}) => ({
  projects: [project("repo")], worktrees: [], sessions: [], sessionStatuses: {}, workspans: [],
  activeSessionId: null, activeWorkspanId: null, workspanEnabled: true, ...extras,
});
const find = (targets, kind, id, intent = "navigate") => targets.find(target => target.id === `${intent}:${kind}:${id}`);

test("projects and worktrees expose distinct navigate/create identities even without terminals", () => {
  const targets = buildQuickJumpTargets(snapshot({ worktrees: [worktree("new"), worktree("missing", { status: "missing" })] }));
  assert.equal(find(targets, "project", "repo").terminalCount, 0);
  assert.equal(find(targets, "project", "repo", "create").intent, "create");
  assert.equal(find(targets, "worktree", "new").projectId, "repo");
  assert.ok(find(targets, "worktree", "new", "create"));
  assert.equal(find(targets, "worktree", "missing").missing, true);
  assert.equal(find(targets, "worktree", "missing", "create"), undefined);
});

test("live targets require a running PTY and exclude exited, failed, unrestored and read-only panes", () => {
  const sessions = [
    terminal("shell"), terminal("agent", { kind: "pty" }), terminal("sync", { kind: "synced-history" }),
    terminal("exited"), terminal("failed"), terminal("unrestored"),
    terminal("transcript", { kind: "subagent-transcript" }), terminal("editor", { kind: "file-editor" }),
  ];
  const sessionStatuses = Object.fromEntries(sessions.map(session => [session.id, "running"]));
  sessionStatuses.exited = "exited";
  sessionStatuses.failed = "error";
  delete sessionStatuses.unrestored;
  const targets = buildQuickJumpTargets(snapshot({ sessions, sessionStatuses }));
  assert.deepEqual(targets.filter(target => target.kind === "terminal").map(target => target.sessionId), ["shell", "agent", "sync"]);
});

test("directory inference keeps project, nested worktree and host/environment identities separate", () => {
  const projects = [project("repo"), project("wsl", { environment_type: "wsl" }),
    project("ssh-a", { environment_type: "ssh", remote_path: "/repo", ssh_host_id: "a" }),
    project("ssh-b", { environment_type: "ssh", remote_path: "/repo", ssh_host_id: "b" })];
  const tree = worktree("feature", { path: "/repo/.worktrees/feature" });
  const sessions = [
    terminal("local", { cwd: "/repo", environmentType: "local" }),
    terminal("wsl", { cwd: "/repo", environmentType: "wsl" }),
    terminal("nested", { cwd: tree.path + "/src", environmentType: "local" }),
    terminal("remote-a", { cwd: "/repo", environmentType: "ssh", sshHostId: "a" }),
    terminal("remote-b", { cwd: "/repo", environmentType: "ssh", sshHostId: "b" }),
  ];
  const targets = buildQuickJumpTargets(snapshot({ projects, worktrees: [tree], sessions,
    sessionStatuses: Object.fromEntries(sessions.map(session => [session.id, "running"])) }));
  assert.equal(find(targets, "project", "repo").terminalCount, 2);
  assert.equal(find(targets, "project", "wsl").terminalCount, 1);
  assert.equal(find(targets, "project", "ssh-a").terminalCount, 1);
  assert.equal(find(targets, "project", "ssh-b").terminalCount, 1);
  assert.equal(find(targets, "terminal", "nested").worktreeId, tree.id);
  assert.equal(find(targets, "terminal", "remote-b").sshHostId, "b");
  assert.notEqual(find(targets, "project", "ssh-a").id, find(targets, "project", "ssh-b").id);
});

test("Workspan targets retain split members including file and transcript panes", () => {
  const sessions = [terminal("shell"), terminal("editor", { kind: "file-editor" }), terminal("reader", { kind: "subagent-transcript" })];
  const workspans = [workspan("mixed", ["shell", "editor", "reader"]), workspan("removed", ["gone"]), workspan("named", ["editor"], { customTitle: "Review" })];
  const state = snapshot({ sessions, workspans, sessionStatuses: { shell: "running" } });
  const targets = buildQuickJumpTargets(state);
  assert.equal(find(targets, "workspan", "mixed").sessionCount, 3);
  assert.equal(find(targets, "workspan", "mixed").terminalCount, 1);
  assert.equal(find(targets, "workspan", "named").label, "Review");
  assert.equal(find(targets, "workspan", "removed"), undefined);
  assert.equal(buildQuickJumpTargets({ ...state, workspanEnabled: false }).some(target => target.kind === "workspan"), false);
});

test("compact external launch mode hides embedded targets and unsupported SSH creates", () => {
  const targets = buildQuickJumpTargets(snapshot({
    projects: [project("repo"), project("remote", { environment_type: "ssh", remote_path: "/repo", ssh_host_id: "host" })],
    sessions: [terminal("shell")], sessionStatuses: { shell: "running" }, workspans: [workspan("span", ["shell"])],
    includeTerminals: false, externalMode: true,
  }));
  assert.ok(find(targets, "project", "repo", "create"));
  assert.ok(find(targets, "project", "remote"));
  assert.equal(find(targets, "project", "remote", "create"), undefined);
  assert.equal(targets.some(target => target.kind === "terminal" || target.kind === "workspan"), false);
});

test("search combines project/branch/path/host tokens and stable ties ignore live activity", () => {
  const state = snapshot({ worktrees: [worktree("jump")],
    sessions: [terminal("first", { title: "Shell", cwd: "/repo" }), terminal("second", { title: "Shell", cwd: "/repo" })],
    sessionStatuses: { first: "running", second: "running" },
  });
  const targets = buildQuickJumpTargets(state);
  assert.deepEqual(searchQuickJumpTargets(targets, "repo feature/jump").map(target => target.kind), ["worktree", "worktree"]);
  assert.equal(matchesQuickJumpQuery("README.md /repo/docs", "read repo"), true);
  assert.equal(matchesQuickJumpQuery("README.md /repo/docs", "nonexistent"), false);
  const before = searchQuickJumpTargets(targets, "shell").map(target => target.id);
  const changed = buildQuickJumpTargets({ ...state, activeSessionId: "second" });
  assert.deepEqual(searchQuickJumpTargets(changed, "shell").map(target => target.id), before);
  const exact = [{ label: "README-old", searchText: "README-old" }, { label: "README", searchText: "README" }];
  assert.equal(searchQuickJumpTargets(exact, "readme")[0].label, "README");
});

test("README does not match characters spread across terminal project/path/CLI metadata", () => {
  const metadata = "Feature Claude · Research · /data · manager · local";
  assert.equal(quickJumpMatchScore("Feature Claude", metadata, "README"), null);
  assert.equal(matchesQuickJumpQuery(metadata, "README"), false);
  assert.equal(quickJumpMatchScore("Feature Claude", "repo /edit agent docs manager engine", "README"), null);
  const results = searchQuickJumpTargets([
    { label: "Feature Claude", searchText: metadata },
    { label: "README.md", searchText: "/repo/README.md" },
  ], "README");
  assert.deepEqual(results.map(item => item.label), ["README.md"]);
});

test("search preserves exact prefixes, separate tokens and bounded label/path abbreviations", () => {
  assert.notEqual(quickJumpMatchScore("README.md", "/repo/docs/README.md", "README"), null);
  assert.notEqual(quickJumpMatchScore("Review Docs", "Review Docs", "rvdoc"), null);
  assert.notEqual(quickJumpMatchScore("Feature Claude", "repo · feature/jump · /trees/jump", "repo feat/jmp"), null);
  assert.notEqual(quickJumpMatchScore("Editor", "src/components/CommandPalette.tsx", "cp.tsx"), null);
  assert.equal(quickJumpMatchScore("Terminal", "/rxxxxxxxxexxxxxxxxaxxxxxxxxdxxxxxxxxmxxxxxxxe", "readme"), null);
  const prefixScore = quickJumpMatchScore("README.md", "/repo/README.md", "readme");
  const fuzzyScore = quickJumpMatchScore("Read More", "Read More", "readme");
  assert.notEqual(fuzzyScore, null);
  assert.ok(prefixScore < fuzzyScore);
});
