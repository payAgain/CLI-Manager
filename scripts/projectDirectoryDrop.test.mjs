import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import ts from "typescript";

const temporary = mkdtempSync(join(tmpdir(), "cli-manager-directory-drop-"));
process.on("exit", () => rmSync(temporary, { recursive: true, force: true }));
async function loadModule(name) {
  const source = readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const path = join(temporary, `${name}.mjs`);
  writeFileSync(path, output);
  return import(pathToFileURL(path).href);
}
const { importProjectDirectories, projectDirectoryDropGroup } = await loadModule("projectDirectoryDrop");
const { isNativeFileDropTarget } = await loadModule("nativeFileDrop");

function importer(initial = [], overrides = {}) {
  const projects = [...initial];
  const inputs = [];
  return {
    projects,
    inputs,
    dependencies: {
      getProjects: () => projects,
      getPathKind: async () => "directory",
      createProject: async (input) => {
        inputs.push(input);
        const project = { id: `project-${projects.length}`, ...input };
        projects.push(project);
        return project;
      },
      ...overrides,
    },
  };
}

test("creates named projects from multiple folders and lets the store choose the default shell", async () => {
  const state = importer();
  const result = await importProjectDirectories(["/work/中文 项目", "/work/another"], "group-1", state.dependencies);
  assert.equal(result.created.length, 2);
  assert.deepEqual(state.inputs[0], {
    name: "中文 项目", path: "/work/中文 项目", group_id: "group-1", environment_type: "local",
  });
  assert.equal(state.inputs[0].shell, undefined);
  assert.equal(state.inputs[0].cli_tool, undefined);
});

test("ignores repeated folder payloads and reuses existing projects without moving them", async () => {
  const existing = { id: "saved", path: "/work/project", group_id: "original", environment_type: "local" };
  const state = importer([existing]);
  const result = await importProjectDirectories(["/work/project/", "/work/project", "/work/new"], "other", state.dependencies);
  assert.deepEqual(result.existing, [existing]);
  assert.equal(result.created.length, 1);
  assert.equal(existing.group_id, "original");
});

test("deduplicates Windows drive, extended-length and network share paths", async () => {
  const state = importer([
    { id: "drive", path: "C:\\Work\\Project", environment_type: "local" },
    { id: "share", path: "\\\\server\\Share\\Project", environment_type: "local" },
  ]);
  const result = await importProjectDirectories([
    "c:/work/project/", "\\\\?\\C:\\WORK\\PROJECT", "\\\\?\\UNC\\SERVER\\share\\PROJECT",
  ], null, state.dependencies);
  assert.deepEqual(result.existing.map((project) => project.id), ["drive", "share"]);
  assert.equal(state.inputs.length, 0);
});

test("normalizes WSL host aliases but preserves Linux path case and environment", async () => {
  const state = importer([
    { id: "wsl", path: "\\\\wsl$\\Ubuntu\\home\\User", environment_type: "wsl" },
  ]);
  const result = await importProjectDirectories([
    "\\\\wsl.localhost\\ubuntu\\home\\User", "\\\\wsl$\\Ubuntu\\home\\user",
  ], null, state.dependencies);
  assert.equal(result.existing[0].id, "wsl");
  assert.equal(result.created[0].environment_type, "wsl");
  assert.equal(result.created[0].name, "user");
});

test("preserves distinct POSIX paths and significant whitespace", async () => {
  const state = importer();
  await importProjectDirectories(["/work/Project", "/work/project", "/work/project "], null, state.dependencies);
  assert.deepEqual(state.inputs.map((input) => input.name), ["Project", "project", "project "]);
});

test("files, missing paths and failed imports do not prevent valid folders from being added", async () => {
  const state = importer([], {
    getPathKind: async (path) => {
      if (path === "/denied") throw new Error("denied");
      return path === "/file.txt" ? "file" : path === "/missing" ? "missing" : "directory";
    },
  });
  const create = state.dependencies.createProject;
  state.dependencies.createProject = async (input) => {
    if (input.path === "/failed") throw new Error("database write failed");
    return create(input);
  };
  const result = await importProjectDirectories([
    "/file.txt", "/denied", "/good", "/missing", "/failed", "/also-good",
  ], null, state.dependencies);
  assert.deepEqual(result.created.map((project) => project.path), ["/good", "/also-good"]);
  assert.deepEqual(result.invalid, ["/file.txt", "/missing"]);
  assert.deepEqual(result.failed.map((failure) => failure.path), ["/denied", "/failed"]);
});

test("checks current projects after asynchronous directory validation", async () => {
  const state = importer();
  state.dependencies.getPathKind = async (path) => {
    state.projects.push({ id: "added-during-validation", path, environment_type: "local" });
    return "directory";
  };
  const result = await importProjectDirectories(["/work/project"], null, state.dependencies);
  assert.equal(result.existing[0].id, "added-during-validation");
  assert.equal(state.inputs.length, 0);
});

test("SSH projects do not claim a local folder with the same path", async () => {
  const state = importer([{ id: "ssh", path: "/work/project", environment_type: "ssh" }]);
  const result = await importProjectDirectories(["/work/project"], null, state.dependencies);
  assert.equal(result.created.length, 1);
  assert.equal(result.created[0].environment_type, "local");
});

test("empty payload entries do not suppress a valid filesystem root", async () => {
  const state = importer();
  const result = await importProjectDirectories(["", "/"], null, state.dependencies);
  assert.deepEqual(result.invalid, [""]);
  assert.equal(result.created[0].name, "/");
});

test("resolves root, group, project and worktree drop destinations", () => {
  const projects = [{ id: "project", group_id: "parent" }];
  const worktrees = [{ id: "worktree", project_id: "project" }];
  assert.equal(projectDirectoryDropGroup(null, projects, worktrees), null);
  assert.equal(projectDirectoryDropGroup("g:nested", projects, worktrees), "nested");
  assert.equal(projectDirectoryDropGroup("p:project", projects, worktrees), "parent");
  assert.equal(projectDirectoryDropGroup("wt:worktree", projects, worktrees), "parent");
  assert.equal(projectDirectoryDropGroup("scope:all", projects, worktrees), null);
});

test("native drops only reach the visible hit region, including high DPI and modal occlusion", () => {
  const sidebarChild = {};
  const terminalChild = {};
  const modal = {};
  let hit = sidebarChild;
  const point = new PhysicalPosition(160, 240).toLogical(2);
  const document = { elementFromPoint: (x, y) => {
    assert.deepEqual([x, y], [80, 120]);
    return hit;
  } };
  const sidebar = { ownerDocument: document, contains: (element) => element === sidebarChild };
  const terminal = { ownerDocument: document, contains: (element) => element === terminalChild };
  assert.equal(isNativeFileDropTarget(sidebar, point.x, point.y), true);
  assert.equal(isNativeFileDropTarget(terminal, point.x, point.y), false);
  hit = terminalChild;
  assert.equal(isNativeFileDropTarget(terminal, point.x, point.y), true);
  assert.equal(isNativeFileDropTarget(sidebar, point.x, point.y), false);
  hit = modal;
  assert.equal(isNativeFileDropTarget(terminal, point.x, point.y), false);
  assert.equal(isNativeFileDropTarget(sidebar, point.x, point.y), false);
  assert.equal(isNativeFileDropTarget(null, point.x, point.y), false);
  assert.equal(isNativeFileDropTarget(sidebar, NaN, point.y), false);
});
