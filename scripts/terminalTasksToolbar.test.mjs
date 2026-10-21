import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../src/stores/settingsStore.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("settingsStore.ts", source, ts.ScriptTarget.Latest, true);
const defaults = ast.statements.filter(ts.isVariableStatement)
  .flatMap(statement => [...statement.declarationList.declarations])
  .find(declaration => declaration.name.getText(ast) === "DEFAULTS").initializer;
const keys = ["terminalToolbarVisibility", "terminalToolbarOrder"];
const fields = defaults.properties.filter(property => keys.includes(property.name?.getText(ast)))
  .map(property => property.getText(ast)).join(",\n");
const names = ["migrateTerminalToolbarVisibility", "migrateTerminalToolbarOrder"];
const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text))
  .map(node => node.getText(ast)).join("\n");
const code = ts.transpileModule(`const DEFAULTS = {${fields}};\n${functions}`, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { migrateTerminalToolbarVisibility: visibility, migrateTerminalToolbarOrder: order } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`,
);

test("legacy task entries combine visibility without exposing two obsolete settings", () => {
  for (const [subagents, backgroundTasks, expected] of [[true, true, true], [true, false, true], [false, true, true], [false, false, false]]) {
    const result = visibility({subagents, backgroundTasks, files:false, showText:true});
    assert.equal(result.tasks, expected);
    assert.equal(result.files, false);
    assert.equal(result.showText, true);
    assert.equal("subagents" in result, false);
    assert.equal("backgroundTasks" in result, false);
  }
});

test("an explicit combined preference wins, and missing legacy entries retain their default visibility", () => {
  assert.equal(visibility({tasks:false, subagents:true, backgroundTasks:true}).tasks, false);
  assert.equal(visibility({tasks:true, subagents:false, backgroundTasks:false}).tasks, true);
  assert.equal(visibility({backgroundTasks:false}).tasks, true);
  assert.equal(visibility({subagents:false}).tasks, true);
  assert.equal(visibility(null).tasks, true);
});

test("the merged toolbar entry retains the first legacy position and the order of unrelated entries", () => {
  const legacy = ["new", "stats", "subagents", "gitChanges", "backgroundTasks", "templates", "files", "sessionHistory", "fullscreen", "replay"];
  const original = [...legacy];
  assert.deepEqual(order(legacy), ["new", "stats", "tasks", "gitChanges", "templates", "files", "sessionHistory", "fullscreen", "replay"]);
  assert.deepEqual(legacy, original);
});

test("mixed and partially migrated orders remain complete and contain one task entry", () => {
  const result = order(["backgroundTasks", "tasks", "subagents", "stats", "stats", "removed", null]);
  assert.deepEqual(result.slice(0,2), ["tasks", "stats"]);
  assert.equal(result.filter(key => key === "tasks").length, 1);
  assert.equal(result.includes("backgroundTasks"), false);
  assert.equal(result.includes("subagents"), false);
  assert.equal(result.includes("removed"), false);
  assert.deepEqual(new Set(result), new Set(order(null)));
});
