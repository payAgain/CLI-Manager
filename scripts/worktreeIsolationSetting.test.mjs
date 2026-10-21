import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../src/stores/worktreeStore.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("worktreeStore.ts", source, ts.ScriptTarget.Latest, true);
let decision;
function find(node) {
  if (ts.isPropertyAssignment(node) && node.name.getText(ast) === "shouldIsolateNewSession") decision = node.initializer;
  ts.forEachChild(node, find);
}
find(ast);
assert.ok(decision);
const code = ts.transpileModule(`const decide = ${decision.getText(ast)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
function harness() {
  const settings = { projectWorktreeConfigEnabled: true };
  const env = {
    useSettingsStore: { getState: () => settings },
    projectSupportsCapability: project => project.environment_type !== "ssh",
    normalizeStrategy: value => ["prompt", "autoParallel", "always"].includes(value) ? value : "disabled",
    hasConfiguredCliTool: project => Boolean(project.cli_tool),
    hasSameProjectTerminalSession: (id, sessions) => sessions.some(session => session.projectId === id),
  };
  const decide = new Function(...Object.keys(env), code + "\nreturn decide;")(...Object.values(env));
  return { decide, settings };
}

test("disabling Worktree configuration stops automatic and prompted isolation for previously saved projects", () => {
  const { decide, settings } = harness();
  const sessions = [{ projectId: "project" }];
  for (const [strategy, result] of [["prompt", "prompt"], ["autoParallel", "auto"], ["always", "auto"]]) {
    const project = { id: "project", cli_tool: "codex", worktree_strategy: strategy };
    assert.equal(decide(project, sessions), result);
    settings.projectWorktreeConfigEnabled = false;
    assert.equal(decide(project, sessions), "none");
    settings.projectWorktreeConfigEnabled = true;
    assert.equal(decide(project, sessions), result, "reenabling retains each project's explicit strategy");
  }
});

test("the global option preserves SSH, disabled strategy, and ordinary-shell boundaries", () => {
  const { decide } = harness();
  assert.equal(decide({ id: "p", cli_tool: "codex", environment_type: "ssh", worktree_strategy: "always" }, []), "none");
  assert.equal(decide({ id: "p", cli_tool: "codex", worktree_strategy: "disabled" }, [{ projectId: "p" }]), "none");
  assert.equal(decide({ id: "p", cli_tool: "", worktree_strategy: "prompt" }, [{ projectId: "p" }]), "none");
  assert.equal(decide({ id: "p", cli_tool: "codex", worktree_strategy: "autoParallel" }, []), "none");
});
