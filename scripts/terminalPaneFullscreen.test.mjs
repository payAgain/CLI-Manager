import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../src/components/TerminalTabs.tsx", import.meta.url), "utf8");
const syntax = ts.createSourceFile("TerminalTabs.tsx", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
let fullscreenMemo;
let fullscreenCleanup;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(syntax) === "activeFullscreenPaneId") {
    fullscreenMemo = node.initializer.getText(syntax);
  }
  if (ts.isCallExpression(node) && node.expression.getText(syntax) === "useEffect"
    && node.arguments[0]?.getText(syntax).includes("setFullscreenPaneId(null)")) {
    fullscreenCleanup = node.arguments[0].getText(syntax);
  }
  ts.forEachChild(node, visit);
}
visit(syntax);
assert.ok(fullscreenMemo, "the actual fullscreen visibility derivation must exist");
assert.ok(fullscreenCleanup, "invalid fullscreen state must be cleared after navigation");

function transpile(code) {
  return ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
const deriveFullscreen = new Function("useMemo", "fullscreenPaneId", "activeWorkspanPaneId", "allPanes", "scopedSessionIds",
  transpile(`const result = ${fullscreenMemo};`) + "return result;");
const clearInvalidFullscreen = new Function("fullscreenPaneId", "activeFullscreenPaneId", "setFullscreenPaneId",
  transpile(`const effect = ${fullscreenCleanup};`) + "effect();");
const paneExports = {};
new Function("exports", transpile(readFileSync(new URL("../src/stores/terminalPaneTree.ts", import.meta.url), "utf8")))(paneExports);
const { collectPaneLeaves, setPaneActiveSession } = paneExports;

function tree() {
  return {
    id: "split", type: "split", direction: "horizontal", ratio: 0.5,
    first: { id: "a", type: "leaf", sessionIds: ["local", "local-second"], activeSessionId: "local" },
    second: { id: "b", type: "leaf", sessionIds: ["remote", "file-editor", "subagent-transcript"], activeSessionId: "remote" },
  };
}
function visibilityMemo() {
  let previousDependencies;
  let previousValue;
  return (callback, dependencies) => {
    if (!previousDependencies || dependencies.some((value, index) => !Object.is(value, previousDependencies[index]))) {
      previousValue = callback();
      previousDependencies = dependencies;
    }
    return previousValue;
  };
}

test("jumping from a zoomed pane to an existing terminal or editor immediately reveals the target pane", () => {
  for (const target of ["remote", "file-editor", "subagent-transcript"]) {
    const layout = tree();
    const memo = visibilityMemo();
    assert.equal(deriveFullscreen(memo, "a", "a", collectPaneLeaves(layout), null), "a");
    const selected = setPaneActiveSession(layout, target);
    assert.equal(selected.activePaneId, "b");
    assert.equal(deriveFullscreen(memo, "a", selected.activePaneId, collectPaneLeaves(selected.tree), null), null, target);
    const cleared = [];
    clearInvalidFullscreen("a", null, value => cleared.push(value));
    assert.deepEqual(cleared, [null], "returning later cannot resurrect the old zoom");
  }
});

test("changing tabs in the same pane preserves its zoom", () => {
  const layout = tree();
  const selected = setPaneActiveSession(layout, "local-second");
  assert.equal(selected.activePaneId, "a");
  assert.equal(deriveFullscreen(visibilityMemo(), "a", selected.activePaneId, collectPaneLeaves(selected.tree), null), "a");
  const cleared = [];
  clearInvalidFullscreen("a", "a", value => cleared.push(value));
  assert.deepEqual(cleared, []);
});

test("the memo invalidates when focus changes even when the pane collection is unchanged", () => {
  const panes = collectPaneLeaves(tree());
  const memo = visibilityMemo();
  assert.equal(deriveFullscreen(memo, "a", "a", panes, null), "a");
  assert.equal(deriveFullscreen(memo, "a", "b", panes, null), null);
  assert.equal(deriveFullscreen(memo, "b", "b", panes, null), "b", "explicitly zooming the newly active pane still works");
});

test("changing Workspan, deleting the zoomed pane, or filtering it out restores the normal layout", () => {
  const panes = collectPaneLeaves(tree());
  assert.equal(deriveFullscreen(visibilityMemo(), "a", "other-workspan-pane", panes, null), null);
  assert.equal(deriveFullscreen(visibilityMemo(), "a", "a", [panes[1]], null), null);
  assert.equal(deriveFullscreen(visibilityMemo(), "a", "a", panes, new Set(["remote"])), null);
  assert.equal(deriveFullscreen(visibilityMemo(), "a", "a", panes, new Set(["local-second"])), "a");
  assert.equal(deriveFullscreen(visibilityMemo(), "a", null, [], null), null);
});
