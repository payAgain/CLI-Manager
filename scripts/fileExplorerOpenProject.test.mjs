import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-file-project-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));
function transpile(sourcePath, name, replacements = {}) {
  let output = ts.transpileModule(readFileSync(new URL(sourcePath, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const [from, to] of Object.entries(replacements)) output = output.replaceAll(`from "${from}"`, `from "${to}"`);
  writeFileSync(join(tempDir, name), output, "utf8");
}

writeFileSync(join(tempDir, "mocks.mjs"), `
export const control = {
  builds: [], lists: [], releases: [], invokes: [], errors: [],
  build: async project => ({ consumerId: "files:" + project.id, rootPath: project.remote_path, launch: { hostId: project.ssh_host_id } }),
  list: async () => [], release: async () => {}, invoke: async () => [],
};
export const invoke = (command, args) => { control.invokes.push({command, args}); return control.invoke(command, args); };
export const buildSshRemoteFileContext = project => { control.builds.push(project); return control.build(project); };
export const sshRemoteListDir = context => { control.lists.push(context); return control.list(context); };
export const releaseSshRemoteFileContext = context => { control.releases.push(context); return control.release(context); };
export const sshRemoteReadFile = async () => ({ content: "remote content", previewKind: "text", sizeBytes: 14, modifiedMs: 1 });
export const sshRemoteSearch = async () => [];
export const remoteEntryToSearchMatch = entry => entry;
export const logError = () => {};
export const recordCrashActivity = () => {};
export const translateCurrent = key => key;
export const activateProjectFileSurface = () => {};
export const toast = { error: (...args) => control.errors.push(args), warning() {} };
`, "utf8");
transpile("../src/lib/terminalProject.ts", "terminalProject.mjs");
transpile("../src/lib/projectCapabilities.ts", "projectCapabilities.mjs");
transpile("../src/stores/fileExplorerStore.ts", "store.mjs", {
  "zustand": import.meta.resolve("zustand"),
  "@tauri-apps/api/core": "./mocks.mjs", "sonner": "./mocks.mjs", "../lib/logger": "./mocks.mjs",
  "../lib/i18n": "./mocks.mjs", "./gitDiffWorkspaceStore": "./mocks.mjs", "../lib/sshRemoteFiles": "./mocks.mjs",
  "../lib/terminalProject": "./terminalProject.mjs", "../lib/projectCapabilities": "./projectCapabilities.mjs",
});
const { useFileExplorerStore: store } = await import(pathToFileURL(join(tempDir, "store.mjs")).href);
const { control } = await import(pathToFileURL(join(tempDir, "mocks.mjs")).href);
const remote = (id = "a", root = `/srv/${id}`) => ({ id, name: id, path: "", environment_type: "ssh", remote_path: root, ssh_host_id: "host" });
const context = (project) => ({ consumerId: `files:${project.id}`, rootPath: project.remote_path, launch: { hostId: project.ssh_host_id } });
const file = (path = "dirty.ts") => ({ path, name: path, kind: "file", sizeBytes: 1 });
const buffer = { ...file(), previewKind: "text", content: "unsaved", savedContent: "saved", image: null, encoding: "utf-8", hasBom: false };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
test.beforeEach(async () => {
  store.getState().closeProject();
  await flush();
  store.setState(store.getInitialState(), true);
  Object.assign(control, {
    builds: [], lists: [], releases: [], invokes: [], errors: [],
    build: async project => context(project), list: async () => [], release: async () => {}, invoke: async () => [],
  });
});

test("concurrent same-location SSH opens wait for both context creation and listing", async () => {
  const project = remote();
  const buildGate = deferred();
  const listGate = deferred();
  control.build = () => buildGate.promise;
  control.list = () => listGate.promise;
  const first = store.getState().openProject(project);
  let secondDone = false;
  const second = store.getState().openProject({ ...project, name: "renamed" }).then(() => { secondDone = true; });
  await flush();
  assert.equal(control.builds.length, 1);
  assert.equal(secondDone, false);
  buildGate.resolve(context(project));
  await flush();
  assert.ok(store.getState().remoteFileContext);
  assert.equal(control.lists.length, 1);
  assert.equal(secondDone, false);
  listGate.resolve([file("ready.ts")]);
  await Promise.all([first, second]);
  assert.equal(secondDone, true);
  assert.equal(store.getState().loading, false);
  assert.equal(store.getState().project.name, "renamed");
  assert.deepEqual(store.getState().tree.map(entry => entry.path), ["ready.ts"]);
});

test("failed SSH initialization retries in place without losing search state or unsaved buffers", async () => {
  const project = remote();
  control.list = async () => { throw new Error("connection lost"); };
  await store.getState().openProject(project);
  assert.equal(store.getState().remoteFileContext, null);
  assert.equal(control.errors.length, 1);
  const searchResults = [file("search-result.ts")];
  const openFiles = [buffer];
  const expandedPaths = new Set(["", "src"]);
  store.setState({ openFiles, activeFile: buffer, activeFilePath: buffer.path, searchMode: "files",
    searchQuery: "search-result", searchResults, expandedPaths, selectedTreePath: "src" });
  const retryGate = deferred();
  control.list = () => retryGate.promise;
  const retry = store.getState().openProject({ ...project });
  const concurrent = store.getState().openProject(project);
  await flush();
  assert.equal(control.builds.length, 2);
  assert.equal(control.lists.length, 2);
  assert.equal(store.getState().loading, true);
  assert.equal(store.getState().openFiles, openFiles);
  assert.equal(store.getState().searchResults, searchResults);
  assert.equal(store.getState().searchQuery, "search-result");
  assert.equal(store.getState().expandedPaths, expandedPaths);
  assert.equal(store.getState().selectedTreePath, "src");
  retryGate.resolve([file("ready.ts")]);
  await Promise.all([retry, concurrent]);
  assert.ok(store.getState().remoteFileContext);
  assert.equal(store.getState().activeFile.content, "unsaved");
  assert.equal(store.getState().searchResults, searchResults);
  await store.getState().openFile(file());
  assert.equal(store.getState().activeFile.content, "unsaved");
  await store.getState().openProject(project);
  assert.equal(control.builds.length, 2);
  assert.equal(control.lists.length, 2);
  assert.equal(store.getState().searchQuery, "search-result");
});

test("same-location retry waits for release of the failed SSH consumer before listing", async () => {
  const project = remote();
  const releaseGate = deferred();
  control.release = () => releaseGate.promise;
  control.list = async () => { throw new Error("connection lost"); };
  await store.getState().openProject(project);
  assert.equal(control.releases.length, 1);
  control.list = async () => [file("recovered.ts")];
  const retry = store.getState().openProject(project);
  await flush();
  assert.equal(control.builds.length, 2);
  assert.equal(control.lists.length, 1);
  releaseGate.resolve();
  await retry;
  assert.equal(control.lists.length, 2);
  assert.equal(store.getState().tree[0].path, "recovered.ts");
});

test("a context-creation failure can be retried without reopening another project", async () => {
  const project = remote();
  control.build = async () => { throw new Error("agent temporarily unavailable"); };
  await store.getState().openProject(project);
  assert.equal(control.lists.length, 0);
  control.build = async project => context(project);
  await store.getState().openProject(project);
  assert.equal(control.builds.length, 2);
  assert.equal(control.lists.length, 1);
  assert.ok(store.getState().remoteFileContext);
});

test("stale project completion cannot clear the new project's shared initialization", async () => {
  const a = remote("a");
  const b = remote("b");
  const firstGate = deferred();
  const secondGate = deferred();
  control.list = current => current.rootPath === a.remote_path ? firstGate.promise : secondGate.promise;
  const first = store.getState().openProject(a);
  await flush();
  const second = store.getState().openProject(b);
  await flush();
  firstGate.resolve([file("stale.ts")]);
  await first;
  let thirdDone = false;
  const third = store.getState().openProject({ ...b }).then(() => { thirdDone = true; });
  await flush();
  assert.equal(thirdDone, false);
  assert.equal(control.builds.length, 2);
  secondGate.resolve([file("current.ts")]);
  await Promise.all([second, third]);
  assert.equal(store.getState().project.id, b.id);
  assert.equal(store.getState().tree[0].path, "current.ts");
});

test("closing during initialization prevents late context attachment and automatic retries", async () => {
  const project = remote();
  const gate = deferred();
  control.build = () => gate.promise;
  const opening = store.getState().openProject(project);
  await flush();
  store.getState().closeProject();
  gate.resolve(context(project));
  await opening;
  assert.equal(control.lists.length, 0);
  assert.equal(store.getState().project, null);
  assert.equal(store.getState().remoteFileContext, null);
  await flush();
  assert.equal(control.builds.length, 1);
});

test("local and WSL concurrent opens share initialization and retain the ready fast path", async () => {
  for (const [environment_type, path] of [["local", "/repo"], ["wsl", "//wsl.localhost/Ubuntu/home/repo"]]) {
    const project = { id: environment_type, name: environment_type, path, environment_type, remote_path: "", ssh_host_id: "" };
    const gate = deferred();
    control.invokes = [];
    control.invoke = async (command) => command === "file_list_dir" ? gate.promise : [];
    const first = store.getState().openProject(project);
    let secondDone = false;
    const second = store.getState().openProject({ ...project }).then(() => { secondDone = true; });
    await flush();
    assert.equal(secondDone, false);
    assert.equal(control.invokes.filter(call => call.command === "file_list_dir").length, 1);
    gate.resolve([file("local.ts")]);
    await Promise.all([first, second]);
    store.setState({ openFiles: [buffer], activeFile: buffer, activeFilePath: buffer.path, searchQuery: "keep" });
    await store.getState().openProject(project);
    assert.equal(control.invokes.filter(call => call.command === "file_list_dir").length, 1);
    assert.equal(store.getState().activeFile.content, "unsaved");
    assert.equal(store.getState().searchQuery, "keep");
  }
  assert.equal(control.builds.length, 0);
});
