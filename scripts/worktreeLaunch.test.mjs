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
const { worktreeStartupCommand, defaultWorktreeLaunchMode, freshWorkspaceAgentArgs } = load("../src/lib/worktreeLaunch.ts");
const project = { cli_tool: "codex", cli_args: '--model "model name" resume --last --cd /old', startup_cmd: "" };

test("a new Worktree starts a fresh conversation without an old session or directory selector", () => {
  assert.equal(defaultWorktreeLaunchMode(project), "agent");
  assert.equal(worktreeStartupCommand(project, "agent"), 'codex --model "model name"');
  assert.equal(worktreeStartupCommand({ ...project, startup_cmd: 'codex resume old-id -C /old --worktree' }, "agent"), "codex");
  assert.equal(freshWorkspaceAgentArgs('claude -r old-id -c --fork-session -w old-tree --model opus', "claude"), "claude --model opus");
  assert.equal(freshWorkspaceAgentArgs('pi --session old-id --model model', "pi"), "pi --model model");
  assert.equal(freshWorkspaceAgentArgs('codex -C"/old dir" --model fast', "codex"), "codex --model fast");
  assert.equal(freshWorkspaceAgentArgs('claude -rold-id -wold-tree --model opus', "claude"), "claude --model opus");
});

test("blank, create-only and configured commands are distinct outcomes", () => {
  assert.equal(worktreeStartupCommand(project, "shell"), "");
  assert.equal(worktreeStartupCommand(project, "none"), null);
  const custom = { ...project, startup_cmd: "npm run dev" };
  assert.equal(worktreeStartupCommand(custom, "agent"), "npm run dev");
  assert.equal(defaultWorktreeLaunchMode({ ...project, cli_tool: "" }), "shell");
});

test("new sessions retain quoted model/config values and remove only the launch selectors", () => {
  assert.equal(freshWorkspaceAgentArgs('codex -c model="x y" -C=/old --cd="/other dir" resume id --no-alt-screen --model x', "codex"), 'codex -c model="x y" --model x');
});
