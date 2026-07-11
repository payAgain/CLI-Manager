import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-workspan-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

function transpile(sourcePath, outputName, transform = (code) => code) {
  const source = readFileSync(new URL(sourcePath, import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: sourcePath,
  }).outputText;
  writeFileSync(join(tempDir, outputName), transform(output), "utf8");
}

transpile("../src/stores/terminalPaneTree.ts", "terminalPaneTree.mjs");
transpile(
  "../src/stores/terminalWorkspan.ts",
  "terminalWorkspan.mjs",
  (code) => code.replace('from "./terminalPaneTree"', 'from "./terminalPaneTree.mjs"')
);

const { resolvePaneDropEdgeFromPoint } = await import(pathToFileURL(join(tempDir, "terminalPaneTree.mjs")).href);

const {
  collectWorkspanSessionIds,
  createTerminalWorkspan,
  mergeTerminalWorkspansAtPaneEdge,
  migrateTerminalWorkspans,
  removeSessionFromTerminalWorkspans,
  reorderTerminalWorkspans,
  restoreTerminalWorkspans,
  sanitizeTerminalWorkspans,
} = await import(pathToFileURL(join(tempDir, "terminalWorkspan.mjs")).href);

function idFactory(prefix = "generated") {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
}

test("workspan pane drop keeps a neutral center and resolves outer directions", () => {
  const rect = { left: 100, top: 200, width: 200, height: 100 };
  const activationRatio = 0.18;

  assert.equal(resolvePaneDropEdgeFromPoint(160, 250, rect, activationRatio), "left");
  assert.equal(resolvePaneDropEdgeFromPoint(240, 250, rect, activationRatio), "right");
  assert.equal(resolvePaneDropEdgeFromPoint(200, 225, rect, activationRatio), "top");
  assert.equal(resolvePaneDropEdgeFromPoint(200, 275, rect, activationRatio), "bottom");
  assert.equal(resolvePaneDropEdgeFromPoint(200, 250, rect, activationRatio), null);
  assert.equal(resolvePaneDropEdgeFromPoint(170, 250, rect, activationRatio), null);
});

test("mergeTerminalWorkspansAtPaneEdge preserves sessions and honors all four edges", () => {
  const cases = [
    ["left", "horizontal", "source-pane"],
    ["right", "horizontal", "target-pane"],
    ["top", "vertical", "source-pane"],
    ["bottom", "vertical", "target-pane"],
  ];

  for (const [edge, direction, firstPaneId] of cases) {
    const source = createTerminalWorkspan("source", "source-pane", "source-session");
    const target = createTerminalWorkspan("target", "target-pane", "target-session");
    const result = mergeTerminalWorkspansAtPaneEdge(
      [source, target],
      source.id,
      target.id,
      "target-pane",
      edge,
      idFactory(edge)
    );

    assert.equal(result.changed, true);
    assert.equal(result.activeWorkspanId, "target");
    assert.equal(result.workspans.length, 1);
    assert.deepEqual(new Set(collectWorkspanSessionIds(result.workspans[0])), new Set(["source-session", "target-session"]));
    assert.equal(result.workspans[0].paneTree.type, "split");
    assert.equal(result.workspans[0].paneTree.direction, direction);
    assert.equal(result.workspans[0].paneTree.first.id, firstPaneId);
    assert.equal(result.workspans[0].activeSessionId, "source-session");
  }
});

test("merge inserts a complete source layout beside the hovered nested pane", () => {
  const source = {
    id: "source",
    paneTree: {
      type: "split",
      id: "source-root",
      direction: "horizontal",
      ratio: 0.4,
      first: { type: "leaf", id: "source-a", sessionIds: ["a"], activeSessionId: "a" },
      second: { type: "leaf", id: "source-b", sessionIds: ["b"], activeSessionId: "b" },
    },
    activePaneId: "source-b",
    activeSessionId: "b",
  };
  const target = {
    id: "target",
    paneTree: {
      type: "split",
      id: "target-root",
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", id: "target-a", sessionIds: ["c"], activeSessionId: "c" },
      second: { type: "leaf", id: "target-b", sessionIds: ["d"], activeSessionId: "d" },
    },
    activePaneId: "target-a",
    activeSessionId: "c",
  };

  const result = mergeTerminalWorkspansAtPaneEdge(
    [source, target],
    "source",
    "target",
    "target-b",
    "top",
    idFactory("nested")
  );

  assert.equal(result.changed, true);
  const tree = result.workspans[0].paneTree;
  assert.equal(tree.type, "split");
  assert.equal(tree.id, "target-root");
  assert.equal(tree.first.id, "target-a");
  assert.equal(tree.second.type, "split");
  assert.equal(tree.second.direction, "vertical");
  assert.equal(tree.second.first.id, "source-root");
  assert.equal(tree.second.second.id, "target-b");
});

test("merge rejects duplicate session ownership", () => {
  const source = createTerminalWorkspan("source", "source-pane", "same-session");
  const target = createTerminalWorkspan("target", "target-pane", "same-session");
  const result = mergeTerminalWorkspansAtPaneEdge(
    [source, target],
    "source",
    "target",
    "target-pane",
    "right",
    idFactory()
  );
  assert.equal(result.changed, false);
  assert.equal(result.workspans.length, 2);
});

test("migration validates compound workspan data", () => {
  const migrated = migrateTerminalWorkspans([
    {
      id: "valid",
      paneTree: {
        type: "split",
        id: "root",
        direction: "invalid-direction",
        ratio: 9,
        first: { type: "leaf", id: "left", sessionIds: ["a", "a"], activeSessionId: "missing" },
        second: { type: "leaf", id: "right", sessionIds: ["b"], activeSessionId: "b" },
      },
      activePaneId: "missing-pane",
      activeSessionId: "missing-session",
    },
    { id: "invalid", paneTree: null },
  ]);

  assert.equal(migrated.length, 1);
  assert.equal(migrated[0].paneTree.type, "split");
  assert.equal(migrated[0].paneTree.direction, "horizontal");
  assert.equal(migrated[0].paneTree.ratio, 0.8);
  assert.deepEqual(collectWorkspanSessionIds(migrated[0]), ["a", "b"]);
  assert.equal(migrated[0].activeSessionId, "a");
});

test("sanitize and restore remove invalid or duplicate membership", () => {
  const workspans = [
    createTerminalWorkspan("first", "first-pane", "old-a"),
    {
      id: "second",
      paneTree: { type: "leaf", id: "second-pane", sessionIds: ["old-a", "old-b"], activeSessionId: "old-b" },
      activePaneId: "second-pane",
      activeSessionId: "old-b",
    },
  ];
  const restored = restoreTerminalWorkspans(workspans, { "old-a": "new-a", "old-b": "new-b" });
  const sanitized = sanitizeTerminalWorkspans(restored, new Set(["new-a", "new-b"]));

  assert.deepEqual(collectWorkspanSessionIds(sanitized[0]), ["new-a"]);
  assert.deepEqual(collectWorkspanSessionIds(sanitized[1]), ["new-b"]);
  assert.equal(sanitized[1].activeSessionId, "new-b");
});

test("sanitize keeps each session in only one pane", () => {
  const workspans = [{
    id: "duplicate-layout",
    paneTree: {
      type: "split",
      id: "root",
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", id: "first-pane", sessionIds: ["a", "b"], activeSessionId: "b" },
      second: { type: "leaf", id: "second-pane", sessionIds: ["b", "c"], activeSessionId: "b" },
    },
    activePaneId: "second-pane",
    activeSessionId: "b",
  }];

  const sanitized = sanitizeTerminalWorkspans(workspans, new Set(["a", "b", "c"]));

  assert.deepEqual(collectWorkspanSessionIds(sanitized[0]), ["a", "b", "c"]);
  assert.deepEqual(sanitized[0].paneTree.second.sessionIds, ["c"]);
  assert.equal(sanitized[0].activeSessionId, "b");
  assert.equal(sanitized[0].activePaneId, "first-pane");
});

test("remove and reorder keep top-level workspan behavior deterministic", () => {
  const first = createTerminalWorkspan("first", "first-pane", "first-session");
  const second = createTerminalWorkspan("second", "second-pane", "second-session");
  const reordered = reorderTerminalWorkspans([first, second], "second", "first");
  assert.deepEqual(reordered.map((workspan) => workspan.id), ["second", "first"]);
  assert.deepEqual(removeSessionFromTerminalWorkspans(reordered, "second-session").map((workspan) => workspan.id), ["first"]);
});
