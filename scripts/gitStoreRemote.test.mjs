import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../src/stores/gitStore.ts", import.meta.url), "utf8");
const terminalTabsSource = readFileSync(new URL("../src/components/TerminalTabs.tsx", import.meta.url), "utf8");
const gitPanelSource = readFileSync(new URL("../src/components/git/GitChangesPanel.tsx", import.meta.url), "utf8");
const fileStoreSource = readFileSync(new URL("../src/stores/fileExplorerStore.ts", import.meta.url), "utf8");
const filePanelSource = readFileSync(new URL("../src/components/files/FileExplorerSidebar.tsx", import.meta.url), "utf8");
const terminalProjectSource = readFileSync(new URL("../src/lib/terminalProject.ts", import.meta.url), "utf8");
const sshAgentManifestSource = readFileSync(new URL("../src-tauri/ssh-agent/Cargo.toml", import.meta.url), "utf8");

const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const projectContext = {};
new Function("exports", compile(terminalProjectSource))(projectContext);
const fileStoreAst = ts.createSourceFile("fileExplorerStore.ts", fileStoreSource, ts.ScriptTarget.Latest, true);
function findNode(predicate) {
  let found;
  function visit(node) { if (predicate(node)) found = node; else ts.forEachChild(node, visit); }
  visit(fileStoreAst);
  assert.ok(found, "production file workspace entry point exists");
  return found;
}
const workspaceHelpers = ["findEditorWorkspace", "upsertEditorWorkspace"].map(name =>
  findNode(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(fileStoreAst)).join("\n");
const openProjectBody = findNode(node => ts.isPropertyAssignment(node)
  && node.name.getText(fileStoreAst) === "openProject").initializer.getText(fileStoreAst);
const openProjectCode = compile(`let openProjectRequestSeq = 0; let pendingOpenProject = null;
${workspaceHelpers}\nexports.open = ${openProjectBody};`);
const remoteProject = (extra = {}) => ({ id: "remote", name: "Remote", path: "", environment_type: "ssh",
  ssh_host_id: "host-a", remote_path: "/srv/project", ...extra });
function fileWorkspace(current) {
  const tree = [{ path: "loaded.ts", kind: "file" }], openFiles = [{ path: "dirty.ts", content: "unsaved" }];
  const context = project => ({ hostId: project.ssh_host_id, rootPath: project.remote_path });
  const state = { project: current, tree, openFiles, activeFilePath: "dirty.ts", activeFile: openFiles[0],
    editorWorkspaces: [{ project: current, openFiles, activeFilePath: "dirty.ts" }],
    remoteFileContext: current.environment_type === "ssh" ? context(current) : null, loading: false };
  const calls = { builds: [], lists: [], releases: [], errors: [] }, exports = {};
  const ports = {
    ...projectContext,
    projectSupportsCapability: () => true,
    buildSshRemoteFileContext: async project => { calls.builds.push(project); return context(project); },
    waitForRemoteFileContextRelease: async () => {},
    releaseRemoteFileContext: async value => { calls.releases.push(value); },
    sshRemoteListDir: async value => { calls.lists.push(value); return [{ path: `${value.hostId}:${value.rootPath}` }]; },
    listDir: async path => { calls.lists.push(path); return []; },
    fetchGitChanges: async () => [], logError: (...args) => calls.errors.push(args), toast: { error() {} },
  };
  new Function("exports", "get", "set", ...Object.keys(ports), openProjectCode)(exports, () => state,
    update => Object.assign(state, typeof update === "function" ? update(state) : update), ...Object.values(ports));
  return { state, calls, open: exports.open };
}

test("remote root repository permits deleting untracked files", () => {
  const actionStart = source.indexOf("deleteUntrackedPaths: async");
  const actionEnd = source.indexOf("loadFileDiff: async", actionStart);
  assert.ok(actionStart >= 0 && actionEnd > actionStart);

  const action = source.slice(actionStart, actionEnd);
  assert.match(action, /repoPath === null/);
  assert.doesNotMatch(action, /!repoPath/);
});

test("SSH terminal panels use the registered remote project root", () => {
  assert.match(
    terminalTabsSource,
    /panelProject\?\.environment_type === "ssh"\s*\? panelProject\.remote_path\.trim\(\) \|\| null/,
  );
});

test("SSH visible-file refresh never falls back to local file commands", () => {
  const refreshStart = fileStoreSource.indexOf("refreshVisibleStateOnce: async");
  const refreshEnd = fileStoreSource.indexOf("refreshGitChanges: async", refreshStart);
  assert.ok(refreshStart >= 0 && refreshEnd > refreshStart);

  const refresh = fileStoreSource.slice(refreshStart, refreshEnd);
  assert.match(refresh, /project\.environment_type === "ssh" && !remoteFileContext/);
  assert.match(refresh, /loadProjectFile\(project, latestEntry, remoteFileContext\)/);
});

test("remote project panels show loading during initial context fetch", () => {
  assert.match(gitPanelSource, /\(contextLoading \|\| loading\) && changes\.length === 0/);
  assert.match(filePanelSource, /loading && tree\.length === 0/);
  assert.match(filePanelSource, /t\("common\.loading"\)/);
});

test("SSH file context identity includes host and remote project root", async () => {
  const current = remoteProject();
  assert.equal(projectContext.isSameProjectFileContext(current, { ...current }), true);
  for (const changed of [{ ssh_host_id: "host-b" }, { remote_path: "/srv/other" }, { remote_path: "/Srv/project" }]) {
    const target = remoteProject(changed), h = fileWorkspace(current);
    const originalContext = h.state.remoteFileContext;
    assert.equal(projectContext.isSameProjectFileContext(current, target), false);
    assert.equal(projectContext.isSameProjectFileLocation(current, target), false);
    await h.open(target);
    assert.deepEqual(h.calls.errors, []);
    assert.equal(h.calls.builds[0], target);
    assert.deepEqual(h.calls.lists, [{ hostId: target.ssh_host_id, rootPath: target.remote_path }]);
    assert.deepEqual(h.calls.releases, [originalContext]);
    assert.equal(h.state.tree[0].path, `${target.ssh_host_id}:${target.remote_path}`);
  }
  assert.match(terminalTabsSource, /filePanelProject\?\.ssh_host_id/);
  assert.match(terminalTabsSource, /filePanelProject\?\.remote_path/);
});

test("opening the same file location preserves the loaded tree", async () => {
  for (const current of [remoteProject(), { id: "local", environment_type: "local", path: "E:/Repo" }]) {
    const target = { ...current, id: "renamed", name: "Renamed", ...(current.environment_type === "local" ? { path: "e:\\repo\\" } : {}) };
    const h = fileWorkspace(current), { tree, openFiles, activeFile, remoteFileContext } = h.state;
    assert.equal(projectContext.isSameProjectFileLocation(current, target), true);
    assert.equal(projectContext.isSameProjectFileContext(current, target), false, "location sharing does not merge project identity");
    await h.open(target);
    assert.equal(h.state.project, target);
    assert.equal(h.state.tree, tree);
    assert.equal(h.state.openFiles, openFiles);
    assert.equal(h.state.activeFile, activeFile);
    assert.equal(h.state.remoteFileContext, remoteFileContext);
    assert.equal(h.state.editorWorkspaces[0].project, target);
    assert.deepEqual(h.calls, { builds: [], lists: [], releases: [], errors: [] });
  }
});

test("question Hook Agent does not regress to a release predating question support", () => {
  const version = sshAgentManifestSource.match(/^version = "(\d+)\.(\d+)\.(\d+)"$/m);
  assert.ok(version);
  const [, major, minor, patch] = version.map(Number);
  assert.ok(major > 0 || minor > 1 || (minor === 1 && patch >= 5));
});
