import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-quick-jump-files-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));
const write = (name, source) => writeFileSync(join(tempDir, name), source, "utf8");
function transpile(name, replacements = {}, source = `../src/lib/${name}.ts`) {
  let output = ts.transpileModule(readFileSync(new URL(source, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const [from, to] of Object.entries(replacements)) output = output.replaceAll(`from "${from}"`, `from "${to}"`);
  write(`${name}.mjs`, output);
}

write("mocks.mjs", `
export const control = {
  calls: [], releases: [], contexts: [], opened: [], historyClosed: 0,
  invoke: async () => [],
  buildContext: async (project) => ({ consumerId: "files:sidebar", rootPath: project.remote_path, launch: { hostId: project.ssh_host_id } }),
  fileState: null,
};
export const invoke = (command, args) => { control.calls.push({ command, args }); return control.invoke(command, args); };
export const buildSshRemoteFileContext = async (project) => {
  const context = await control.buildContext(project); control.contexts.push(context); return context;
};
export const releaseSshRemoteFileContext = async (context) => { control.releases.push(context.consumerId); };
export const useFileExplorerStore = { getState: () => control.fileState };
export const useTerminalStore = { getState: () => ({ openFileEditorPane: (project) => control.opened.push(project) }) };
export const useHistoryStore = { getState: () => ({ closeHistory: () => control.historyClosed++ }) };
`);
transpile("terminalProject");
transpile("workspaceTerminals", { "./terminalProject": "./terminalProject.mjs" });
transpile("terminalScope", { "./terminalProject": "./terminalProject.mjs", "./workspaceTerminals": "./workspaceTerminals.mjs" });
transpile("quickJumpFileContext", {
  "./terminalProject": "./terminalProject.mjs", "./terminalScope": "./terminalScope.mjs", "./workspaceTerminals": "./workspaceTerminals.mjs",
});
transpile("projectCapabilities");
transpile("terminalPaneTree", {}, "../src/stores/terminalPaneTree.ts");
transpile("terminalWorkspan", { "./terminalPaneTree": "./terminalPaneTree.mjs" }, "../src/stores/terminalWorkspan.ts");
transpile("quickJumpTargets", {
  "../stores/terminalWorkspan": "./terminalWorkspan.mjs", "./projectCapabilities": "./projectCapabilities.mjs",
  "./workspaceTerminals": "./workspaceTerminals.mjs",
});
transpile("quickJumpFiles", {
  "@tauri-apps/api/core": "./mocks.mjs", "./sshRemoteFiles": "./mocks.mjs",
  "./terminalProject": "./terminalProject.mjs", "./quickJumpFileContext": "./quickJumpFileContext.mjs", "./quickJumpTargets": "./quickJumpTargets.mjs",
  "../stores/fileExplorerStore": "./mocks.mjs", "../stores/terminalStore": "./mocks.mjs", "../stores/historyStore": "./mocks.mjs",
});
const load = (name) => import(pathToFileURL(join(tempDir, `${name}.mjs`)).href);
const { control } = await load("mocks");
const { resolveQuickJumpFileProject } = await load("quickJumpFileContext");
const { createQuickJumpFileSearch, getQuickJumpOpenFiles, openQuickJumpFile, QUICK_JUMP_FILE_LIMIT, QUICK_JUMP_FILE_DEBOUNCE_MS } = await load("quickJumpFiles");
const project = (id, path = `/${id}`, extra = {}) => ({ id, path, name: id, environment_type: "local", remote_path: "", ssh_host_id: "", ...extra });
const file = (path) => ({ path, name: path.split("/").at(-1), kind: "file", sizeBytes: 1 });
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
const reset = () => { control.calls = []; control.releases = []; control.contexts = []; control.opened = []; control.historyClosed = 0; };

test("explicit project and Worktree scope ignore an unrelated active terminal", () => {
  const a = project("a");
  const b = project("b");
  const worktree = { id: "work-b", project_id: b.id, path: "/b-feature", name: "feature" };
  const options = { projects: [a, b], worktrees: [worktree], sessions: [{ id: "term-a", projectId: a.id }], activeSessionId: "term-a" };
  assert.equal(resolveQuickJumpFileProject({ ...options, terminalScope: { kind: "project", projectId: b.id } }), b);
  assert.equal(resolveQuickJumpFileProject({ ...options, terminalScope: { kind: "worktree", projectId: b.id, worktreeId: worktree.id } }).path, worktree.path);
  assert.equal(resolveQuickJumpFileProject({ ...options, terminalScope: { kind: "worktree", projectId: a.id, worktreeId: worktree.id } }), null);
});

test("file editors and subagents retain the active Worktree location", () => {
  const base = project("a");
  const worktree = { id: "work-a", project_id: base.id, path: "/a-feature", name: "feature" };
  const editor = { id: "editor", kind: "file-editor", fileEditor: { project: { ...base, path: worktree.path }, projectPath: worktree.path } };
  const child = { id: "child", kind: "subagent-transcript", subagent: { parentSessionId: "terminal" } };
  const terminal = { id: "terminal", projectId: base.id, worktreeId: worktree.id };
  for (const activeSessionId of ["editor", "child", "terminal"]) {
    assert.equal(resolveQuickJumpFileProject({ projects: [base], worktrees: [worktree], sessions: [editor, child, terminal], activeSessionId, terminalScope: { kind: "all" } }).path, worktree.path);
  }
});

test("restored WSL and SSH sessions infer the correct project without a project id", () => {
  const local = project("local", "/srv/repo");
  const sshA = project("ssh-a", "", { environment_type: "ssh", ssh_host_id: "host-a", remote_path: "/srv/repo" });
  const sshB = project("ssh-b", "", { environment_type: "ssh", ssh_host_id: "host-b", remote_path: "/srv/repo" });
  const wsl = project("wsl", "//wsl.localhost/Ubuntu/home/repo", { environment_type: "wsl" });
  const sessions = [
    { id: "ssh", environmentType: "ssh", sshHostId: "host-b", remotePath: "/srv/repo/src" },
    { id: "wsl", environmentType: "wsl", cwd: `${wsl.path}/src` },
    { id: "child", kind: "subagent-transcript", subagent: { parentSessionId: "ssh" } },
  ];
  for (const [activeSessionId, expected] of [["ssh", sshB], ["child", sshB], ["wsl", wsl]]) {
    assert.equal(resolveQuickJumpFileProject({ projects: [local, sshA, sshB, wsl], worktrees: [], sessions, activeSessionId, terminalScope: { kind: "all" } }), expected);
  }
  assert.equal(resolveQuickJumpFileProject({ projects: [local, sshA, sshB], worktrees: [], sessions, activeSessionId: "ssh", terminalScope: { kind: "group", groupId: "empty" } }), null);
});

test("empty-query files come from the exact editor location, preserving unsaved buffers", () => {
  const base = project("a");
  const worktree = { ...base, path: "/a-feature" };
  const state = { project: base, openFiles: [file("base.ts")], editorWorkspaces: [{ project: worktree, openFiles: [file("changed.ts")] }] };
  assert.deepEqual(getQuickJumpOpenFiles(worktree, state).map((entry) => entry.path), ["changed.ts"]);
  assert.deepEqual(getQuickJumpOpenFiles(base, state).map((entry) => entry.path), ["base.ts"]);
  assert.equal(state.editorWorkspaces[0].openFiles.length, 1);
});

test("search debounces keystrokes and runs only the latest query after an in-flight request", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  reset();
  const first = deferred();
  control.invoke = () => control.calls.length === 1 ? first.promise : Promise.resolve([file("latest.ts")]);
  const states = [];
  const search = createQuickJumpFileSearch((state) => states.push(state));
  search.search(project("a"), "f");
  search.search(project("a"), "first");
  t.mock.timers.tick(QUICK_JUMP_FILE_DEBOUNCE_MS);
  assert.equal(control.calls.length, 1);
  search.search(project("b"), "intermediate");
  t.mock.timers.tick(QUICK_JUMP_FILE_DEBOUNCE_MS);
  search.search(project("b"), "latest");
  t.mock.timers.tick(QUICK_JUMP_FILE_DEBOUNCE_MS);
  assert.equal(control.calls.length, 1);
  first.resolve([file("stale.ts")]);
  await flush();
  assert.deepEqual(control.calls.map(({ args }) => [args.rootPath, args.query]), [["/a", "first"], ["/b", "latest"]]);
  assert.deepEqual(states.filter((state) => !state.loading).map((state) => state.files[0].path), ["latest.ts"]);
  search.cancel();
});

test("closing cancels queued scans and ignores late results and failures", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const failure of [false, true]) {
    reset();
    const result = deferred();
    control.invoke = () => result.promise;
    const states = [];
    const search = createQuickJumpFileSearch((state) => states.push(state));
    search.search(project("a"), "first");
    t.mock.timers.tick(QUICK_JUMP_FILE_DEBOUNCE_MS);
    search.search(project("a"), "queued");
    search.cancel();
    t.mock.timers.tick(QUICK_JUMP_FILE_DEBOUNCE_MS);
    if (failure) result.reject(new Error("late failure"));
    else result.resolve([file("late.ts")]);
    await flush();
    assert.equal(control.calls.length, 1);
    assert.equal(states.filter((state) => !state.loading).length, 0);
  }
  reset();
  const search = createQuickJumpFileSearch(() => {});
  search.search(project("a"), "never-started");
  search.cancel();
  t.mock.timers.tick(QUICK_JUMP_FILE_DEBOUNCE_MS);
  assert.equal(control.calls.length, 0);
});

test("search results exclude directories and duplicates and obey the display limit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  reset();
  control.invoke = async () => [
    { ...file("directory"), kind: "directory" }, file("one.ts"), file("one.ts"),
    ...Array.from({ length: QUICK_JUMP_FILE_LIMIT + 20 }, (_, index) => file(`${index}.ts`)),
  ];
  const states = [];
  const search = createQuickJumpFileSearch((state) => states.push(state));
  search.search(project("a"), "src\\file");
  t.mock.timers.tick(QUICK_JUMP_FILE_DEBOUNCE_MS);
  await flush();
  assert.equal(control.calls[0].args.query, "src/file");
  assert.equal(states.at(-1).files.length, QUICK_JUMP_FILE_LIMIT);
  assert.equal(new Set(states.at(-1).files.map((entry) => entry.path)).size, QUICK_JUMP_FILE_LIMIT);
  assert.ok(states.at(-1).files.every((entry) => entry.kind === "file"));
  search.cancel();
});

test("a failed query can be retried without changing its workspace or text", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  reset();
  const failure = new Error("temporary failure");
  control.invoke = async () => {
    if (control.calls.length === 1) throw failure;
    return [file("retry.ts")];
  };
  const states = [];
  const search = createQuickJumpFileSearch((state) => states.push(state));
  const scope = project("a");
  search.search(scope, "retry");
  t.mock.timers.tick(QUICK_JUMP_FILE_DEBOUNCE_MS);
  await flush();
  assert.equal(states.at(-1).error, failure);
  search.search(scope, "retry");
  assert.equal(states.at(-1).error, null);
  assert.equal(states.at(-1).loading, true);
  t.mock.timers.tick(QUICK_JUMP_FILE_DEBOUNCE_MS);
  await flush();
  assert.equal(control.calls.length, 2);
  assert.deepEqual(states.at(-1).files.map((entry) => entry.path), ["retry.ts"]);
  assert.equal(states.at(-1).error, null);
  search.cancel();
});

test("exact filenames are ranked before path matches before applying the result limit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  reset();
  control.invoke = async () => [
    ...Array.from({ length: QUICK_JUMP_FILE_LIMIT + 10 }, (_, index) => file(`a/target.ts/${index}.ts`)),
    file("y/target.ts-extra"), file("z/target.ts"), file("z/target.ts"),
  ];
  const states = [];
  const search = createQuickJumpFileSearch((state) => states.push(state));
  search.search(project("a"), "target.ts");
  t.mock.timers.tick(QUICK_JUMP_FILE_DEBOUNCE_MS);
  await flush();
  assert.equal(states.at(-1).files.length, QUICK_JUMP_FILE_LIMIT);
  assert.deepEqual(states.at(-1).files.slice(0, 2).map((entry) => entry.path), ["z/target.ts", "y/target.ts-extra"]);
  search.cancel();
});

test("backend matches are retained when frontend fuzzy scoring cannot match them", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  reset();
  control.invoke = async () => [file("backend-match.ts"), file("target.ts")];
  const states = [];
  const search = createQuickJumpFileSearch((state) => states.push(state));
  search.search(project("a"), "target.ts");
  t.mock.timers.tick(QUICK_JUMP_FILE_DEBOUNCE_MS);
  await flush();
  assert.deepEqual(states.at(-1).files.map((entry) => entry.path), ["target.ts", "backend-match.ts"]);
  search.cancel();
});

test("SSH search uses and releases a separate consumer without touching sidebar state", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  reset();
  const result = deferred();
  control.invoke = () => result.promise;
  const states = [];
  const search = createQuickJumpFileSearch((state) => states.push(state));
  control.fileState = { searchQuery: "keep-me", searchResults: [file("keep.ts")] };
  search.search(project("remote", "", { environment_type: "ssh", ssh_host_id: "host-a", remote_path: "/srv/a" }), "foo");
  t.mock.timers.tick(QUICK_JUMP_FILE_DEBOUNCE_MS);
  await flush();
  assert.equal(control.calls[0].command, "ssh_remote_file_search");
  assert.equal(control.calls[0].args.rootPath, "/srv/a");
  assert.match(control.calls[0].args.consumerId, /^files:sidebar:quick-jump:/);
  search.cancel();
  result.resolve({ entries: [{ name: "foo.ts", relativePath: "src/foo.ts", kind: "file", sizeBytes: 2 }] });
  await flush();
  assert.deepEqual(control.releases, [control.calls[0].args.consumerId]);
  assert.equal(control.fileState.searchQuery, "keep-me");
  assert.equal(states.filter((state) => !state.loading).length, 0);
});

test("SSH context resolution after close never starts a remote scan", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  reset();
  const context = deferred();
  const original = control.buildContext;
  control.buildContext = () => context.promise;
  const search = createQuickJumpFileSearch(() => {});
  search.search(project("remote", "", { environment_type: "ssh", remote_path: "/srv/a" }), "foo");
  t.mock.timers.tick(QUICK_JUMP_FILE_DEBOUNCE_MS);
  search.cancel();
  context.resolve({ consumerId: "files:sidebar", rootPath: "/srv/a", launch: {} });
  await flush();
  assert.equal(control.calls.length, 0);
  assert.equal(control.releases.length, 1);
  control.buildContext = original;
});

test("opening a file preserves sidebar searches and refuses stale project or missing SSH context", async () => {
  reset();
  const a = project("a");
  const b = project("b");
  const opened = [];
  control.fileState = {
    project: a, searchQuery: "sidebar", searchResults: [file("sidebar.ts")],
    openProject: async () => {}, clearSearchNavigationTarget: () => {}, openFile: async (entry) => opened.push(entry.path),
  };
  assert.equal(await openQuickJumpFile(a, file("main.ts")), true);
  assert.deepEqual(opened, ["main.ts"]);
  assert.deepEqual(control.opened, [a]);
  assert.equal(control.historyClosed, 1);
  assert.equal(control.fileState.searchQuery, "sidebar");
  assert.equal(await openQuickJumpFile(b, file("wrong.ts")), false);
  control.fileState.openFile = async () => { control.fileState.project = b; };
  assert.equal(await openQuickJumpFile(a, file("late.ts")), false);
  const ssh = project("ssh", "", { environment_type: "ssh", ssh_host_id: "host", remote_path: "/srv/a" });
  control.fileState.project = ssh;
  await assert.rejects(openQuickJumpFile(ssh, file("remote.ts")), /ssh_file_context_unavailable/);
  assert.deepEqual(control.opened, [a]);
  assert.equal(control.historyClosed, 1);
});
